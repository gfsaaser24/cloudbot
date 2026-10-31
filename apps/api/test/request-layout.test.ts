import { type LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { mergeIncomingMessages } from "@workspace/api-routes/lib/chat/chat-history.js";
import { type ChatRequest } from "@workspace/api-routes/lib/chat/chat-request.js";
import { StandardChatHandler } from "@workspace/api-routes/lib/chat/standard-chat-handler.js";
import { extractFromDocuments } from "@workspace/api-routes/lib/tools/extract-from-documents.js";
import { extractFromWeb } from "@workspace/api-routes/lib/tools/extract-from-web.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { generateText, type UIMessageStreamWriter } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Follow-up turns only hit the prompt cache when everything before the new
// message is byte-identical: the instructions, the tool list and the history.

const calls = vi.hoisted(() => ({
  model: [] as unknown[],
  saved: [] as unknown[],
}));

const chatModel = new MockLanguageModelV4({
  doStream: async (options) => {
    calls.model.push(options);
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "ok" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ] as const) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      }),
    };
  },
});

vi.mock("@workspace/api-routes/providers/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("@workspace/api-routes/providers/providers.js")>();
  return {
    ...actual,
    // The real request settings, sent to a mock model.
    getModel: async (...args: Parameters<typeof actual.getModel>) => ({
      ...(await actual.getModel(...args)),
      model: chatModel,
    }),
  };
});

vi.mock("@workspace/api-routes/lib/queries/messages.js", () => ({
  saveMessages: async ({ newMessages }: { newMessages: unknown[] }) => {
    calls.saved.push(...structuredClone(newMessages));
  },
}));

vi.mock("@workspace/api-routes/lib/queries/prompts.js", () => ({
  getPromptsByIds: async () => [{ name: "Tone", content: "Write like a podcast host." }],
}));

vi.mock("@workspace/api-routes/lib/chat/project-context.js", async (importActual) => ({
  ...(await importActual<typeof import("@workspace/api-routes/lib/chat/project-context.js")>()),
  loadProject: async () => ({
    folder: { id: PROJECT_FOLDER, name: "Season 3", description: null },
    fileNames: ["episode-1.md"],
    hasMoreFiles: false,
  }),
}));

// The folder permission check reads the folders from D1.
vi.mock("@workspace/server/drizzle/db.js", () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => [{ id: OTHER_FOLDER, visibility: "private", folderId: OTHER_FOLDER, owner: "user-1" }],
      }),
    }),
  }),
}));

vi.mock("@workspace/api-routes/utils/filter-authorized-folders.js", () => ({
  filterAuthorizedFolders: async (folders: unknown[]) => folders,
}));

const PROJECT_FOLDER = "00000000-0000-4000-8000-0000000000aa";
const OTHER_FOLDER = "00000000-0000-4000-8000-0000000000bb";
const PROMPT_ID = "00000000-0000-4000-8000-0000000000cc";

type Selection = { folders?: string[]; prompts?: string[] };

function userTurn(id: string, text: string, selection: Selection = {}, extraParts: unknown[] = []) {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }, ...extraParts],
    metadata: {
      contextFilter: {
        folders: (selection.folders ?? []).map((id) => ({ id })),
        files: [],
        documents: [],
        prompts: (selection.prompts ?? []).map((id) => ({ id })),
      },
    },
  } as unknown as CustomUIMessage;
}

// Like ChatRequest.from: the stored chat plus the client's new message.
async function runTurn(stored: CustomUIMessage[], incoming: CustomUIMessage) {
  const messages = mergeIncomingMessages(stored, [incoming]);
  const request = {
    id: "chat-1",
    messages,
    lastMessage: messages.at(-1),
    user: { id: "user-1" },
    model: "anthropic/claude-sonnet-5.5",
    folderId: PROJECT_FOLDER,
    userLocation: { city: "Lisbon", region: "Lisbon", country: "PT", timezone: "Europe/Lisbon" },
    createNewChat: false,
    isTemporary: false,
  } as unknown as ChatRequest;

  const response = await new StandardChatHandler({} as Bindings, request).handleRequest();
  await response.text();
  return calls.model.at(-1) as LanguageModelV4CallOptions;
}

const systemText = (call: LanguageModelV4CallOptions) =>
  call.prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n");

const toolNames = (call: LanguageModelV4CallOptions) => (call.tools ?? []).map((t) => t.name);

const turnContextParts = (message: unknown) =>
  (message as CustomUIMessage).parts.filter((p) => p.type === "data-turnContext");

