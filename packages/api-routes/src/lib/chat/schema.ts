import * as z from "zod";

const basePayloadSchema = z
  .object({
    id: z.uuid({
      message: "Chat ID must be a valid UUID",
    }),
    messages: z.array(z.any()).min(1), // This will be validated with the ai.validateUIMessages function later
    // OpenRouter model id from the model menu, e.g. "anthropic/claude-sonnet-5.5".
    model: z
      .string()
      .max(200)
      .regex(/^[\w.-]+\/[\w.:-]+$/),
    temporary: z.boolean(),
    reasoning: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    trigger: z.string().max(128).optional(),
  })
  .refine(
    (data) => {
      if (data.temporary === false) {
        return data.messages.length === 1;
      }
      return true;
    },
    {
      message:
        "When temporary is false, messages array must contain exactly one element",
      path: ["messages"],
    },
  );

export const chatPayloadSchema = basePayloadSchema.strict();
