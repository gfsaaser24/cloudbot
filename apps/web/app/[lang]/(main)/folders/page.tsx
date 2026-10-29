"use client";

import { FolderPage } from "@/components/custom/folder-page";
import { FoldersPage } from "@/components/custom/folders-page";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

// Static export: one folder's page is /folders?id=<folderId>&name=<name>.
export default function FoldersRoute() {
  return (
    <Suspense fallback={null}>
      <FoldersRouteContent />
    </Suspense>
  );
}

function FoldersRouteContent() {
  const searchParams = useSearchParams();
  const folderId = searchParams.get("id");

  if (folderId) {
    return (
      <FolderPage folderId={folderId} folderName={searchParams.get("name")} />
    );
  }

  return <FoldersPage />;
}
