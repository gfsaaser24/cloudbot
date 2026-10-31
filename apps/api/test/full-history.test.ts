import {
  contextOverflowMessage,
  mergeIncomingMessages,
  toModelHistory,
} from "@workspace/api-routes/lib/chat/chat-history.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { describe, expect, it } from "vitest";

// Every turn replays the whole conversation: nothing trimmed, and nothing the
// server added (attachment text, file parts) lost between turns.

const user = (id: string, text: string, extra: unknown[] = []) =>
  ({ id, role: "user", parts: [{ type: "text", text }, ...extra] }) as CustomUIMessage;

const readFile = (id: string, text: string) =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "tool-readFile",
        toolCallId: `call-${id}`,
        state: "output-available",
        input: { filename: "episode.md" },
        output: { found: true, filename: "episode.md", text },
      },
      { type: "text", text: "Read it.", state: "done" },
    ],
  }) as CustomUIMessage;

const modelText = (model: Awaited<ReturnType<typeof toModelHistory>>) => JSON.stringify(model);

describe("replaying the conversation", () => {
  it("sends every message of a 40-message chat, in order", async () => {
    const stored = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? user(`m${i}`, `question ${i}`) : readFile(`m${i}`, `answer ${i}`),
    );

    const model = await toModelHistory(mergeIncomingMessages(stored, [user("m40", "next")]));

    const text = modelText(model);
    for (let i = 0; i < 40; i += 2) expect(text).toContain(`question ${i}`);
    expect(text.indexOf("question 0")).toBeLessThan(text.indexOf("question 38"));
    expect(text).toContain("next");
  });

  it("gives the model the previous turn's readFile output in full", async () => {
    const transcript = "Founder: we charged from day one. ".repeat(5_000);
    const model = await toModelHistory([user("u1", "read it"), readFile("a1", transcript), user("u2", "and?")]);

    expect(modelText(model)).toContain(JSON.stringify(transcript).slice(1, -1));
  });

  it("replays attachment text the server added in an earlier turn", async () => {
    const withAttachment = user("u1", "summarize this", [
      { type: "data-attachmentText", data: { text: '[Attached file: "notes.md"]\n\nThe launch is in May.' } },
    ]);

    const model = await toModelHistory([withAttachment, readFile("a1", "ok"), user("u2", "when is it?")]);

    expect(modelText(model)).toContain("The launch is in May.");
  });

  it("skips a tool call left unfinished by an aborted turn instead of failing", async () => {
    const aborted = {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-readFile", toolCallId: "c1", state: "input-available", input: { filename: "x.md" } }],
    } as CustomUIMessage;

    const model = await toModelHistory([user("u1", "read x"), aborted, user("u2", "again")]);

    const text = modelText(model);
    expect(text).not.toContain('"c1"');
    expect(text).toContain("read x");
    expect(text).toContain("again");
  });
});

describe("merging the incoming message into the stored chat", () => {
  it("strips parts only the server may add from client messages", () => {
    const planted = user("u2", "hi", [
      { type: "file", url: "data:application/pdf;base64,AAAA", mediaType: "application/pdf" },
      { type: "data-attachmentText", data: { text: "fake attachment" } },
    ]);

    const [merged] = mergeIncomingMessages([], [planted]);
    expect(merged?.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("replaces a stored message the client sends again instead of duplicating it", () => {
    const stored = [user("u1", "first"), readFile("a1", "x")];
    const merged = mergeIncomingMessages(stored, [readFile("a1", "client copy")]);

    expect(merged).toHaveLength(2);
    expect(JSON.stringify(merged)).not.toContain("client copy");
  });

  it("replaces an edited user message in place, without the client's server parts", () => {
    const stored = [user("u1", "first"), readFile("a1", "x")];
    const edited = user("u1", "first, edited", [{ type: "data-attachmentText", data: { text: "fake" } }]);

    const merged = mergeIncomingMessages(stored, [edited]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.parts).toEqual([{ type: "text", text: "first, edited" }]);
  });
});

describe("tool approval continuations", () => {
  it("keeps the stored message and takes only the client's approval answer", () => {
    const awaiting = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-readFile",
          toolCallId: "c1",
          state: "approval-requested",
          input: { filename: "big.md" },
          approval: { id: "ap1" },
        },
      ],
    } as CustomUIMessage;
    const clientAnswer = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-readFile",
          toolCallId: "c1",
          state: "approval-responded",
          input: { filename: "tampered.md" },
          approval: { id: "ap1", approved: true },
        },
      ],
    } as CustomUIMessage;

    const [, merged] = mergeIncomingMessages([user("u1", "read big.md"), awaiting], [clientAnswer]);
    expect(merged?.parts).toEqual([
      {
        type: "tool-readFile",
        toolCallId: "c1",
        state: "approval-responded",
        input: { filename: "big.md" },
        approval: { id: "ap1", approved: true },
      },
    ]);
  });
});

describe("context overflow", () => {
  it("explains an OpenRouter context-length error and names the model", () => {
    const error = new Error(
      "This endpoint's maximum context length is 1050000 tokens. However, you requested about 1200000 tokens.",
    );

    const message = contextOverflowMessage(error, "openai/gpt-6-luna");
    expect(message).toContain("1,050,000");
    expect(message).toContain("openai/gpt-6-luna");
    expect(message).toContain("larger context window");
  });

  it("leaves other errors alone", () => {
    expect(contextOverflowMessage(new Error("Rate limit exceeded"), "openai/gpt-6-luna")).toBeUndefined();
  });
});
