import { ChatHandler } from "@workspace/api-routes/lib/chat/chat-handler.js";
import { type ChatRequest } from "@workspace/api-routes/lib/chat/chat-request.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type CustomUIMessage } from "@workspace/api-routes/types/custom-ui-message.js";
import { describe, expect, it, vi } from "vitest";

// The document filter stays selected across turns and the whole conversation is
// replayed, so a referenced document must enter the history once, not every turn.

const documents = vi.hoisted(() => ({
  current: [{ id: "d1", title: "Plan", content: "The launch is in May." }],
}));

vi.mock("@workspace/api-routes/lib/queries/documents.js", () => ({
  getLatestDocumentsByIds: async () => documents.current,
}));

class TestHandler extends ChatHandler {
  integrate() {
    return this.integrateContextIntoMessages();
  }
  protected async retrieveToolSet() {
    return {};
  }
  protected async executeChat() {}
  protected handleError() {
    return "";
  }
}

const filter = {
  prompts: [],
  folders: [],
  files: [],
  documents: [{ id: "00000000-0000-4000-8000-000000000001" }],
};

const userTurn = (id: string, text: string) =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: { contextFilter: filter },
  }) as unknown as CustomUIMessage;

async function integrate(messages: CustomUIMessage[]) {
  const request = {
    messages,
    lastMessage: messages.at(-1),
    user: { id: "user-1" },
  } as unknown as ChatRequest;
  await new TestHandler({} as Bindings, request).integrate();
  return messages;
}

const documentParts = (messages: CustomUIMessage[]) =>
  messages.flatMap((m) => m.parts.filter((p) => p.type === "data-attachmentText"));

describe("referenced documents", () => {
  it("adds a selected document once, not again on later turns", async () => {
    const first = await integrate([userTurn("u1", "summarize")]);
    const second = await integrate([...first, userTurn("u2", "and the date?")]);

    expect(documentParts(second)).toHaveLength(1);
    expect(JSON.stringify(documentParts(second))).toContain("The launch is in May.");
  });

  it("adds the new version when the document changed since it was added", async () => {
    const first = await integrate([userTurn("u1", "summarize")]);
    documents.current = [{ id: "d1", title: "Plan", content: "The launch moved to June." }];
    const second = await integrate([...first, userTurn("u2", "anything new?")]);

    expect(documentParts(second)).toHaveLength(2);
    expect(JSON.stringify(second.at(-1))).toContain("The launch moved to June.");
  });
});
