"use client";

import { type CustomUITools } from "@workspace/api-routes/types/custom-ui-tools";
import { type ToolUIPart } from "ai";
import { Youtube } from "lucide-react";
import { ToolStatusBadge } from "./tool-status-badge";

interface Props {
  part: ToolUIPart<Pick<CustomUITools, "importYouTubeTranscripts">>;
}

export function ToolImportYouTubeTranscripts({ part }: Props) {
  const { state, input, output } = part;
  const done = state === "output-available" && output;

  return (
    <div className="w-full rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Youtube className="size-4 text-red-600" />
        <span className="text-sm font-medium">Import YouTube transcripts</span>
        <ToolStatusBadge state={state} failed={done ? !output.started : false} />
      </div>
      <div className="text-muted-foreground mt-2 text-sm">
        {done ? output.message : input?.url}
      </div>
    </div>
  );
}
