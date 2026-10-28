import * as z from "zod";
import { fileTypeOf } from "../lib/file-types.js";

export const filenameSchema = z
  .string()
  .min(1, {
    message: "Filename is required and must be at least one character long.",
  })
  .max(64, {
    message: "Filename must be less than 64 characters.",
  })
  .regex(/^[a-zA-Z0-9_-\s.:]+$/, {
    message:
      "Filename can only contain letters, numbers, underscores, hyphens, whitespaces, periods and colons.",
  });

// A filename with one of the extensions CloudChat accepts (lib/file-types.ts).
export const filenameWithExtensionSchema = z.string().refine(
  (value) => {
    if (!fileTypeOf(value)) return false;
    return filenameSchema.safeParse(value.slice(0, value.lastIndexOf(".")))
      .success;
  },
  {
    message:
      "Filename must use one of the supported extensions and must exclude unsupported special characters.",
  },
);
