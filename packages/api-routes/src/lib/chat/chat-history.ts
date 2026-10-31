import { convertToModelMessages, isToolUIPart, type ModelMessage } from "ai";
import { type CustomUIMessage } from "../../types/custom-ui-message.js";
import { mockedTools } from "../tools/index.js";

// Every turn sends the model the whole open conversation, as saved. Nothing is
// trimmed or summarized; a conversation that no longer fits the model's context
// window gets a clear error instead (contextOverflowMessage).

// Parts only the server adds (attachments, document text). A client copy of a
// message never supplies them; the server adds them again from the attachments.
// Saved ones are the server's own and replay as sent.
const SERVER_PART_TYPES = new Set(["file", "data-attachmentText"]);

type Part = CustomUIMessage["parts"][number];

function withoutServerParts(message: CustomUIMessage): CustomUIMessage {
  return {
    ...message,
    parts: message.parts.filter((part) => !SERVER_PART_TYPES.has(part.type)),
  };
}

// An assistant message the client sends back (to answer a tool approval) keeps
// the stored parts and takes only the client's approval answers.
function withApprovalAnswers(
  stored: CustomUIMessage,
  client: CustomUIMessage,
): CustomUIMessage {
  const answers = new Map(
    client.parts
      .filter(isToolUIPart)
      .filter((part) => part.state === "approval-responded")
      .map((part) => [part.toolCallId, part] as const),
  );

  return {
    ...stored,
    parts: stored.parts.map((part) => {
      const answer = isToolUIPart(part)
        ? answers.get(part.toolCallId)
        : undefined;
      return answer && "approval" in answer
        ? ({ ...part, state: answer.state, approval: answer.approval } as Part)
        : part;
    }),
  };
}

// Adds the client's message(s) to the stored chat. A message whose id is already
// stored replaces it rather than appearing twice.
export function mergeIncomingMessages(
  stored: CustomUIMessage[],
  incoming: CustomUIMessage[],
): CustomUIMessage[] {
  const merged = [...stored];
  for (const message of incoming.map(withoutServerParts)) {
    const index = merged.findIndex((m) => m.id === message.id);
    if (index === -1) {
      merged.push(message);
    } else if (message.role === "assistant") {
      merged[index] = withApprovalAnswers(merged[index]!, message);
    } else {
      merged[index] = message;
    }
  }
  return merged;
}

export function toModelHistory(
  messages: CustomUIMessage[],
): Promise<ModelMessage[]> {
  return convertToModelMessages<CustomUIMessage>(messages, {
    // Every tool ever saved in a chat, so old tool results replay in full.
    tools: mockedTools,
    // A turn that was cut off can leave a tool call without a result.
    ignoreIncompleteToolCalls: true,
    convertDataPart: (part) =>
      part.type === "data-attachmentText"
        ? { type: "text", text: part.data.text }
        : undefined,
  });
}

const CONTEXT_LIMIT =
  /maximum context length is ([\d,]+)|context_length_exceeded|context window|prompt is too long/i;

// The message to show when a conversation no longer fits the model, or undefined.
export function contextOverflowMessage(
  error: unknown,
  modelId: string,
): string | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  const match = CONTEXT_LIMIT.exec(detail);
  if (!match) return undefined;

  const limit = match[1]
    ? ` (${Number(match[1].replace(/,/g, "")).toLocaleString("en-US")} tokens)`
    : "";
  return `This conversation is longer than ${modelId}'s context window${limit}. Nothing was cut from it; switch to a model with a larger context window to continue.`;
}
