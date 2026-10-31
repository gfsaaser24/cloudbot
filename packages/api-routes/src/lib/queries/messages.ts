import { db } from "@workspace/server/drizzle/db.js";
import { messages } from "@workspace/server/drizzle/schema.js";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  offloadLargeParts,
  type PartBucket,
  restoreOffloadedParts,
} from "../chat/part-storage.js";
import { type CustomUIMessage } from "../../types/custom-ui-message.js";

export async function getMessageById({ messageId }: { messageId: string }) {
  const result = await db()
    .select({ chatId: messages.chatId, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId));

  if (result.length === 0) {
    throw new HTTPException(404, { message: "NOT_FOUND" });
  }

  return result[0];
}

// The whole chat, oldest first.
export async function getMessagesByChatId({
  bucket,
  chatId,
}: {
  bucket: PartBucket;
  chatId: string;
}) {
  const rows = (await db()
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.createdAt))) as CustomUIMessage[];
  return restoreOffloadedParts(bucket, rows);
}

export async function saveMessages({
  bucket,
  chatId,
  newMessages,
}: {
  bucket: PartBucket;
  chatId: string;
  newMessages: CustomUIMessage[];
}) {
  const storedMessages = await Promise.all(
    newMessages.map((msg) => offloadLargeParts(bucket, chatId, msg)),
  );
  const messagesToInsert = storedMessages.map((msg) => ({
    chatId,
    ...msg,
  }));

  return await db()
    .insert(messages)
    .values(messagesToInsert)
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        chatId: sql`excluded.chat_id`,
        role: sql`excluded.role`,
        parts: sql`excluded.parts`,
        metadata: sql`excluded.metadata`,
      },
    })
    .returning();
}

export async function deleteLastMessagePair({ chatId }: { chatId: string }) {
  // Delete the last two messages in the chat
  const lastTwoMessages = await db()
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt))
    .limit(2);

  const messageIdsToDelete = lastTwoMessages.map((msg) => msg.id);

  await db().delete(messages).where(inArray(messages.id, messageIdsToDelete));
}
