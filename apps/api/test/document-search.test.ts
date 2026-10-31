import { extractFromDocuments } from "@workspace/api-routes/lib/tools/extract-from-documents.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { type UIMessageStreamWriter } from "ai";
import { describe, expect, it } from "vitest";

const userId = "41f82dd9-6dbe-4bf1-bcb2-28c461fbc73f";
const folderId = "6a703cdb-461e-4082-801b-9a89ae31ff04";

// AI Search returns each passage's text as a list of parts.
const env = {
  AI: {
    autorag: () => ({
      search: async () => ({
        data: [
          {
            filename: `${userId}/${folderId}/episode.md`,
            score: 0.55,
            content: [
              { type: "text", text: "Revenue is the signal" },
              { type: "text", text: "founders keep coming back to." },
            ],
          },
        ],
      }),
    }),
  },
} as unknown as Bindings;

describe("extractFromDocuments", () => {
  it("returns each passage's text, not [object Object]", async () => {
    const search = extractFromDocuments({
      env,
      userId,
      fileMetadata: [],
      folderMetadata: [{ id: folderId, visibility: "private", owner: userId }],
      dataStream: {} as UIMessageStreamWriter<CustomUIMessage>,
    });

    const output = await search.execute!(
      { query: "success", max_num_results: 10 },
      { toolCallId: "1", messages: [] },
    );

    expect(output).toMatchObject({
      excerpts: [
        {
          folderId,
          filename: "episode.md",
          text: "Revenue is the signal\nfounders keep coming back to.",
        },
      ],
      sources: [{ folderId, filename: "episode.md", score: 0.55 }],
    });
  });
});
