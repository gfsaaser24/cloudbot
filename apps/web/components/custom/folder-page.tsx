"use client";

import { useWebTranslations } from "@/contexts/web-translations";
import { newChatInFolderHref } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@workspace/ui/components/button";
import { SidebarTrigger } from "@workspace/ui/components/sidebar-left";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { useInfiniteQueryWithRPC } from "@workspace/ui/hooks/use-infinite-query";
import { apiFetcher } from "@workspace/ui/lib/fetcher";
import {
  ArrowLeft,
  File,
  FolderOpen,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  ShieldAlert,
  Star,
} from "lucide-react";
import Link from "next/link";
import { memo } from "react";

interface FolderPageProps {
  folderId: string;
  folderName: string | null;
}

// One folder: its chats (the user's own) and its files.
export const FolderPage = memo(({ folderId, folderName }: FolderPageProps) => {
  const { sharedT, locale } = useSharedTranslations();
  const { webT } = useWebTranslations();

  const name = folderName || webT.project.folder;

  // Also the access check: 403 when the user can't read the folder.
  const {
    data: chats,
    isPending: chatsPending,
    error: chatsError,
  } = useQuery({
    queryKey: ["folder-chats", folderId],
    queryFn: () =>
      apiFetcher(
        (client) =>
          client.folders[":folderId"].chats.$get({
            param: { folderId },
          }),
        sharedT.apiCodes,
      ),
  });

  // Same query as the files page, so its cache invalidation covers this list.
  const {
    data: files,
    isPending: filesPending,
    inViewRef,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQueryWithRPC({
    queryKey: ["folder-files", folderId],
    queryFn: ({ pageParam }) =>
      apiFetcher(
        (client) =>
          client.files.$get({
            query: {
              folderIds: folderId,
              pageNumber: (pageParam ?? 0).toString(),
              itemsPerPage: "20",
            },
          }),
        sharedT.apiCodes,
      ),
    enabled: !chatsError,
  });

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 md:px-8">
        <div className="flex flex-col gap-4">
          <Link
            href={`/${locale}/folders`}
            className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm"
          >
            <ArrowLeft className="size-4" />
            {webT.project.allFolders}
          </Link>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight">
              <FolderOpen className="text-muted-foreground size-6 shrink-0" />
              <span className="truncate">{name}</span>
            </h1>
            {!chatsError && (
              <Button asChild className="shrink-0">
                <Link
                  href={newChatInFolderHref(locale, { id: folderId, name })}
                >
                  <MessageSquarePlus />
                  {webT.project.newChatInFolder}
                </Link>
              </Button>
            )}
          </div>
        </div>

        {chatsError ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
            <ShieldAlert className="text-muted-foreground size-10" />
            <p className="text-muted-foreground text-sm">
              {chatsError.message}
            </p>
          </div>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">{webT.project.chats}</h2>
              {chatsPending ? (
                <div className="grid gap-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton
                      key={i}
                      className="bg-muted/50 h-16 rounded-lg border"
                    />
                  ))}
                </div>
              ) : !chats || chats.length === 0 ? (
                <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                  {webT.project.noChats}
                </p>
              ) : (
                <div className="grid gap-2">
                  {chats.map((chat) => (
                    <Link
                      key={chat.id}
                      href={`/${locale}/chat?id=${chat.id}`}
                      className="hover:bg-muted/30 flex items-center gap-3 rounded-lg border p-3 transition-colors"
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-blue-500/10 text-blue-600 dark:text-blue-400">
                        <MessageSquare className="size-4" />
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <h3 className="truncate font-medium">
                          {chat.title || webT.chatItem.defaultTitle}
                        </h3>
                        <p className="text-muted-foreground text-xs">
                          {formatDate(chat.createdAt)}
                        </p>
                      </div>
                      {chat.isFavourite && (
                        <Star className="text-primary size-4 shrink-0 fill-current" />
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-3">
              <h2 className="text-lg font-semibold">{webT.project.files}</h2>
              {filesPending ? (
                <div className="grid gap-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full rounded-lg" />
                  ))}
                </div>
              ) : !files || files.length === 0 ? (
                <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
                  {webT.project.noFiles}
                </p>
              ) : (
                <div className="grid gap-1">
                  {files.map((file) => (
                    <div
                      key={file.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                    >
                      <File className="text-muted-foreground size-4 shrink-0" />
                      <span className="truncate">{file.name}</span>
                    </div>
                  ))}
                  {hasNextPage && (
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
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
});
