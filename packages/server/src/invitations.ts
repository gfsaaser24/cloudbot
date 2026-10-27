import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./drizzle/db.js";
import { invitations } from "./drizzle/schema.js";

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The sign-up form sends the invite token in this header on POST /api/auth/sign-up/email.
export const INVITE_TOKEN_HEADER = "x-invite-token";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// 32 random bytes, hex encoded. Only the hash is stored; the token itself is only in the email.
export function generateInviteToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toHex(new Uint8Array(digest));
}

// Returns the invite for this token if it is unused and unexpired, otherwise null.
export async function findPendingInvite(token: string) {
  const tokenHash = await hashInviteToken(token);
  const [invite] = await db()
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, tokenHash),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invite ?? null;
}

export async function markInviteAccepted(token: string) {
  const tokenHash = await hashInviteToken(token);
  await db()
    .update(invitations)
    .set({ acceptedAt: new Date() })
    .where(eq(invitations.tokenHash, tokenHash));
}
