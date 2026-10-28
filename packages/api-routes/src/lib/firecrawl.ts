// Firecrawl's scrape endpoint returns any web page as Markdown, and for
// YouTube URLs the video's transcript (when captions exist).
// https://docs.firecrawl.dev/features/scrape

export interface ScrapedPage {
  url: string;
  title: string;
  markdown: string;
}

export function isFirecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

function isYouTube(url: string): boolean {
  const host = new URL(url).hostname.replace(/^(www|m)\./, "");
  return host === "youtube.com" || host === "youtu.be";
}

export async function scrapeToMarkdown(url: string): Promise<ScrapedPage> {
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
      onlyMainContent: true,
      // Firecrawl caches pages for up to 2 days, and a cached YouTube page can
      // lack the transcript. A fresh scrape costs the same single credit.
      ...(isYouTube(url) ? { maxAge: 0 } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Could not fetch ${url} (Firecrawl ${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }

  const { data } = (await response.json()) as {
    data?: { markdown?: string; metadata?: { title?: string } };
  };

  return {
    url,
    title: data?.metadata?.title ?? url,
    markdown: data?.markdown ?? "",
  };
}
