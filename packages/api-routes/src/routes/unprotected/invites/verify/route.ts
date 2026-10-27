import * as z from "zod";

import { findPendingInvite } from "@workspace/server/invitations.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";

const verifyInviteSchema = z.object({
  token: z.string().min(1).max(128),
});

// Lets the sign-up page check an invite link and pre-fill its email.
// The token goes in the body so it doesn't end up in URLs and request logs.
// The real check happens again on sign-up, in the better-auth before hook.
const app = new Hono().post(
  "/",
  validator("json", (value, c) => {
    const parsed = verifyInviteSchema.safeParse(value);
    if (!parsed.success) {
      throw new HTTPException(400, { message: "BAD_REQUEST" });
    }
    return parsed.data;
  }),
  async (c) => {
    const { token } = c.req.valid("json");

    const invite = await findPendingInvite(token);
    if (!invite) {
      throw new HTTPException(404, { message: "INVITE_INVALID" });
    }

    return c.json({ email: invite.email });
  },
);

export default app;
