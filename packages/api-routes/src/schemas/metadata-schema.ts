import * as z from "zod";

import { replyUsageSchema } from "../lib/chat/reply-usage.js";
import { attachmentSchema } from "./attachment-schema.js";
import { contextFilterSchema } from "./context-filter-schema.js";

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
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
