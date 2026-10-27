import * as z from "zod";

import { type Bindings } from "@workspace/api-routes/types/bindings.js";
import { type Variables } from "@workspace/api-routes/types/variables.js";
import { db } from "@workspace/server/drizzle/db.js";
import { invitations, users } from "@workspace/server/drizzle/schema.js";
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_TTL_MS,
} from "@workspace/server/invitations.js";
import { sendInviteEmail } from "@workspace/server/send-email.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

const createInviteSchema = z.object({
  email: z.email().max(64),
  locale: z.enum(["en", "de"]).default("en"),
});

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  .get("/", async (c) => {
    const rows = await db()
      .select({
        id: invitations.id,
        email: invitations.email,
        createdAt: invitations.createdAt,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
      })
      .from(invitations)
      .orderBy(desc(invitations.createdAt));

    const now = new Date();
    const invites = rows.map((invite) => ({
      ...invite,
      status: invite.acceptedAt
        ? ("accepted" as const)
        : invite.expiresAt <= now
          ? ("expired" as const)
          : ("pending" as const),
    }));

    return c.json(invites);
  })
  .post(
    "/",
    validator("json", (value, c) => {
      const parsed = createInviteSchema.safeParse(value);
      if (!parsed.success) {
        throw new HTTPException(400, { message: "BAD_REQUEST" });
      }
      return parsed.data;
    }),
    async (c) => {
      const { locale } = c.req.valid("json");
      const email = c.req.valid("json").email.toLowerCase();
      const admin = c.get("user");

      const [existingUser] = await db()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existingUser) {
        throw new HTTPException(409, { message: "USER_ALREADY_EXISTS" });
      }

      // Re-inviting replaces any earlier invite that hasn't been used yet.
      await db()
        .delete(invitations)
        .where(
          and(eq(invitations.email, email), isNull(invitations.acceptedAt)),
        );

      const token = generateInviteToken();
      await db()
        .insert(invitations)
        .values({
          email,
          tokenHash: await hashInviteToken(token),
          invitedBy: admin.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        });

      try {
        await sendInviteEmail({
          to: email,
          url: `${process.env.BETTER_AUTH_URL}/${locale}/sign-up?invite=${token}`,
        });
      } catch (error) {
        // The invite stays pending; inviting the same email again replaces it.
        console.error(error);
        throw new HTTPException(502, { message: "INVITE_EMAIL_FAILED" });
      }

      return c.json({ message: "Invite sent" });
    },
  );

export default app;
