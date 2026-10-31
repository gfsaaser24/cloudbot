// Firecrawl's v2 API: scrape, search, map, crawl, batch scrape, agent,
// interact, parse, monitors and credit usage. The scrape endpoint returns any
// web page as Markdown, and for YouTube URLs the video's transcript (when
// captions exist).
// https://docs.firecrawl.dev/api-reference/v2-introduction

const API_URL = "https://api.firecrawl.dev/v2";
// A stalled call must not hold the chat turn open; callers that start long
// work (parsing, running code in a browser) pass a longer limit.
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ScrapedPage {
  url: string;
  title: string;
  markdown: string;
}

export function isFirecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

export type FirecrawlResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

type RequestOptions = {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  form?: FormData;
  timeoutMs?: number;
};

// What went wrong, in words the model can pass on to the user.
function errorMessage(status: number, body: string): string {
  if (status === 402) {
    return "Firecrawl is out of credits for this billing period, so this can't run. Tell the user to top up their Firecrawl credits.";
  }
  if (status === 429) {
    return "Firecrawl's rate limit was reached. Wait a moment and try again, or make fewer requests.";
  }
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // Not JSON: keep the raw text.
  }
  return `Firecrawl returned an error (${status}): ${detail}`;
}

// One Firecrawl v2 call. Never throws: failures come back as readable errors.
export async function firecrawlRequest<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  { body, query, form, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
): Promise<FirecrawlResponse<T>> {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: `Could not reach Firecrawl: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: errorMessage(response.status, text),
    };
  }
  try {
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch {
    return {
      ok: false,
      status: response.status,
      error: "Firecrawl returned a response that isn't JSON.",
    };
  }
}

function isYouTube(url: string): boolean {
  const host = new URL(url).hostname.replace(/^(www|m)\./, "");
  return host === "youtube.com" || host === "youtu.be";
}

export async function scrapeToMarkdown(url: string): Promise<ScrapedPage> {
  const result = await firecrawlRequest<{
    data?: { markdown?: string; metadata?: { title?: string } };
  }>("POST", "/scrape", {
    body: {
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      // Firecrawl caches pages for up to 2 days, and a cached YouTube page can
      // lack the transcript. A fresh scrape costs the same single credit.
      ...(isYouTube(url) ? { maxAge: 0 } : {}),
    },
  });

  if (!result.ok) {
    throw new Error(`Could not fetch ${url}: ${result.error}`);
  }

  return {
    url,
    title: result.data.data?.metadata?.title ?? url,
    markdown: result.data.data?.markdown ?? "",
  };
}
