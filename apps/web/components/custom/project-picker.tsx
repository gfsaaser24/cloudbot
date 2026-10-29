"use client";

import { useWebTranslations } from "@/contexts/web-translations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { useInfiniteQueryWithRPC } from "@workspace/ui/hooks/use-infinite-query";
import { apiFetcher } from "@workspace/ui/lib/fetcher";
import { cn } from "@workspace/ui/lib/utils";
import { Check, Globe, Loader2, Lock, Search, ShieldCheck } from "lucide-react";
import { memo, useMemo, useState } from "react";

export interface PickerFolder {
  id: string;
  name: string;
  visibility: "private" | "protected" | "public";
}

interface ProjectPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentFolderId: string | null;
  onSelect: (folder: PickerFolder) => void;
}

const visibilityIcons = {
  private: Lock,
  public: Globe,
  protected: ShieldCheck,
};

// Picks one folder as the chat's project.
export const ProjectPicker = memo(
  ({ open, onOpenChange, currentFolderId, onSelect }: ProjectPickerProps) => {
    const { sharedT } = useSharedTranslations();
    const { webT } = useWebTranslations();
    const [search, setSearch] = useState("");

    // Same query as the folder combobox, so the list is shared in the cache.
    const {
      data: folders,
      isPending,
      inViewRef,
      hasNextPage,
      isFetchingNextPage,
    } = useInfiniteQueryWithRPC({
      queryKey: ["folders"],
      queryFn: ({ pageParam }) =>
        apiFetcher(
          (client) =>
            client.folders.$get({
              query: {
                pageNumber: (pageParam ?? 0).toString(),
                itemsPerPage: "20",
              },
            }),
          sharedT.apiCodes,
        ),
      enabled: open,
    });

    const filtered = useMemo(() => {
      if (!folders) return [];
      const q = search.trim().toLowerCase();
      if (!q) return folders;
      return folders.filter((f) => f.name.toLowerCase().includes(q));
    }, [folders, search]);

    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          if (!next) setSearch("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{webT.project.pickerTitle}</DialogTitle>
            <DialogDescription>
              {webT.project.pickerDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
            <Input
              placeholder={webT.folderCombobox.placeholder}
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {isPending ? (
              <div className="grid gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full rounded-md" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {webT.folderCombobox.noFoldersFound}
              </p>
            ) : (
              filtered.map((folder) => {
                const VisIcon = visibilityIcons[folder.visibility];
                const isCurrent = folder.id === currentFolderId;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => onSelect(folder)}
                    className={cn(
                      "hover:bg-accent hover:text-accent-foreground flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                      isCurrent && "bg-accent/50",
                    )}
                  >
                    <VisIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">{folder.name}</span>
                    {isCurrent && <Check className="ml-auto size-4 shrink-0" />}
                  </button>
                );
              })
            )}
            {!search && hasNextPage && (
              <div
                ref={inViewRef}
                className="flex h-8 items-center justify-center"
              >
                {isFetchingNextPage && (
                  <Loader2 className="size-4 animate-spin" />
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  },
);
