import { formatReplyUsage, replyUsage } from "@workspace/api-routes/lib/chat/reply-usage.js";
import { type LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";

const usageOf = ({ input, cacheRead = 0, output, reasoning = 0 }: { input: number; cacheRead?: number; output: number; reasoning?: number }): LanguageModelUsage => ({
  inputTokens: input,
  inputTokenDetails: { noCacheTokens: input - cacheRead, cacheReadTokens: cacheRead, cacheWriteTokens: 0 },
  outputTokens: output,
  outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
  totalTokens: input + output,
});

// Each reply shows what it used: tokens, how much came from the prompt cache,
// reasoning, and what the turn cost.

describe("reply usage", () => {
  it("shows the cache-read share and the cost", () => {
    const usage = replyUsage(usageOf({ input: 120_000, cacheRead: 100_000, output: 1_500, reasoning: 300 }), 0.0421);

    expect(formatReplyUsage(usage)).toBe("120,000 in (83% from cache) · 1,500 out (300 reasoning) · $0.042");
  });

  it("leaves out cache and reasoning when there were none", () => {
    const usage = replyUsage(usageOf({ input: 900, output: 50 }), 0.00042);

    expect(formatReplyUsage(usage)).toBe("900 in · 50 out · $0.0004");
  });

  it("doesn't show a tiny cost as zero", () => {
    const usage = replyUsage(usageOf({ input: 12, output: 94, reasoning: 81 }), 0.00005);
    expect(formatReplyUsage(usage)).toBe("12 in · 94 out (81 reasoning) · <$0.0001");
  });
});
