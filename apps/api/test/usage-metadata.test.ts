import { formatReplyUsage, replyUsage } from "@workspace/api-routes/lib/chat/reply-usage.js";
import { describe, expect, it } from "vitest";

// Each reply shows what it used: tokens, how much came from the prompt cache,
// reasoning, and what the turn cost.

describe("reply usage", () => {
  it("shows the cache-read share and the cost", () => {
    const usage = replyUsage(
      {
        inputTokens: 120_000,
        inputTokenDetails: { noCacheTokens: 20_000, cacheReadTokens: 100_000, cacheWriteTokens: 0 },
        outputTokens: 1_500,
        outputTokenDetails: { textTokens: 1_200, reasoningTokens: 300 },
        totalTokens: 121_500,
      },
      0.0421,
    );

    expect(formatReplyUsage(usage)).toBe("120,000 in (83% from cache) · 1,500 out (300 reasoning) · $0.042");
  });

  it("leaves out cache and reasoning when there were none", () => {
    const usage = replyUsage(
      {
        inputTokens: 900,
        inputTokenDetails: { noCacheTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokens: 50,
        outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
        totalTokens: 950,
      },
      0.00042,
    );

    expect(formatReplyUsage(usage)).toBe("900 in · 50 out · $0.0004");
  });

  it("doesn't show a tiny cost as zero", () => {
    const usage = replyUsage({ inputTokens: 12, outputTokens: 94, totalTokens: 106, inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 13, reasoningTokens: 81 } }, 0.00005);
    expect(formatReplyUsage(usage)).toBe("12 in · 94 out (81 reasoning) · <$0.0001");
  });
});
