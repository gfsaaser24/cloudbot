import { db } from "@workspace/server/drizzle/db.js";
import { files } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import { and, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import { type Bindings } from "../../types/bindings.js";
import { fileKey } from "../../utils/build-metadata-filter.js";
import { type FileMetadata } from "../../utils/filter-authorized-files.js";
import { type FolderMetadata } from "../../utils/filter-authorized-folders.js";
import { fileTypeOf } from "../file-types.js";

const logger = createLogger("read-file");

// About 50K tokens: a long transcript fits whole, a book does not.
const MAX_FILE_CHARS = 200_000;

export const readFileInput = z.object({
  filename: z.string().describe("The file's name, exactly as listed"),
  folderId: z
    .string()
    .optional()
    .describe(
      "The file's folder id, when files in several folders share the name",
    ),
});

export const readFileOutput = z.object({
  found: z.boolean(),
  filename: z.string(),
  folderId: z.string().optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  message: z.string().optional(),
});

type Props = {
  env: Bindings;
  userId: string;
  // The files and folders the chat may read (already permission-checked).
  fileMetadata: FileMetadata[];
  folderMetadata: FolderMetadata[];
};

// The named file, if it's in the selected files or folders. Selected files limit
// the lookup to those files; otherwise any file in the selected folders.
export async function findSelectedFile(
  filename: string,
  folderId: string | undefined,
  {
    fileMetadata,
    folderMetadata,
  }: { fileMetadata: FileMetadata[]; folderMetadata: FolderMetadata[] },
) {
  const scope = fileMetadata.length
    ? fileMetadata.map((f) => f.folderId)
    : folderMetadata.map((f) => f.id);
  const folderIds = folderId
    ? scope.filter((id) => id === folderId)
    : [...new Set(scope)];

  const candidates = folderIds.length
    ? await db()
        .select({
          name: files.name,
          visibility: files.visibility,
          folderId: files.folderId,
        })
        .from(files)
        .where(
          and(
            eq(files.name, filename),
            eq(files.uploadConfirmed, true),
            inArray(files.folderId, folderIds),
          ),
        )
    : [];

  return candidates.find(
    (c) =>
      !fileMetadata.length ||
      fileMetadata.some((f) => f.name === c.name && f.folderId === c.folderId),
  );
}

// A selected file's full text: as stored for text files, converted to Markdown
// for documents and PDFs.
export async function readSelectedFileText(
  env: Bindings,
  userId: string,
  file: Pick<FileMetadata, "name" | "visibility" | "folderId">,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const type = fileTypeOf(file.name);
  if (!type || type.kind === "image") {
    return { ok: false, message: "This file isn't text, so it can't be read." };
  }

  const object = await env.CLOUDBOT_BUCKET.get(fileKey(userId, file));
  if (!object) {
    return {
      ok: false,
      message: "The file is listed but its contents are missing.",
    };
  }

  if (type.kind === "text") {
    return { ok: true, text: await object.text() };
  }

  const result = await env.AI.toMarkdown({
    name: file.name,
    blob: await object.blob(),
  });
  if (result.format === "error") {
    logger.warn("Could not convert file to Markdown", {
      filename: file.name,
      error: result.error,
    });
    return { ok: false, message: "This file could not be read." };
  }
  return { ok: true, text: result.data };
}

export const readFile = ({
  env,
  userId,
  fileMetadata,
  folderMetadata,
}: Props) =>
  tool({
    description:
      "Reads one whole file from the selected folders or files and returns its full text (Markdown for documents and PDFs). Use it when a question needs complete documents rather than matching passages, for example to compare or summarise transcripts; call it once per file, several at a time if needed. Cite the file as [[doc:folderId/filename]].",
    inputSchema: readFileInput,
    outputSchema: readFileOutput,
    execute: async ({ filename, folderId }) => {
      // Always offered so the tool list never changes between turns.
      if (fileMetadata.length === 0 && folderMetadata.length === 0) {
        return {
          found: false,
          filename,
          message:
            "No folder or file is selected for this message, so there is nothing to read. Ask the user to select a folder or file.",
        };
      }

      const file = await findSelectedFile(filename, folderId, {
        fileMetadata,
        folderMetadata,
      });

      if (!file) {
        return {
          found: false,
          filename,
          message: "No file with that name in the selected folders or files.",
        };
      }

      try {
        const read = await readSelectedFileText(env, userId, file);
        if (!read.ok) {
          return {
            found: false,
            filename,
            folderId: file.folderId,
            message: read.message,
          };
        }

        return {
          found: true,
          filename,
          folderId: file.folderId,
          text: read.text.slice(0, MAX_FILE_CHARS),
          truncated: read.text.length > MAX_FILE_CHARS,
        };
      } catch (error) {
        logger.error("Error in readFile tool", error);
        throw error;
      }
    },
  });
