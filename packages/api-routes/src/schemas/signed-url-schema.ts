import * as z from "zod";
import { fileTypeOf, type FileKind } from "../lib/file-types.js";
import { filenameSchema } from "./filename-schema.js";

// The MIME type is derived from the filename's extension on the server (see
// lib/file-types.ts); `fileType` from the browser is accepted but not trusted.
export const createSignedUrlSchema = (allowedKinds: readonly FileKind[]) => {
  return z
    .object({
      filename: z.string().refine(
        (value) => {
          const type = fileTypeOf(value);
          if (!type || !allowedKinds.includes(type.kind)) return false;
          return filenameSchema.safeParse(value.slice(0, value.lastIndexOf(".")))
            .success;
        },
        {
          message:
            "Filename must use one of the supported extensions and must exclude unsupported special characters.",
        },
      ),
      fileSize: z
        .number()
        .int()
        .positive()
        .max(30 * 1024 * 1024, {
          message: "File size must be less than 30 MB",
        }),
      fileType: z.string().max(256).optional(),
    })
    .strict();
};
