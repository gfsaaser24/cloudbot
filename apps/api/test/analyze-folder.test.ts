import { analyzeFolder } from "@workspace/api-routes/lib/tools/analyze-folder.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

// analyzeFolder answers questions across many files by extracting the same
// fields from each one with a cheap model and returning one table.

const FOLDER = "00000000-0000-4000-8000-0000000000aa";

const state = vi.hoisted(() => ({
  // The files the folder query finds, and how many the count query reports.
  rows: [] as { name: string; visibility: string; folderId: string }[],
  total: 0,
  // Files whose extraction fails.
  failing: new Set<string>(),
}));

vi.mock("@workspace/server/drizzle/db.js", () => ({
  db: () => ({
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: (_where: unknown) =>
          "total" in columns
            ? Promise.resolve([{ total: state.total }])
            : { orderBy: () => ({ limit: async (n: number) => state.rows.slice(0, n) }) },
      }),
    }),
  }),
}));

const COST_PER_FILE = 0.002;

vi.mock("@workspace/api-routes/providers/providers.js", async (importActual) => ({
  ...(await importActual<typeof import("@workspace/api-routes/providers/providers.js")>()),
  getExtractionModel: async () =>
    new MockLanguageModelV4({
      doGenerate: async ({ prompt }) => {
        const text = JSON.stringify(prompt);
        const filename = /Document \\"([^"\\]+)\\"/.exec(text)?.[1] ?? "?";
        if (state.failing.has(filename)) throw new Error("model error");
        return {
          content: [{ type: "text", text: JSON.stringify({ pricing: `from ${filename}` }) }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          providerMetadata: { openrouter: { usage: { cost: COST_PER_FILE } } },
          warnings: [],
        };
      },
    }),
}));

const transcript = (i: number) => ({ name: `episode-${String(i).padStart(3, "0")}.md`, visibility: "private", folderId: FOLDER });

const bucket = {
  get: async (key: string) => ({ text: async () => `Transcript of ${key}` }),
};

type Run = { status: string; completed: number; total: number; rows: { filename: string; values?: Record<string, string>; error?: string }[]; skipped: number; message?: string };

async function run({
  selectedFiles,
  filenames,
}: { selectedFiles?: { id: string; name: string; visibility: string; folderId: string; owner: string }[]; filenames?: string[] } = {}) {
  const toolSpend = { usd: 0 };
  const tool = analyzeFolder({
    env: { CLOUDBOT_BUCKET: bucket } as unknown as Bindings,
    userId: "user-1",
    fileMetadata: selectedFiles ?? [],
    folderMetadata: selectedFiles ? [] : [{ id: FOLDER, visibility: "private", folderId: FOLDER, owner: "user-1" }],
    toolSpend,
  });

  const outputs: Run[] = [];
  const stream = tool.execute!(
    { fields: [{ name: "pricing", description: "How the guest priced their first offer" }], filenames },
    { toolCallId: "c1", messages: [] },
  ) as AsyncIterable<Run>;
  for await (const output of stream) outputs.push(output);
  return { outputs, final: outputs.at(-1)!, toolSpend };
}

beforeEach(() => {
  state.rows = [];
  state.total = 0;
  state.failing = new Set();
});

describe("analyzeFolder", () => {
  it("returns one row per file with the requested fields filled in", async () => {
    state.rows = [1, 2, 3].map(transcript);
    state.total = 3;

    const { final } = await run();
    expect(final.status).toBe("done");
    expect(final.rows.map((r) => r.values?.pricing)).toEqual([
      "from episode-001.md",
      "from episode-002.md",
      "from episode-003.md",
    ]);
  });

  it("reports a file that fails as an error row and keeps the others", async () => {
    state.rows = [1, 2, 3].map(transcript);
    state.total = 3;
    state.failing.add("episode-002.md");

    const { final } = await run();
    expect(final.rows.map((r) => Boolean(r.error))).toEqual([false, true, false]);
    expect(final.message).toContain("1 could not be read");
  });

  it("analyzes 100 files of 130 and says 30 were left out", async () => {
    state.rows = Array.from({ length: 130 }, (_, i) => transcript(i + 1));
    state.total = 130;

    const { final } = await run();
    expect(final.rows).toHaveLength(100);
    expect(final.skipped).toBe(30);
    expect(final.message).toContain("30 more files were not analyzed");
  });

  it("reports progress once per finished file", async () => {
    state.rows = Array.from({ length: 12 }, (_, i) => transcript(i + 1));
    state.total = 12;

    const { outputs } = await run();
    expect(outputs.map((o) => o.completed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(outputs.filter((o) => o.status === "running")).toHaveLength(11);
  });

  it("doesn't analyze a file outside the selection", async () => {
    const selected = [{ id: "f1", ...transcript(1), owner: "user-1" }];

    const { final } = await run({ selectedFiles: selected, filenames: ["someone-elses.md"] });
    expect(final.rows).toEqual([]);
  });

  it("adds each extraction's cost to the turn's tool spend", async () => {
    state.rows = [1, 2, 3].map(transcript);
    state.total = 3;

    const { toolSpend } = await run();
    expect(toolSpend.usd).toBeCloseTo(3 * COST_PER_FILE);
  });
});
