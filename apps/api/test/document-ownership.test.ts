import { updateDocument } from "@workspace/api-routes/lib/tools/update-document.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { type UIMessageStreamWriter } from "ai";
import { describe, expect, it, vi } from "vitest";

// The model can only edit documents that belong to the user it works for.

const saved = vi.hoisted(() => ({ diffs: 0 }));

vi.mock("@workspace/api-routes/lib/queries/documents.js", () => ({
  getDocumentById: async () => ({ id: "doc-1", title: "Notes", content: "Old", kind: "text", owner: "user-2" }),
  saveDocument: async () => undefined,
  saveDiff: async () => {
    saved.diffs += 1;
    return "diff-1";
  },
}));

const writes: unknown[] = [];
const dataStream = { write: (part: unknown) => writes.push(part) } as unknown as UIMessageStreamWriter<CustomUIMessage>;

describe("updateDocument", () => {
  it("treats another user's document as missing and changes nothing", async () => {
    const tool = updateDocument({ userId: "user-1", dataStream, env: {} as Bindings, spend: { steps: 0, tools: 0 } });

    await expect(tool.execute!({ id: "doc-1", description: "Rewrite it" }, { toolCallId: "c1", messages: [] })).rejects.toThrow(
      "Document not found",
    );
    expect(saved.diffs).toBe(0);
    expect(writes).toEqual([]);
  });
});
