import { type R2Bucket } from "@cloudflare/workers-types";
import { createLogger } from "@workspace/server/logger/logger.js";
import {
  type CustomUIMessage,
  type CustomUIMessagePart,
} from "../../types/custom-ui-message.js";

// D1 stores all of a message's parts in one row, and rows are capped at 2 MB.
// When a message's parts would exceed ROW_BUDGET_BYTES, its largest parts move to
// R2 and the row keeps a small marker in their place. Every read path restores
// them before the message is used, so the model and the UI see it unchanged.

const logger = createLogger("part-storage");

const ROW_BUDGET_BYTES = 1_000_000;
// Smaller parts aren't worth an R2 round trip.
const MIN_OFFLOAD_BYTES = 16_384;

const MISSING_PART_TEXT = "(Part of this message could not be loaded.)";

export type PartBucket = Pick<R2Bucket, "put" | "get" | "list" | "delete">;

type OffloadedPartMarker = {
  type: "data-offloadedPart";
  data: { key: string };
};

const encoder = new TextEncoder();
const byteLength = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length;

function partsPrefix(chatId: string, messageId?: string) {
  return messageId
    ? `chat-parts/${chatId}/${messageId}/`
    : `chat-parts/${chatId}/`;
}

function isMarker(part: unknown): part is OffloadedPartMarker {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "data-offloadedPart"
  );
}

// Returns the message to store in D1. Offloaded parts are written to R2 first.
export async function offloadLargeParts(
  bucket: PartBucket,
  chatId: string,
  message: CustomUIMessage,
): Promise<CustomUIMessage> {
  let total = byteLength(message.parts);
  if (total <= ROW_BUDGET_BYTES) return message;

  const parts: unknown[] = [...message.parts];
  const largestFirst = parts
    .map((part, index) => ({ index, size: byteLength(part) }))
    .filter(({ size }) => size > MIN_OFFLOAD_BYTES)
    .sort((a, b) => b.size - a.size);

  for (const { index, size } of largestFirst) {
    if (total <= ROW_BUDGET_BYTES) break;

    const key = `${partsPrefix(chatId, message.id)}${index}`;
    // No file extension and an octet-stream type keep AI Search, which indexes
    // this bucket, from indexing chat content as documents.
    await bucket.put(key, JSON.stringify(parts[index]), {
      httpMetadata: { contentType: "application/octet-stream" },
    });

    const marker: OffloadedPartMarker = {
      type: "data-offloadedPart",
      data: { key },
    };
    parts[index] = marker;
    total -= size - byteLength(marker);
  }

  return { ...message, parts: parts as CustomUIMessagePart[] };
}

// Puts offloaded parts back into messages read from D1.
export async function restoreOffloadedParts(
  bucket: PartBucket,
  messages: CustomUIMessage[],
): Promise<CustomUIMessage[]> {
  return Promise.all(
    messages.map(async (message) => {
      const parts: unknown[] = message.parts;
      if (!parts.some(isMarker)) return message;

      const restored = await Promise.all(
        parts.map(async (part) => {
          if (!isMarker(part)) return part;

          const object = await bucket.get(part.data.key);
          if (!object) {
            logger.error("Offloaded message part is missing", {
              key: part.data.key,
            });
            return { type: "text", text: MISSING_PART_TEXT };
          }
          return JSON.parse(await object.text()) as unknown;
        }),
      );

      return { ...message, parts: restored as CustomUIMessagePart[] };
    }),
  );
}

// Deletes the offloaded parts of a whole chat, or of the given messages only.
export async function deleteOffloadedParts(
  bucket: PartBucket,
  chatId: string,
  messageIds?: string[],
): Promise<void> {
  const prefixes = messageIds
    ? messageIds.map((id) => partsPrefix(chatId, id))
    : [partsPrefix(chatId)];

  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, cursor });
      const keys = page.objects.map((object) => object.key);
      if (keys.length > 0) await bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
