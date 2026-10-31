import { db } from "@workspace/server/drizzle/db.js";
import { files } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import { generateText, Output, tool } from "ai";
import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import * as z from "zod";
import { getExtractionModel } from "../../providers/providers.js";
import { type Bindings } from "../../types/bindings.js";
import { type FileMetadata } from "../../utils/filter-authorized-files.js";
import { type FolderMetadata } from "../../utils/filter-authorized-folders.js";
import { callCost, isOverBudget, type TurnSpend } from "../chat/stop-conditions.js";
import { readSelectedFileText } from "./read-file.js";

// Answers questions across many documents ("how many guests charged from day
// one?") by extracting the same fields from every file with a cheap model,
// several files at a time, and handing back one table the chat model can count
// and quote from.

const logger = createLogger("analyze-folder");

const MAX_FILES = 100;
// Each name is one query parameter, and D1 allows at most 100 per query.
const MAX_FILENAMES = 90;
const EXTRACTION_TIMEOUT_MS = 90_000;
const COST_LIMIT_MESSAGE =
  "Not analyzed: this turn reached its cost limit. Ask again to continue.";
const CONCURRENCY = 8;
// The extraction model reads at most this much of each file.
const MAX_FILE_CHARS = 400_000;
// The table stays in the history for good, so it is capped as a whole: each
// value gets an equal share, at most MAX_VALUE_CHARS.
const MAX_VALUE_CHARS = 1_500;
const TABLE_CHARS = 100_000;
// Each row's filename, folder id and JSON keys.
const ROW_OVERHEAD_CHARS = 200;

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
    .max(MAX_FILENAMES)
    .optional()
    .describe("Only these files, exactly as listed; all selected files by default."),
  startAfter: z
    .string()
    .optional()
    .describe("Continue with the files after this name, as given by a previous run's nextStartAfter."),
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
  // Where the next run continues, when files were left out.
  nextStartAfter: z.string().optional(),
  message: z.string().optional(),
});

type AnalyzeFolderOutput = z.infer<typeof analyzeFolderOutput>;
type Row = z.infer<typeof row>;
type ScopedFile = { name: string; visibility: string; folderId: string };

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Props = {
  env: Bindings;
  userId: string;
  // The files and folders the chat may read (already permission-checked).
  fileMetadata: FileMetadata[];
  folderMetadata: FolderMetadata[];
  // The turn's spend: extraction costs are added, and no new file starts once
  // the turn reaches its cost ceiling.
  spend: TurnSpend;
};

// The files to analyze, in name order, and how many in scope were left out.
async function filesInScope(
  { fileMetadata, folderMetadata }: Pick<Props, "fileMetadata" | "folderMetadata">,
  filenames: string[] | undefined,
  startAfter: string | undefined,
): Promise<{ files: ScopedFile[]; skipped: number }> {
  const wanted = (name: string) =>
    (!filenames || filenames.includes(name)) &&
    (startAfter === undefined || name > startAfter);

  if (fileMetadata.length > 0) {
    const selected = fileMetadata
      .filter((f) => wanted(f.name))
      .sort((a, b) => byName(a.name, b.name));
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
    ...(startAfter !== undefined ? [gt(files.name, startAfter)] : []),
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

export const analyzeFolder = ({ env, userId, fileMetadata, folderMetadata, spend }: Props) =>
  tool({
    description:
      "Extracts the same fields from every selected file (up to 100) and returns one row per file, so you can count, compare and quote across many documents, e.g. which guests mentioned pricing and how. Use it for questions about all or many files; use readFile or extractFromDocuments for one or a few. Name each field and describe what to extract.",
    inputSchema: analyzeFolderInput,
    outputSchema: analyzeFolderOutput,
    async *execute({ fields, filenames, startAfter }): AsyncGenerator<AnalyzeFolderOutput> {
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

      const scope = await filesInScope({ fileMetadata, folderMetadata }, filenames, startAfter);
      const total = scope.files.length;
      if (total === 0) {
        yield {
          status: "done",
          completed: 0,
          total: 0,
          rows: [],
          skipped: 0,
          message: "None of the selected files match, so there is nothing to analyze.",
        };
        return;
      }

      const schema = fieldSchema(fields);
      const model = await getExtractionModel(userId);
      const valueChars = Math.min(
        MAX_VALUE_CHARS,
        Math.floor(
          (TABLE_CHARS - total * ROW_OVERHEAD_CHARS) / (fields.length * total),
        ),
      );

      const extract = async (file: ScopedFile): Promise<Row> => {
        const base = { filename: file.name, folderId: file.folderId };
        if (isOverBudget(spend)) return { ...base, error: COST_LIMIT_MESSAGE };
        try {
          const read = await readSelectedFileText(env, userId, file);
          if (!read.ok) return { ...base, error: read.message };

          const result = await generateText({
            model,
            output: Output.object({ schema }),
            instructions:
              "Extract the requested fields from the document. Use only what the document says.",
            prompt: `Document "${file.name}":\n\n${read.text.slice(0, MAX_FILE_CHARS)}`,
            abortSignal: AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
          });
          spend.tools += callCost(result.providerMetadata);

          const values = Object.fromEntries(
            Object.entries(result.output).map(([name, value]) => [
              name,
              String(value).slice(0, valueChars),
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

      // CONCURRENCY files at a time; each finished file is reported as it
      // completes.
      const rows: Row[] = [];
      const running = new Map<number, Promise<[number, Row]>>();
      let next = 0;
      const startNext = () => {
        const index = next++;
        running.set(index, extract(scope.files[index]!).then((done) => [index, done]));
      };
      while (next < Math.min(CONCURRENCY, total)) startNext();

      while (running.size > 0) {
        const [index, done] = await Promise.race(running.values());
        running.delete(index);
        rows.push(done);
        if (next < total) startNext();
        if (rows.length < total) {
          yield { status: "running", completed: rows.length, total, rows: [], skipped: scope.skipped };
        }
      }

      rows.sort((a, b) => byName(a.filename, b.filename));
      const overBudget = rows.filter((r) => r.error === COST_LIMIT_MESSAGE).length;
      const failed = rows.filter((r) => r.error).length - overBudget;
      const nextStartAfter = scope.skipped ? scope.files.at(-1)?.name : undefined;
      yield {
        status: "done",
        completed: rows.length,
        total,
        rows,
        skipped: scope.skipped,
        nextStartAfter,
        message: [
          `Analyzed ${rows.length - failed - overBudget} of ${total} files${failed ? `; ${failed} could not be read` : ""}.`,
          overBudget
            ? `${overBudget} were not analyzed because this turn reached its cost limit.`
            : undefined,
          nextStartAfter
            ? `${scope.skipped} more files were not analyzed: a run covers at most ${MAX_FILES}. Call analyzeFolder again with startAfter "${nextStartAfter}" to continue.`
            : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      };
    },
  });
