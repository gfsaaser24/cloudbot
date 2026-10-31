import { db } from "@workspace/server/drizzle/db.js";
import { firecrawlJobs } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import { tool } from "ai";
import { and, eq } from "drizzle-orm";
import * as z from "zod";
import { type Bindings } from "../../types/bindings.js";
import { fileKey } from "../../utils/build-metadata-filter.js";
import { type FileMetadata } from "../../utils/filter-authorized-files.js";
import { type FolderMetadata } from "../../utils/filter-authorized-folders.js";
import { firecrawlRequest, type FirecrawlResponse } from "../firecrawl.js";
import { findSelectedFile } from "./read-file.js";

// Every Firecrawl v2 capability as a tool. Results stay in the conversation
// history for good, so each tool caps what it returns: one page at most
// PAGE_CHARS, a list of pages or results at most LIST_CHARS in total. The model
// reads a full page with firecrawlScrape. Actions that can spend many credits
// ask the user first and run under hard caps.

const PAGE_CHARS = 60_000;
const LIST_CHARS = 100_000;
const EXCERPT_CHARS = 500;

const MAX_CRAWL_PAGES = 100;
const MAX_BATCH_URLS = 100;
const MAX_AGENT_CREDITS = 500;
const MAX_MAP_LINKS = 1_000;
const MAX_MONITOR_TARGETS = 20;
// Browser sessions bill while open; one the model forgets to stop ends itself.
const DEFAULT_SESSION_SECONDS = 600;

const link = z.object({ url: z.string(), title: z.string().optional() });
type Link = z.infer<typeof link>;

export const firecrawlOutput = z.object({
  ok: z.boolean(),
  // One line for the tool card, and for the model.
  summary: z.string(),
  // A job or session id to pass to a follow-up call.
  id: z.string().optional(),
  status: z.string().optional(),
  // Pages the answer can cite.
  links: z.array(link).optional(),
  // A live view of an interact session.
  liveViewUrl: z.string().optional(),
  // The result for the model, already capped in size.
  data: z.unknown().optional(),
});

export type FirecrawlOutput = z.infer<typeof firecrawlOutput>;

// Ids go into URL paths, so only plain ids are accepted.
const jobId = z.string().regex(/^[\w-]{1,100}$/, "Not a Firecrawl id");

// Every CloudChat user shares one Firecrawl account, so each job and browser
// session is recorded with the user who started it, and only that user can
// check, cancel or use it.
type JobKind = (typeof firecrawlJobs.kind.enumValues)[number];

const logger = createLogger("firecrawl-tools");

// Records a job or session that just started. If the record can't be saved,
// nobody could reach the job to check or stop it, so it is cancelled and the
// failure returned. If cancelling fails too, the failure says the job may
// still be running and names it, so it can be stopped by hand.
async function recordJob(userId: string, kind: JobKind, id: string): Promise<FirecrawlOutput | undefined> {
  try {
    await db().insert(firecrawlJobs).values({ id, userId, kind });
    return undefined;
  } catch (error) {
    logger.error("Could not record a Firecrawl job", { kind, id, error });
    const cancel = await firecrawlRequest("DELETE", kind === "interact" ? `/interact/${id}` : `${JOB_PATH[kind]}/${id}`);
    if (cancel.ok) return failed("The job couldn't be recorded, so it was cancelled. Try again.");
    logger.error("Could not cancel an unrecorded Firecrawl job", { kind, id, error: cancel.error });
    return {
      ...failed(
        `The job couldn't be recorded, and cancelling it failed (${cancel.error}), so ${kind} ${id} may still be running and can't be checked or stopped from this chat. Tell the user before starting it again.`,
      ),
      id,
    };
  }
}

async function ownsJob(userId: string, kind: JobKind, id: string) {
  const [job] = await db()
    .select({ id: firecrawlJobs.id })
    .from(firecrawlJobs)
    .where(and(eq(firecrawlJobs.id, id), eq(firecrawlJobs.userId, userId), eq(firecrawlJobs.kind, kind)))
    .limit(1);
  return job !== undefined;
}

function clip(text: string | undefined, max: number): string {
  if (!text) return "";
  return text.length > max
    ? `${text.slice(0, max)}\n\n[Cut at ${max.toLocaleString("en-US")} characters.]`
    : text;
}

// A JSON value as is when small enough, otherwise as cut-off JSON text.
function clipJson(value: unknown, max: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value);
  return json.length > max ? clip(json, max) : value;
}

