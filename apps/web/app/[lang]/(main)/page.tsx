"use client";

import { Chat } from "@/components/custom/chat";
import { DataStreamHandler } from "@/components/custom/data-stream-handler";
import { generateUUID } from "@workspace/ui/lib/utils";
import { useEffect, useState } from "react";

export default function HomePage() {
  // Generated in the browser: a static export would otherwise bake one id into the HTML for every user.
  const [id, setId] = useState<string>();

  useEffect(() => {
    setId(generateUUID());
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
