import { OpenRouterCore } from "@openrouter/sdk/core.js";
import { modelsList } from "@openrouter/sdk/funcs/modelsList.js";
import { Model$inboundSchema, type Model } from "@openrouter/sdk/models/model.js";
import { ResponseValidationError } from "@openrouter/sdk/models/errors/responsevalidationerror.js";

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

const CACHE_TTL_MS = 60 * 60 * 1000;
// Every chat turn waits for the catalog, so a slow models endpoint must not
// hold it up for long.
const FETCH_TIMEOUT_MS = 5_000;
// The endpoint's own page size, and a bound in case it ever ignores offset
// (OpenRouter lists a few hundred models).
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

let cache: { models: CatalogModel[]; fetchedAt: number } | null = null;

function shortDescription(description = ""): string {
  const firstSentence = description.split(/(?<=\.)\s/)[0] ?? "";
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137)}...`
    : firstSentence;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// A page the SDK rejected, entry by entry. The SDK validates a page as a whole,
// so one model listed in a shape it doesn't expect would otherwise fail the
// whole catalog; this way only that model is left out. When no entry matches,
// the SDK no longer fits the endpoint, and the error stands so the stale
// catalog is served.
function validModels(error: unknown): { models: Model[]; listed: number } {
  const raw = error instanceof ResponseValidationError ? error.rawValue : undefined;
  const entries = isRecord(raw) && isRecord(raw.Result) ? raw.Result.data : undefined;
  if (!Array.isArray(entries)) throw error;
  const models = entries.flatMap((entry) => {
    const parsed = Model$inboundSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
  if (entries.length > 0 && models.length === 0) throw error;
  return { models, listed: entries.length };
}

// Every model in OpenRouter's catalog, through its typed client SDK. The
// models endpoint is public, so no API key is sent.
async function fetchModels(): Promise<Model[]> {
  const client = new OpenRouterCore({
    // Empty, so the SDK doesn't fall back to OPENROUTER_API_KEY.
    apiKey: "",
    timeoutMs: FETCH_TIMEOUT_MS,
    retryConfig: { strategy: "none" },
  });
  const models: Model[] = [];
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const page = await modelsList(client, { offset: pageIndex * PAGE_SIZE, limit: PAGE_SIZE });
    const { models: found, listed } = page.ok
      ? { models: page.value.result.data, listed: page.value.result.data.length }
      : validModels(page.error);
    models.push(...found);
    if (listed < PAGE_SIZE) break;
  }
  return models;
}

export async function getOpenRouterCatalog(): Promise<CatalogModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }

  let data: Model[];
  try {
    data = await fetchModels();
  } catch (error) {
    if (cache) {
      return cache.models; // Serve the stale list rather than failing.
    }
    throw error;
  }

  const models = data
    .filter(
      (m) =>
        m.supportedParameters.includes("tools") &&
        m.supportedParameters.includes("tool_choice"),
    )
    .map((m) => {
      const inputs: string[] = m.architecture.inputModalities;
      return {
        id: m.id,
        label: m.name,
        description: shortDescription(m.description),
        images: inputs.includes("image"),
        // The file-parser plugin (see providers.ts) lets every model read PDFs.
        pdfs: true,
        reasoning: m.supportedParameters.includes("reasoning"),
        contextLength: m.contextLength ?? 0,
        supportedParameters: m.supportedParameters,
        maxCompletionTokens: m.topProvider.maxCompletionTokens ?? null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  cache = { models, fetchedAt: Date.now() };
  return models;
}
