import { db } from "@workspace/server/drizzle/db.js";
import {
  type Folder,
  folderUsers,
  folders,
} from "@workspace/server/drizzle/schema.js";
import { and, eq } from "drizzle-orm";

async function isFolderMember(
  folderId: string,
  userId: string,
): Promise<boolean> {
  const access = await db()
    .select()
    .from(folderUsers)
    .where(
      and(eq(folderUsers.folderId, folderId), eq(folderUsers.userId, userId)),
    )
    .limit(1);
  return access.length > 0;
}

// Who may add files to a folder (uploads and the chat's saveToFolder tool):
// - public: anyone
// - protected: users added to the folder
// - private: the owner only
export async function canWriteToFolder(
  folder: Folder,
  userId: string,
): Promise<boolean> {
  if (folder.visibility === "public") return true;
  if (folder.visibility === "private") return folder.owner === userId;

  return isFolderMember(folder.id, userId);
}

// Who may read a folder (search it, use it as a chat's project):
// - the owner
// - public: anyone
// - protected: users added to the folder
export async function canReadFolder(
  folder: { id: string; owner: string; visibility: string },
  userId: string,
): Promise<boolean> {
  if (folder.owner === userId || folder.visibility === "public") return true;
  if (folder.visibility !== "protected") return false;

  return isFolderMember(folder.id, userId);
}

// The folder, if it exists and the user may read it.
export async function getReadableFolder(
  folderId: string,
  userId: string,
): Promise<Folder | undefined> {
  const [folder] = await db()
    .select()
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);

  if (!folder || !(await canReadFolder(folder, userId))) return undefined;
  return folder;
}

// R2 key for a folder file. AI Search indexes the bucket, and document search
// filters on this layout, so every writer must use it.
export function folderObjectKey(
  folder: Folder,
  userId: string,
  filename: string,
): string {
  return folder.visibility === "private"
    ? `${userId}/${folder.id}/${filename}`
    : `${folder.visibility}/${folder.id}/${filename}`;
}
