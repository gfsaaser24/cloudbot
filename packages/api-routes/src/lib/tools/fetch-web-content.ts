import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import * as z from "zod";
import { scrapeToMarkdown } from "../firecrawl.js";

const logger = createLogger("fetch-web-content");

// Enough for long transcripts and articles without filling the context window.
const MAX_CONTENT_CHARS = 60_000;

export const fetchWebContentInput = z.object({
  url: z.url().describe("The page or YouTube video URL to fetch"),
});

export const fetchWebContentOutput = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const fetchWebContent = () =>
  tool({
    description:
      "Fetches a specific URL and returns its content as Markdown. For YouTube videos this returns the transcript (when captions exist). Use it when the user gives you a link to read, summarize or quote. To store the full content in a folder, call saveToFolder with the url instead of copying the content.",
    inputSchema: fetchWebContentInput,
    outputSchema: fetchWebContentOutput,
    execute: async ({ url }) => {
      try {
        const page = await scrapeToMarkdown(url);
        const truncated = page.markdown.length > MAX_CONTENT_CHARS;
        return {
          url: page.url,
          title: page.title,
          content: truncated
            ? page.markdown.slice(0, MAX_CONTENT_CHARS)
            : page.markdown,
          truncated,
        };
      } catch (error) {
        logger.error("Error in fetchWebContent tool", error);
        throw error;
      }
    },
  });
