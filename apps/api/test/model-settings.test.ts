import { prepareFinalAnswer, stopWhen } from "@workspace/api-routes/lib/chat/stop-conditions.js";
import { type CatalogModel } from "@workspace/api-routes/providers/openrouter-catalog.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { generateText, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Answers should be as deep as the question needs, within what each model
// supports, and a turn's tool loop is bounded by steps and by cost.

const catalog = vi.hoisted(() => ({ models: [] as CatalogModel[], unavailable: false }));

vi.mock("@workspace/api-routes/providers/openrouter-catalog.js", async (importActual) => ({
  ...(await importActual<typeof import("@workspace/api-routes/providers/openrouter-catalog.js")>()),
  getOpenRouterCatalog: async () => {
    if (catalog.unavailable) throw new Error("OpenRouter models request failed: 503");
    return catalog.models;
  },
}));

function catalogModel(id: string, supportedParameters: string[], maxCompletionTokens: number | null = 128_000) {
  return {
    id,
    label: id,
    description: "",
    images: false,
    pdfs: true,
    reasoning: supportedParameters.includes("reasoning"),
    contextLength: 1_000_000,
    supportedParameters,
    maxCompletionTokens,
  } satisfies CatalogModel;
}

const FULL = ["tools", "tool_choice", "max_tokens", "reasoning", "verbosity"];

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  catalog.unavailable = false;
  catalog.models = [
    catalogModel("openai/gpt-6-luna", FULL),
    catalogModel("google/gemini-4-argon", ["tools", "tool_choice", "max_tokens", "reasoning"], 943_718),
    catalogModel("small/no-budget", ["tools", "tool_choice"]),
    catalogModel("small/short-output", ["tools", "tool_choice", "max_tokens"], 8_192),
  ];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("chat model settings", () => {
  async function requestBody(modelId: string, options: { reasoning?: boolean } = {}) {
    const { getModel } = await import("@workspace/api-routes/providers/providers.js");
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

    const config = await getModel({} as Bindings, modelId, options);
    await generateText({ model: config.model, providerOptions: config.providerOptions, prompt: "hi" });
    return bodies[0]!;
  }

  it("asks for high verbosity, and high reasoning effort when reasoning is on, if the model supports them", async () => {
    const body = await requestBody("openai/gpt-6-luna", { reasoning: true });
    expect(body.verbosity).toBe("high");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("sends no reasoning when the user didn't turn it on", async () => {
    expect(await requestBody("openai/gpt-6-luna")).not.toHaveProperty("reasoning");
  });

  it("never sends verbosity to a model that doesn't support it", async () => {
    expect(await requestBody("google/gemini-4-argon", { reasoning: true })).not.toHaveProperty("verbosity");
  });

  it("requires every sent parameter to be supported, with an output budget within the model's maximum", async () => {
    for (const id of ["openai/gpt-6-luna", "google/gemini-4-argon", "small/short-output"]) {
      const body = await requestBody(id);
      expect(body.provider).toMatchObject({ require_parameters: true });
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.max_tokens).toBeLessThanOrEqual(catalog.models.find((m) => m.id === id)!.maxCompletionTokens!);
    }
    expect((await requestBody("openai/gpt-6-luna")).max_tokens).toBe(32_000);
  });

  it("gives a model that doesn't list max_tokens no output budget", async () => {
    expect(await requestBody("small/no-budget")).not.toHaveProperty("max_tokens");
  });

  it("sends no reasoning to a model that doesn't support it, even when turned on", async () => {
    expect(await requestBody("small/no-budget", { reasoning: true })).not.toHaveProperty("reasoning");
  });

  it("still answers, with default settings, when the catalog can't be loaded", async () => {
    catalog.unavailable = true;
    const body = await requestBody("openai/gpt-6-luna", { reasoning: true });
    expect(body).not.toHaveProperty("verbosity");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("reasoning");
    expect(body.provider).toMatchObject({ require_parameters: true });
  });

  it("still answers when the catalog has no entry for the model", async () => {
    const body = await requestBody("unknown/model", { reasoning: true });
    expect(body).not.toHaveProperty("verbosity");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.provider).toMatchObject({ require_parameters: true });
  });
});

