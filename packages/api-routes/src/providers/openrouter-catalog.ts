// The chat model menu lists every OpenRouter model that supports tool calling
// (the chat always sends tools, and the AI SDK sends tool_choice with them).
// The list comes from OpenRouter's public models endpoint and is cached per
// Worker isolate for an hour. The chat also reads each model's supported
// parameters from it, to send only settings the model accepts.

export interface CatalogModel {
  id: string; // OpenRouter model id, e.g. "anthropic/claude-sonnet-5.5"
  label: string;
  description: string;
  images: boolean;
  pdfs: boolean;
  reasoning: boolean;
  contextLength: number;
  supportedParameters: string[];
  maxCompletionTokens: number | null;
}

type OpenRouterModel = {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
};

const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { models: CatalogModel[]; fetchedAt: number } | null = null;

function shortDescription(description = ""): string {
  const firstSentence = description.split(/(?<=\.)\s/)[0] ?? "";
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137)}...`
    : firstSentence;
}

export async function getOpenRouterCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    if (cache) {
      return cache.models; // Serve the stale list rather than failing.
    }
    throw new Error(`OpenRouter models request failed: ${response.status}`);
  }

  const { data } = (await response.json()) as { data: OpenRouterModel[] };

  const models = data
    .filter(
      (m) =>
        m.supported_parameters?.includes("tools") &&
        m.supported_parameters.includes("tool_choice"),
    )
    .map((m) => {
      const inputs = m.architecture?.input_modalities ?? [];
      return {
        id: m.id,
        label: m.name,
        description: shortDescription(m.description),
        images: inputs.includes("image"),
        // The file-parser plugin (see providers.ts) lets every model read PDFs.
        pdfs: true,
        reasoning: m.supported_parameters?.includes("reasoning") ?? false,
        contextLength: m.context_length ?? 0,
        supportedParameters: m.supported_parameters ?? [],
        maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  cache = { models, fetchedAt: Date.now() };
  return models;
}
