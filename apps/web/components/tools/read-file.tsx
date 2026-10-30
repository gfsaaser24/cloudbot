"use client";

import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { type ToolUIPart } from "ai";
import { FileText } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

interface ToolReadFileProps {
  part: ToolUIPart<Pick<CustomUITools, "readFile">>;
}

export function ToolReadFile({ part }: ToolReadFileProps) {
  const { state, input, output } = part;
  const done = state === "output-available" && output;

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-blue-600" />
        <span className="text-sm font-medium">Read file</span>
        <ToolStatusBadge state={state} failed={done ? !output.found : false} />
      </div>
      <div className="text-muted-foreground mt-2 truncate text-sm">
        {done && !output.found ? output.message : input?.filename}
        {done && output.truncated ? " (only the first part fits)" : null}
      </div>
    </div>
  );
}