describe("chat model menu", () => {
  it("lists only models that support both tools and tool_choice", async () => {
    const { getOpenRouterCatalog } = await vi.importActual<typeof import("@workspace/api-routes/providers/openrouter-catalog.js")>(
      "@workspace/api-routes/providers/openrouter-catalog.js",
    );
    vi.stubGlobal("fetch", async () =>
      Response.json({
        data: [
          { id: "a/both", name: "Both", supported_parameters: ["tools", "tool_choice", "max_tokens"], top_provider: { max_completion_tokens: 64_000 } },
          { id: "b/tools-only", name: "Tools only", supported_parameters: ["tools"] },
        ],
      }),
    );

    const models = await getOpenRouterCatalog();
    expect(models.map((m) => m.id)).toEqual(["a/both"]);
    expect(models[0]).toMatchObject({ supportedParameters: ["tools", "tool_choice", "max_tokens"], maxCompletionTokens: 64_000 });
  });
});

describe("the tool loop", () => {
  // A model that keeps calling a tool until it is told to answer, reporting
  // the given OpenRouter cost for each step. It records the tool_choice of
  // every call.
  function loopingModel(costPerStep: number, modelId = "openai/gpt-6-luna") {
    const toolChoices: (string | undefined)[] = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const providerMetadata = { openrouter: { usage: { cost: costPerStep } } };
    const model = new MockLanguageModelV4({
      modelId,
      doGenerate: async (options) => {
        toolChoices.push(options.toolChoice?.type);
        const lastMessage = JSON.stringify(options.prompt.at(-1));
        const toldToAnswer = options.toolChoice?.type === "none" || lastMessage.includes("Answer now");
        return toldToAnswer
          ? {
              content: [{ type: "text", text: "Here is what I found." }],
              finishReason: { unified: "stop", raw: "stop" },
              usage,
              providerMetadata,
              warnings: [],
            }
          : {
              content: [{ type: "tool-call", toolCallId: `c${toolChoices.length}`, toolName: "search", input: "{}" }],
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage,
              providerMetadata,
              warnings: [],
            };
      },
    });
    return { model, toolChoices };
  }

  const tools = { search: tool({ inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "more results" }) };

  const run = (model: MockLanguageModelV4) =>
    generateText({ model, tools, prompt: "research this", stopWhen, prepareStep: prepareFinalAnswer });

  it("keeps going while the cost is under $2 and steps are under 30, then ends with an answer", async () => {
    const result = await run(loopingModel(0.01).model);
    expect(result.steps).toHaveLength(30);
    expect(result.steps.slice(0, 29).every((s) => s.toolCalls.length === 1)).toBe(true);
    expect(result.text).toBe("Here is what I found.");
  });

  it("answers instead of calling tools once the cost reaches 85% of the ceiling", async () => {
    const result = await run(loopingModel(0.6).model); // 0.6, 1.2, 1.8 (90%) -> answer
    expect(result.steps).toHaveLength(4);
    expect(result.text).toBe("Here is what I found.");
  });

  it("answers before a step would cross the ceiling, even when steps skip past 85%", async () => {
    const result = await run(loopingModel(0.5).model); // 0.5, 1.0, 1.5; the next would reach 2.0 -> answer
    expect(result.steps).toHaveLength(4);
    expect(result.text).toBe("Here is what I found.");
  });

  it("keeps tool_choice unchanged on Anthropic, so its cached conversation stays valid", async () => {
    const { model, toolChoices } = loopingModel(0.6, "anthropic/claude-sonnet-5.5");
    const result = await run(model);

    expect(result.text).toBe("Here is what I found.");
    expect(new Set(toolChoices)).toEqual(new Set(["auto"]));
  });

  it("stops when a single step costs more than the whole ceiling", async () => {
    const result = await run(loopingModel(2.5).model);
    expect(result.steps).toHaveLength(1);
  });
});
