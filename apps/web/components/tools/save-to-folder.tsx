"use client";

import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { type ToolUIPart } from "ai";
import { FolderInput } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

interface ToolSaveToFolderProps {
  part: ToolUIPart<Pick<CustomUITools, "saveToFolder">>;
}

export function ToolSaveToFolder({ part }: ToolSaveToFolderProps) {
  const { state, input, output } = part;
  const done = state === "output-available" && output;

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <FolderInput className="size-4 text-amber-600" />
        <span className="text-sm font-medium">Save to folder</span>
        <ToolStatusBadge state={state} failed={done ? !output.saved : false} />
      </div>
      <div className="text-muted-foreground mt-2 text-sm">
        {done
          ? output.message
          : input?.folder
            ? `Saving "${input.filename ?? ""}" to "${input.folder}"`
            : null}
      </div>
    </div>
  );
}
