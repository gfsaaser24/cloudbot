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

  it("keeps each file's best two passages, so one long file can't fill every slot", async () => {
    const requested: { max_num_results?: number }[] = [];
    const file = (name: string, chunks: number, score: number) => ({
      filename: `${userId}/${folderId}/${name}`,
      score,
      content: Array.from({ length: chunks }, (_, i) => ({ type: "text", text: `${name} passage ${i + 1}` })),
    });
    const crowded = {
      AI: {
        autorag: () => ({
          search: async (request: { max_num_results?: number }) => {
            requested.push(request);
            return { data: [file("style-guide.md", 10, 0.7), file("episode-1.md", 3, 0.5), file("episode-2.md", 1, 0.4), file("episode-3.md", 2, 0.3)] };
          },
        }),
      },
    } as unknown as Bindings;
    const search = extractFromDocuments({
      env: crowded,
      userId,
      fileMetadata: [],
      folderMetadata: [{ id: folderId, visibility: "private", owner: userId }],
      dataStream: {} as UIMessageStreamWriter<CustomUIMessage>,
    });

    const output = await search.execute!({ query: "Maya", max_num_results: 4 }, { toolCallId: "1", messages: [] });

    // AI Search's maximum is fetched, then trimmed to the four passages asked for.
    expect(requested[0]!.max_num_results).toBe(50);
    expect(output.excerpts!.map((e) => [e.filename, e.text])).toEqual([
      ["style-guide.md", "style-guide.md passage 1\nstyle-guide.md passage 2"],
      ["episode-1.md", "episode-1.md passage 1\nepisode-1.md passage 2"],
    ]);
  });
});
