import * as z from "zod";
import { artifactSchema } from "./artifact-schema.js";
import { uuidSchema } from "./uuid-schema.js";

export const dataSchemas = {
  chatCreated: z
    .object({
      chatId: uuidSchema,
    })
    .strict(),
  documentIdentifier: z.object({
    id: uuidSchema,
    title: z.string(),
    kind: artifactSchema,
  }),
  textDelta: z.string(),
  codeDelta: z.string(),
  // sheetDelta: z.string(), // Maybe add sheet later
  createFinish: artifactSchema,
  updateFinish: z.object({
    diffId: uuidSchema,
  }),
  fileGenerating: z.string(),
  fileGenerated: z.string(),
  // Attachment and referenced-document text the server adds to a user message.
  // Saved with the message so later turns replay it; the bubble doesn't show it.
  attachmentText: z.object({ text: z.string() }).strict(),
  // The per-turn context (date, location, project, selected instructions), kept
  // out of the instructions so they stay identical and cacheable across turns.
  turnContext: z.object({ text: z.string() }).strict(),
};
