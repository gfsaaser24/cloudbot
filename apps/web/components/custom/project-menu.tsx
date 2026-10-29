"use client";

import {
  type ProjectFolder,
  useChatControl,
} from "@/contexts/chat-control-context";
import { useWebTranslations } from "@/contexts/web-translations";
import { folderHref } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@workspace/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { apiFetcher } from "@workspace/ui/lib/fetcher";
import {
  ArrowLeftRight,
  ChevronDown,
  FolderMinus,
  FolderOpen,
  FolderPlus,
} from "lucide-react";
import Link from "next/link";
import { memo, useState } from "react";
import { toast } from "sonner";
import { type PickerFolder, ProjectPicker } from "./project-picker";

interface ProjectMenuProps {
  chatId: string;
  folder: ProjectFolder | null;
  isSaved: boolean; // Saved chats change their folder on the server; unsaved ones send it with the first message
  disabled: boolean;
}

// The chat's project badge (or "Add to project") in the chat header.
export const ProjectMenu = memo(
  ({ chatId, folder, isSaved, disabled }: ProjectMenuProps) => {
    const { sharedT, locale } = useSharedTranslations();
    const { webT } = useWebTranslations();
    const queryClient = useQueryClient();
    const { setPendingProject } = useChatControl();
    const [pickerOpen, setPickerOpen] = useState(false);

    const updateFolder = async (folderId: string | null) => {
      const result = await apiFetcher(
        (client) =>
          client.chats[":chatId"].folder.$patch({
            param: { chatId },
            json: { folderId },
          }),
        sharedT.apiCodes,
      );

      queryClient.invalidateQueries({ queryKey: ["chats"] });
      queryClient.invalidateQueries({ queryKey: ["favourites"] });
      queryClient.invalidateQueries({ queryKey: ["folder-chats"] });
      await queryClient.invalidateQueries({ queryKey: ["chatTitle", chatId] });

      return result;
    };

    const handleSelect = (picked: PickerFolder) => {
      setPickerOpen(false);
      if (picked.id === folder?.id) return;

      const project = { id: picked.id, name: picked.name };

      if (isSaved) {
        toast.promise(updateFolder(picked.id), {
          loading: webT.project.moving,
          success: () => webT.project.moved.replace("{name}", picked.name),
          error: (err) => (err as Error).message,
        });
        return;
      }

      // Not saved yet: the first message sends the folder, so check read access now.
      if (picked.visibility === "public") {
        setPendingProject({ chatId, folder: project });
        return;
      }

      apiFetcher(
        (client) =>
          client.folders["validate-access"].$post({
            json: { folderId: picked.id },
          }),
        sharedT.apiCodes,
      )
        .then(({ hasAccess }) => {
          if (hasAccess) {
            setPendingProject({ chatId, folder: project });
          } else {
            toast.error(webT.project.noAccess);
          }
        })
        .catch((err: Error) => toast.error(err.message));
    };

    const handleRemove = () => {
      if (!isSaved) {
        setPendingProject({ chatId, folder: null });
        return;
      }

      toast.promise(updateFolder(null), {
        loading: webT.project.removing,
        success: webT.project.removed,
        error: (err) => (err as Error).message,
      });
    };

    const picker = (
      <ProjectPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        currentFolderId={folder?.id ?? null}
        onSelect={handleSelect}
      />
    );

    if (!folder) {
      return (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground shrink-0"
            disabled={disabled}
            onClick={() => setPickerOpen(true)}
            title={webT.project.addToProject}
          >
            <FolderPlus />
            <span className="hidden sm:inline">
              {webT.project.addToProject}
            </span>
          </Button>
          {picker}
        </>
      );
    }

    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              variant="outline"
              size="sm"
              className="border-primary/30 bg-primary/5 hover:bg-primary/10 max-w-40 min-w-0 shrink sm:max-w-64"
              title={folder.name}
            >
              <FolderOpen className="text-primary" />
              <span className="truncate">
                {webT.project.badge.replace("{name}", folder.name)}
              </span>
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem asChild className="cursor-pointer">
              <Link href={folderHref(locale, folder)}>
                <FolderOpen />
                <span>{webT.project.openFolder}</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setPickerOpen(true)}
            >
              <ArrowLeftRight />
              <span>{webT.project.changeProject}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={handleRemove}
            >
              <FolderMinus />
              <span>{webT.project.removeFromProject}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {picker}
      </>
    );
  },
);
