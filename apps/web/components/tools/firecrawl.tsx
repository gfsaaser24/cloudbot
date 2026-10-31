"use client";

import { useToolApproval } from "@/contexts/tool-approval-context";
import { type FirecrawlToolName } from "@workspace/api-routes/lib/tools/firecrawl-tools";
import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { Button } from "@workspace/ui/components/button";
import { type ToolUIPart } from "ai";
import { ExternalLink, Flame } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

export type FirecrawlToolPart = ToolUIPart<Pick<CustomUITools, FirecrawlToolName>>;

const LABELS: Record<FirecrawlToolName, string> = {
  firecrawlScrape: "Read page",
  firecrawlSearch: "Search",
  firecrawlMap: "Map site",
  firecrawlCrawl: "Crawl site",
  firecrawlBatchScrape: "Read pages",
  firecrawlAgent: "Research agent",
  firecrawlJobStatus: "Check job",
  firecrawlInteract: "Browser session",
  firecrawlParse: "Parse file",
  firecrawlMonitor: "Monitor",
  firecrawlCreditUsage: "Firecrawl credits",
};

// The input that best says what the call is about.
function subject(input: FirecrawlToolPart["input"]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const key of ["query", "url", "prompt", "filename", "name", "action"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  const urls = (input as { urls?: unknown }).urls;
  return Array.isArray(urls) ? `${urls.length} URLs` : undefined;
}

// What an approval would spend, so the user can judge it.
function approvalDetail(
  name: FirecrawlToolName,
  input: FirecrawlToolPart["input"],
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  switch (name) {
    case "firecrawlCrawl":
      return `Up to ${Math.min(Number(fields.limit ?? 20), 100)} pages.`;
    case "firecrawlBatchScrape":
      return `${Math.min((fields.urls as unknown[] | undefined)?.length ?? 0, 100)} pages.`;
    case "firecrawlAgent":
      return `Up to ${Math.min(Number(fields.maxCredits ?? 200), 500)} credits.`;
    case "firecrawlInteract":
      return `A live browser session for up to ${Math.round(Number(fields.ttlSeconds ?? 600) / 60)} minutes.`;
    case "firecrawlMonitor": {
      const schedule = fields.schedule as { text?: string; cron?: string } | undefined;
      const targets = (fields.targets as unknown[] | undefined)?.length;
      return [
        `${String(fields.action)} a monitor`,
        schedule ? `running ${schedule.text ?? schedule.cron}` : undefined,
        targets ? `${targets} targets per check` : undefined,
      ]
        .filter(Boolean)
        .join(", ")
        .concat(".");
    }
    default:
      return undefined;
  }
}

export function ToolFirecrawl({ part }: { part: FirecrawlToolPart }) {
  const respond = useToolApproval();
  const name = part.type.slice("tool-".length) as FirecrawlToolName;
  const output = part.state === "output-available" ? part.output : undefined;
  const about = subject(part.input);

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Flame className="size-4 text-orange-600" />
        <span className="text-sm font-medium">{LABELS[name] ?? name}</span>
        {part.state !== "approval-requested" && (
          <ToolStatusBadge state={part.state} failed={output?.ok === false} />
        )}
      </div>
      {about && (
        <div className="text-muted-foreground mt-1 truncate text-sm">{about}</div>
      )}

      {part.state === "approval-requested" && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {approvalDetail(name, part.input)} This can use many Firecrawl
            credits. Run it?
          </span>
          <Button size="sm" onClick={() => respond(part.approval.id, true)}>
            Run
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => respond(part.approval.id, false)}
          >
            Don&apos;t run
          </Button>
        </div>
      )}

      {output && <div className="mt-1 text-sm">{output.summary}</div>}
      {output?.liveViewUrl && (
        <a
          href={output.liveViewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex items-center gap-1 text-sm text-blue-600 hover:underline"
        >
          Watch the browser
          <ExternalLink className="size-3" />
        </a>
      )}
      {output?.links && output.links.length > 0 && (
        <ul className="mt-2 space-y-1">
          {output.links.slice(0, 5).map((link) => (
            <li key={link.url}>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground flex items-center gap-1 text-sm hover:underline"
              >
                <span className="truncate">{link.title || link.url}</span>
                <ExternalLink className="size-3 shrink-0" />
              </a>
            </li>
          ))}
          {output.links.length > 5 && (
            <li className="text-muted-foreground text-xs">
              and {output.links.length - 5} more
            </li>
          )}
        </ul>
      )}
      {part.state === "output-error" && part.errorText && (
        <div className="text-destructive mt-2 text-sm">{part.errorText}</div>
      )}
    </div>
  );
}
