import * as z from "zod";

import { createLogger } from "@workspace/server/logger/logger.js";
import { generateText, tool, type UIMessageStreamWriter } from "ai";
import { searchModelIdx } from "../../providers/models.js";
import { webSearchPrompt } from "../../providers/prompts.js";
import { getModel } from "../../providers/providers.js";
import { type Bindings } from "../../types/bindings.js";
import { type CustomUIMessage } from "../../types/custom-ui-message.js";
import { type UserLocation } from "../../types/user-location.js";

type ExtractFromWebProps = {
  env: Bindings;
  userLocation: UserLocation;
  dataStream: UIMessageStreamWriter<CustomUIMessage>;
};

export type WebSource = {
  id: string;
  url: string;
  title: string;
};

type SearchProvider = "vercel-ai-perplexity" | "vercel-ai-parallel" | "tavily";

const logger = createLogger("extract-from-web");

// Tavily REST API instead of @tavily/ai-sdk, which bundles a ~5 MB tokenizer.
async function tavilyRequest(path: "search" | "extract", body: object) {
  const response = await fetch(`https://api.tavily.com/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Tavily ${path} failed: ${response.status}`);
  }

  return response.json();
}

const tavilyTools = () => ({
  webSearch: tool({
    description: "Search the web and return relevant results.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) =>
      tavilyRequest("search", { query, max_results: 8 }),
  }),
  webExtract: tool({
    description: "Extract the content of one or more web pages.",
    inputSchema: z.object({ urls: z.array(z.string()) }),
    execute: async ({ urls }) => tavilyRequest("extract", { urls }),
  }),
});

export const extractFromWeb = ({ env, userLocation }: ExtractFromWebProps) =>
  tool({
    description:
      "Searches the web for current information. Use this tool when you need to find up-to-date information, news, or facts that may not be in your training data.",
    inputSchema: z.object({
      informationToExtract: z
        .string()
        .describe("The information to extract from the web"),
    }),
    outputSchema: z.object({
      extractedInformation: z.string(),
    }),
    execute: async ({ informationToExtract }) => {
      try {
        const provider = process.env.SEARCH_PROVIDER as SearchProvider;

        let tools;

        switch (provider) {
          case "vercel-ai-perplexity": {
            const { gateway } = await import("ai");

            tools = {
              perplexity_search: gateway.tools.perplexitySearch({
                maxResults: 8,
                maxTokens: 50000,
                maxTokensPerPage: 2048,
                country: userLocation.country,
              }),
            };

            break;
          }

          case "vercel-ai-parallel": {
            const { gateway } = await import("ai");

            tools = {
              parallel_search: gateway.tools.parallelSearch({
                mode: "one-shot",
                maxResults: 8,
              }),
            };

            break;
          }

          case "tavily": {
            tools = tavilyTools();

            break;
          }
        }

        const config = await getModel(env, searchModelIdx);
        const result = await generateText({
          system: webSearchPrompt,
          prompt:
            "Extract the following information from the web: " +
            informationToExtract,
          model: config.model,
          tools: tools as any,
        });

        const sources =
          result.sources
            ?.filter((s) => s.sourceType === "url")
            .map((s) => ({
              id: s.id,
              url: s.url,
              title: s.title,
            })) ?? [];

        return { extractedInformation: result.text, sources };
      } catch (error) {
        logger.error("Error in extractFromWeb tool", error);
        throw error;
      }
    },
  });
