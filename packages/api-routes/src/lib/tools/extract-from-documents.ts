import * as z from "zod";

import { createLogger } from "@workspace/server/logger/logger.js";
import { tool, type UIMessageStreamWriter } from "ai";
import { type Bindings } from "../../types/bindings.js";
import { type CustomUIMessage } from "../../types/custom-ui-message.js";
import {
  buildMetadataFilter,
  selectedFileKeys,
} from "../../utils/build-metadata-filter.js";
import { type FileMetadata } from "../../utils/filter-authorized-files.js";
import { FolderMetadata } from "../../utils/filter-authorized-folders.js";

type ExtractFromDocumentsProps = {
  env: Bindings;
  userId: string;
  fileMetadata: FileMetadata[];
  folderMetadata: FolderMetadata[];
  dataStream: UIMessageStreamWriter<CustomUIMessage>;
};

export type DocumentSource = {
  folderId: string;
  filename: string;
  score: number;
};

const logger = createLogger("extract-from-documents");

// AutoRAG returns its best chunks grouped by file, and one long file that
// matches most queries (a style guide, say) can fill every slot. So the most
// chunks it allows are fetched, each file keeps its best few, and the passages
// returned stay at max_num_results.
const CHUNKS_FETCHED = 50;
const CHUNKS_PER_FILE = 2;

const sourceSchema = z.object({
  folderId: z.string(),
  filename: z.string(),
  score: z.number(),
});

export const extractFromDocumentsOutput = z.object({
  // The matching passages, verbatim, for the chat model to read.
  excerpts: z
    .array(
      z.object({
        folderId: z.string(),
        filename: z.string(),
        score: z.number(),
        text: z.string(),
      }),
    )
    .optional(),
  // Older messages carry a summary here instead of excerpts.
  extractedInformation: z.string().optional(),
  sources: z.array(sourceSchema),
});

export const extractFromDocuments = ({
  env,
  userId,
  fileMetadata,
  folderMetadata,
}: ExtractFromDocumentsProps) =>
  tool({
    description:
      "Searches the user's documents (the selected folders or files) and returns the passages that best match the query, verbatim. Each passage is a section of a file, not the whole file. Search several times with different wording to cover a topic, and read whole files with readFile when a question needs a full document or many of them (e.g. themes across transcripts). Cite passages as [[doc:folderId/filename]].",
    inputSchema: z.object({
      query: z.string(),
      max_num_results: z.number().min(2).max(20).default(10),
    }),
    outputSchema: extractFromDocumentsOutput,
    execute: async ({
      query,
      max_num_results,
    }): Promise<z.infer<typeof extractFromDocumentsOutput>> => {
      // Always offered so the tool list never changes between turns.
      if (fileMetadata.length === 0 && folderMetadata.length === 0) {
        return {
          extractedInformation:
            "No folder or file is selected for this message, so there is nothing to search. Ask the user to select a folder or file.",
          sources: [],
        };
      }

      try {
        // Permissions already checked in standard-chat-handler
        // fileMetadata contains only files the user has access to
        const metadataFilter = buildMetadataFilter(
          userId,
          fileMetadata,
          folderMetadata,
        );

        // No reranking: bge-reranker-base scored most natural-language questions
        // below the threshold, so searches came back empty.
        const searchResult = await env.AI.autorag(
          process.env.AUTORAG_NAME ?? "",
        ).search({
          query,
          max_num_results: CHUNKS_FETCHED,
          ranking_options: {
            score_threshold: 0.2,
          },
          ...(metadataFilter ? { filters: metadataFilter } : {}),
        });

        // The filter narrows to folders; keep only the selected files, if any.
        const fileKeys = selectedFileKeys(userId, fileMetadata);
        const results = fileKeys
          ? searchResult.data.filter((item) => fileKeys.has(item.filename))
          : searchResult.data;

        let passagesLeft = max_num_results;
        const excerpts = results.flatMap((item) => {
          const chunks = item.content.slice(0, Math.min(CHUNKS_PER_FILE, passagesLeft));
          if (chunks.length === 0) return [];
          passagesLeft -= chunks.length;
          const parts = item.filename.split("/");
          return [
            {
              folderId: parts[parts.length - 2] ?? "",
              filename: parts[parts.length - 1] ?? item.filename,
              score: item.score,
              text: chunks.map((c) => c.text).join("\n"),
            },
          ];
        });

        logger.info(
          `Found ${excerpts.length} passage(s) for query: "${query}"`,
        );

        return {
          excerpts,
          sources: excerpts.map(({ folderId, filename, score }) => ({
            folderId,
            filename,
            score,
          })),
        };
      } catch (error) {
        logger.error("Error in extractFromDocuments tool", error);
        throw error;
      }
    },
  });
