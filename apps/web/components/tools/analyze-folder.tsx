"use client";

import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { type ToolUIPart } from "ai";
import { Table } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

interface ToolAnalyzeFolderProps {
  part: ToolUIPart<Pick<CustomUITools, "analyzeFolder">>;
}

export function ToolAnalyzeFolder({ part }: ToolAnalyzeFolderProps) {
  const { state, input, output } = part;
  // While files are read, the tool reports progress after each one.
  const running = output?.status === "running";
  const fields = input?.fields?.map((field) => field?.name).filter(Boolean);

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Table className="size-4 text-emerald-600" />
        <span className="text-sm font-medium">Analyze files</span>
        <ToolStatusBadge state={running ? "input-available" : state} />
      </div>
      {fields && fields.length > 0 && (
        <div className="text-muted-foreground mt-1 truncate text-sm">
          {fields.join(", ")}
        </div>
      )}
      {running && (
        <div className="mt-2 space-y-1">
          <div className="text-sm">
            Reading {output.completed} of {output.total} files
          </div>
          <div className="bg-muted h-1.5 w-full overflow-hidden rounded">
            <div
              className="h-full bg-emerald-600 transition-all"
              style={{
                width: `${output.total ? (output.completed / output.total) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {output?.status === "done" && output.message && (
        <div className="mt-1 text-sm">{output.message}</div>
      )}
      {state === "output-error" && part.errorText && (
        <div className="text-destructive mt-2 text-sm">{part.errorText}</div>
      )}
    </div>
  );
}
