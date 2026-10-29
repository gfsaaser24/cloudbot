import { createLogger } from "@workspace/server/logger/logger.js";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { listWritableFolders } from "@workspace/api-routes/lib/folder-access.js";
import {
  fetchForSaving,
  writeMarkdownFile,
} from "@workspace/api-routes/lib/folder-files.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import {
  type TranscriptImportParams,
  type TranscriptImportResult,
  type TranscriptImportSummary,
} from "@workspace/api-routes/types/transcript-import.js";

const logger = createLogger("transcript-import");

// Saves each video's transcript into a folder, one durable step per video, so
// a channel import keeps going after the chat that started it closes.
// Files are named "<title> - <videoId>.md"; videos already imported are skipped.
export class TranscriptImport extends WorkflowEntrypoint<
  Bindings,
  TranscriptImportParams
> {
  async run(
    event: Readonly<WorkflowEvent<TranscriptImportParams>>,
    step: WorkflowStep,
  ): Promise<TranscriptImportSummary> {
    const { userId, folderId, videoIds } = event.payload;
    const results: TranscriptImportResult[] = [];
    let folderName = "";

    for (const videoId of videoIds) {
      const result = await step.do(
        `video ${videoId}`,
        {
          // Firecrawl or YouTube hiccups get retried; a missing transcript does not.
          retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
          timeout: "3 minutes",
        },
        async (): Promise<TranscriptImportResult> => {
          // Checked per video: the user may lose access mid-import.
          const folder = (await listWritableFolders(userId)).find(
            (f) => f.id === folderId,
          );
          if (!folder) {
            return {
              videoId,
              status: "skipped",
              reason: "No longer allowed to write to the folder.",
            };
          }
          folderName = folder.name;

          const fetched = await fetchForSaving(
            `https://www.youtube.com/watch?v=${videoId}`,
          );
          if (!fetched.ok) {
            return { videoId, status: "skipped", reason: fetched.reason };
          }

          const file = await writeMarkdownFile({
            env: this.env,
            userId,
            folder,
            // The id keeps the name unique and makes re-imports skip it.
            filename: `${fetched.title.slice(0, 40)} - ${videoId}`,
            body: fetched.markdown,
            ifExists: "skip",
          });
          return {
            videoId,
            status: file.skipped ? "already-saved" : "saved",
            filename: file.name,
            characters: fetched.markdown.length,
          };
        },
      );
      results.push(result);
    }

    const summary: TranscriptImportSummary = {
      userId,
      folder: folderName,
      saved: results.filter((r) => r.status === "saved").length,
      alreadySaved: results.filter((r) => r.status === "already-saved").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    };
    logger.info("Transcript import finished", {
      saved: summary.saved,
      alreadySaved: summary.alreadySaved,
      skipped: summary.skipped,
    });
    return summary;
  }
}
