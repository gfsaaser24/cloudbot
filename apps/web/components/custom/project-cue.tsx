"use client";

import { useChatControl } from "@/contexts/chat-control-context";
import { useFilter } from "@/contexts/filter-context";
import { useWebTranslations } from "@/contexts/web-translations";
import { useChatProject } from "@/hooks/use-chat-project";
import { FolderOpen } from "lucide-react";
import { memo } from "react";

interface ProjectCueProps {
  chatId: string;
  isEmpty: boolean;
  isLoading: boolean;
  isNewChat: boolean;
}

// A quiet line above the composer saying the chat works inside a project.
export const ProjectCue = memo((props: ProjectCueProps) => {
  const { webT } = useWebTranslations();
  const { isTemporary } = useChatControl();
  const { filter } = useFilter();
  const { folder } = useChatProject(props);

  if (isTemporary || !folder) return null;

  // Same rule as the server: a message's own file or folder selection replaces the project folder in search.
  const searchesProject =
    filter.files.length === 0 &&
    (filter.folders.length === 0 ||
      filter.folders.some((f) => f.id === folder.id));

  const text = searchesProject
    ? webT.project.cueSearches
    : webT.project.cueOverridden;

  return (
    <p className="text-muted-foreground flex items-center gap-1.5 px-3 pb-1.5 text-xs">
      <FolderOpen className="size-3.5 shrink-0" />
      <span className="truncate">{text.replace("{name}", folder.name)}</span>
    </p>
  );
});