beforeEach(() => {
  calls.model.length = 0;
  calls.saved.length = 0;
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("request layout across turns", () => {
  it("sends identical instructions and the same tools in the same order on every turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
    const first = await runTurn([], userTurn("u1", "what is in season 3?"));

    vi.setSystemTime(new Date("2026-10-30T17:45:00Z"));
    const second = await runTurn(
      [...(calls.saved as CustomUIMessage[])],
      userTurn("u2", "and the other folder?", { folders: [OTHER_FOLDER], prompts: [PROMPT_ID] }),
    );

    expect(systemText(second)).toBe(systemText(first));
    // Turn 1's message, with its own date and context, replays byte for byte.
    const firstUser = (call: LanguageModelV4CallOptions) => call.prompt.find((m) => m.role === "user");
    expect(JSON.stringify(firstUser(second))).toBe(JSON.stringify(firstUser(first)));
    expect(systemText(first)).not.toMatch(/2026|Lisbon|Season 3/);
    expect(toolNames(second)).toEqual(toolNames(first));
    expect(toolNames(first)).toEqual([...toolNames(first)].sort());
    expect(toolNames(first)).toEqual(expect.arrayContaining(["extractFromDocuments", "readFile", "extractFromWeb"]));
  });

  it("saves the date, location, project and selected instructions on the new user message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
    await runTurn([], userTurn("u1", "hi", { prompts: [PROMPT_ID] }));

    const savedUser = calls.saved.find((m) => (m as CustomUIMessage).role === "user");
    const [context] = turnContextParts(savedUser);
    expect(turnContextParts(savedUser)).toHaveLength(1);
    expect(JSON.stringify(context)).toContain("October 30, 2026");
    expect(JSON.stringify(context)).toContain("Lisbon");
    expect(JSON.stringify(context)).toContain("Season 3");
    expect(JSON.stringify(context)).toContain("Write like a podcast host.");
  });

  it("gives a retried message exactly one context part", async () => {
    const stale = { type: "data-turnContext", data: { text: "## Current Context\n\nan old one" } };
    await runTurn([], userTurn("u1", "again", {}, [stale]));

    const savedUser = calls.saved.find((m) => (m as CustomUIMessage).role === "user");
    expect(turnContextParts(savedUser)).toHaveLength(1);
    expect(JSON.stringify(savedUser)).not.toContain("an old one");
  });

  it("sends the chat id as session_id on every turn", async () => {
    const call = await runTurn([], userTurn("u1", "hi"));
    expect(call.providerOptions?.openrouter).toMatchObject({ session_id: "chat-1" });
  });
});

describe("tools whose precondition is off", () => {
  const toolCall = { toolCallId: "c1", messages: [] };
  const writer = {} as UIMessageStreamWriter<CustomUIMessage>;

  it("extractFromDocuments explains that nothing is selected instead of searching", async () => {
    const search = vi.fn();
    const env = { AI: { autorag: search } } as unknown as Bindings;
    const tool = extractFromDocuments({ env, userId: "user-1", fileMetadata: [], folderMetadata: [], dataStream: writer });

    const output = await tool.execute?.({ query: "pricing", max_num_results: 10 }, toolCall);
    expect(JSON.stringify(output)).toMatch(/no folder or file is selected/i);
    expect(search).not.toHaveBeenCalled();
  });

  it("extractFromWeb explains that web search is off", async () => {
    const tool = extractFromWeb({
      env: {} as Bindings,
      userLocation: {},
      dataStream: writer,
      enabled: false,
    } as Parameters<typeof extractFromWeb>[0]);

    const output = await tool.execute?.({ informationToExtract: "news" }, toolCall);
    expect(JSON.stringify(output)).toMatch(/web search is turned off/i);
  });
});

describe("prompt caching settings", () => {
  async function requestBody(modelId: string) {
    const { getModel } = await vi.importActual<typeof import("@workspace/api-routes/providers/providers.js")>(
      "@workspace/api-routes/providers/providers.js",
    );
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        id: "gen-1",
        model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });

    const config = await getModel({} as Bindings, modelId, { sessionId: "chat-1" });
    await generateText({ model: config.model, providerOptions: config.providerOptions, prompt: "hi" });
    vi.unstubAllGlobals();
    return bodies[0]!;
  }

  it.each(["anthropic/claude-sonnet-5.5", "~anthropic/claude-sonnet-latest"])(
    "%s gets top-level cache_control with a 1 hour lifetime",
    async (modelId) => {
      expect((await requestBody(modelId)).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    },
  );

  it.each(["openai/gpt-6-luna", "google/gemini-4-argon"])("%s gets no cache_control", async (modelId) => {
    expect(await requestBody(modelId)).not.toHaveProperty("cache_control");
  });

  it("puts the chat id in session_id", async () => {
    expect((await requestBody("openai/gpt-6-luna")).session_id).toBe("chat-1");
  });
});
