import { type LanguageModelUsage } from "ai";
import * as z from "zod";

// What one reply used: tokens from every step of the turn, and what it cost,
// including model calls made by tools (analyzeFolder's per-file reads).
// Shared with the web app, which shows it under the reply.

export const replyUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  costUsd: z.number(),
});

export type ReplyUsage = z.infer<typeof replyUsageSchema>;

export function replyUsage(
  total: LanguageModelUsage,
  costUsd: number,
): ReplyUsage {
  return {
    inputTokens: total.inputTokens ?? 0,
    outputTokens: total.outputTokens ?? 0,
    cacheReadTokens: total.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: total.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: total.outputTokenDetails?.reasoningTokens ?? 0,
    costUsd,
  };
}

const tokens = (count: number) => count.toLocaleString("en-US");

function dollars(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}

// e.g. "120,000 in (83% from cache) · 1,500 out (300 reasoning) · $0.042"
export function formatReplyUsage(usage: ReplyUsage): string {
  const cached =
    usage.inputTokens > 0 && usage.cacheReadTokens > 0
      ? ` (${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}% from cache)`
      : "";
  const reasoning =
    usage.reasoningTokens > 0
      ? ` (${tokens(usage.reasoningTokens)} reasoning)`
      : "";
  return [
    `${tokens(usage.inputTokens)} in${cached}`,
    `${tokens(usage.outputTokens)} out${reasoning}`,
    dollars(usage.costUsd),
  ].join(" · ");
}
