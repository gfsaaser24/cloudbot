"use client";

import { chatModels } from "@workspace/api-routes/providers/models";
import React, {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

// A model from the OpenRouter catalog (GET /api/protected/models).
export interface ChatModel {
  id: string; // OpenRouter model id
  label: string;
  description: string;
  images: boolean;
  pdfs: boolean;
  reasoning: boolean;
  contextLength?: number;
}

const STORAGE_KEY = "cloudchat:model";

// A folder used as a chat's project.
export interface ProjectFolder {
  id: string;
  name: string;
}

// The project picked for a chat that isn't saved yet. Its first message sends the folder id.
export interface PendingProject {
  chatId: string;
  folder: ProjectFolder | null;
}

function defaultChatModel(): ChatModel {
  const model = chatModels[0];
  if (!model) {
    throw new Error("No default chat models found.");
  }
  return {
    id: model.name,
    label: model.label,
    description: model.description,
    images: model.images,
    pdfs: model.pdfs,
    reasoning: model.reasoning,
  };
}

interface ChatControlContextType {
  selectedChatModel: ChatModel;
  setSelectedChatModel: React.Dispatch<React.SetStateAction<ChatModel>>;
  isTemporary: boolean;
  setIsTemporary: React.Dispatch<React.SetStateAction<boolean>>;
  reasoningEnabled: boolean;
  setReasoningEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  webSearchEnabled: boolean;
  setWebSearchEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  pendingProject: PendingProject | null;
  setPendingProject: React.Dispatch<
    React.SetStateAction<PendingProject | null>
  >;
}

const ChatControlContext = createContext<ChatControlContextType | undefined>(
  undefined,
);

interface Props {
  children: ReactNode;
}

export function ChatControlProvider({ children }: Props) {
  const [selectedChatModel, setSelectedChatModel] =
    useState<ChatModel>(defaultChatModel);

  // Restore the last picked model (localStorage is only available in the browser).
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setSelectedChatModel(JSON.parse(saved) as ChatModel);
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selectedChatModel));
  }, [selectedChatModel]);
  const [isTemporary, setIsTemporary] = useState(false);
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [pendingProject, setPendingProject] = useState<PendingProject | null>(
    null,
  );

  return (
    <ChatControlContext.Provider
      value={{
        selectedChatModel,
        setSelectedChatModel,
        isTemporary,
        setIsTemporary,
        reasoningEnabled,
        setReasoningEnabled,
        webSearchEnabled,
        setWebSearchEnabled,
        pendingProject,
        setPendingProject,
      }}
    >
      {children}
    </ChatControlContext.Provider>
  );
}

export function useChatControl(): ChatControlContextType {
  const context = useContext(ChatControlContext);
  if (!context) {
    throw new Error("useChatControl must be used within a ChatControlProvider");
  }
  return context;
}
