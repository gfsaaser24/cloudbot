import { type FileMetadata } from "./filter-authorized-files.js";
import { type FolderMetadata } from "./filter-authorized-folders.js";

type ComparisonFilter = {
  type: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
  key: string;
  value: string;
};

type CompoundFilter = {
  type: "and" | "or";
  filters: ComparisonFilter[];
};

type MetadataFilter = ComparisonFilter | CompoundFilter;

// AI Search only indexes the first 64 bytes of a metadata string and rejects longer
// filter values. Folder paths are made of ASCII ids ("<userId>/<folderId>/" is 74 bytes),
// and the first 64 bytes still tell folders apart.
const FILTERABLE_BYTES = 64;

function folderPath(userId: string, visibility: string, folderId: string) {
  const owner = visibility === "private" ? userId : visibility;
  return `${owner}/${folderId}/`;
}

// The object key AI Search reports as a result's filename.
function fileKey(userId: string, file: FileMetadata) {
  return `${folderPath(userId, file.visibility, file.folderId)}${file.name}`;
}

// Full keys of the selected files, or undefined when no files were selected.
// buildMetadataFilter can only narrow a search to the files' folders, so search
// results have to be checked against these keys.
export function selectedFileKeys(
  userId: string,
  fileMetadata: FileMetadata[],
): Set<string> | undefined {
  if (fileMetadata.length === 0) return undefined;
  return new Set(fileMetadata.map((file) => fileKey(userId, file)));
}

export function buildMetadataFilter(
  userId: string,
  fileMetadata: FileMetadata[],
  folderMetadata: FolderMetadata[],
): MetadataFilter | undefined {
  // Selected files are searched through their folders (a full file key is too long to filter on).
  const paths =
    fileMetadata.length > 0
      ? fileMetadata.map((f) => folderPath(userId, f.visibility, f.folderId))
      : folderMetadata.map((f) => folderPath(userId, f.visibility, f.id));

  const values = [
    ...new Set(paths.map((path) => path.slice(0, FILTERABLE_BYTES))),
  ];

  if (values.length === 0) return undefined;

  if (values.length === 1) {
    return { type: "eq", key: "folder", value: values[0]! };
  }

  // "or" only allows eq filters on the same key.
  return {
    type: "or",
    filters: values.map((value) => ({ type: "eq", key: "folder", value })),
  };
}
