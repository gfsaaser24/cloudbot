"use client";

import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { type ToolUIPart } from "ai";
import { ListChecks } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

interface Props {
  part: ToolUIPart<Pick<CustomUITools, "getImportStatus">>;
}

export function ToolGetImportStatus({ part }: Props) {
  const { state, output } = part;
  const done = state === "output-available" && output;

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <ListChecks className="size-4 text-red-600" />
        <span className="text-sm font-medium">Import progress</span>
        <ToolStatusBadge
          state={state}
          failed={done ? output.status === "errored" : false}
        />
      </div>
      {done && (
        <div className="text-muted-foreground mt-2 text-sm">
          {output.message}
        </div>
      )}
    </div>
  );
}
