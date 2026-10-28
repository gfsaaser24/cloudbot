import * as z from "zod";
import { uuidSchema } from "@workspace/api-routes/schemas/uuid-schema.js";

export const chatsFolderSchema = z
  .object({
    folderId: uuidSchema.nullable(), // null clears the chat's folder
  })
  .strict();
