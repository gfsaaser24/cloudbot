import * as z from "zod";

import { getReadableFolder } from "@workspace/api-routes/lib/folder-access.js";
import { uuidSchema } from "@workspace/api-routes/schemas/uuid-schema.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type Variables } from "@workspace/api-routes/types/variables.js";
import { db } from "@workspace/server/drizzle/db.js";
import { chats } from "@workspace/server/drizzle/schema.js";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import { chatsFolderSchema } from "./schema.js";

const paramSchema = z.object({ chatId: uuidSchema }).strict();

// Sets or clears the chat's folder ("project").
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().patch(
  "/",
  validator("param", (value, c) => {
    const parsed = paramSchema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    return parsed.data;
  }),
  validator("json", (value, c) => {
    const parsed = chatsFolderSchema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    return parsed.data;
  }),
  async (c) => {
    const { chatId } = c.req.valid("param");
    const { folderId } = c.req.valid("json");
    const user = c.get("user");

    const chat = await db()
      .select({ id: chats.id })
      .from(chats)
      .where(and(eq(chats.id, chatId), eq(chats.userId, user.id)))
      .limit(1);

    if (chat.length === 0) {
      throw new HTTPException(404, { message: "NOT_FOUND" });
    }

    let folder: { id: string; name: string } | null = null;
    if (folderId) {
      const readable = await getReadableFolder(folderId, user.id);
      if (!readable) {
        throw new HTTPException(403, { message: "FORBIDDEN" });
      }
      folder = { id: readable.id, name: readable.name };
    }

    await db()
      .update(chats)
      .set({ folderId: folder?.id ?? null })
      .where(and(eq(chats.id, chatId), eq(chats.userId, user.id)));

    return c.json({ folderId: folder?.id ?? null, folder });
  },
);

export default app;
