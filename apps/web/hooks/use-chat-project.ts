import {
  type ProjectFolder,
  useChatControl,
} from "@/contexts/chat-control-context";
import { useQuery } from "@tanstack/react-query";
import { useSharedTranslations } from "@workspace/ui/contexts/shared-translations-context";
import { apiFetcher } from "@workspace/ui/lib/fetcher";

interface ChatState {
  chatId: string;
  isEmpty: boolean;
  isLoading: boolean;
  isNewChat: boolean;
}

// Title and folder of a saved chat. Shared by the chat header and the composer's project cue.
export function useChatTitle({
  chatId,
  isEmpty,
  isLoading,
  isNewChat,
}: ChatState) {
  const { sharedT } = useSharedTranslations();
  const { isTemporary } = useChatControl();

  return useQuery({
    queryKey: ["chatTitle", chatId],
    queryFn: () =>
      apiFetcher(
        (client) =>
          client["chats"]["title"][":chatId"].$get({
            param: { chatId },
          }),
        sharedT.apiCodes,
      ),
    enabled: !isEmpty && !isTemporary && !isLoading && !isNewChat,
  });
}

// The chat's project folder: the stored one once the chat's title has loaded,
// otherwise the one picked for this chat before it was saved.
export function useChatProject(chat: ChatState) {
  const { pendingProject } = useChatControl();
  const titleQuery = useChatTitle(chat);
  const stored = titleQuery.data;

  let folder: ProjectFolder | null = null;
  if (stored) {
    if (stored.folderId && stored.folderName) {
      folder = { id: stored.folderId, name: stored.folderName };
    }
  } else if (pendingProject?.chatId === chat.chatId) {
    folder = pendingProject.folder;
  }

  return { folder, isSaved: !!stored, titleQuery };
}
