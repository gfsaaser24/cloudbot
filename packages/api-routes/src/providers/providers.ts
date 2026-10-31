import { type JSONValue, type LanguageModel } from "ai";
import { HTTPException } from "hono/http-exception";
import { Bindings } from "../types/bindings.js";
import { chatModels } from "./models.js";
import { type CatalogModel, getOpenRouterCatalog } from "./openrouter-catalog.js";

export interface Config {
  model: LanguageModel;
  providerOptions: { [model: string]: Record<string, JSONValue> };
}

export interface ModelOptions {
  reasoning?: boolean;
  // Lets OpenRouter attribute usage to the CloudChat user.
  userId?: string;
  // Use OpenRouter's web search plugin (results come back as URL sources).
  webSearch?: boolean;
  // The chat id: keeps a chat's requests on the same provider, where its prompt
  // is already cached.
  sessionId?: string;
}

// Anthropic models, including aliases such as "~anthropic/claude-sonnet-latest".
export function isAnthropicModel(modelId: string): boolean {
  return /^~?anthropic\//.test(modelId);
}

// Room for a long answer even after reasoning, capped by the model's maximum.
const ANSWER_MAX_TOKENS = 32_000;

// `model` is either an index into the configured models (used for titles,
// artifacts, search and completion) or an OpenRouter model id picked in the
// chat model menu.
export const getModel = async (
  env: Bindings,
  model: number | string,
  options: ModelOptions = {},
): Promise<Config> => {
  if (typeof model === "string") {
    const settings = answerSettings(
      await catalogEntry(model),
      options.reasoning ?? false,
    );
    return openRouterModel(model, options, settings);
  }

  const chatModel = chatModels[model];

  if (!chatModel) {
    throw new HTTPException(400, { message: "INVALID_MODEL" });
  }

  switch (chatModel.provider) {
    case "vercel-ai-gateway": {
      const { gateway } = await import("ai");

      return {
        model: gateway(chatModel.name),
        providerOptions: {
          gateway: {
            zeroDataRetention: true,
          },
        },
      };
    }

    case "openrouter": {
      return openRouterModel(chatModel.name, options);
    }

    default:
      throw new HTTPException(400, { message: "INVALID_MODEL" });
  }
};

// A chat model's catalog entry, or undefined when the catalog has none or
// can't be loaded; the chat then sends no capability-dependent settings.
async function catalogEntry(
  modelId: string,
): Promise<CatalogModel | undefined> {
  try {
    const models = await getOpenRouterCatalog();
    return models.find((m) => m.id === modelId);
  } catch {
    return undefined;
  }
}

// Settings for a chat answer, sent only when the model supports them, so
// require_parameters never rules out every provider.
function answerSettings(model: CatalogModel | undefined, reasoning: boolean) {
  // Route only to providers that accept every parameter the request sends.
  const provider = { require_parameters: true };
  if (!model) return { provider };

  const supports = (parameter: string) =>
    model.supportedParameters.includes(parameter);

  return {
    provider,
    ...(supports("verbosity") ? { extraBody: { verbosity: "high" } } : {}),
    ...(reasoning && model.reasoning
      ? { reasoning: { effort: "high" as const } }
      : {}),
    ...(supports("max_tokens")
      ? {
          maxTokens: Math.min(
            ANSWER_MAX_TOKENS,
            model.maxCompletionTokens ?? ANSWER_MAX_TOKENS,
          ),
        }
      : {}),
  };
}

async function openRouterModel(
  modelId: string,
  { userId, webSearch, sessionId }: ModelOptions,
  // Only for a chat answer; titles, search and artifacts keep the defaults.
  answer: Partial<ReturnType<typeof answerSettings>> = {},
): Promise<Config> {
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");

  const openrouter = createOpenRouter({
    compatibility: "strict",
    // App attribution on the openrouter.ai dashboard.
    appName: "CloudChat",
    appUrl: process.env.BETTER_AUTH_URL,
  });

  return {
    model: openrouter.chat(modelId, {
      // Token counts and cost for every response.
      usage: { include: true },
      user: userId,
      ...answer,
      // Anthropic needs caching turned on; one hour so a follow-up after a break
      // still hits it. The other providers cache automatically, and on Gemini
      // cache_control would switch on paid explicit caching.
      ...(isAnthropicModel(modelId)
        ? { cache_control: { type: "ephemeral", ttl: "1h" } }
        : {}),
      plugins: [
        // Lets every model read PDFs, not just ones with native file input.
        // "cloudflare-ai" converts with Workers AI at no cost ("pdf-text" is deprecated).
        { id: "file-parser", pdf: { engine: "cloudflare-ai" } },
        ...(webSearch ? [{ id: "web" as const, max_results: 8 }] : []),
      ],
    }),
    providerOptions: sessionId ? { openrouter: { session_id: sessionId } } : {},
  };
}
