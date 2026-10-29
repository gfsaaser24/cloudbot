// Connected apps through Composio (https://docs.composio.dev): one Tool Router
// session per chat turn gives the model a few meta tools to search ~1,000 app
// toolkits, ask the user to connect an app (a Composio-hosted sign-in link),
// and run app tools. Composio stores each user's connections under their
// CloudChat user id, so CloudChat keeps no OAuth state itself.
//
// Plain REST (v3.1) instead of the SDK or an MCP client, to keep the Worker small.

import { createLogger } from "@workspace/server/logger/logger.js";
import { dynamicTool, jsonSchema, type Tool } from "ai";

const logger = createLogger("composio");

const API = "https://backend.composio.dev/api/v3.1/tool_router";

// Large tool results (e.g. a search plan or an inbox listing) are cut to keep the context small.
const MAX_RESULT_CHARS = 30_000;

type MetaTool = {
  slug: string;
  description: string;
  input_parameters: Record<string, unknown>;
};

export function isComposioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

async function composio<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "x-api-key": process.env.COMPOSIO_API_KEY ?? "",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Composio ${path} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response.json() as Promise<T>;
}

function limit(data: unknown): unknown {
  const text = JSON.stringify(data);
  return text.length > MAX_RESULT_CHARS
    ? { truncated: true, preview: text.slice(0, MAX_RESULT_CHARS) }
    : data;
}

// The session's meta tools as AI SDK tools. Dynamic tools, because their names
// and schemas come from Composio at runtime (and chat history validates them
// without a fixed schema).
export async function createComposioTools(
  userId: string,
): Promise<Record<string, Tool>> {
  const session = await composio<{ session_id: string }>("/session", {
    method: "POST",
    // The remote workbench and bash sandbox are left off; the chat has its own file tools.
    body: JSON.stringify({ user_id: userId, workbench: { enable: false } }),
  });

  const { items } = await composio<{ items: MetaTool[] }>(
    `/session/${session.session_id}/tools`,
  );

  return Object.fromEntries(
    items.map((meta) => [
      meta.slug,
      dynamicTool({
        description: meta.description,
        inputSchema: jsonSchema(meta.input_parameters),
        execute: async (args) => {
          const result = await composio<{
            data: unknown;
            error: string | null;
            result_type?: string;
            log_id?: string;
          }>(`/session/${session.session_id}/execute`, {
            method: "POST",
            body: JSON.stringify({ tool_slug: meta.slug, arguments: args }),
          });
          if (result.error || result.result_type === "failed") {
            logger.warn("Composio tool failed", {
              tool: meta.slug,
              logId: result.log_id,
            });
            return { error: result.error ?? "The tool call failed." };
          }
          return limit(result.data);
        },
      }),
    ]),
  );
}

export const composioPrompt = `

## Connected apps

You can use the user's apps (Gmail, Google Drive and Sheets, Slack, Notion, GitHub, HubSpot and about 1,000 more) through the COMPOSIO_* tools: search for the right tool with COMPOSIO_SEARCH_TOOLS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL. If an app isn't connected yet, call COMPOSIO_MANAGE_CONNECTIONS and give the user the authentication link as a clickable Markdown link; continue once they say they've connected it. Before sending, posting, deleting or changing anything in an app, confirm with the user unless they asked for exactly that.`;
