import { db } from "@workspace/server/drizzle/db.js";
import { files, folders } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import {
  streamText,
  toUIMessageStream,
  type Tool,
  type UIMessageStreamWriter,
} from "ai";
import { inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { standardSystemPrompt } from "../../providers/prompts.js";
import { contextOverflowMessage } from "./chat-history.js";
import { replyUsage } from "./reply-usage.js";
import { callCost, type TurnSpend, turnLimits } from "./stop-conditions.js";
import { type Bindings } from "../../types/bindings.js";
import { type TurnContextSection } from "../../schemas/data-schemas.js";
import { type CustomUIMessage } from "../../types/custom-ui-message.js";
import {
  type FileMetadata,
  filterAuthorizedFiles,
} from "../../utils/filter-authorized-files.js";
import {
  filterAuthorizedFolders,
  type FolderMetadata,
} from "../../utils/filter-authorized-folders.js";
import { generateUUID } from "../../utils/generate-uuid.js";
import { getPromptsByIds } from "../queries/prompts.js";
import { analyzeFolder } from "../tools/analyze-folder.js";
import { createDocument } from "../tools/create-document.js";
import { extractFromDocuments } from "../tools/extract-from-documents.js";
import { fetchWebContent } from "../tools/fetch-web-content.js";
import { firecrawlTools } from "../tools/firecrawl-tools.js";
import { readFile } from "../tools/read-file.js";
import {
  getImportStatus,
  importYouTubeTranscripts,
} from "../tools/import-youtube-transcripts.js";
import { saveToFolder } from "../tools/save-to-folder.js";
import { isFirecrawlConfigured } from "../firecrawl.js";
import {
  composioPrompt,
  createComposioTools,
  isComposioConfigured,
} from "../composio.js";
import { generateFile } from "../tools/generate-file.js";
import { updateDocument } from "../tools/update-document.js";
import { ChatHandler } from "./chat-handler.js";
import { type ChatRequest } from "./chat-request.js";
import {
  buildProjectPrompt,
  loadProject,
  type Project,
  withProjectFolder,
} from "./project-context.js";

const logger = createLogger("standard-chat-handler");

export class StandardChatHandler extends ChatHandler {
  private systemPrompt = standardSystemPrompt;
  private project?: Project; // Loaded at the start of executeChat
  // What this turn has spent, toward its cost ceiling.
  private spend: TurnSpend = { steps: 0, tools: 0 };

  constructor(
    env: Bindings,
    request: ChatRequest,
    waitUntil?: (promise: PromiseLike<unknown>) => void,
  ) {
    super(env, request, waitUntil);
  }

  // The same on every turn, so the provider can reuse its cached prompt.
  private buildSystemPrompt(): string {
    return isComposioConfigured()
      ? this.systemPrompt + composioPrompt
      : this.systemPrompt;
  }

  // What changes from turn to turn goes on the new user message and is saved
  // with it, so earlier turns replay unchanged. The date and location are added
  // every turn; the project and the selected instructions only when they differ
  // from the latest ones already in the conversation, since the selection stays
  // on across turns and the whole conversation is replayed.
  private async addTurnContext(): Promise<void> {
    const lastMessage = this.request.lastMessage;
    if (lastMessage.role !== "user") return;

    const latest = new Map<TurnContextSection, string>();
    for (const message of this.request.messages) {
      for (const part of message.parts) {
        if (part.type === "data-turnContext") {
          latest.set(part.data.section, part.data.text);
        }
      }
    }

    const sections: [TurnContextSection, string | undefined][] = [
      ["now", `\n\n${this.buildCurrentContext()}`],
      ["project", this.buildProjectSection()],
      ["instructions", await this.buildInstructionsSection(latest)],
    ];

    for (const [section, text] of sections) {
      if (text === undefined) continue;
      if (section !== "now" && latest.get(section) === text) continue;
      lastMessage.parts.push({
        type: "data-turnContext",
        data: { section, text },
      });
    }
  }

  private buildProjectSection(): string | undefined {
    if (!this.project) return undefined;

    const effectiveFilter = this.getEffectiveContextFilter();
    const searchesProject =
      !effectiveFilter?.files.length &&
      !!effectiveFilter?.folders.some((f) => f.id === this.project?.folder.id);
    return buildProjectPrompt(this.project, searchesProject);
  }

  // Selected instructions apply from the message they were selected on until a
  // later message changes or removes them.
  private async buildInstructionsSection(
    latest: Map<TurnContextSection, string>,
  ): Promise<string | undefined> {
    const contextFilter = this.getContextFilter();
    const userPrompts = contextFilter?.prompts.length
      ? await getPromptsByIds({
          ids: contextFilter.prompts.map((p) => p.id),
          userId: this.request.user.id,
        })
      : [];

    if (userPrompts.length === 0) {
      // Earlier messages still carry the old instructions, so say they ended.
      return latest.has("instructions")
        ? `\n\n## User-Selected Instructions\n\nThe user removed the custom instructions selected earlier. Don't follow them any more.\n`
        : undefined;
    }

    let section = `\n\n## User-Selected Instructions\n\n`;
    section += `The user selected the following custom instructions. Follow them carefully from this message on; they replace any selected earlier:\n\n`;
    for (const prompt of userPrompts) {
      section += `### ${prompt.name}\n\n${prompt.content}\n\n`;
    }
    return section;
  }

  // The message's context filter, falling back to the chat's project folder
  private getEffectiveContextFilter() {
    return withProjectFolder(this.getContextFilter(), this.project?.folder.id);
  }

  // A Composio outage shouldn't break the chat: carry on without app tools.
  private async composioTools(): Promise<Record<string, Tool>> {
    if (!isComposioConfigured()) return {};
    try {
      return await createComposioTools(this.request.user.id);
    } catch (error) {
      logger.error("Could not load Composio tools", error);
      return {};
    }
  }

  protected async retrieveToolSet(
    writer: UIMessageStreamWriter<CustomUIMessage>,
  ): Promise<Record<string, Tool>> {
    const contextFilter = this.getEffectiveContextFilter();

    const tools: Record<string, Tool> = {
      createDocument: createDocument({
        env: this.env,
        userId: this.request.user.id,
        dataStream: writer,
      }),
      updateDocument: updateDocument({
        env: this.env,
        userId: this.request.user.id,
        dataStream: writer,
      }),
      generateFile: generateFile({
        env: this.env,
        userId: this.request.user.id,
        dataStream: writer,
      }),
      saveToFolder: saveToFolder({
        env: this.env,
        userId: this.request.user.id,
        defaultFolderId: this.project?.folder.id,
      }),
      // Needs FIRECRAWL_API_KEY (pages and YouTube transcripts).
      ...(isFirecrawlConfigured()
        ? {
            fetchWebContent: fetchWebContent(),
            importYouTubeTranscripts: importYouTubeTranscripts({
              env: this.env,
              userId: this.request.user.id,
              defaultFolderId: this.project?.folder.id,
            }),
            getImportStatus: getImportStatus({
              env: this.env,
              userId: this.request.user.id,
            }),
          }
        : {}),
      // Connected apps (Gmail, Slack, Notion, ...) via Composio; needs COMPOSIO_API_KEY.
      ...(await this.composioTools()),
    };

    // Check permissions and get authorized file metadata
    let authorizedFileMetadata: FileMetadata[] = [];
    let authorizedFolderMetadata: FolderMetadata[] = [];

    if (
      contextFilter &&
      ((contextFilter.files && contextFilter.files.length > 0) ||
        (contextFilter.folders && contextFilter.folders.length > 0))
    ) {
      // Check files if present
      if (contextFilter.files && contextFilter.files.length > 0) {
        const fileIds = contextFilter.files.map((f) => f.id);
        const requestedFiles = await db()
          .select({
            id: files.id,
            name: files.name,
            visibility: files.visibility,
            folderId: files.folderId,
            owner: files.owner,
          })
          .from(files)
          .where(inArray(files.id, fileIds));

        logger.debug(
          `Requested ${requestedFiles.length} file(s) for context filter`,
          {
            userId: this.request.user.id,
            fileIds,
          },
        );

        authorizedFileMetadata = await filterAuthorizedFiles(
          requestedFiles,
          this.request.user.id,
        );

        if (authorizedFileMetadata.length !== fileIds.length) {
          logger.warn("User does not have access to all referenced files", {
            userId: this.request.user.id,
            requestedFiles: fileIds.length,
            authorizedFiles: authorizedFileMetadata.length,
          });
          throw new HTTPException(403, {
            message: "You do not have permission to access one or more files",
          });
        }
      }
      // Check folders only if no files are present
      else if (contextFilter.folders && contextFilter.folders.length > 0) {
        const folderIds = contextFilter.folders.map((c) => c.id);
        const requestedFolders = await db()
          .select({
            id: folders.id,
            visibility: folders.visibility,
            folderId: folders.id,
            owner: folders.owner,
          })
          .from(folders)
          .where(inArray(folders.id, folderIds));

        authorizedFolderMetadata = await filterAuthorizedFolders(
          requestedFolders,
          this.request.user.id,
        );

        if (authorizedFolderMetadata.length !== folderIds.length) {
          logger.warn("User does not have access to all referenced folders", {
            userId: this.request.user.id,
            requestedFolders: folderIds.length,
            authorizedFolders: authorizedFolderMetadata.length,
          });
          throw new HTTPException(403, {
            message: "You do not have permission to access one or more folders",
          });
        }
      }

      logger.debug(
        `There are ${authorizedFileMetadata.length} authorized file(s) for the user`,
        {
          userId: this.request.user.id,
          authorizedFileMetadata,
        },
      );
    }

    // Registered on every turn, even with nothing selected or web search off:
    // changing the tool list would invalidate the provider's prompt cache.
    // They explain at call time when their precondition is off.
    tools.extractFromDocuments = extractFromDocuments({
      env: this.env,
      userId: this.request.user.id,
      fileMetadata: authorizedFileMetadata,
      folderMetadata: authorizedFolderMetadata,
      dataStream: writer,
    });
    tools.readFile = readFile({
      env: this.env,
      userId: this.request.user.id,
      fileMetadata: authorizedFileMetadata,
      folderMetadata: authorizedFolderMetadata,
    });
    tools.analyzeFolder = analyzeFolder({
      env: this.env,
      userId: this.request.user.id,
      fileMetadata: authorizedFileMetadata,
      folderMetadata: authorizedFolderMetadata,
      spend: this.spend,
    });
    // Firecrawl is the web layer; the web search toggle enables it.
    if (isFirecrawlConfigured()) {
      Object.assign(
        tools,
        firecrawlTools({
          env: this.env,
          userId: this.request.user.id,
          enabled: Boolean(this.request.webSearchEnabled),
          fileMetadata: authorizedFileMetadata,
          folderMetadata: authorizedFolderMetadata,
        }),
      );
    }

    // A fixed order, so the same tools always produce the same request. A plain
    // comparison, since locale-aware ordering can vary between runtimes.
    return Object.fromEntries(
      Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }

  protected async executeChat(
    writer: UIMessageStreamWriter<CustomUIMessage>,
  ): Promise<void> {
    // Access is checked on every request; a folder the user lost access to is skipped
    this.project = await loadProject(
      this.request.folderId,
      this.request.user.id,
    );

    // Integrate attachments and context filter documents into the messages
    await this.integrateContextIntoMessages();
    await this.addTurnContext();

    // Saved after the attachments are added, so later turns replay them as sent.
    // A continuation (an assistant message) is saved by the reply's onEnd.
    if (!this.request.isTemporary && this.request.lastMessage.role === "user") {
      await this.saveUserMessage();
    }

    const streamConfig = await this.buildStreamTextConfig({
      systemPrompt: this.buildSystemPrompt(),
    });
    const tools = await this.retrieveToolSet(writer);

    logger.info("Executing chat with tools:", Object.keys(tools));

    const result = streamText({
      ...streamConfig,
      tools,
      ...turnLimits(this.spend),
      onError: ({ error }) => {
        logger.error("Model stream error", error);
      },
    });

    // Finish generating even if the client disconnects, so the reply isn't lost.
    this.waitUntil?.(result.consumeStream());

    let stepsCost = 0;
    writer.merge(
      toUIMessageStream<typeof tools, CustomUIMessage>({
        stream: result.stream,
        // The full conversation, so a continuation updates its message in place.
        originalMessages: this.request.messages,
        generateMessageId: generateUUID,
        onEnd: async ({ responseMessage }) => {
          await this.saveResponseMessages([responseMessage]);
        },
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step") {
            stepsCost += callCost(part.providerMetadata);
          }
          // Tokens and cost of the whole turn, including tools' model calls.
          if (part.type === "finish") {
            return {
              usage: replyUsage(part.totalUsage, stepsCost + this.spend.tools),
            };
          }
        },
        sendReasoning: true,
        // Show the real error (e.g. the provider's message) instead of a generic one.
        onError: (error) => this.handleError(error),
      }),
    );
  }

  protected handleError(error: unknown): string {
    logger.error("Error in chat route", error);

    const overflow = contextOverflowMessage(error, this.request.model);
    if (overflow) return overflow;

    const detail = error instanceof Error ? error.message : String(error);
    return `Something went wrong: ${detail.slice(0, 300)}`;
  }
}
