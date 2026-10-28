import * as z from "zod";

import { fileTypeOf } from "../lib/file-types.js";

export const attachmentSchema = z.object({
  // The R2 key; its extension decides how the chat reads the file (lib/file-types.ts).
  filename: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => fileTypeOf(value) !== null, {
      message: "Unsupported attachment type",
    }),
  mediaType: z.string().max(256),
  previewUrl: z.string().optional(),
});

export type Attachment = z.infer<typeof attachmentSchema>;
