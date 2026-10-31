import { generateTitleFromUserMessage } from "@workspace/api-routes/providers/generate-title.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { type LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

// A new chat is named by a small model call. Gemini Flash reasons by default,
// and with a small budget used to spend it all reasoning and return no title.

const message = {
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "Please look inside the folder into the building now podcast and find the themes" }],
} as CustomUIMessage;

const titleModel = (text: string, calls: LanguageModelV4CallOptions[]) =>
  new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: text ? [{ type: "text", text }] : [],
        finishReason: { unified: text ? "stop" : "length", raw: text ? "stop" : "length" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 16, text: 0, reasoning: 16 },
        },
        warnings: [],
      };
    },
  });

describe("chat title", () => {
  it("asks for minimal reasoning so the budget goes to the title", async () => {
    const calls: LanguageModelV4CallOptions[] = [];
    const title = await generateTitleFromUserMessage({ message, model: titleModel(" Founder Success Themes \n", calls) });

    expect(title).toBe("Founder Success Themes");
    expect(calls[0]!.providerOptions).toEqual({ openrouter: { reasoning: { effort: "minimal" } } });
  });

  it("names the chat after its first words when the title call fails", async () => {
    const rejecting = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("max_tokens must be greater than thinking.budget_tokens");
      },
    });

    const title = await generateTitleFromUserMessage({ message, model: rejecting });

    expect(title).toBe("Please look inside the folder into");
  });

  it("names the chat after its first words when the model returns no title", async () => {
    const title = await generateTitleFromUserMessage({ message, model: titleModel("", []) });

    expect(title).toBe("Please look inside the folder into");
  });
});
