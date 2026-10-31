import { analyzeFolder } from "@workspace/api-routes/lib/tools/analyze-folder.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { MockLanguageModelV4 } from "ai/test";
import { type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// analyzeFolder answers questions across many files by extracting the same
// fields from each one with a cheap model and returning one table.

const FOLDER = "00000000-0000-4000-8000-0000000000aa";

const state = vi.hoisted(() => ({
  // The files the folder query finds, and how many the count query reports.
  rows: [] as { name: string; visibility: string; folderId: string; size: number }[],
  total: 0,
  // Files whose extraction fails.
  failing: new Set<string>(),
  // How long each extracted value is.
  valueLength: 0,
  // The folder query's where clause, and how many extraction calls ran.
  where: undefined as unknown,
  modelCalls: 0,
  // How many extractions run at once, and the most that did.
  active: 0,
  maxActive: 0,
}));

vi.mock("@workspace/server/drizzle/db.js", () => ({
  db: () => ({
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: (where: unknown) =>
          ((state.where = where), "total" in columns)
            ? Promise.resolve([{ total: state.total }])
            : {
                orderBy: () => ({ limit: async (n: number) => state.rows.slice(0, n) }),
                // The selected files' sizes.
                then: (resolve: (rows: unknown) => void) =>
                  resolve(state.rows.map((r) => ({ id: r.name, size: r.size }))),
              },
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
        state.modelCalls += 1;
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        state.active -= 1;
        const text = JSON.stringify(prompt);
        const filename = /Document \\"([^"\\]+)\\"/.exec(text)?.[1] ?? "?";
        if (state.failing.has(filename)) throw new Error("model error");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ pricing: state.valueLength ? "v".repeat(state.valueLength) : `from ${filename}` }),
            },
          ],
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

const transcript = (i: number, size = 1_000) => ({
  name: `episode-${String(i).padStart(3, "0")}.md`,
  visibility: "private",
  folderId: FOLDER,
  size,
});

const bucket = {
  get: async (key: string) => ({ text: async () => `Transcript of ${key}` }),
};

type Run = { status: string; completed: number; total: number; rows: { filename: string; values?: Record<string, string>; error?: string }[]; skipped: number; message?: string };

async function run({
  selectedFiles,
  filenames,
  startAfter,
  spend = { steps: 0, tools: 0 },
}: {
  selectedFiles?: { id: string; name: string; visibility: string; folderId: string; owner: string }[];
  filenames?: string[];
  startAfter?: string;
  spend?: { steps: number; tools: number };
} = {}) {
  const tool = analyzeFolder({
    env: { CLOUDBOT_BUCKET: bucket } as unknown as Bindings,
    userId: "user-1",
    fileMetadata: selectedFiles ?? [],
    folderMetadata: selectedFiles ? [] : [{ id: FOLDER, visibility: "private", folderId: FOLDER, owner: "user-1" }],
    spend,
  });

  const outputs: Run[] = [];
  const stream = tool.execute!(
    { fields: [{ name: "pricing", description: "How the guest priced their first offer" }], filenames, startAfter },
    { toolCallId: "c1", messages: [] },
  ) as AsyncIterable<Run>;
  for await (const output of stream) outputs.push(output);
  return { outputs, final: outputs.at(-1)!, spend };
}

beforeEach(() => {
  state.rows = [];
  state.total = 0;
  state.failing = new Set();
  state.valueLength = 0;
  state.where = undefined;
  state.modelCalls = 0;
  state.active = 0;
  state.maxActive = 0;
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
    expect(final.nextStartAfter).toBe("episode-100.md");
    expect(final.message).toContain('startAfter "episode-100.md"');
  });

  it("reports progress once per finished file", async () => {
    state.rows = Array.from({ length: 12 }, (_, i) => transcript(i + 1));
    state.total = 12;

    const { outputs } = await run();
    expect(outputs.map((o) => o.completed)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(outputs.filter((o) => o.status === "running")).toHaveLength(11);
  });

  it("reads 8 small files at once, but large files one at a time", async () => {
    state.rows = Array.from({ length: 12 }, (_, i) => transcript(i + 1));
    state.total = 12;
    await run();
    expect(state.maxActive).toBe(8);

    state.maxActive = 0;
    state.rows = Array.from({ length: 4 }, (_, i) => transcript(i + 1, 20 * 1024 * 1024));
    state.total = 4;
    const { final } = await run();
    expect(state.maxActive).toBe(1);
    expect(final.rows).toHaveLength(4);
  });

  it("weighs selected files by their stored size", async () => {
    state.rows = Array.from({ length: 3 }, (_, i) => transcript(i + 1, 20 * 1024 * 1024));
    const selected = state.rows.map((r) => ({ id: r.name, ...r, owner: "user-1" }));

    const { final } = await run({ selectedFiles: selected });
    expect(state.maxActive).toBe(1);
    expect(final.rows).toHaveLength(3);
  });

  it("doesn't analyze a file outside the selection", async () => {
    const selected = [{ id: "f1", ...transcript(1), owner: "user-1" }];

    const { final } = await run({ selectedFiles: selected, filenames: ["someone-elses.md"] });
    expect(final.rows).toEqual([]);
  });

  it("adds each extraction's cost to the turn's tool spend", async () => {
    state.rows = [1, 2, 3].map(transcript);
    state.total = 3;

    const { spend } = await run();
    expect(spend.tools).toBeCloseTo(3 * COST_PER_FILE);
  });

  it("keeps a large table within about 100,000 characters", async () => {
    state.rows = Array.from({ length: 100 }, (_, i) => transcript(i + 1));
    state.total = 100;
    state.valueLength = 5_000;

    const { final } = await run();
    expect(final.rows).toHaveLength(100);
    expect(JSON.stringify(final.rows).length).toBeLessThan(110_000);
  });

  it("starts no more files once the turn reaches its cost limit", async () => {
    state.rows = [1, 2, 3].map(transcript);
    state.total = 3;

    const { final } = await run({ spend: { steps: 1.99, tools: 0.01 } });
    expect(state.modelCalls).toBe(0);
    expect(final.rows.every((r) => r.error?.includes("cost limit"))).toBe(true);
    expect(final.message).toContain("3 were not analyzed because this turn reached its cost limit");
  });

  it("queries only the selected folders' confirmed files, after the cursor", async () => {
    await run({ filenames: ["episode-007.md"], startAfter: "episode-005.md" });

    const { sql, params } = new SQLiteSyncDialect().sqlToQuery(state.where as SQL);
    expect(sql).toMatch(/folder_id.*in.*upload_confirmed.*name.*in.*name.*>/is);
    expect(params).toEqual(expect.arrayContaining([FOLDER, "episode-007.md", "episode-005.md"]));
  });
});
