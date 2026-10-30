import * as z from "zod";

import { tool } from "ai";
import { artifactSchema } from "../../schemas/artifact-schema.js";
import { createDocument } from "./create-document.js";
import {
  extractFromDocuments,
  extractFromDocumentsOutput,
} from "./extract-from-documents.js";
import { extractFromWeb } from "./extract-from-web.js";
import {
  fetchWebContent,
  fetchWebContentInput,
  fetchWebContentOutput,
} from "./fetch-web-content.js";
import { generateFile } from "./generate-file.js";
import { readFile, readFileInput, readFileOutput } from "./read-file.js";
import {
  getImportStatus,
  getImportStatusInput,
  getImportStatusOutput,
  importYouTubeTranscripts,
  importYouTubeTranscriptsInput,
  importYouTubeTranscriptsOutput,
} from "./import-youtube-transcripts.js";
import {
  saveToFolder,
  saveToFolderInput,
  saveToFolderOutput,
} from "./save-to-folder.js";
import { updateDocument } from "./update-document.js";

export const tools = {
  extractFromWeb: extractFromWeb,
  extractFromDocuments: extractFromDocuments,
  readFile: readFile,
  createDocument: createDocument,
  updateDocument: updateDocument,
  generateFile: generateFile,
  fetchWebContent: fetchWebContent,
  saveToFolder: saveToFolder,
  importYouTubeTranscripts: importYouTubeTranscripts,
  getImportStatus: getImportStatus,
};

export const mockedTools = {
  extractFromWeb: tool({
    inputSchema: z.object({
      informationToExtract: z.string(),
    }),
    outputSchema: z.object({
      extractedInformation: z.string(),
      sources: z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          title: z.string(),
        }),
      ),
    }),
  }),
  extractFromDocuments: tool({
    inputSchema: z.object({
      query: z.string(),
      max_num_results: z.number().optional(),
    }),
    outputSchema: extractFromDocumentsOutput,
  }),
  readFile: tool({
    inputSchema: readFileInput,
    outputSchema: readFileOutput,
  }),
  createDocument: tool({
    inputSchema: z.object({
      title: z.string(),
      kind: artifactSchema,
      description: z.string(),
    }),
    outputSchema: z.object({
      id: z.string(),
      title: z.string(),
      kind: artifactSchema,
      message: z.string(),
    }),
  }),
  updateDocument: tool({
    inputSchema: z.object({
      id: z.string(),
      description: z.string(),
    }),
    outputSchema: z.object({
      id: z.string(),
      diffId: z.string(),
      title: z.string(),
      kind: artifactSchema,
      message: z.string(),
    }),
  }),
  generateFile: tool({
    inputSchema: z.object({
      title: z.string(),
      format: z.string(),
      description: z.string(),
    }),
    outputSchema: z.object({
      fileId: z.string(),
      filename: z.string(),
      format: z.string(),
      contentType: z.string(),
      size: z.number(),
      message: z.string(),
    }),
  }),
  fetchWebContent: tool({
    inputSchema: fetchWebContentInput,
    outputSchema: fetchWebContentOutput,
  }),
  saveToFolder: tool({
    inputSchema: saveToFolderInput,
    outputSchema: saveToFolderOutput,
  }),
  importYouTubeTranscripts: tool({
    inputSchema: importYouTubeTranscriptsInput,
    outputSchema: importYouTubeTranscriptsOutput,
  }),
  getImportStatus: tool({
    inputSchema: getImportStatusInput,
    outputSchema: getImportStatusOutput,
  }),
};
