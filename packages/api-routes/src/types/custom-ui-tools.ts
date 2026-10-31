import {
  type analyzeFolderInput,
  type analyzeFolderOutput,
} from "../lib/tools/analyze-folder.js";
import { type extractFromDocumentsOutput } from "../lib/tools/extract-from-documents.js";
import { type WebSource } from "../lib/tools/extract-from-web.js";
import { type fetchWebContentOutput } from "../lib/tools/fetch-web-content.js";
import {
  type firecrawlInputs,
  type FirecrawlOutput,
  type FirecrawlToolName,
} from "../lib/tools/firecrawl-tools.js";
import {
  type getImportStatusInput,
  type getImportStatusOutput,
  type importYouTubeTranscriptsInput,
  type importYouTubeTranscriptsOutput,
} from "../lib/tools/import-youtube-transcripts.js";
import {
  type readFileInput,
  type readFileOutput,
} from "../lib/tools/read-file.js";
import {
  type saveToFolderInput,
  type saveToFolderOutput,
} from "../lib/tools/save-to-folder.js";
import type * as z from "zod";
import { type ArtifactKind } from "../schemas/artifact-schema.js";

type FirecrawlUITools = {
  [Name in FirecrawlToolName]: {
    input: z.infer<(typeof firecrawlInputs)[Name]>;
    output: FirecrawlOutput;
  };
};

export type CustomUITools = FirecrawlUITools & {
  extractFromWeb: {
    input: { informationToExtract: string };
    output: { extractedInformation: string; sources: WebSource[] };
  };
  extractFromDocuments: {
    input: { query: string; max_num_results?: number };
    output: z.infer<typeof extractFromDocumentsOutput>;
  };
  readFile: {
    input: z.infer<typeof readFileInput>;
    output: z.infer<typeof readFileOutput>;
  };
  analyzeFolder: {
    input: z.infer<typeof analyzeFolderInput>;
    output: z.infer<typeof analyzeFolderOutput>;
  };
  createDocument: {
    input: { title: string; kind: ArtifactKind; description: string };
    output: { id: string; title: string; kind: ArtifactKind; message: string };
  };
  updateDocument: {
    input: { id: string; description: string };
    output: {
      id: string;
      diffId: string;
      title: string;
      kind: ArtifactKind;
      message: string;
    };
  };
  generateFile: {
    input: { title: string; format: string; description: string };
    output: {
      fileId: string;
      filename: string;
      format: string;
      contentType: string;
      size: number;
      message: string;
    };
  };
  fetchWebContent: {
    input: { url: string };
    output: z.infer<typeof fetchWebContentOutput>;
  };
  saveToFolder: {
    input: z.infer<typeof saveToFolderInput>;
    output: z.infer<typeof saveToFolderOutput>;
  };
  importYouTubeTranscripts: {
    input: z.infer<typeof importYouTubeTranscriptsInput>;
    output: z.infer<typeof importYouTubeTranscriptsOutput>;
  };
  getImportStatus: {
    input: z.infer<typeof getImportStatusInput>;
    output: z.infer<typeof getImportStatusOutput>;
  };
};
