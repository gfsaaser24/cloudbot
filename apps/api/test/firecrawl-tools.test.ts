import { firecrawlInputs, firecrawlTools } from "@workspace/api-routes/lib/tools/firecrawl-tools.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every Firecrawl v2 capability is a tool. Costly ones ask first and run under
// caps, and every result is kept small enough to stay in the history for good.

// The selected-file lookup reads the files table; jobs and browser sessions
// are recorded with the user who started them.
const filesTable = vi.hoisted(() => ({ rows: [] as { name: string; visibility: string; folderId: string }[] }));
const jobsTable = vi.hoisted(() => ({ rows: [] as { id: string; userId: string; kind: string }[], insertFails: false }));

vi.mock("@workspace/server/drizzle/db.js", () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: (where: SQL) => ({
          then: (resolve: (rows: unknown) => void) => resolve(filesTable.rows),
          // The job lookup: the rows whose id, owner and kind match, in that order.
          limit: async () => {
            const { sql, params } = new SQLiteSyncDialect().sqlToQuery(where);
            expect(sql).toMatch(/"id" = \?.*"user_id" = \?.*"kind" = \?/);
            return jobsTable.rows.filter(
              (job) => job.id === params[0] && job.userId === params[1] && job.kind === params[2],
            );
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (job: { id: string; userId: string; kind: string }) => {
        if (jobsTable.insertFails) throw new Error("D1 unavailable");
        jobsTable.rows.push(job);
      },
    }),
  }),
}));

type Call = { method: string; url: URL; body: unknown; auth: string | null };

let calls: Call[] = [];
let respond: (call: Call) => Response = () => Response.json({ success: true });

