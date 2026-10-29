import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import * as z from "zod";
import { type Bindings } from "../../types/bindings.js";
import { type TranscriptImportSummary } from "../../types/transcript-import.js";
import { generateUUID } from "../../utils/generate-uuid.js";
import { resolveWritableFolder } from "../folder-files.js";
import { listYouTubeVideos, youTubeListPage } from "../youtube.js";

const logger = createLogger("import-youtube-transcripts");

const MAX_VIDEOS = 100;

export const importYouTubeTranscriptsInput = z.object({
  url: z
    .url()
    .describe("A YouTube channel (e.g. https://www.youtube.com/@name) or playlist URL"),
  folder: z
    .string()
    .optional()
    .describe(
      "The folder's name (or id) to save into. Leave it out to use the chat's project folder.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_VIDEOS)
    .optional()
    .describe(`How many of the newest videos to import (default and max ${MAX_VIDEOS})`),
});

export const importYouTubeTranscriptsOutput = z.object({
  started: z.boolean(),
  message: z.string(),
  jobId: z.string().optional(),
  videoCount: z.number().optional(),
  folder: z.string().optional(),
  availableFolders: z.array(z.string()).optional(),
});

export const getImportStatusInput = z.object({
  jobId: z.string().describe("The jobId returned by importYouTubeTranscripts"),
});

export const getImportStatusOutput = z.object({
  status: z.string(),
  message: z.string(),
  saved: z.number().optional(),
  alreadySaved: z.number().optional(),
  skipped: z.number().optional(),
  skippedReasons: z.array(z.string()).optional(),
});

type Props = {
  env: Bindings;
  userId: string;
  defaultFolderId?: string;
};

// Job ids carry the user id, so a user can only look up their own imports.
const jobPrefix = (userId: string) => `yt-${userId}-`;

export const importYouTubeTranscripts = ({ env, userId, defaultFolderId }: Props) =>
  tool({
    description:
      "Saves the transcript of every video on a YouTube channel or playlist into a folder, one Markdown file per video. It runs in the background and keeps going if the chat is closed; it returns a jobId. Use it whenever the user asks for all (or many) videos from a channel or playlist. For a single video use saveToFolder. Tell the user it started and how many videos it covers; don't claim transcripts are saved until getImportStatus says so.",
    inputSchema: importYouTubeTranscriptsInput,
    outputSchema: importYouTubeTranscriptsOutput,
    execute: async ({ url, folder: folderRef, limit }) => {
      try {
        const listPage = youTubeListPage(url);
        if (!listPage) {
          return {
            started: false,
            message:
              "That isn't a YouTube channel or playlist URL. For a single video, use saveToFolder with its url.",
          };
        }

        const lookup = await resolveWritableFolder(userId, folderRef, defaultFolderId);
        if (!lookup.folder) {
          return {
            started: false,
            message: lookup.message,
            availableFolders: lookup.availableFolders,
          };
        }

        const videoIds = (await listYouTubeVideos(listPage)).slice(
          0,
          limit ?? MAX_VIDEOS,
        );
        if (videoIds.length === 0) {
          return {
            started: false,
            message: `Found no videos at ${listPage}. Check the channel or playlist URL.`,
          };
        }

        const instance = await env.TRANSCRIPT_IMPORT.create({
          id: `${jobPrefix(userId)}${generateUUID()}`,
          params: {
            userId,
            folderId: lookup.folder.id,
            videoIds,
            sourceUrl: url,
          },
        });

        return {
          started: true,
          message: `Started importing transcripts for ${videoIds.length} videos into "${lookup.folder.name}". It runs in the background (roughly ${Math.max(1, Math.round((videoIds.length * 8) / 60))} minutes) and continues if this chat is closed. Videos without captions are skipped. Check progress with getImportStatus.`,
          jobId: instance.id,
          videoCount: videoIds.length,
          folder: lookup.folder.name,
        };
      } catch (error) {
        logger.error("Error in importYouTubeTranscripts tool", error);
        throw error;
      }
    },
  });

export const getImportStatus = ({ env, userId }: Pick<Props, "env" | "userId">) =>
  tool({
    description:
      "Reports the progress of a YouTube transcript import started with importYouTubeTranscripts. Use it when the user asks whether the import is done, and report the numbers it returns.",
    inputSchema: getImportStatusInput,
    outputSchema: getImportStatusOutput,
    execute: async ({ jobId }) => {
      if (!jobId.startsWith(jobPrefix(userId))) {
        return { status: "unknown", message: "No import with that jobId." };
      }
      try {
        const instance = await env.TRANSCRIPT_IMPORT.get(jobId);
        const { status, error, output } = await instance.status();
        const summary = output as TranscriptImportSummary | undefined;

        if (status === "complete" && summary) {
          return {
            status,
            message: `Finished: ${summary.saved} saved, ${summary.alreadySaved} already in the folder, ${summary.skipped} skipped.`,
            saved: summary.saved,
            alreadySaved: summary.alreadySaved,
            skipped: summary.skipped,
            skippedReasons: summary.results
              .filter((r) => r.status === "skipped")
              .map((r) => `${r.videoId}: ${r.reason ?? "skipped"}`)
              .slice(0, 20),
          };
        }
        if (status === "errored") {
          return { status, message: `The import failed: ${error?.message ?? "unknown error"}` };
        }
        return {
          status,
          message: "Still running; files appear in the folder as each video finishes.",
        };
      } catch (error) {
        logger.error("Error in getImportStatus tool", error);
        return { status: "unknown", message: "No import with that jobId." };
      }
    },
  });