// Keeps a list under LIST_CHARS by dropping items from the end. An item with a
// URL also counts the citation link the output lists for it.
function fitList<T extends Partial<Link>>(items: T[]): { items: T[]; omitted: number } {
  let size = 2;
  const kept: T[] = [];
  for (const item of items) {
    size += JSON.stringify(item).length + 1;
    if (item.url) size += JSON.stringify({ url: item.url, title: item.title }).length + 1;
    if (size > LIST_CHARS) break;
    kept.push(item);
  }
  return { items: kept, omitted: items.length - kept.length };
}

function failed(error: string): FirecrawlOutput {
  return { ok: false, summary: error };
}

const WEB_OFF: FirecrawlOutput = {
  ok: false,
  summary:
    "Web search is turned off for this message. Answer without it, or ask the user to turn on web search.",
};

const firstString = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

// ---------------------------------------------------------------- scrape

const scrapeFormat = z.union([
  z.enum([
    "markdown",
    "summary",
    "html",
    "rawHtml",
    "links",
    "images",
    "screenshot",
    "branding",
    "product",
    "menu",
    "audio",
    "video",
  ]),
  z.object({
    type: z.literal("json"),
    prompt: z.string().optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("question"), question: z.string() }),
  z.object({ type: z.literal("highlights"), query: z.string() }),
  z.object({
    type: z.literal("attributes"),
    selectors: z.array(z.object({ selector: z.string(), attribute: z.string() })),
  }),
  z.object({
    type: z.literal("changeTracking"),
    modes: z.array(z.enum(["git-diff", "json"])).optional(),
    prompt: z.string().optional(),
    tag: z.string().optional(),
  }),
  z.object({
    type: z.literal("screenshot"),
    fullPage: z.boolean().optional(),
  }),
]);

const scrapeAction = z.union([
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().optional(), selector: z.string().optional() }),
  z.object({ type: z.literal("click"), selector: z.string(), all: z.boolean().optional() }),
  z.object({ type: z.literal("write"), text: z.string() }),
  z.object({ type: z.literal("press"), key: z.string() }),
  z.object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]).optional(), selector: z.string().optional() }),
  z.object({ type: z.literal("screenshot"), fullPage: z.boolean().optional() }),
  z.object({ type: z.literal("scrape") }),
  z.object({ type: z.literal("executeJavascript"), script: z.string() }),
  z.object({ type: z.literal("pdf"), format: z.string().optional(), landscape: z.boolean().optional() }),
]);

const firecrawlScrapeInput = z.object({
  url: z.url(),
  formats: z
    .array(scrapeFormat)
    .optional()
    .describe(
      "What to return; Markdown by default. json extracts structured data with a prompt or schema, question answers a question about the page, highlights returns the passages matching a query, changeTracking compares with the last scrape.",
    ),
  actions: z
    .array(scrapeAction)
    .optional()
    .describe("Browser actions to run before scraping: click, type, scroll, wait, screenshots."),
  onlyMainContent: z.boolean().optional(),
  waitFor: z.number().int().min(0).max(30_000).optional(),
  mobile: z.boolean().optional(),
  maxAge: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Accept a cached copy up to this many milliseconds old; 0 forces a fresh scrape."),
  location: z
    .object({ country: z.string().optional(), languages: z.array(z.string()).optional() })
    .optional(),
});

type ScrapeData = {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  summary?: string;
  answer?: string;
  highlights?: unknown;
  json?: unknown;
  links?: string[];
  images?: string[];
  screenshot?: string;
  audio?: string;
  video?: string;
  attributes?: unknown;
  changeTracking?: unknown;
  branding?: unknown;
  product?: unknown;
  menu?: unknown;
  actions?: unknown;
  metadata?: { title?: string | string[]; sourceURL?: string; url?: string };
};

// One page for the model, at most PAGE_CHARS in total.
function shapePage(url: string, page: ScrapeData) {
  const extras = clipJson(
    {
      summary: page.summary,
      answer: page.answer,
      highlights: page.highlights,
      json: page.json,
      attributes: page.attributes,
      changeTracking: page.changeTracking,
      branding: page.branding,
      product: page.product,
      menu: page.menu,
      actions: page.actions,
      screenshot: page.screenshot,
      audio: page.audio,
      video: page.video,
      links: page.links?.slice(0, 200),
      images: page.images?.slice(0, 50),
    },
    PAGE_CHARS / 3,
  );
  const budget = PAGE_CHARS - JSON.stringify(extras).length;
  const content = page.markdown ?? page.html ?? page.rawHtml;
  return {
    title: firstString(page.metadata?.title) ?? url,
    url: page.metadata?.sourceURL ?? page.metadata?.url ?? url,
    content: clip(content, Math.max(budget, 0)),
    // Cut-off extras are a string, which can't be spread.
    ...(typeof extras === "object" && extras !== null ? extras : { extras }),
  };
}

