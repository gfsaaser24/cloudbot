import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import * as z from "zod";
import { fetchForSaving } from "../folder-files.js";

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
      "Fetches a specific URL and returns its content as Markdown. For a single YouTube video this returns its transcript (when captions exist). For a whole channel or playlist use importYouTubeTranscripts. Use it when the user gives you a link to read, summarize or quote. To store the full content in a folder, call saveToFolder with the url instead of copying the content.",
    inputSchema: fetchWebContentInput,
    outputSchema: fetchWebContentOutput,
    execute: async ({ url }) => {
      try {
        // Same checks as saving: no channel pages, error pages or empty transcripts.
        const fetched = await fetchForSaving(url);
        if (!fetched.ok) {
          return { url, title: "", content: fetched.reason, truncated: false };
        }
        const truncated = fetched.markdown.length > MAX_CONTENT_CHARS;
        return {
          url,
          title: fetched.title,
          content: truncated
            ? fetched.markdown.slice(0, MAX_CONTENT_CHARS)
            : fetched.markdown,
          truncated,
        };
      } catch (error) {
        logger.error("Error in fetchWebContent tool", error);
        throw error;
      }
    },
  });
