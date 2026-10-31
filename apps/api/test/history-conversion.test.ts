import { mockedTools } from "@workspace/api-routes/lib/tools/index.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { convertToModelMessages, validateUIMessages } from "ai";
import { describe, expect, it } from "vitest";

// Saved chats are replayed to the model on every turn, so what the model gets back
// must keep reasoning metadata and the results of tools that are no longer offered.

const reasoningDetails = [
  { type: "reasoning.encrypted", data: "opaque-signature", format: "openai-responses-v1" },
];

const savedChat = [
  {
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: "What happened in Lisbon this week?" }],
  },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      {
        type: "reasoning",
        text: "I should search the web.",
        state: "done",
        providerMetadata: { openrouter: { reasoning_details: reasoningDetails } },
      },
      {
        type: "tool-extractFromWeb",
        toolCallId: "call_1",
        state: "output-available",
        input: { informationToExtract: "Lisbon news this week" },
        output: {
          extractedInformation: "A new metro line opened.",
          sources: [{ id: "s1", url: "https://example.com/metro", title: "Metro" }],
        },
        callProviderMetadata: { openrouter: { reasoning_details: reasoningDetails } },
      },
      { type: "step-start" },
      { type: "text", text: "A new metro line opened.", state: "done" },
    ],
  },
  {
    id: "u2",
    role: "user",
    parts: [{ type: "text", text: "Tell me more." }],
  },
] as CustomUIMessage[];

async function replay() {
  const messages = await validateUIMessages<CustomUIMessage>({
    messages: savedChat,
    tools: mockedTools,
  });
  return convertToModelMessages(messages, { tools: mockedTools });
}

describe("replaying a saved chat to the model", () => {
  it("keeps OpenRouter reasoning_details on the reasoning part", async () => {
    const model = await replay();
    const reasoning = model
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === "reasoning");

    expect(reasoning?.providerOptions?.openrouter).toEqual({
      reasoning_details: reasoningDetails,
    });
  });

  it("keeps the full output of a tool that is no longer offered (extractFromWeb)", async () => {
    const model = await replay();
    const result = model
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === "tool-result");

    expect(JSON.stringify(result)).toContain("A new metro line opened.");
    expect(JSON.stringify(result)).not.toContain("omitted");
  });
});
