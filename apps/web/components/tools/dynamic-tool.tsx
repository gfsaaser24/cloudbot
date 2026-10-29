"use client";

import { Button } from "@workspace/ui/components/button";
import { type DynamicToolUIPart } from "ai";
import { ExternalLink, Plug } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

// Connected-app tools (Composio's meta tools) arrive as dynamic tools.
const LABELS: Record<string, string> = {
  COMPOSIO_SEARCH_TOOLS: "Find app tools",
  COMPOSIO_GET_TOOL_SCHEMAS: "Look up app tools",
  COMPOSIO_MULTI_EXECUTE_TOOL: "Use connected apps",
  COMPOSIO_MANAGE_CONNECTIONS: "Connect an app",
};

type ConnectionResult = { toolkit?: string; status?: string; redirect_url?: string };

// Sign-in links from COMPOSIO_MANAGE_CONNECTIONS ({ results: { gmail: { redirect_url } } }).
function connectLinks(output: unknown): { toolkit: string; url: string }[] {
  const results = (output as { results?: Record<string, ConnectionResult> })
    ?.results;
  if (!results || typeof results !== "object") return [];
  return Object.entries(results)
    .filter(([, r]) => typeof r?.redirect_url === "string")
    .map(([toolkit, r]) => ({ toolkit: r.toolkit ?? toolkit, url: r.redirect_url! }));
}

export function ToolDynamic({ part }: { part: DynamicToolUIPart }) {
  const label = LABELS[part.toolName] ?? part.toolName;
  const done = part.state === "output-available";
  const failed =
    done && typeof part.output === "object" && part.output !== null
      ? "error" in part.output
      : false;
  const links = done ? connectLinks(part.output) : [];

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Plug className="size-4 text-indigo-600" />
        <span className="text-sm font-medium">{label}</span>
        <ToolStatusBadge state={part.state} failed={failed} />
      </div>
      {links.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {links.map((link) => (
            <Button key={link.url} asChild size="sm" variant="outline">
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                Connect {link.toolkit}
                <ExternalLink className="size-3" />
              </a>
            </Button>
          ))}
        </div>
      )}
      {part.state === "output-error" && part.errorText && (
        <div className="text-destructive mt-2 text-sm">{part.errorText}</div>
      )}
    </div>
  );
}