// ---------------------------------------------------------------- search

const searchSource = z.enum(["web", "news", "images", "research", "gov", "developer"]);

const firecrawlSearchInput = z.object({
  query: z.string(),
  sources: z
    .array(searchSource)
    .default(["web"])
    .describe(
      "Where to search: the web, news, images, research papers, government and legal sources, or developer docs and code.",
    ),
  limit: z.number().int().min(1).max(20).default(8),
  scrapeResults: z
    .boolean()
    .default(false)
    .describe("Also return each web result's page content (one credit per page)."),
  tbs: z.string().optional().describe("Time filter, e.g. qdr:d (past day), qdr:w, qdr:m, qdr:y."),
  location: z.string().optional(),
  country: z.string().optional(),
  includeDomains: z.array(z.string()).optional(),
  excludeDomains: z.array(z.string()).optional(),
});

type SearchResult = {
  source: string;
  title: string;
  url: string;
  excerpt?: string;
  content?: string;
};

type WebSearchItem = {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
  markdown?: string;
  imageUrl?: string;
};

function paperUrl(paperId: string, primaryId?: string): string {
  const id = primaryId ?? paperId;
  const [namespace, ...rest] = id.split(":");
  const value = rest.join(":");
  switch (namespace) {
    case "arxiv":
      return `https://arxiv.org/abs/${value}`;
    case "doi":
      return `https://doi.org/${value}`;
    case "pmid":
      return `https://pubmed.ncbi.nlm.nih.gov/${value}`;
    case "pmcid":
      return `https://www.ncbi.nlm.nih.gov/pmc/articles/${value}`;
    case "web":
      return value;
    default:
      return id;
  }
}

