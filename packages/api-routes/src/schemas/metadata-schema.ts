import * as z from "zod";

import { attachmentSchema } from "./attachment-schema.js";
import { contextFilterSchema } from "./context-filter-schema.js";

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

const replyUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  costUsd: z.number(),
});

export const metadataSchema = z
  .object({
    attachments: z.array(attachmentSchema).max(5).optional(),
    contextFilter: contextFilterSchema.optional(),
    // Replies saved before usage covered cache and cost.
    totalUsage: usageSchema.optional(),
    usage: replyUsageSchema.optional(),
  })
  .nullable();
