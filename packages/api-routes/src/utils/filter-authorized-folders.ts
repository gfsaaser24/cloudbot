import { canReadFolder } from "../lib/folder-access.js";

export type FolderMetadata = {
  id: string;
  visibility: string;
  owner: string;
};

/**
 * Filters folders to the ones the user may read (see canReadFolder):
 * - The owner can always read their folders
 * - Public folders are always accessible
 * - Protected folders require user to be in folderUsers
 */
export async function filterAuthorizedFolders(
  folderList: FolderMetadata[],
  userId: string,
): Promise<FolderMetadata[]> {
  const readable = await Promise.all(
    folderList.map((folder) => canReadFolder(folder, userId)),
  );

  return folderList.filter((_, i) => readable[i]);
}
