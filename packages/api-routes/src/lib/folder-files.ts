// Writing Markdown into folders: shared by the saveToFolder tool and the
// YouTube transcript import workflow.

import { db } from "@workspace/server/drizzle/db.js";
import { type Folder, files } from "@workspace/server/drizzle/schema.js";
import { and, eq } from "drizzle-orm";
import { type Bindings } from "../types/bindings.js";
import { generateUUID } from "../utils/generate-uuid.js";
import { scrapeToMarkdown } from "./firecrawl.js";
import { folderObjectKey, listWritableFolders } from "./folder-access.js";
import {
  extractTranscript,
  looksLikeErrorPage,
  youTubeListPage,
  youTubeVideoId,
} from "./youtube.js";

// Same character rules as uploads (schemas/filename-schema.ts), 64 chars max.
export function toMarkdownFilename(name: string): string {
  const base = name
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[^a-zA-Z0-9_\- .]/g, "-")
    .replace(/-{2,}/g, "-")
    .trim()
    .slice(0, 56);
  return `${base || "saved"}.md`;
}

export type FolderLookup =
  | { folder: Folder }
  | { folder?: undefined; message: string; availableFolders: string[] };

// The folder to write into: by name or id, else the chat's project folder.
export async function resolveWritableFolder(
  userId: string,
  folderRef: string | undefined,
  defaultFolderId: string | undefined,
): Promise<FolderLookup> {
  const writable = await listWritableFolders(userId);
  const availableFolders = writable.map((f) => f.name);

  if (!folderRef && !defaultFolderId) {
    return {
      message:
        "No folder given and this chat has no project folder. Ask the user which folder to use.",
      availableFolders,
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
      message: folderRef
        ? `No folder named "${folderRef}" that you can save to. Ask the user which folder to use.`
        : "You can't save to this chat's project folder. Ask the user which folder to use.",
      availableFolders,
    };
  }
  return { folder };
}

export type FetchedForSaving =
  | { ok: true; title: string; markdown: string; isTranscript: boolean }
  | { ok: false; reason: string };

// Fetches a URL for saving and refuses anything that isn't real content:
// channel/playlist pages, YouTube error pages, videos without a transcript.
export async function fetchForSaving(url: string): Promise<FetchedForSaving> {
  if (youTubeListPage(url)) {
    return {
      ok: false,
      reason:
        "That's a YouTube channel or playlist, not a single video. Use importYouTubeTranscripts to save every video's transcript.",
    };
  }

  const page = await scrapeToMarkdown(url);
  if (looksLikeErrorPage(page.markdown)) {
    return {
      ok: false,
      reason: `The site returned an error page instead of content for ${url}. Nothing was saved.`,
    };
  }

  const videoId = youTubeVideoId(url);
  if (videoId) {
    const transcript = extractTranscript(page.markdown);
    if (!transcript) {
      return {
        ok: false,
        reason: `The video ${url} has no transcript (captions) available. Nothing was saved.`,
      };
    }
    const title = page.title.replace(/ - YouTube$/, "");
    return {
      ok: true,
      title,
      markdown: `# ${title}\n\nSource: https://www.youtube.com/watch?v=${videoId}\n\n## Transcript\n\n${transcript}`,
      isTranscript: true,
    };
  }

  if (page.markdown.trim().length < 100) {
    return {
      ok: false,
      reason: `${url} returned almost no content. Nothing was saved.`,
    };
  }
  return {
    ok: true,
    title: page.title,
    markdown: `# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`,
    isTranscript: false,
  };
}

// Writes a Markdown file into a folder (R2 object + files row, like an upload,
// so AI Search indexes it). "rename" adds -2, -3, ... when the name is taken;
// "skip" leaves an existing file alone and reports it.
export async function writeMarkdownFile({
  env,
  userId,
  folder,
  filename,
  body,
  ifExists,
}: {
  env: Pick<Bindings, "CLOUDBOT_BUCKET">;
  userId: string;
  folder: Folder;
  filename: string;
  body: string;
  ifExists: "rename" | "skip";
}): Promise<{ name: string; fileId?: string; skipped: boolean; bytes: number }> {
  const base = toMarkdownFilename(filename);
  let name = base;
  for (let n = 2; ; n++) {
    const existing = await db()
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.folderId, folder.id), eq(files.name, name)))
      .limit(1);
    if (existing.length === 0) break;
    if (ifExists === "skip") return { name, skipped: true, bytes: 0 };
    name = base.replace(/\.md$/, `-${n}.md`);
  }

  const bytes = new TextEncoder().encode(body);
  await env.CLOUDBOT_BUCKET.put(folderObjectKey(folder, userId, name), bytes, {
    httpMetadata: { contentType: "text/markdown" },
  });

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

  return { name, fileId, skipped: false, bytes: bytes.byteLength };
}
