import { type ContextFilter } from "@/contexts/filter-context";
import { type PanelImperativeHandle } from "react-resizable-panels";

export function capitalizeFirstLetter(string: string): string {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

export function resizeEditor(
  panelRef: React.RefObject<PanelImperativeHandle | null>,
  collapse?: boolean,
) {
  if (panelRef.current?.isCollapsed()) {
    panelRef.current?.resize("50");
  } else if (collapse) {
    panelRef.current?.collapse();
  }
}

export function minimizeFilter(filter: ContextFilter) {
  return {
    prompts: filter.prompts.map((p) => ({ id: p.id })),
    folders: filter.folders.map((f) => ({
      id: f.id,
    })),
    files: filter.files.map((f) => ({
      id: f.id,
    })),
    documents: filter.documents.map((doc) => ({ id: doc.id })),
  };
}

// A folder's page. The static export has no dynamic segments and the API has no
// folder-by-id endpoint, so the name travels in the link for display.
export function folderHref(
  locale: string,
  folder: { id: string; name: string },
) {
  return `/${locale}/folders?${new URLSearchParams({ id: folder.id, name: folder.name })}`;
}

// The new-chat page with the folder preselected as the chat's project.
export function newChatInFolderHref(
  locale: string,
  folder: { id: string; name: string },
) {
  return `/${locale}?${new URLSearchParams({ folder: folder.id, name: folder.name })}`;
}
