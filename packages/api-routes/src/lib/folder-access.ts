import { db } from "@workspace/server/drizzle/db.js";
import { type Folder, folderUsers } from "@workspace/server/drizzle/schema.js";
import { and, eq } from "drizzle-orm";

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

  const access = await db()
    .select()
    .from(folderUsers)
    .where(
      and(eq(folderUsers.folderId, folder.id), eq(folderUsers.userId, userId)),
    )
    .limit(1);
  return access.length > 0;
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
