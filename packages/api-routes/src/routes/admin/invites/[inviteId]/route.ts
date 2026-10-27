import * as z from "zod";

import { uuidSchema } from "@workspace/api-routes/schemas/uuid-schema.js";
import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type Variables } from "@workspace/api-routes/types/variables.js";
import { db } from "@workspace/server/drizzle/db.js";
import { invitations } from "@workspace/server/drizzle/schema.js";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

const paramSchema = z.object({ inviteId: uuidSchema }).strict();

// Revoking deletes an unused invite, which makes its link stop working.
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>().delete(
  "/",
  validator("param", (value, c) => {
    const parsed = paramSchema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    return parsed.data;
  }),
  async (c) => {
    const { inviteId } = c.req.valid("param");

    const deleted = await db()
      .delete(invitations)
      .where(and(eq(invitations.id, inviteId), isNull(invitations.acceptedAt)))
      .returning({ email: invitations.email });

    if (!deleted[0]) {
      throw new HTTPException(404, { message: "NOT_FOUND" });
    }

    return c.json({ email: deleted[0].email });
  },
);

export default app;
