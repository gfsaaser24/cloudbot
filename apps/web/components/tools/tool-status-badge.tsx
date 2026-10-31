"use client";

import { Badge } from "@workspace/ui/components/badge";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";

// Status badge for a tool card, from the tool part's state.
export function ToolStatusBadge({
  state,
  failed,
}: {
  state: string;
  // A tool can finish but report that it didn't do the job (e.g. saved: false).
  failed?: boolean;
}) {
  if (
    state === "input-streaming" ||
    state === "input-available" ||
    // Approved, and now running on the server.
    state === "approval-responded"
  ) {
    return (
      <Badge variant="secondary" className="flex items-center gap-1">
        <Loader2 className="size-3 animate-spin" />
        <span>Running</span>
      </Badge>
    );
  }
  if (state === "output-error" || state === "output-denied" || failed) {
    return (
      <Badge variant="destructive" className="flex items-center gap-1">
        <XCircle className="size-3" />
        <span>{state === "output-denied" ? "Denied" : "Error"}</span>
      </Badge>
    );
  }
  return (
    <Badge
      variant="secondary"
      className="flex items-center gap-1 text-green-600"
    >
      <CheckCircle2 className="size-3" />
      <span>Completed</span>
    </Badge>
  );
}
