// YouTube helpers for the transcript tools.
//
// Listing a channel's or playlist's videos: YouTube serves Firecrawl an error
// page for these, but answers Cloudflare's own fetch, so the Worker reads the
// video ids from the page's embedded data itself. Transcripts come from
// Firecrawl, which renders a video page with its transcript.

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return YOUTUBE_HOSTS.has(parsed.hostname) ? parsed : null;
  } catch {
    return null;
  }
}

export function isYouTubeUrl(url: string): boolean {
  return parse(url) !== null;
}

// The 11-character video id of a single-video URL, else null.
export function youTubeVideoId(url: string): string | null {
  const parsed = parse(url);
  if (!parsed) return null;
  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.slice(1, 12) || null;
  }
  const fromQuery = parsed.searchParams.get("v");
  if (parsed.pathname === "/watch" && fromQuery) return fromQuery;
  const match = parsed.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
  return match?.[2] ?? null;
}

// The page that lists a channel's or playlist's videos, else null.
export function youTubeListPage(url: string): string | null {
  const parsed = parse(url);
  if (!parsed || youTubeVideoId(url)) return null;

  const list = parsed.searchParams.get("list");
  if (list) return `https://www.youtube.com/playlist?list=${list}`;

  const channel = parsed.pathname.match(
    /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/,
  );
  return channel ? `https://www.youtube.com/${channel[1]}/videos` : null;
}

// Video ids on a channel's Videos tab or a playlist page, newest first, deduplicated.
// Returns what the first page shows (about 30 videos on a channel, 100 on a playlist).
export async function listYouTubeVideos(listPage: string): Promise<string[]> {
  const response = await fetch(listPage, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
      "Accept-Language": "en",
    },
  });
  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status} for ${listPage}`);
  }

  const html = await response.text();
  const ids: string[] = [];
  for (const match of html.matchAll(/"videoId":"([\w-]{11})"/g)) {
    if (!ids.includes(match[1]!)) ids.push(match[1]!);
  }
  return ids;
}

// Firecrawl renders a video page as Markdown with the transcript after a
// "Transcript" heading. Returns just that text, or null if there is none.
export function extractTranscript(markdown: string): string | null {
  const match = markdown.match(/^#*\s*Transcript\s*$/im);
  if (!match || match.index === undefined) return null;
  const transcript = markdown.slice(match.index + match[0].length).trim();
  return transcript.length > 0 ? transcript : null;
}

// Pages YouTube serves instead of content (e.g. "Error 401 ... That's an error").
export function looksLikeErrorPage(markdown: string): boolean {
  return (
    /Error \d{3} \(/.test(markdown.slice(0, 300)) ||
    /That[’']s an error/.test(markdown.slice(0, 400))
  );
}
