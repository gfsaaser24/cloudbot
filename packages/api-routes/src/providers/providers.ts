import { type JSONValue, type LanguageModel } from "ai";
import { HTTPException } from "hono/http-exception";
import { Bindings } from "../types/bindings.js";
import { chatModels } from "./models.js";

export interface Config {
  model: LanguageModel;
  providerOptions: { [model: string]: Record<string, JSONValue> };
}

export const getModel = async (
  env: Bindings,
  modelIdx: number,
  reasoningEnabled?: boolean,
): Promise<Config> => {
  const chatModel = chatModels[modelIdx];

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
      const { openrouter } = await import("@openrouter/ai-sdk-provider");

      return {
        model: openrouter(chatModel.name),
        providerOptions: {
          openrouter: {
            ...(reasoningEnabled
              ? { reasoning: { enabled: true, max_tokens: 1024 } }
              : {}),
          },
        },
      };
    }

    default:
      throw new HTTPException(400, { message: "INVALID_MODEL" });
  }
};
