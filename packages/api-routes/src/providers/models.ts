export type Provider = "vercel-ai-gateway" | "workers-ai" | "openrouter";

export interface ChatModel {
  id: number;
  name: string;
  label: string;
  provider: Provider;
  description: string;
  images: boolean;
  pdfs: boolean;
  reasoning: boolean;
}

const defaultChatModels: Omit<ChatModel, "id">[] = [
  {
    name: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "openrouter",
    description: "Fast, low-cost model",
    images: true,
    pdfs: true,
    reasoning: false,
  },
  {
    name: "anthropic/claude-sonnet-5.5",
    label: "Claude Sonnet 5.5",
    provider: "openrouter",
    description: "Strong all-round model",
    images: true,
    pdfs: true,
    reasoning: true,
  },
];

function parseChatModels(): ChatModel[] {
  const envModels = process.env.NEXT_PUBLIC_LLM_MODELS;

  if (envModels) {
    try {
      const parsed = JSON.parse(envModels) as Omit<ChatModel, "id">[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((model, index) => ({
          id: index,
          name: model.name,
          label: model.label,
          provider: model.provider,
          description: model.description,
          images: model.images ?? false,
          pdfs: model.pdfs ?? false,
          reasoning: model.reasoning ?? false,
        }));
      }
    } catch (e) {
      console.warn(
        "Failed to parse NEXT_PUBLIC_LLM_MODELS environment variable, using defaults",
      );
    }
  }

  return defaultChatModels.map((model, index) => ({ id: index, ...model }));
}

export const chatModels: ChatModel[] = parseChatModels();

export const titleModelIdx = parseInt(process.env.TITLE_MODEL_IDX ?? "0");
export const artifactModelIdx = parseInt(process.env.ARTIFACT_MODEL_IDX ?? "0");
export const searchModelIdx = parseInt(process.env.SEARCH_MODEL_IDX ?? "0");
export const completionModelIdx = parseInt(
  process.env.COMPLETION_MODEL_IDX ?? "0",
);
