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
}

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

    case "workers-ai": {
      const { createWorkersAI } = await import("workers-ai-provider");

      const workersai = createWorkersAI({ binding: env.AI });

      return {
        model: workersai(chatModel.name),
        providerOptions: {},
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
  { reasoning, userId, webSearch }: ModelOptions,
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
      // Automatic prompt caching; only Anthropic models honor this.
      ...(modelId.startsWith("anthropic/")
        ? { cache_control: { type: "ephemeral" } }
        : {}),
      plugins: [
        // Lets every model read PDFs, not just ones with native file input.
        // "cloudflare-ai" converts with Workers AI at no cost ("pdf-text" is deprecated).
        { id: "file-parser", pdf: { engine: "cloudflare-ai" } },
        ...(webSearch ? [{ id: "web" as const, max_results: 8 }] : []),
      ],
      // Compress the middle of very long conversations instead of failing.
      extraBody: { transforms: ["middle-out"] },
    }),
    providerOptions: {},
  };
}
