import { codeDocumentHandler } from "@workspace/api-routes/lib/artifacts/code-server.js";
import { textDocumentHandler } from "@workspace/api-routes/lib/artifacts/text-server.js";
import { generateFile } from "@workspace/api-routes/lib/tools/generate-file.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { type Document } from "@workspace/server/drizzle/schema.js";
import { type UIMessageStreamWriter } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

// Tools that write with a model of their own (files and documents) add what
// that call cost to the turn's spend, so the turn's cost limit counts it.

// A bring-your-own-key charge: OpenRouter reports cost 0 and the provider's
// charge separately.
const COST = 0.05;
const providerMetadata = {
  openrouter: { usage: { cost: 0, costDetails: { upstreamInferenceCost: COST } } },
};
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

vi.mock("@workspace/api-routes/providers/providers.js", async (importActual) => ({
  ...(await importActual<typeof import("@workspace/api-routes/providers/providers.js")>()),
  getModel: async () => ({
    model: new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "a,b\n1,2" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        providerMetadata,
        warnings: [],
      }),
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "Draft" },
            { type: "text-end", id: "t" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage, providerMetadata },
          ],
        }),
      }),
    }),
  }),
}));

vi.mock("@workspace/api-routes/lib/queries/documents.js", () => ({
  saveDocument: async () => undefined,
  saveDiff: async () => "diff-1",
}));

const dataStream = { write: () => undefined } as unknown as UIMessageStreamWriter<CustomUIMessage>;
const env = { CLOUDBOT_BUCKET: { put: async () => undefined } } as unknown as Bindings;
const document = { id: "doc-1", title: "Notes", content: "Old", kind: "text" } as Document;

describe("tool spend", () => {
  it("counts a generated file's model call", async () => {
    const spend = { steps: 0, tools: 0 };
    await generateFile({ userId: "user-1", dataStream, env, spend }).execute!(
      { title: "Table", format: "csv", description: "Two columns" },
      { toolCallId: "c1", messages: [] },
    );
    expect(spend.tools).toBeCloseTo(COST);
  });

  it("counts creating and updating text and code documents", async () => {
    const spend = { steps: 0, tools: 0 };
    for (const handler of [textDocumentHandler, codeDocumentHandler]) {
      await handler.onCreateDocument({ id: "doc-1", title: "Notes", description: "", dataStream, userId: "user-1", env, spend });
      await handler.onUpdateDocument({ document, description: "Shorter", dataStream, userId: "user-1", env, spend });
    }
    expect(spend.tools).toBeCloseTo(4 * COST);
  });
});
