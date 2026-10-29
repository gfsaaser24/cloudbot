// Parameters of a TranscriptImport workflow instance (workflows/transcript-import.ts).
export type TranscriptImportParams = {
  userId: string;
  folderId: string;
  videoIds: string[];
  sourceUrl: string;
};

export type TranscriptImportResult = {
  videoId: string;
  status: "saved" | "already-saved" | "skipped";
  filename?: string;
  characters?: number;
  reason?: string;
};

export type TranscriptImportSummary = {
  userId: string;
  folder: string;
  saved: number;
  alreadySaved: number;
  skipped: number;
  results: TranscriptImportResult[];
};
