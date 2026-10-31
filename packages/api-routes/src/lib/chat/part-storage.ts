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

const MARKER_TYPE = "data-offloadedPart";

type OffloadedPartMarker = {
  type: typeof MARKER_TYPE;
  data: { key: string };
};

const encoder = new TextEncoder();
const byteLength = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).length;

const ROOT_PREFIX = "chat-parts/";

function partsPrefix(chatId: string, messageId?: string) {
  return messageId
    ? `${ROOT_PREFIX}${chatId}/${messageId}/`
    : `${ROOT_PREFIX}${chatId}/`;
}

function isMarker(part: unknown): part is OffloadedPartMarker {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === MARKER_TYPE
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

  const largestFirst = message.parts
    .map((part, index) => {
      const json = JSON.stringify(part);
      return { index, json, size: encoder.encode(json).length };
    })
    .filter(({ size }) => size > MIN_OFFLOAD_BYTES)
    .sort((a, b) => b.size - a.size);

  // Choose by size first, so the R2 writes can run in parallel.
  const chosen: { index: number; json: string; marker: OffloadedPartMarker }[] =
    [];
  for (const { index, json, size } of largestFirst) {
    if (total <= ROW_BUDGET_BYTES) break;
    const marker: OffloadedPartMarker = {
      type: MARKER_TYPE,
      data: { key: `${partsPrefix(chatId, message.id)}${index}` },
    };
    chosen.push({ index, json, marker });
    total -= size - byteLength(marker);
  }

  // No file extension and an octet-stream type keep AI Search, which indexes
  // this bucket, from indexing chat content as documents.
  await Promise.all(
    chosen.map(({ json, marker }) =>
      bucket.put(marker.data.key, json, {
        httpMetadata: { contentType: "application/octet-stream" },
      }),
    ),
  );

  // Markers replace parts only after every write succeeded.
  const parts: unknown[] = [...message.parts];
  for (const { index, marker } of chosen) parts[index] = marker;
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

          const { key } = part.data;
          // Only offloaded chat parts are ever read back, never other objects
          // in the bucket (such as folder files).
          if (!key.startsWith(ROOT_PREFIX)) {
            logger.error("Ignored a marker outside chat parts", { key });
            return { type: "text", text: MISSING_PART_TEXT };
          }

          try {
            const object = await bucket.get(key);
            if (object) return JSON.parse(await object.text()) as unknown;
            logger.error("Offloaded message part is missing", { key });
          } catch (error) {
            logger.error("Offloaded message part could not be read", {
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          // One unreadable part must not stop the whole chat from loading.
          return { type: "text", text: MISSING_PART_TEXT };
        }),
      );

      return { ...message, parts: restored as CustomUIMessagePart[] };
    }),
  );
}

// Deletes the offloaded parts of a whole chat, or of the given messages only.
// Best effort: it runs after the D1 rows are already gone, so a failure is
// logged (leaving unreachable objects) rather than failing the delete.
export async function deleteOffloadedParts(
  bucket: PartBucket,
  chatId: string,
  messageIds?: string[],
): Promise<void> {
  const prefixes = messageIds
    ? messageIds.map((id) => partsPrefix(chatId, id))
    : [partsPrefix(chatId)];

  await Promise.all(
    prefixes.map(async (prefix) => {
      try {
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix, cursor });
          const keys = page.objects.map((object) => object.key);
          if (keys.length > 0) await bucket.delete(keys);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      } catch (error) {
        logger.error("Could not delete offloaded message parts", {
          prefix,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
