"use client";

import { Chat } from "@/components/custom/chat";
import { DataStreamHandler } from "@/components/custom/data-stream-handler";
import { useChatControl } from "@/contexts/chat-control-context";
import { generateUUID } from "@workspace/ui/lib/utils";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

// Reading the query string needs a Suspense boundary in a static export.
export default function HomeRoute() {
  return (
    <Suspense fallback={null}>
      <HomePage />
    </Suspense>
  );
}

function HomePage() {
  const searchParams = useSearchParams();
  const { setPendingProject } = useChatControl();

  // Generated in the browser: a static export would otherwise bake one id into the HTML for every user.
  const [id, setId] = useState<string>();

  useEffect(() => {
    const chatId = generateUUID();

    // "New chat in this folder" links here with ?folder=<id>&name=<name>.
    // Read once: sending the first message rewrites the URL to /chat?id=…
    const folderId = searchParams.get("folder");
    const folderName = searchParams.get("name");
    setPendingProject(
      folderId && folderName
        ? { chatId, folder: { id: folderId, name: folderName } }
        : null,
    );

    setId(chatId);
  }, []);

  if (!id) {
    return null;
  }

  return (
    <>
      <Chat chatId={id} initialMessages={[]} />
      <DataStreamHandler />
    </>
  );
}
