import { db } from "@workspace/server/drizzle/db.js";
import { files } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import { generateText, Output, tool } from "ai";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import { getExtractionModel } from "../../providers/providers.js";
import { type Bindings } from "../../types/bindings.js";
import { type FileMetadata } from "../../utils/filter-authorized-files.js";
import { type FolderMetadata } from "../../utils/filter-authorized-folders.js";
import { callCost, type ToolSpend } from "../chat/stop-conditions.js";
import { readSelectedFileText } from "./read-file.js";

// Answers questions across many documents ("how many guests charged from day
// one?") by extracting the same fields from every file with a cheap model,
// eight files at a time, and handing back one table the chat model can count
// and quote from.

const logger = createLogger("analyze-folder");

const MAX_FILES = 100;
const CONCURRENCY = 8;
// The extraction model reads at most this much of each file.
const MAX_FILE_CHARS = 400_000;
// Each extracted value, so a run of 100 files stays readable in the history.
const MAX_VALUE_CHARS = 1_500;

export const analyzeFolderInput = z.object({
  fields: z
    .array(
      z.object({
        name: z.string().describe("Short column name, e.g. pricing_model"),
        description: z
          .string()
          .describe("What to extract for this column, e.g. 'How the guest priced their first offer'"),
      }),
    )
    .min(1)
    .max(20),
  filenames: z
    .array(z.string())
    .optional()
    .describe("Only these files, exactly as listed; all selected files by default."),
});

const row = z.object({
  filename: z.string(),
  folderId: z.string(),
  values: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
});

export const analyzeFolderOutput = z.object({
  status: z.enum(["running", "done"]),
  completed: z.number(),
  total: z.number(),
  rows: z.array(row),
  // Files beyond the per-run limit, which weren't read.
  skipped: z.number(),
  message: z.string().optional(),
});

type Output = z.infer<typeof analyzeFolderOutput>;
type Row = z.infer<typeof row>;
type ScopedFile = { name: string; visibility: string; folderId: string };

type Props = {
  env: Bindings;
  userId: string;
  // The files and folders the chat may read (already permission-checked).
  fileMetadata: FileMetadata[];
  folderMetadata: FolderMetadata[];
  // Where the extraction calls' cost is added for the turn's cost ceiling.
  toolSpend: ToolSpend;
};

// The files to analyze, in name order, and how many in scope were left out.
async function filesInScope(
  { fileMetadata, folderMetadata }: Pick<Props, "fileMetadata" | "folderMetadata">,
  filenames: string[] | undefined,
): Promise<{ files: ScopedFile[]; skipped: number }> {
  const wanted = (name: string) => !filenames || filenames.includes(name);

  if (fileMetadata.length > 0) {
    const selected = fileMetadata
      .filter((f) => wanted(f.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      files: selected.slice(0, MAX_FILES),
      skipped: Math.max(selected.length - MAX_FILES, 0),
    };
  }

  const where = and(
    inArray(
      files.folderId,
      folderMetadata.map((f) => f.id),
    ),
    eq(files.uploadConfirmed, true),
    ...(filenames ? [inArray(files.name, filenames)] : []),
  );
  const [rows, [total]] = await Promise.all([
    db()
      .select({ name: files.name, visibility: files.visibility, folderId: files.folderId })
      .from(files)
      .where(where)
      .orderBy(asc(files.name))
      .limit(MAX_FILES),
    db().select({ total: count() }).from(files).where(where),
  ]);
  return { files: rows, skipped: Math.max((total?.total ?? rows.length) - rows.length, 0) };
}

function fieldSchema(fields: z.infer<typeof analyzeFolderInput>["fields"]) {
  return z.object(
    Object.fromEntries(
      fields.map((field) => [
        field.name,
        z
          .string()
          .describe(`${field.description}. Quote the file where you can; write "not mentioned" if the file doesn't say.`),
      ]),
    ),
  );
}

export const analyzeFolder = ({ env, userId, fileMetadata, folderMetadata, toolSpend }: Props) =>
  tool({
    description:
      "Extracts the same fields from every selected file (up to 100) and returns one row per file, so you can count, compare and quote across many documents, e.g. which guests mentioned pricing and how. Use it for questions about all or many files; use readFile or extractFromDocuments for one or a few. Name each field and describe what to extract.",
    inputSchema: analyzeFolderInput,
    outputSchema: analyzeFolderOutput,
    async *execute({ fields, filenames }): AsyncGenerator<Output> {
      // Always offered so the tool list never changes between turns.
      if (fileMetadata.length === 0 && folderMetadata.length === 0) {
        yield {
          status: "done",
          completed: 0,
          total: 0,
          rows: [],
          skipped: 0,
          message:
            "No folder or file is selected for this message, so there is nothing to analyze. Ask the user to select a folder or file.",
        };
        return;
      }

      const scope = await filesInScope({ fileMetadata, folderMetadata }, filenames);
      const total = scope.files.length;
      const schema = fieldSchema(fields);
      const model = await getExtractionModel(userId);
      const rows: Row[] = [];

      const extract = async (file: ScopedFile): Promise<Row> => {
        const base = { filename: file.name, folderId: file.folderId };
        try {
          const read = await readSelectedFileText(env, userId, file);
          if (!read.ok) return { ...base, error: read.message };

          const result = await generateText({
            model,
            output: Output.object({ schema }),
            instructions:
              "Extract the requested fields from the document. Use only what the document says.",
            prompt: `Document "${file.name}":\n\n${read.text.slice(0, MAX_FILE_CHARS)}`,
          });
          toolSpend.usd += callCost(result.providerMetadata);

          const values = Object.fromEntries(
            Object.entries(result.output).map(([name, value]) => [
              name,
              String(value).slice(0, MAX_VALUE_CHARS),
            ]),
          );
          return { ...base, values };
        } catch (error) {
          logger.warn("Could not analyze file", {
            filename: file.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return { ...base, error: "This file could not be analyzed." };
        }
      };

      // Eight at a time; each finished file is reported as it completes.
      const queue = [...scope.files];
      const finished: Row[] = [];
      let notify: (() => void) | undefined;
      const worker = async () => {
        for (let file = queue.shift(); file; file = queue.shift()) {
          finished.push(await extract(file));
          notify?.();
        }
      };
      const workers = Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

      while (rows.length < total) {
        if (finished.length === 0) {
          await new Promise<void>((resolve) => (notify = resolve));
          notify = undefined;
          continue;
        }
        for (const done of finished.splice(0)) {
          rows.push(done);
          if (rows.length < total) {
            yield { status: "running", completed: rows.length, total, rows: [], skipped: scope.skipped };
          }
        }
      }
      await workers;

      rows.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
      const failed = rows.filter((r) => r.error).length;
      yield {
        status: "done",
        completed: rows.length,
        total,
        rows,
        skipped: scope.skipped,
        message: [
          `Analyzed ${rows.length - failed} of ${total} files${failed ? `; ${failed} could not be read` : ""}.`,
          scope.skipped
            ? `${scope.skipped} more files were not analyzed: a run covers at most ${MAX_FILES}. Name the remaining files to analyze them.`
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      };
    },
  });
