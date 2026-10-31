import { firecrawlTools } from "@workspace/api-routes/lib/tools/firecrawl-tools.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every Firecrawl v2 capability is a tool. Costly ones ask first and run under
// caps, and every result is kept small enough to stay in the history for good.

type Call = { method: string; url: URL; body: unknown; auth: string | null };

let calls: Call[] = [];
let respond: (call: Call) => Response = () => Response.json({ success: true });

beforeEach(() => {
  calls = [];
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

const tools = (enabled = true) =>
  firecrawlTools({ env: {} as Bindings, userId: "user-1", enabled, fileMetadata: [], folderMetadata: [] });

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

    expect(typeof crawl.needsApproval === "function" && (await crawl.needsApproval({ url: "https://a.com", limit: 500 }, options))).toBe(true);
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

    expect(typeof interact.needsApproval === "function" && (await interact.needsApproval({ action: "start" }, options))).toBe(true);
    expect(typeof interact.needsApproval === "function" && (await interact.needsApproval({ action: "execute", sessionId: "sess-1" }, options))).toBe(false);

    const started = await interact.execute!({ action: "start" }, options);
    expect(started).toMatchObject({ id: "sess-1", liveViewUrl: "https://live/sess-1" });

    const ran = await interact.execute!({ action: "execute", sessionId: started.id, code: "await page.click('#login')" }, options);
    expect(calls[1]!.url.pathname).toBe("/v2/interact/sess-1/execute");
    expect(JSON.stringify(ran.data)).toContain("Logged in");

    await interact.execute!({ action: "stop", sessionId: started.id }, options);
    expect(calls[2]).toMatchObject({ method: "DELETE" });
    expect(calls[2]!.url.pathname).toBe("/v2/interact/sess-1");
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

  it("explains that web search is off instead of searching", async () => {
    const off = tools(false);
    const output = await off.firecrawlSearch.execute!({ query: "news", sources: ["web"], limit: 5, scrapeResults: false }, options);

    expect(output.summary).toMatch(/web search is turned off/i);
    expect(calls).toHaveLength(0);
    expect(typeof off.firecrawlCrawl.needsApproval === "function" && (await off.firecrawlCrawl.needsApproval({ url: "https://a.com", limit: 5 }, options))).toBe(false);
  });

  it("asks before creating a monitor, but not before listing them", async () => {
    const monitor = tools().firecrawlMonitor;
    const needs = async (action: "create" | "list") =>
      typeof monitor.needsApproval === "function" && (await monitor.needsApproval({ action }, options));

    expect(await needs("create")).toBe(true);
    expect(await needs("list")).toBe(false);
  });
});
