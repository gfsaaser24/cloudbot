"use client";

import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { type ToolUIPart } from "ai";
import { ExternalLink, Link2 } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

interface ToolFetchWebContentProps {
  part: ToolUIPart<Pick<CustomUITools, "fetchWebContent">>;
}

export function ToolFetchWebContent({ part }: ToolFetchWebContentProps) {
  const { state, input, output } = part;
  const done = state === "output-available" && output;

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Link2 className="size-4 text-blue-600" />
        <span className="text-sm font-medium">Fetch page</span>
        <ToolStatusBadge state={state} />
      </div>
      {input?.url && (
        <a
          href={input.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground mt-2 flex items-center gap-1 text-sm hover:underline"
        >
          <span className="truncate">{done ? output.title : input.url}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
      )}
      {done && output.truncated && (
        <div className="text-muted-foreground mt-1 text-xs">
          Long page: only the first part was read. Ask to save it to a folder to
          keep all of it.
        </div>
      )}
    </div>
  );
}
