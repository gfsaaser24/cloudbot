import {
  deleteOffloadedParts,
  offloadLargeParts,
  type PartBucket,
  restoreOffloadedParts,
} from "@workspace/api-routes/lib/chat/part-storage.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { describe, expect, it } from "vitest";

// D1 stores a message's parts in one row, capped at 2 MB. Large parts move to R2
// and must come back exactly as they were saved.

function fakeBucket() {
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string) {
      objects.set(key, value);
      return null;
    },
    async get(key: string) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of [keys].flat()) objects.delete(key);
    },
  };
  return { bucket: bucket as unknown as PartBucket, objects };
}

const chatId = "c1";

function readFileOutput(id: string, chars: number) {
  return {
    type: "tool-readFile",
    toolCallId: id,
    state: "output-available",
    input: { filename: `${id}.md` },
    output: { found: true, filename: `${id}.md`, text: "x".repeat(chars) },
  };
}

function message(parts: unknown[]): CustomUIMessage {
  return { id: "m1", role: "assistant", parts } as CustomUIMessage;
}

const rowBytes = (m: CustomUIMessage) => new TextEncoder().encode(JSON.stringify(m.parts)).length;

describe("offloading large message parts", () => {
  it("moves a 3 MB tool output to R2 and restores it exactly", async () => {
    const { bucket, objects } = fakeBucket();
    const original = message([{ type: "text", text: "Here is the file." }, readFileOutput("t1", 3_000_000)]);

    const saved = await offloadLargeParts(bucket, chatId, original);
    expect(rowBytes(saved)).toBeLessThan(1_000_000);
    expect(objects.size).toBe(1);

    const [restored] = await restoreOffloadedParts(bucket, [saved]);
    expect(restored).toEqual(original);
  });

  it("keeps a message under the row budget when many medium parts add up", async () => {
    const { bucket } = fakeBucket();
    const parts = Array.from({ length: 30 }, (_, i) => readFileOutput(`t${i}`, 150_000));
    const original = message(parts);

    const saved = await offloadLargeParts(bucket, chatId, original);
    expect(rowBytes(saved)).toBeLessThan(1_000_000);

    const [restored] = await restoreOffloadedParts(bucket, [saved]);
    expect(restored).toEqual(original);
  });

  it("leaves a small message untouched", async () => {
    const { bucket, objects } = fakeBucket();
    const original = message([{ type: "text", text: "Short reply." }, readFileOutput("t1", 10_000)]);

    const saved = await offloadLargeParts(bucket, chatId, original);
    expect(saved).toEqual(original);
    expect(objects.size).toBe(0);
  });

  it("shows a visible placeholder when an offloaded part is missing", async () => {
    const { bucket, objects } = fakeBucket();
    const saved = await offloadLargeParts(bucket, chatId, message([readFileOutput("t1", 3_000_000)]));
    objects.clear();

    const [restored] = await restoreOffloadedParts(bucket, [saved]);
    expect(restored?.parts).toEqual([
      { type: "text", text: "(Part of this message could not be loaded.)" },
    ]);
  });

  it("deletes a chat's offloaded parts, or only the given messages' parts", async () => {
    const { bucket, objects } = fakeBucket();
    await offloadLargeParts(bucket, chatId, message([readFileOutput("t1", 3_000_000)]));
    await offloadLargeParts(bucket, chatId, { ...message([readFileOutput("t2", 3_000_000)]), id: "m2" });
    await offloadLargeParts(bucket, "other-chat", message([readFileOutput("t3", 3_000_000)]));

    await deleteOffloadedParts(bucket, chatId, ["m1"]);
    expect([...objects.keys()].some((k) => k.startsWith(`chat-parts/${chatId}/m1/`))).toBe(false);
    expect([...objects.keys()].filter((k) => k.startsWith(`chat-parts/${chatId}/`))).toHaveLength(1);

    await deleteOffloadedParts(bucket, chatId);
    expect([...objects.keys()]).toEqual(["chat-parts/other-chat/m1/0"]);
  });
});