beforeEach(() => {
  calls = [];
  jobsTable.rows = [];
  jobsTable.insertFails = false;
  vi.stubEnv("FIRECRAWL_API_KEY", "fc-test");
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      auth: new Headers(init.headers).get("Authorization"),
    };
    calls.push(call);
    return respond(call);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const tools = (enabled = true, userId = "user-1") =>
  firecrawlTools({ env: {} as Bindings, userId, enabled, fileMetadata: [], folderMetadata: [] });

const options = { toolCallId: "c1", messages: [] };

describe("firecrawl tools", () => {
  it("searches research papers on the research index, with the API key", async () => {
    respond = () =>
      Response.json({
        success: true,
        results: [{ paperId: "p1", primaryId: "arxiv:2105.05233", title: "Diffusion beats GANs", abstract: "We show..." }],
      });

    const output = await tools().firecrawlSearch.execute!(
      { query: "diffusion models", sources: ["research"], limit: 5, scrapeResults: false },
      options,
    );

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v2/search/research/papers");
    expect(calls[0]!.url.searchParams.get("query")).toBe("diffusion models");
    expect(calls[0]!.auth).toBe("Bearer fc-test");
    expect(output.links).toEqual([{ url: "https://arxiv.org/abs/2105.05233", title: "Diffusion beats GANs" }]);
    expect(JSON.stringify(output.data)).toContain("We show...");
  });

  it("caps a crawl at 100 pages and asks the user before running it", async () => {
    respond = () => Response.json({ success: true, id: "crawl-1" });
    const crawl = tools().firecrawlCrawl;

    expect(crawl.needsApproval).toBe(true);
    const output = await crawl.execute!({ url: "https://a.com", limit: 500 }, options);

    expect(calls[0]!.url.pathname).toBe("/v2/crawl");
    expect(calls[0]!.body).toMatchObject({ url: "https://a.com", limit: 100 });
    expect(output).toMatchObject({ ok: true, id: "crawl-1" });
  });

  it("caps the agent's credit budget at 500", async () => {
    respond = () => Response.json({ success: true, id: "agent-1" });
    await tools().firecrawlAgent.execute!({ prompt: "find the founders", maxCredits: 5_000 }, options);

    expect(calls[0]!.url.pathname).toBe("/v2/agent");
    expect(calls[0]!.body).toMatchObject({ prompt: "find the founders", maxCredits: 500 });
  });

  it("keeps an interact session across calls and stops it", async () => {
    respond = ({ method, url }) =>
      method === "POST" && url.pathname === "/v2/interact"
        ? Response.json({ success: true, id: "sess-1", liveViewUrl: "https://live/sess-1" })
        : Response.json({ success: true, result: "Logged in", exitCode: 0 });
    const interact = tools().firecrawlInteract;

    // Every start and every piece of code run asks first; stopping doesn't.
    expect(typeof interact.needsApproval === "function" && (await interact.needsApproval({ action: "start" }, options))).toBe(true);
    expect(typeof interact.needsApproval === "function" && (await interact.needsApproval({ action: "execute", sessionId: "sess-1" }, options))).toBe(true);
    expect(typeof interact.needsApproval === "function" && (await interact.needsApproval({ action: "stop", sessionId: "sess-1" }, options))).toBe(false);

    const started = await interact.execute!({ action: "start" }, options);
    expect(started).toMatchObject({ id: "sess-1", liveViewUrl: "https://live/sess-1" });

    const ran = await interact.execute!({ action: "execute", sessionId: started.id, code: "await page.click('#login')" }, options);
    expect(calls[1]!.url.pathname).toBe("/v2/interact/sess-1/execute");
    expect(JSON.stringify(ran.data)).toContain("Logged in");

    await interact.execute!({ action: "stop", sessionId: started.id }, options);
    expect(calls[2]).toMatchObject({ method: "DELETE" });
    expect(calls[2]!.url.pathname).toBe("/v2/interact/sess-1");
  });

  it("doesn't let another user use a browser session", async () => {
    respond = () => Response.json({ success: true, id: "sess-1" });
    await tools().firecrawlInteract.execute!({ action: "start" }, options);

    const other = tools(true, "user-2").firecrawlInteract;
    const ran = await other.execute!({ action: "execute", sessionId: "sess-1", code: "await page.content()" }, options);
    const stopped = await other.execute!({ action: "stop", sessionId: "sess-1" }, options);

    expect([ran.ok, stopped.ok]).toEqual([false, false]);
    expect(calls).toHaveLength(1);
  });

  it("doesn't show or cancel another user's crawl", async () => {
    respond = () => Response.json({ success: true, id: "crawl-1" });
    await tools().firecrawlCrawl.execute!({ url: "https://a.com", limit: 10 }, options);

    const other = tools(true, "user-2").firecrawlJobStatus;
    const status = await other.execute!({ kind: "crawl", id: "crawl-1", action: "status" }, options);
    const cancelled = await other.execute!({ kind: "crawl", id: "crawl-1", action: "cancel" }, options);
    // The id is the user's, but not as a different kind of job.
    const asAgent = await tools().firecrawlJobStatus.execute!({ kind: "agent", id: "crawl-1", action: "status" }, options);

    expect([status.ok, cancelled.ok, asAgent.ok]).toEqual([false, false, false]);
    expect(calls).toHaveLength(1);
  });

  it("lets the user check their own batch scrapes and agent jobs", async () => {
    respond = ({ method, url }) =>
      method === "POST" ? Response.json({ success: true, id: url.pathname.endsWith("/agent") ? "agent-1" : "batch-1" }) : Response.json({ status: "completed", data: [] });
    await tools().firecrawlBatchScrape.execute!({ urls: ["https://a.com"] }, options);
    await tools().firecrawlAgent.execute!({ prompt: "find the founders", maxCredits: 10 }, options);

    const batch = await tools().firecrawlJobStatus.execute!({ kind: "batchScrape", id: "batch-1", action: "status" }, options);
    const agent = await tools().firecrawlJobStatus.execute!({ kind: "agent", id: "agent-1", action: "status" }, options);

    expect([batch.ok, agent.ok]).toEqual([true, true]);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/batch/scrape", "/v2/agent", "/v2/batch/scrape/batch-1", "/v2/agent/agent-1"]);
  });

  it("cancels a job it couldn't record, since nobody could reach it", async () => {
    respond = () => Response.json({ success: true, id: "crawl-1" });
    jobsTable.insertFails = true;

    const output = await tools().firecrawlCrawl.execute!({ url: "https://a.com", limit: 10 }, options);

    expect(output.ok).toBe(false);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(["POST /v2/crawl", "DELETE /v2/crawl/crawl-1"]);
  });

  it("says a job it couldn't record or cancel may still be running, and names it", async () => {
    respond = ({ method }) =>
      method === "DELETE" ? new Response("unavailable", { status: 503 }) : Response.json({ success: true, id: "crawl-1" });
    jobsTable.insertFails = true;

    const output = await tools().firecrawlCrawl.execute!({ url: "https://a.com", limit: 10 }, options);

    expect(output).toMatchObject({ ok: false, id: "crawl-1" });
    expect(output.summary).toMatch(/may still be running/);
    expect(output.summary).not.toMatch(/so it was cancelled/);
  });

  it("tells the model Firecrawl is out of credits instead of failing", async () => {
    respond = () => new Response(JSON.stringify({ success: false, error: "Payment required" }), { status: 402 });

    const output = await tools().firecrawlScrape.execute!({ url: "https://a.com" }, options);
    expect(output.ok).toBe(false);
    expect(output.summary).toMatch(/out of credits/i);
  });

  it("keeps a 100-page crawl status under 100,000 characters", async () => {
    const page = (i: number) => ({
      markdown: "word ".repeat(20_000),
      metadata: { sourceURL: `https://a.com/${i}`, title: `Page ${i}` },
    });
    respond = () => Response.json({ status: "completed", total: 100, completed: 100, data: Array.from({ length: 100 }, (_, i) => page(i)) });
    jobsTable.rows = [{ id: "crawl-1", userId: "user-1", kind: "crawl" }];

    const output = await tools().firecrawlJobStatus.execute!({ kind: "crawl", id: "crawl-1", action: "status" }, options);
    expect(JSON.stringify(output).length).toBeLessThan(100_000 + 5_000);
    expect(JSON.stringify(output.data).length).toBeLessThanOrEqual(100_000);
    expect(output.links!.length).toBeGreaterThan(50);
  });

  it("returns at most 60,000 characters of a very long page", async () => {
    respond = () => Response.json({ success: true, data: { markdown: "x".repeat(500_000), metadata: { title: "Long" } } });

    const output = await tools().firecrawlScrape.execute!({ url: "https://a.com/long" }, options);
    expect(JSON.stringify(output.data).length).toBeLessThanOrEqual(61_000);
  });

  it("keeps a page with very large extracted data within 60,000 characters", async () => {
    respond = () =>
      Response.json({ success: true, data: { markdown: "text", json: { rows: "y".repeat(200_000) }, metadata: { title: "Data" } } });

    const output = await tools().firecrawlScrape.execute!({ url: "https://a.com/data", formats: [{ type: "json", prompt: "rows" }] }, options);
    expect(JSON.stringify(output.data).length).toBeLessThanOrEqual(61_000);
    expect(Object.keys(output.data as object)).not.toContain("0");
  });

  it("explains that web search is off instead of searching", async () => {
    const off = tools(false);
    const output = await off.firecrawlSearch.execute!({ query: "news", sources: ["web"], limit: 5, scrapeResults: false }, options);

    expect(output.summary).toMatch(/web search is turned off/i);
    expect(calls).toHaveLength(0);
    expect(off.firecrawlCrawl.needsApproval).toBe(false);
  });

  it("asks before creating a monitor, but not before listing them", async () => {
    const monitor = tools().firecrawlMonitor;
    const needs = async (action: "create" | "list") =>
      typeof monitor.needsApproval === "function" && (await monitor.needsApproval({ action }, options));

    expect(await needs("create")).toBe(true);
    expect(await needs("list")).toBe(false);
  });

  it("needs approval for every costly action only while web search is on", async () => {
    const on = tools();
    const off = tools(false);
    expect([on.firecrawlCrawl, on.firecrawlBatchScrape, on.firecrawlAgent].map((t) => t.needsApproval)).toEqual([true, true, true]);
    expect([off.firecrawlCrawl, off.firecrawlBatchScrape, off.firecrawlAgent].map((t) => t.needsApproval)).toEqual([false, false, false]);

    const monitor = on.firecrawlMonitor.needsApproval;
    const asked = async (action: "list" | "get" | "create" | "update" | "delete" | "run" | "checks") =>
      typeof monitor === "function" && (await monitor({ action }, options));
    expect(await Promise.all((["create", "update", "delete", "run"] as const).map(asked))).toEqual([true, true, true, true]);
    expect(await Promise.all((["list", "get", "checks"] as const).map(asked))).toEqual([false, false, false]);
  });

  it("sends at most 100 URLs in a batch, and ends a forgotten browser session after 10 minutes", async () => {
    respond = () => Response.json({ success: true, id: "job-1" });
    const urls = Array.from({ length: 250 }, (_, i) => `https://a.com/${i}`);

    const batch = await tools().firecrawlBatchScrape.execute!({ urls }, options);
    expect((calls[0]!.body as { urls: string[] }).urls).toHaveLength(100);
    expect(batch.summary).toContain("150");

    await tools().firecrawlInteract.execute!({ action: "start" }, options);
    expect(calls[1]!.body).toMatchObject({ ttl: 600 });
  });

  it("caps what a monitor may crawl or scrape on every check", () => {
    const monitor = firecrawlInputs.firecrawlMonitor;
    const crawlTarget = (limit: number) => ({ action: "create", targets: [{ type: "crawl", url: "https://a.com", crawlOptions: { limit } }] });

    expect(monitor.safeParse(crawlTarget(100)).success).toBe(true);
    expect(monitor.safeParse(crawlTarget(500)).success).toBe(false);
    const manyUrls = Array.from({ length: 101 }, (_, i) => `https://a.com/${i}`);
    expect(monitor.safeParse({ action: "create", targets: [{ type: "scrape", urls: manyUrls }] }).success).toBe(false);
  });

  it("only accepts plain ids, so an id can't change the API path", () => {
    for (const id of ["../x", "a/b", "a?b=1", "%2e%2e", "", "x".repeat(101)]) {
      expect(firecrawlInputs.firecrawlJobStatus.safeParse({ kind: "crawl", id }).success).toBe(false);
      expect(firecrawlInputs.firecrawlInteract.safeParse({ action: "stop", sessionId: id }).success).toBe(false);
    }
    expect(firecrawlInputs.firecrawlJobStatus.safeParse({ kind: "crawl", id: "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b" }).success).toBe(true);
  });

  it("keeps a long scraped search result instead of dropping it", async () => {
    respond = () => Response.json({ success: true, data: { web: [{ url: "https://a.com", title: "A", markdown: "z".repeat(200_000) }] } });

    const output = await tools().firecrawlSearch.execute!({ query: "a", sources: ["web"], limit: 1, scrapeResults: true }, options);
    expect(output.links).toHaveLength(1);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(100_000);
  });
});

describe("monitors on the shared Firecrawl account", () => {
  const monitor = (id: string, owner: string) => ({ id, name: `[cloudchat:${owner}] Price watch`, webhook: { url: "https://hook" } });

  it("lists only the user's own monitors, without their delivery settings", async () => {
    respond = () => Response.json({ success: true, data: [monitor("m1", "user-1"), monitor("m2", "user-2")] });

    const output = await tools().firecrawlMonitor.execute!({ action: "list" }, options);
    expect(JSON.stringify(output.data)).toContain("m1");
    expect(JSON.stringify(output.data)).not.toContain("m2");
    expect(JSON.stringify(output.data)).not.toContain("hook");
  });

  it("refuses to change another user's monitor", async () => {
    respond = () => Response.json({ success: true, data: monitor("m2", "user-2") });

    const output = await tools().firecrawlMonitor.execute!({ action: "delete", monitorId: "m2" }, options);
    expect(output).toMatchObject({ ok: false, summary: "No monitor with that id." });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("records the owner in a new monitor's name", async () => {
    respond = () => Response.json({ success: true, data: { id: "m3" } });

    await tools().firecrawlMonitor.execute!({ action: "create", name: "Price watch" }, options);
    expect(calls[0]!.body).toMatchObject({ name: "[cloudchat:user-1] Price watch" });
  });
});

describe("parsing a selected file", () => {
  const folder = "00000000-0000-4000-8000-0000000000aa";
  const selection = { fileMetadata: [], folderMetadata: [{ id: folder, visibility: "private", folderId: folder, owner: "user-1" }] };

  function parseTool(objects: Record<string, string>, enabled = true) {
    const get = vi.fn(async (key: string) =>
      key in objects ? { arrayBuffer: async () => new TextEncoder().encode(objects[key]).buffer } : null,
    );
    const env = { CLOUDBOT_BUCKET: { get } } as unknown as Bindings;
    return { get, tool: firecrawlTools({ env, userId: "user-1", enabled, ...selection } as Parameters<typeof firecrawlTools>[0]).firecrawlParse };
  }

  it("uploads the user's own copy of the file and returns its text, capped", async () => {
    filesTable.rows = [{ name: "deck.pdf", visibility: "private", folderId: folder }];
    respond = () => Response.json({ success: true, data: { markdown: "q".repeat(300_000) } });
    const { get, tool } = parseTool({ [`user-1/${folder}/deck.pdf`]: "%PDF" });

    const output = await tool.execute!({ filename: "deck.pdf" }, options);

    expect(get).toHaveBeenCalledWith(`user-1/${folder}/deck.pdf`);
    expect(calls[0]!.url.pathname).toBe("/v2/parse");
    expect((calls[0]!.body as FormData).get("file")).toBeInstanceOf(Blob);
    expect(output.ok).toBe(true);
    expect(JSON.stringify(output.data).length).toBeLessThanOrEqual(61_000);
  });

  it("uploads nothing for a file outside the selection", async () => {
    filesTable.rows = [];
    const { get, tool } = parseTool({});

    const output = await tool.execute!({ filename: "other.pdf" }, options);
    expect(output.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("uploads nothing when web search is off", async () => {
    filesTable.rows = [{ name: "deck.pdf", visibility: "private", folderId: folder }];
    const { get, tool } = parseTool({}, false);

    expect((await tool.execute!({ filename: "deck.pdf" }, options)).summary).toMatch(/web search is turned off/i);
    expect(get).not.toHaveBeenCalled();
  });
});
