import { generateText, type LanguageModel } from "ai";
import { type CustomUIMessage } from "../types/custom-ui-message.js";

// When the model returns no title, the chat is named after its first words.
const FALLBACK_TITLE_WORDS = 6;

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

  return (
    title.trim() ||
    text.trim().split(/\s+/).slice(0, FALLBACK_TITLE_WORDS).join(" ")
  );
}