async function searchOne(
  source: z.infer<typeof searchSource>,
  input: z.infer<typeof firecrawlSearchInput>,
  // How much of each scraped result's page fits in the list.
  contentChars: number,
): Promise<FirecrawlResponse<SearchResult[]>> {
  const { query, limit } = input;

  if (source === "research") {
    const result = await firecrawlRequest<{
      results?: { paperId: string; primaryId?: string; title?: string; abstract?: string }[];
    }>("GET", "/search/research/papers", { query: { query, k: limit } });
    if (!result.ok) return result;
    return {
      ok: true,
      data: (result.data.results ?? []).map((paper) => ({
        source,
        title: paper.title ?? paper.paperId,
        url: paperUrl(paper.paperId, paper.primaryId),
        excerpt: clip(paper.abstract, EXCERPT_CHARS * 2),
      })),
    };
  }

  if (source === "gov") {
    const result = await firecrawlRequest<{
      data?: { web?: { url: string; title?: string; description?: string }[] };
    }>("POST", "/search/gov", { body: { query, k: limit } });
    if (!result.ok) return result;
    return {
      ok: true,
      data: (result.data.data?.web ?? []).map((item) => ({
        source,
        title: item.title ?? item.url,
        url: item.url,
        excerpt: clip(item.description, EXCERPT_CHARS),
      })),
    };
  }

  if (source === "developer") {
    const result = await firecrawlRequest<{
      results?: { url: string; title?: string; passages?: { text?: string }[] }[];
    }>("POST", "/search/developer", { body: { query, k: limit } });
    if (!result.ok) return result;
    return {
      ok: true,
      data: (result.data.results ?? []).map((item) => ({
        source,
        title: item.title ?? item.url,
        url: item.url,
        excerpt: clip(
          item.passages?.map((p) => p.text ?? "").join("\n\n"),
          EXCERPT_CHARS * 4,
        ),
      })),
    };
  }

  const result = await firecrawlRequest<{
    data?: Partial<Record<"web" | "news" | "images", WebSearchItem[]>>;
  }>("POST", "/search", {
    body: {
      query,
      limit,
      sources: [{ type: source }],
      tbs: input.tbs,
      location: input.location,
      country: input.country,
      includeDomains: input.includeDomains,
      excludeDomains: input.excludeDomains,
      ...(input.scrapeResults && source !== "images"
        ? { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }
        : {}),
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    data: (result.data.data?.[source] ?? []).flatMap((item) => {
      const url = item.url ?? item.imageUrl;
      if (!url) return [];
      return [
        {
          source,
          title: item.title ?? url,
          url,
          excerpt: clip(item.description ?? item.snippet, EXCERPT_CHARS),
          ...(item.markdown ? { content: clip(item.markdown, contentChars) } : {}),
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------- jobs

const crawlKind = z.enum(["crawl", "batchScrape", "agent"]);

const JOB_LABEL: Record<z.infer<typeof crawlKind>, string> = {
  crawl: "Crawl",
  batchScrape: "Batch scrape",
  agent: "Agent",
};

const JOB_PATH: Record<z.infer<typeof crawlKind>, string> = {
  crawl: "/crawl",
  batchScrape: "/batch/scrape",
  agent: "/agent",
};

type PageList = {
  status?: string;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  data?: ScrapeData[];
};

type AgentStatus = {
  status?: string;
  data?: unknown;
  error?: string;
  message?: string;
  creditsUsed?: number;
};

function shapePageList(kind: z.infer<typeof crawlKind>, job: PageList): FirecrawlOutput {
  const pages = (job.data ?? []).map((page) => {
    const url = page.metadata?.sourceURL ?? page.metadata?.url ?? "";
    return {
      url,
      title: firstString(page.metadata?.title) ?? url,
      excerpt: clip(page.markdown, EXCERPT_CHARS),
    };
  });
  const { items, omitted } = fitList(pages);
  const progress =
    job.total !== undefined ? `${job.completed ?? 0} of ${job.total} pages` : `${pages.length} pages`;
  return {
    ok: true,
    status: job.status,
    summary: `${JOB_LABEL[kind]} ${job.status ?? "status"}: ${progress}${job.creditsUsed !== undefined ? `, ${job.creditsUsed} credits used` : ""}.${omitted ? ` ${omitted} more pages not listed.` : ""} Read a page in full with firecrawlScrape.`,
    links: items.map(({ url, title }) => ({ url, title })),
    data: { pages: items, omitted },
  };
}

// ---------------------------------------------------------------- interact

const interactAction = z.enum(["start", "execute", "stop"]);

// ---------------------------------------------------------------- monitors

const monitorAction = z.enum(["list", "get", "create", "update", "delete", "run", "checks"]);
// Monitors spend credits on a schedule, so anything that changes or runs one
// needs the user's approval.
const MONITOR_ACTIONS_NEEDING_APPROVAL: ReadonlySet<z.infer<typeof monitorAction>> =
  new Set(["create", "update", "delete", "run"]);

// A monitor runs its targets on every check, so they get the same caps as a
// one-off crawl or batch scrape.
const monitorTarget = z.union([
  z.object({
    type: z.literal("scrape"),
    urls: z.array(z.url()).min(1).max(MAX_BATCH_URLS),
  }),
  z.object({
    type: z.literal("crawl"),
    url: z.url(),
    crawlOptions: z
      .object({
        limit: z.number().int().min(1).max(MAX_CRAWL_PAGES).default(20),
        maxDiscoveryDepth: z.number().int().min(1).optional(),
        includePaths: z.array(z.string()).optional(),
        excludePaths: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("search"),
    queries: z.array(z.string().min(1).max(256)).min(1).max(12),
  }),
]);

type Monitor = {
  id?: string;
  name?: string;
  webhook?: unknown;
  notification?: unknown;
  [field: string]: unknown;
};

// A monitor as the model sees it: without its delivery settings.
function forModel({ webhook: _webhook, notification: _notification, ...monitor }: Monitor) {
  return monitor;
}

// ---------------------------------------------------------------- tools

export const firecrawlInputs = {
  firecrawlScrape: firecrawlScrapeInput,
  firecrawlSearch: firecrawlSearchInput,
  firecrawlMap: z.object({
    url: z.url(),
    search: z.string().optional().describe("Order the links by relevance to this text."),
    limit: z.number().int().min(1).max(MAX_MAP_LINKS).default(200),
    includeSubdomains: z.boolean().optional(),
    sitemap: z.enum(["skip", "include", "only"]).optional(),
  }),
  firecrawlCrawl: z.object({
    url: z.url(),
    prompt: z
      .string()
      .optional()
      .describe("What to crawl, in words; Firecrawl turns it into crawl settings."),
    limit: z
      .number()
      .int()
      .min(1)
      .default(20)
      .describe(`Pages to crawl; at most ${MAX_CRAWL_PAGES}.`),
    includePaths: z.array(z.string()).optional(),
    excludePaths: z.array(z.string()).optional(),
    maxDiscoveryDepth: z.number().int().min(1).optional(),
    crawlEntireDomain: z.boolean().optional(),
    allowSubdomains: z.boolean().optional(),
    sitemap: z.enum(["skip", "include", "only"]).optional(),
  }),
  firecrawlBatchScrape: z.object({
    urls: z.array(z.url()).min(1).describe(`At most ${MAX_BATCH_URLS} URLs.`),
    onlyMainContent: z.boolean().optional(),
  }),
  firecrawlAgent: z.object({
    prompt: z.string().describe("What to find or extract, in words."),
    urls: z.array(z.url()).optional().describe("Pages to start from, if known."),
    schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON schema for the result, when a fixed structure is wanted."),
    maxCredits: z
      .number()
      .int()
      .min(1)
      .default(200)
      .describe(`Credit budget for the agent; at most ${MAX_AGENT_CREDITS}.`),
    model: z.enum(["spark-2", "spark-1-mini", "spark-1-pro"]).optional(),
  }),
  firecrawlJobStatus: z.object({
    kind: crawlKind,
    id: jobId,
    action: z.enum(["status", "cancel", "errors"]).default("status"),
  }),
  firecrawlInteract: z.object({
    action: interactAction,
    sessionId: jobId.optional().describe("The session from the start call; for execute and stop."),
    code: z
      .string()
      .optional()
      .describe("For execute: code to run against the session's live browser (Playwright in node by default)."),
    language: z.enum(["node", "python", "bash"]).optional(),
    timeoutSeconds: z.number().int().min(1).max(300).optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(3_600)
      .optional()
      .describe("For start: how long the session may live."),
  }),
  firecrawlParse: z.object({
    filename: z.string().describe("A file in the selected folders or files, exactly as listed."),
    folderId: z.string().optional(),
  }),
  firecrawlMonitor: z.object({
    action: monitorAction,
    monitorId: jobId.optional(),
    checkId: jobId.optional().describe("For checks: one check to inspect."),
    name: z.string().optional(),
    schedule: z
      .object({
        cron: z.string().optional(),
        text: z.string().optional().describe("e.g. 'every weekday at 9am'"),
        timezone: z.string().optional(),
      })
      .optional(),
    goal: z.string().optional().describe("What changes or results to alert on."),
    targets: z.array(monitorTarget).max(MAX_MONITOR_TARGETS).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
  }),
  firecrawlCreditUsage: z.object({}),
};

type Props = {
  env: Bindings;
  userId: string;
  // The user's web search toggle for this message.
  enabled: boolean;
  // The files and folders the chat may read (already permission-checked).
  fileMetadata: FileMetadata[];
  folderMetadata: FolderMetadata[];
};

// Registered on every turn; with web search off they explain instead of running.
export function firecrawlTools({ env, userId, enabled, fileMetadata, folderMetadata }: Props) {
  return {
    firecrawlScrape: tool({
      description:
        "Scrapes one URL and returns its content (Markdown by default), with optional formats (summary, links, images, screenshot, structured json, a question answered about the page, highlights, change tracking, branding) and browser actions before scraping. Use it to read any page in full, including pages listed by other Firecrawl tools.",
      inputSchema: firecrawlInputs.firecrawlScrape,
      outputSchema: firecrawlOutput,
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const result = await firecrawlRequest<{ data?: ScrapeData }>("POST", "/scrape", {
          body: { ...input, formats: input.formats ?? ["markdown"] },
        });
        if (!result.ok) return failed(result.error);
        const page = shapePage(input.url, result.data.data ?? {});
        return {
          ok: true,
          summary: `Scraped ${page.title}.`,
          links: [{ url: page.url, title: page.title }],
          data: page,
        };
      },
    }),

    firecrawlSearch: tool({
      description:
        "Searches the web, news, images, research papers (arXiv, PubMed, DOI), government and legal sources, or developer docs and code, and returns titles, URLs and excerpts. Set scrapeResults to also get each web result's content. Cite results as [[web:url]].",
      inputSchema: firecrawlInputs.firecrawlSearch,
      outputSchema: firecrawlOutput,
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const sources = [...new Set(input.sources)];
        // Room for every result's page, with space left for titles and links.
        const contentChars = Math.min(
          PAGE_CHARS,
          Math.floor(LIST_CHARS / (input.limit * sources.length + 1)),
        );
        const responses = await Promise.all(
          sources.map((source) => searchOne(source, input, contentChars)),
        );
        const errors = responses.flatMap((r) => (r.ok ? [] : [r.error]));
        const results = responses.flatMap((r) => (r.ok ? r.data : []));
        if (results.length === 0 && errors.length > 0) return failed(errors.join(" "));

        const { items, omitted } = fitList(results);
        return {
          ok: true,
          summary: `${items.length} results${omitted ? ` (${omitted} more not listed)` : ""}.${errors.length ? ` Some sources failed: ${errors.join(" ")}` : ""}`,
          links: items.map(({ url, title }) => ({ url, title })),
          data: { results: items },
        };
      },
    }),

    firecrawlMap: tool({
      description:
        "Lists the URLs of a website (from its sitemap and links), optionally ordered by relevance to a search text. Use it to find the right pages before scraping or crawling.",
      inputSchema: firecrawlInputs.firecrawlMap,
      outputSchema: firecrawlOutput,
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const result = await firecrawlRequest<{ links?: Link[] }>("POST", "/map", { body: input });
        if (!result.ok) return failed(result.error);
        const { items, omitted } = fitList(result.data.links ?? []);
        return {
          ok: true,
          summary: `${items.length} URLs on ${input.url}${omitted ? ` (${omitted} more not listed)` : ""}.`,
          data: { links: items },
        };
      },
    }),

    firecrawlCrawl: tool({
      description: `Starts crawling a website from a URL, following its links, up to ${MAX_CRAWL_PAGES} pages. Asks the user to approve first because it can use many credits. Returns a job id; check progress and results with firecrawlJobStatus (kind crawl).`,
      inputSchema: firecrawlInputs.firecrawlCrawl,
      outputSchema: firecrawlOutput,
      needsApproval: enabled,
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const limit = Math.min(input.limit, MAX_CRAWL_PAGES);
        const result = await firecrawlRequest<{ id: string }>("POST", "/crawl", {
          body: {
            ...input,
            limit,
            scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
          },
        });
        if (!result.ok) return failed(result.error);
        const unrecorded = await recordJob(userId, "crawl", result.data.id);
        if (unrecorded) return unrecorded;
        return {
          ok: true,
          id: result.data.id,
          status: "started",
          summary: `Crawl of ${input.url} started (up to ${limit} pages). Check it with firecrawlJobStatus, kind crawl, id ${result.data.id}.`,
        };
      },
    }),

    firecrawlBatchScrape: tool({
      description: `Starts scraping many URLs at once (at most ${MAX_BATCH_URLS}). Asks the user to approve first. Returns a job id; check results with firecrawlJobStatus (kind batchScrape).`,
      inputSchema: firecrawlInputs.firecrawlBatchScrape,
      outputSchema: firecrawlOutput,
      needsApproval: enabled,
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const urls = input.urls.slice(0, MAX_BATCH_URLS);
        const result = await firecrawlRequest<{ id: string }>("POST", "/batch/scrape", {
          body: { urls, formats: ["markdown"], onlyMainContent: input.onlyMainContent ?? true },
        });
        if (!result.ok) return failed(result.error);
        const unrecorded = await recordJob(userId, "batchScrape", result.data.id);
        if (unrecorded) return unrecorded;
        const dropped = input.urls.length - urls.length;
        return {
          ok: true,
          id: result.data.id,
          status: "started",
          summary: `Batch scrape of ${urls.length} URLs started${dropped ? ` (${dropped} over the limit were left out)` : ""}. Check it with firecrawlJobStatus, kind batchScrape, id ${result.data.id}.`,
        };
      },
    }),

    firecrawlAgent: tool({
      description: `Starts Firecrawl's research agent, which searches, navigates and extracts what the prompt asks for, optionally into a JSON schema. Asks the user to approve first; spends at most ${MAX_AGENT_CREDITS} credits. Returns a job id; get the result with firecrawlJobStatus (kind agent).`,
      inputSchema: firecrawlInputs.firecrawlAgent,
      outputSchema: firecrawlOutput,
      needsApproval: enabled,
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const maxCredits = Math.min(input.maxCredits, MAX_AGENT_CREDITS);
        const result = await firecrawlRequest<{ id: string }>("POST", "/agent", {
          body: { ...input, maxCredits },
        });
        if (!result.ok) return failed(result.error);
        const unrecorded = await recordJob(userId, "agent", result.data.id);
        if (unrecorded) return unrecorded;
        return {
          ok: true,
          id: result.data.id,
          status: "started",
          summary: `Agent started (up to ${maxCredits} credits). Get the result with firecrawlJobStatus, kind agent, id ${result.data.id}.`,
        };
      },
    }),

    firecrawlJobStatus: tool({
      description:
        "Checks a crawl, batch scrape or agent job: its progress and results (crawl and batch results list pages with titles, URLs and excerpts), its errors, or cancels it.",
      inputSchema: firecrawlInputs.firecrawlJobStatus,
      outputSchema: firecrawlOutput,
      execute: async ({ kind, id, action }): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        if (!(await ownsJob(userId, kind, id))) return failed(`No ${kind} job with that id.`);
        const path = `${JOB_PATH[kind]}/${id}`;

        if (action === "cancel") {
          const result = await firecrawlRequest<unknown>("DELETE", path);
          if (!result.ok) return failed(result.error);
          return { ok: true, id, status: "cancelled", summary: `The ${kind} job was cancelled.` };
        }

        if (action === "errors") {
          if (kind === "agent") return failed("Agent jobs report errors in their status.");
          const result = await firecrawlRequest<{ errors?: unknown[]; robotsBlocked?: string[] }>(
            "GET",
            `${path}/errors`,
          );
          if (!result.ok) return failed(result.error);
          const errors = result.data.errors ?? [];
          return {
            ok: true,
            id,
            summary: `${errors.length} errors, ${result.data.robotsBlocked?.length ?? 0} URLs blocked by robots.txt.`,
            data: clipJson(result.data, LIST_CHARS),
          };
        }

        if (kind === "agent") {
          const result = await firecrawlRequest<AgentStatus>("GET", path);
          if (!result.ok) return failed(result.error);
          const job = result.data;
          return {
            ok: true,
            id,
            status: job.status,
            summary: `Agent ${job.status ?? "status"}${job.creditsUsed !== undefined ? `, ${job.creditsUsed} credits used` : ""}.${job.error ? ` ${job.error}` : ""}`,
            data: clipJson({ data: job.data, message: job.message }, LIST_CHARS),
          };
        }

        const result = await firecrawlRequest<PageList>("GET", path);
        if (!result.ok) return failed(result.error);
        return { ...shapePageList(kind, result.data), id };
      },
    }),

    firecrawlInteract: tool({
      description:
        "Controls a live browser session: start one, execute code in it (Playwright in node by default) to click, type, log in or read the page, then stop it. Starting a session and every execute ask the user to approve first. Pass the sessionId from start to every later call.",
      inputSchema: firecrawlInputs.firecrawlInteract,
      outputSchema: firecrawlOutput,
      needsApproval: ({ action }) => enabled && action !== "stop",
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;

        if (input.action === "start") {
          const result = await firecrawlRequest<{
            id: string;
            liveViewUrl?: string;
            expiresAt?: string;
          }>("POST", "/interact", { body: { ttl: input.ttlSeconds ?? DEFAULT_SESSION_SECONDS } });
          if (!result.ok) return failed(result.error);
          const unrecorded = await recordJob(userId, "interact", result.data.id);
          if (unrecorded) return unrecorded;
          return {
            ok: true,
            id: result.data.id,
            status: "started",
            liveViewUrl: result.data.liveViewUrl,
            summary: `Browser session ${result.data.id} started${result.data.expiresAt ? `, expires ${result.data.expiresAt}` : ""}. Pass it as sessionId to execute and stop.`,
          };
        }

        if (!input.sessionId) return failed("This action needs the sessionId from the start call.");
        if (!(await ownsJob(userId, "interact", input.sessionId))) {
          return failed("No browser session with that id.");
        }

        if (input.action === "stop") {
          const result = await firecrawlRequest<unknown>("DELETE", `/interact/${input.sessionId}`);
          if (!result.ok) return failed(result.error);
          return { ok: true, id: input.sessionId, status: "stopped", summary: "Browser session stopped." };
        }

        if (!input.code) return failed("execute needs code to run.");
        const result = await firecrawlRequest<{
          stdout?: string;
          stderr?: string;
          result?: string;
          exitCode?: number;
          error?: string;
        }>("POST", `/interact/${input.sessionId}/execute`, {
          body: { code: input.code, language: input.language, timeout: input.timeoutSeconds },
          // The code may run for up to its own timeout, plus time to report back.
          timeoutMs: ((input.timeoutSeconds ?? 30) + 30) * 1000,
        });
        if (!result.ok) return failed(result.error);
        const run = result.data;
        return {
          ok: run.exitCode === undefined || run.exitCode === 0,
          id: input.sessionId,
          summary: run.error ?? `Code ran${run.exitCode !== undefined ? ` (exit code ${run.exitCode})` : ""}.`,
          data: {
            result: clip(run.result, PAGE_CHARS / 2),
            stdout: clip(run.stdout, PAGE_CHARS / 4),
            stderr: clip(run.stderr, PAGE_CHARS / 8),
          },
        };
      },
    }),

    firecrawlParse: tool({
      description:
        "Parses a file from the selected folders or files with Firecrawl (PDFs, Office documents and more) and returns its text as Markdown. Use it when readFile's text of a complex document (tables, scans, layouts) isn't good enough.",
      inputSchema: firecrawlInputs.firecrawlParse,
      outputSchema: firecrawlOutput,
      execute: async ({ filename, folderId }): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        if (fileMetadata.length === 0 && folderMetadata.length === 0) {
          return failed("No folder or file is selected for this message, so there is nothing to parse. Ask the user to select a folder or file.");
        }

        const file = await findSelectedFile(filename, folderId, { fileMetadata, folderMetadata });
        if (!file) return failed("No file with that name in the selected folders or files.");

        const object = await env.CLOUDBOT_BUCKET.get(fileKey(userId, file));
        if (!object) return failed("The file is listed but its contents are missing.");

        const form = new FormData();
        form.append("file", new Blob([await object.arrayBuffer()]), file.name);
        form.append("options", JSON.stringify({ formats: ["markdown"] }));
        const result = await firecrawlRequest<{ data?: ScrapeData }>("POST", "/parse", {
          form,
          timeoutMs: 300_000,
        });
        if (!result.ok) return failed(result.error);

        return {
          ok: true,
          summary: `Parsed ${file.name}.`,
          data: {
            filename: file.name,
            folderId: file.folderId,
            content: clip(result.data.data?.markdown, PAGE_CHARS),
          },
        };
      },
    }),

    firecrawlMonitor: tool({
      description:
        "Manages monitors that re-check pages, crawls or searches on a schedule and alert on changes: list, get, create, update, delete, run now, or list a monitor's checks. Creating, changing, deleting or running a monitor asks the user to approve first, because monitors spend credits on every check.",
      inputSchema: firecrawlInputs.firecrawlMonitor,
      outputSchema: firecrawlOutput,
      needsApproval: ({ action }) => enabled && MONITOR_ACTIONS_NEEDING_APPROVAL.has(action),
      execute: async (input): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const { action, monitorId, checkId, ...fields } = input;
        // Every CloudChat user shares one Firecrawl account, so each monitor's
        // name carries its owner and a user only ever sees their own.
        const owner = `[cloudchat:${userId}]`;
        const named = (name: string | undefined) =>
          name === undefined ? {} : { name: `${owner} ${name}` };

        if (action === "list") {
          const result = await firecrawlRequest<{ data?: Monitor[] }>("GET", "/monitor", {
            query: { limit: 100 },
          });
          if (!result.ok) return failed(result.error);
          const mine = (result.data.data ?? []).filter((m) => m.name?.startsWith(owner)).map(forModel);
          return {
            ok: true,
            summary: `${mine.length} monitors.`,
            data: clipJson(mine, LIST_CHARS),
          };
        }

        if (action === "create") {
          const result = await firecrawlRequest<{ data?: Monitor }>("POST", "/monitor", {
            body: { ...fields, ...named(fields.name ?? "Monitor") },
          });
          if (!result.ok) return failed(result.error);
          const monitor = result.data.data;
          return {
            ok: true,
            id: monitor?.id,
            summary: `Monitor created${monitor?.id ? `: ${monitor.id}` : ""}.`,
            data: monitor ? forModel(monitor) : undefined,
          };
        }

        if (!monitorId) {
          return failed(`${action} needs a monitorId; list the monitors to find it.`);
        }
        const path = `/monitor/${monitorId}`;
        const existing = await firecrawlRequest<{ data?: Monitor }>("GET", path);
        if (!existing.ok) return failed(existing.error);
        if (!existing.data.data?.name?.startsWith(owner)) {
          return failed("No monitor with that id.");
        }

        const result = await {
          get: () => Promise.resolve(existing),
          update: () => firecrawlRequest<unknown>("PATCH", path, { body: { ...fields, ...named(fields.name) } }),
          delete: () => firecrawlRequest<unknown>("DELETE", path),
          run: () => firecrawlRequest<unknown>("POST", `${path}/run`),
          checks: () =>
            firecrawlRequest<unknown>("GET", checkId ? `${path}/checks/${checkId}` : `${path}/checks`),
        }[action]();
        if (!result.ok) return failed(result.error);

        const data =
          action === "get" || action === "update"
            ? forModel((result.data as { data?: Monitor }).data ?? {})
            : result.data;
        return {
          ok: true,
          id: monitorId,
          summary: `Monitor ${action} done.`,
          data: clipJson(data, LIST_CHARS),
        };
      },
    }),

    firecrawlCreditUsage: tool({
      description: "Returns the Firecrawl credits left in this billing period.",
      inputSchema: firecrawlInputs.firecrawlCreditUsage,
      outputSchema: firecrawlOutput,
      execute: async (): Promise<FirecrawlOutput> => {
        if (!enabled) return WEB_OFF;
        const result = await firecrawlRequest<{
          data?: { remainingCredits?: number; planCredits?: number; billingPeriodEnd?: string };
        }>("GET", "/team/credit-usage");
        if (!result.ok) return failed(result.error);
        const usage = result.data.data ?? {};
        return {
          ok: true,
          summary: `${usage.remainingCredits ?? "Unknown"} of ${usage.planCredits ?? "?"} Firecrawl credits left${usage.billingPeriodEnd ? ` until ${usage.billingPeriodEnd}` : ""}.`,
          data: usage,
        };
      },
    }),
  };
}

export type FirecrawlToolName = keyof ReturnType<typeof firecrawlTools>;
