import * as z from "zod";

import { getReadableFolder } from "@workspace/api-routes/lib/folder-access.js";
import { uuidSchema } from "@workspace/api-routes/schemas/uuid-schema.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type Variables } from "@workspace/api-routes/types/variables.js";
import { db } from "@workspace/server/drizzle/db.js";
import { chats } from "@workspace/server/drizzle/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

const paramSchema = z.object({ folderId: uuidSchema }).strict();

// The current user's chats in a folder, newest first.
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().get(
  "/",
  validator("param", (value, c) => {
    const parsed = paramSchema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    return parsed.data;
  }),
  async (c) => {
    const { folderId } = c.req.valid("param");
    const user = c.get("user");

    const folder = await getReadableFolder(folderId, user.id);
    if (!folder) {
      throw new HTTPException(403, { message: "FORBIDDEN" });
    }

    const folderChats = await db()
      .select({
        id: chats.id,
        title: chats.title,
        createdAt: chats.createdAt,
        isFavourite: chats.isFavourite,
      })
      .from(chats)
      .where(and(eq(chats.userId, user.id), eq(chats.folderId, folder.id)))
      .orderBy(desc(chats.createdAt));

    return c.json(folderChats);
  },
);

export default app;
