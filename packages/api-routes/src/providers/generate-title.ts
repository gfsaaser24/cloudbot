import { createLogger } from "@workspace/server/logger/logger.js";
import { generateText, type LanguageModel } from "ai";
import { type CustomUIMessage } from "../types/custom-ui-message.js";

// When the model returns no title, or the call fails, the chat is named after
// its first words: a title must never stop the chat from being created.
const FALLBACK_TITLE_WORDS = 6;

const logger = createLogger("generate-title");

export async function generateTitleFromUserMessage({
  message,
  model,
}: {
  message: CustomUIMessage;
  model: LanguageModel;
}) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  const fallback = text.trim().split(/\s+/).slice(0, FALLBACK_TITLE_WORDS).join(" ");

  try {
    const { text: title } = await generateText({
      model,
      instructions: `\n
      - Generate a short title based on the first message a user begins a conversation with
      - Ensure it is not more than a few words long
      - Do not use quotes or colons`,
      prompt: "User message: " + text,
      maxOutputTokens: 32,
      // Models that reason by default (Gemini Flash) otherwise spend the whole
      // budget reasoning and return no text; some can't turn it off.
      providerOptions: { openrouter: { reasoning: { effort: "minimal" } } },
    });
    return title.trim() || fallback;
  } catch (error) {
    logger.warn("Could not generate a chat title", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}
