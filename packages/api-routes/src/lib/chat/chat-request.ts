import * as z from "zod";

import { type User } from "@workspace/server/drizzle/schema.js";
import { createLogger } from "@workspace/server/logger/logger.js";
import { validateUIMessages } from "ai";
import { type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { dataSchemas } from "../../schemas/data-schemas.js";
import { metadataSchema } from "../../schemas/metadata-schema.js";
import { type CustomUIMessage } from "../../types/custom-ui-message.js";
import { type UserLocation } from "../../types/user-location.js";
import { getReadableFolder } from "../folder-access.js";
import { getChatById } from "../queries/chats.js";
import { getMessagesByChatId } from "../queries/messages.js";
import { mergeIncomingMessages } from "./chat-history.js";
import { mockedTools } from "../tools/index.js";

const logger = createLogger("chat-request");

interface CloudflareRequest extends Request {
  cf?: Record<string, string>;
}

export class ChatRequest {
  public readonly id: string; // Chat ID
  public readonly user: User;
  public readonly messages: CustomUIMessage[];
  public readonly lastMessage: CustomUIMessage;
  public readonly createNewChat: boolean;
  public readonly model: string; // OpenRouter model id
  public readonly isTemporary: boolean; // Whether to save the chat or not
  public readonly reasoningEnabled?: boolean;
  public readonly webSearchEnabled?: boolean;
  public readonly userLocation: UserLocation;
  // The chat's project folder: the stored one, or the requested one for a new chat.
  // Access is checked again before it is used as context.
  public readonly folderId?: string;

  constructor(
    id: string,
    user: User,
    messages: CustomUIMessage[],
    createNewChat: boolean,
    model: string,
    isTemporary: boolean,
    userLocation: UserLocation,
    reasoningEnabled?: boolean,
    webSearchEnabled?: boolean,
    folderId?: string,
  ) {
    this.id = id;
    this.user = user;
    this.messages = messages;
    this.lastMessage = messages[messages.length - 1];
    this.createNewChat = createNewChat;
    this.model = model;
    this.isTemporary = isTemporary;
    this.userLocation = userLocation;
    this.reasoningEnabled = reasoningEnabled;
    this.webSearchEnabled = webSearchEnabled;
    this.folderId = folderId;

    logger.debug("ChatRequest constructed", {
      chatId: id,
      userId: user.id,
      messageCount: messages.length,
      isTemporary,
      reasoningEnabled,
      webSearchEnabled,
      userLocation,
      folderId,
    });
  }

  static async fromRequest(
    c: Context,
    schema: z.ZodType<any>,
  ): Promise<ChatRequest> {
    const payload = await c.req.json();

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      logger.warn("ChatRequest payload validation failed", {
        error: z.treeifyError(parsed.error),
      });
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    const validatedPayload = parsed.data;

    const user = c.get("user");

    const {
      id,
      messages: incomingMessages,
      model,
      temporary: isTemporary,
      reasoning: reasoningEnabled,
      webSearch: webSearchEnabled,
      folderId: requestedFolderId,
    } = validatedPayload;

    // Extract user location from Cloudflare's request.cf properties.
    // These are populated automatically by Cloudflare's edge network
    const cf = (c.req.raw as CloudflareRequest).cf;
    const userLocation: UserLocation = {
      city: cf?.city,
      region: cf?.region,
      regionCode: cf?.regionCode,
      country: cf?.country,
      timezone: cf?.timezone,
      latitude: cf?.latitude,
      longitude: cf?.longitude,
    };

    let createNewChat = false;
    let folderId: string | undefined;
    let prevMessages: CustomUIMessage[] = [];

    // Check chat ownership and load messages for non-temporary chats
    if (!isTemporary) {
      const chat = await getChatById({ id });

      if (!chat) {
        createNewChat = true;
      } else if (chat.userId !== user.id) {
        logger.warn("User does not own chat", {
          chatId: id,
          userId: user.id,
        });
        throw new HTTPException(403, { message: "FORBIDDEN" });
      } else {
        folderId = chat.folderId ?? undefined;
      }

      // A requested folder only applies to a new chat, and the user must be able to read it
      if (createNewChat && requestedFolderId) {
        const folder = await getReadableFolder(requestedFolderId, user.id);
        if (!folder) {
          logger.warn("User cannot read the requested chat folder", {
            chatId: id,
            userId: user.id,
            folderId: requestedFolderId,
          });
          throw new HTTPException(403, { message: "FORBIDDEN" });
        }
        folderId = folder.id;
      }

      // Load the full saved chat
      prevMessages = await getMessagesByChatId({
        bucket: c.env.CLOUDBOT_BUCKET,
        chatId: id,
      });
    }

    const messages = mergeIncomingMessages(
      prevMessages,
      incomingMessages as CustomUIMessage[],
    );

    let validatedUIMessages: CustomUIMessage[];
    try {
      validatedUIMessages = await validateUIMessages<CustomUIMessage>({
        messages,
        dataSchemas,
        metadataSchema,
        tools: mockedTools,
      });
    } catch (error) {
      logger.warn("Message validation failed", {
        chatId: id,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }


    return new ChatRequest(
      id,
      user,
      validatedUIMessages,
      createNewChat,
      model,
      isTemporary,
      userLocation,
      reasoningEnabled,
      webSearchEnabled,
      folderId,
    );
  }
}
