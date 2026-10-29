import {
  type Ai,
  type D1Database,
  type R2Bucket,
  type Workflow,
} from "@cloudflare/workers-types";
import { type TranscriptImportParams } from "./transcript-import.js";

export type Bindings = {
  CLOUDBOT_BUCKET: R2Bucket;
  CLOUDBOT_DB: D1Database;
  AI: Ai;
  TRANSCRIPT_IMPORT: Workflow<TranscriptImportParams>;
};
