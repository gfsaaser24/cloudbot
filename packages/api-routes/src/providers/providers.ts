import { type JSONValue, type LanguageModel } from "ai";
import { HTTPException } from "hono/http-exception";
import { Bindings } from "../types/bindings.js";
import { chatModels } from "./models.js";

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
const ANTHROPIC_MODEL = /^~?anthropic\//;

// `model` is either an index into the configured models (used for titles,
// artifacts, search and completion) or an OpenRouter model id picked in the
// chat model menu.
export const getModel = async (
  env: Bindings,
  model: number | string,
  options: ModelOptions = {},
): Promise<Config> => {
  if (typeof model === "string") {
    return openRouterModel(model, options);
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

async function openRouterModel(
  modelId: string,
  { reasoning, userId, webSearch, sessionId }: ModelOptions,
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
      ...(reasoning ? { reasoning: { effort: "medium" } } : {}),
      // Anthropic needs caching turned on; one hour so a follow-up after a break
      // still hits it. The other providers cache automatically, and on Gemini
      // cache_control would switch on paid explicit caching.
      ...(ANTHROPIC_MODEL.test(modelId)
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
