"use client";

import { useChatControl } from "@/contexts/chat-control-context";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@workspace/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { Input } from "@workspace/ui/components/input";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { apiFetcher } from "@workspace/ui/lib/fetcher";
import { cn } from "@workspace/ui/lib/utils";
import { Check, ChevronDownIcon, Loader2 } from "lucide-react";
import { memo, useMemo, useState } from "react";

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

// Lists every tool-capable OpenRouter model, with search.
export const ModelSelector = memo(() => {
  const { selectedChatModel, setSelectedChatModel } = useChatControl();
  const { sharedT } = useSharedTranslations();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: models, isPending } = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      apiFetcher((client) => client.models.$get(), sharedT.apiCodes),
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!models || !query) return models ?? [];
    return models.filter(
      (m) =>
        m.label.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query),
    );
  }, [models, search]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="min-w-0 shrink rounded-lg">
          <span className="truncate">{selectedChatModel.label}</span>
          <ChevronDownIcon
            className={cn(
              "ml-1 transition-transform duration-200 ease-in-out",
              open && "rotate-180",
            )}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-96 p-0">
        <div className="border-b p-2">
          <Input
            autoFocus
            placeholder="Search models"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            // Keep the menu's type-ahead from swallowing keystrokes.
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {isPending && (
            <div className="flex justify-center p-4">
              <Loader2 className="size-4 animate-spin" />
            </div>
          )}
          {!isPending && filtered.length === 0 && (
            <div className="text-muted-foreground p-4 text-center text-sm">
              No models found
            </div>
          )}
          {filtered.map((model) => (
            <DropdownMenuItem
              key={model.id}
              onSelect={() => {
                setOpen(false);
                setSearch("");
                setSelectedChatModel(model);
              }}
              className="flex flex-row items-center justify-between gap-4"
            >
              <div className="flex min-w-0 flex-col items-start gap-0.5">
                <div className="truncate">{model.label}</div>
                <div className="text-muted-foreground truncate text-xs">
                  {model.id} · {formatContext(model.contextLength)} context
                  {model.images ? " · images" : ""}
                  {model.reasoning ? " · reasoning" : ""}
                </div>
              </div>

              {model.id === selectedChatModel.id && (
                <Check className="shrink-0 text-green-500" />
              )}
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
