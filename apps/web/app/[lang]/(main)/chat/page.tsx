"use client";

import { Chat } from "@/components/custom/chat";
import { ChatSkeleton } from "@/components/custom/chat-skeleton";
import { DataStreamHandler } from "@/components/custom/data-stream-handler";
import { useQuery } from "@tanstack/react-query";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { useUser } from "@workspace/ui/contexts/user-context";
import { apiFetcher } from "@workspace/ui/lib/fetcher";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

// Static export: the chat id comes from ?id= instead of a dynamic segment.
export default function ChatRoute() {
  return (
    <Suspense fallback={<ChatSkeleton />}>
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const { locale, sharedT } = useSharedTranslations();

  const user = useUser();

  const router = useRouter();
  const chatId = useSearchParams().get("id");

  const {
    data: messages,
    isPending,
    isError,
  } = useQuery({
    queryKey: ["messages", chatId],
    queryFn: () =>
      apiFetcher(
        (client) =>
          client["messages"][":chatId"].$get({
            param: { chatId: chatId! },
          }),
        sharedT.apiCodes,
      ),
    enabled: !!user && !!chatId,
  });

  useEffect(() => {
    if (!user) {
      router.replace(`/${locale}/sign-in`);
    }
  }, [user, router, locale]);

  useEffect(() => {
    if (!chatId) {
      router.replace(`/${locale}`);
    }
  }, [chatId, router, locale]);

  useEffect(() => {
    if (!isPending && (isError || !messages)) {
      router.replace(`/${locale}`);
    }
  }, [isPending, isError, messages, router, locale]);

  if (isPending || !chatId || !messages) {
    return <ChatSkeleton />;
  }

  return (
    <>
      <Chat
        chatId={chatId}
        initialMessages={messages as unknown as CustomUIMessage[]}
      />
      <DataStreamHandler />
    </>
  );
}
