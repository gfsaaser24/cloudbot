import { db } from "@workspace/server/drizzle/db.js";
import { files, folders } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { type Bindings } from "../../types/bindings.js";
import { generateUUID } from "../../utils/generate-uuid.js";
import { isFirecrawlConfigured, scrapeToMarkdown } from "../firecrawl.js";
import { canWriteToFolder, folderObjectKey } from "../folder-access.js";

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
      "Fetch this page or YouTube video and save its full content (transcript for videos). Prefer this over content for anything from the web.",
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
  availableFolders: z.array(z.string()).optional(),
});

type SaveToFolderProps = {
  env: Bindings;
  userId: string;
  defaultFolderId?: string; // The chat's project folder, used when no folder is given
};

// Same character rules as uploads (schemas/filename-schema.ts), 64 chars max.
function toMarkdownFilename(name: string): string {
  const base = name
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[^a-zA-Z0-9_\- .]/g, "-")
    .replace(/-{2,}/g, "-")
    .trim()
    .slice(0, 56);
  return `${base || "saved"}.md`;
}

async function writableFolders(userId: string) {
  const all = await db().select().from(folders);
  const writable = [];
  for (const folder of all) {
    if (await canWriteToFolder(folder, userId)) writable.push(folder);
  }
  return writable;
}

export const saveToFolder = ({
  env,
  userId,
  defaultFolderId,
}: SaveToFolderProps) =>
  tool({
    description:
      "Saves Markdown into one of the user's folders so it can be searched later. Use it when the user asks to save, store or keep something (a YouTube transcript, an article, notes). Pass url to fetch and save a page or video in full; pass content to save text you wrote. Leave out folder to save into the chat's project folder.",
    inputSchema: saveToFolderInput,
    outputSchema: saveToFolderOutput,
    execute: async ({ folder: folderRef, filename, url, content }) => {
      try {
        const writable = await writableFolders(userId);

        if (!folderRef && !defaultFolderId) {
          return {
            saved: false,
            message:
              "No folder given and this chat has no project folder. Ask the user which folder to use.",
            availableFolders: writable.map((f) => f.name),
          };
        }

        const folder = folderRef
          ? writable.find(
              (f) =>
                f.id === folderRef ||
                f.name.toLowerCase() === folderRef.trim().toLowerCase(),
            )
          : writable.find((f) => f.id === defaultFolderId);

        if (!folder) {
          return {
            saved: false,
            message: folderRef
              ? `No folder named "${folderRef}" that you can save to. Ask the user which folder to use.`
              : "You can't save to this chat's project folder. Ask the user which folder to use.",
            availableFolders: writable.map((f) => f.name),
          };
        }

        let body: string;
        if (url) {
          if (!isFirecrawlConfigured()) {
            return {
              saved: false,
              message: "Fetching web pages isn't configured on this server.",
            };
          }
          const page = await scrapeToMarkdown(url);
          body = `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`;
        } else if (content) {
          body = content;
        } else {
          return {
            saved: false,
            message: "Provide either a url or content to save.",
          };
        }

        // Filenames are unique per folder: add -2, -3, ... when taken.
        const base = toMarkdownFilename(filename);
        let name = base;
        for (let n = 2; ; n++) {
          const existing = await db()
            .select({ id: files.id })
            .from(files)
            .where(and(eq(files.folderId, folder.id), eq(files.name, name)))
            .limit(1);
          if (existing.length === 0) break;
          name = base.replace(/\.md$/, `-${n}.md`);
        }

        const bytes = new TextEncoder().encode(body);
        await env.CLOUDBOT_BUCKET.put(
          folderObjectKey(folder, userId, name),
          bytes,
          { httpMetadata: { contentType: "text/markdown" } },
        );

        const fileId = generateUUID();
        await db().insert(files).values({
          id: fileId,
          folderId: folder.id,
          name,
          owner: userId,
          size: bytes.byteLength,
          format: "text/markdown",
          visibility: folder.visibility,
          uploadConfirmed: true,
        });

        return {
          saved: true,
          message: `Saved "${name}" to the "${folder.name}" folder. It becomes searchable within about 15 minutes.`,
          fileId,
          folder: folder.name,
          filename: name,
        };
      } catch (error) {
        logger.error("Error in saveToFolder tool", error);
        throw error;
      }
    },
  });
