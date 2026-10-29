import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import * as z from "zod";
import { type Bindings } from "../../types/bindings.js";
import { isFirecrawlConfigured } from "../firecrawl.js";
import {
  fetchForSaving,
  resolveWritableFolder,
  writeMarkdownFile,
} from "../folder-files.js";

const logger = createLogger("save-to-folder");

export const saveToFolderInput = z.object({
  folder: z
    .string()
    .optional()
    .describe(
      "The folder's name (or id) to save into. Leave it out to save into the chat's project folder.",
    ),
  filename: z
    .string()
    .describe("A short descriptive name; it is saved as a .md file"),
  url: z
    .url()
    .optional()
    .describe(
      "Fetch this page or single YouTube video and save its full content (the transcript for videos). Not for channels or playlists: use importYouTubeTranscripts for those. Prefer this over content for anything from the web.",
    ),
  content: z
    .string()
    .optional()
    .describe("Markdown to save, e.g. notes or a summary you wrote"),
});

export const saveToFolderOutput = z.object({
  saved: z.boolean(),
  message: z.string(),
  fileId: z.string().optional(),
  folder: z.string().optional(),
  filename: z.string().optional(),
  characters: z.number().optional(), // Size of what was saved, so the model can't overstate it
  availableFolders: z.array(z.string()).optional(),
});

type SaveToFolderProps = {
  env: Bindings;
  userId: string;
  defaultFolderId?: string; // The chat's project folder, used when no folder is given
};

export const saveToFolder = ({
  env,
  userId,
  defaultFolderId,
}: SaveToFolderProps) =>
  tool({
    description:
      "Saves Markdown into one of the user's folders so it can be searched later. Use it when the user asks to save, store or keep something (a single YouTube video's transcript, an article, notes). Pass url to fetch and save a page or video in full; pass content to save text you wrote. Leave out folder to save into the chat's project folder. Only tell the user something was saved if this returns saved: true, and report what it says.",
    inputSchema: saveToFolderInput,
    outputSchema: saveToFolderOutput,
    execute: async ({ folder: folderRef, filename, url, content }) => {
      try {
        const lookup = await resolveWritableFolder(
          userId,
          folderRef,
          defaultFolderId,
        );
        if (!lookup.folder) {
          return {
            saved: false,
            message: lookup.message,
            availableFolders: lookup.availableFolders,
          };
        }
        const { folder } = lookup;

        let markdown: string;
        if (url) {
          if (!isFirecrawlConfigured()) {
            return {
              saved: false,
              message: "Fetching web pages isn't configured on this server.",
            };
          }
          const fetched = await fetchForSaving(url);
          if (!fetched.ok) {
            return { saved: false, message: fetched.reason };
          }
          markdown = fetched.markdown;
        } else if (content) {
          markdown = content;
        } else {
          return {
            saved: false,
            message: "Provide either a url or content to save.",
          };
        }

        const file = await writeMarkdownFile({
          env,
          userId,
          folder,
          filename,
          body: markdown,
          ifExists: "rename",
        });

        return {
          saved: true,
          message: `Saved "${file.name}" (${markdown.length.toLocaleString("en")} characters) to the "${folder.name}" folder. It becomes searchable within about 15 minutes.`,
          fileId: file.fileId,
          folder: folder.name,
          filename: file.name,
          characters: markdown.length,
        };
      } catch (error) {
        logger.error("Error in saveToFolder tool", error);
        throw error;
      }
    },
  });
