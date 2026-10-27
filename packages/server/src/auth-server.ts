import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, lastLoginMethod, twoFactor } from "better-auth/plugins";
import { HTTPException } from "hono/http-exception";
import { db } from "./drizzle/db.js";
import {
  findPendingInvite,
  INVITE_TOKEN_HEADER,
  markInviteAccepted,
} from "./invitations.js";
import { sendPasswordResetEmail, sendVerificationEmail } from "./send-email.js";

// console.log("Initializing auth server with the following configuration:");
// console.log(`Better Auth URL: ${process.env.BETTER_AUTH_URL}`);
// console.log(`Email Sign-Up Enabled: ${process.env.ENABLE_EMAIL_SIGNUP}`);
// console.log(`OAuth Login Enabled: ${process.env.ENABLE_OAUTH_LOGIN}`);
// console.log(`Enable SSO: ${process.env.ENABLE_SSO}`);

// Helper to build the auth instance with correct plugin typing
function buildAuth() {
  // Build plugins array
  const plugins = [
    admin({
      adminUserIds: (process.env.ADMIN_USER_IDS ?? "").split(","),
    }),
    ...(process.env.ENABLE_EMAIL_SIGNUP === "true"
      ? [
          twoFactor({
            issuer: "CloudBot",
            skipVerificationOnEnable: false,
          }),
        ]
      : []),
    lastLoginMethod({
      storeInDatabase: true,
    }),
  ];

  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    database: drizzleAdapter(db(), {
      provider: "sqlite",
      usePlural: true,
    }),
    user: {
      additionalFields: {
        username: {
          type: "string",
        },
      },
    },
    emailAndPassword: {
      enabled: process.env.ENABLE_EMAIL_SIGNUP === "true",
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url, token }, request) => {
        await sendPasswordResetEmail({
          to: user.email,
          url,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url, token }, request) => {
        // Invited sign-ups are created already verified (see databaseHooks), so they don't need this email.
        if (user.emailVerified) {
          return;
        }
        await sendVerificationEmail({
          to: user.email,
          url,
        });
      },
    },
    ...(process.env.ENABLE_OAUTH_LOGIN === "true"
      ? {
          socialProviders: {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID!,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            },
            github: {
              clientId: process.env.GITHUB_CLIENT_ID!,
              clientSecret: process.env.GITHUB_CLIENT_SECRET,
            },
            gitlab: {
              clientId: process.env.GITLAB_CLIENT_ID!,
              clientSecret: process.env.GITLAB_CLIENT_SECRET,
            },
          },
        }
      : {}),
    trustedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(","),
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      disableSessionRefresh: true,
      cookieCache: {
        enabled: true,
        maxAge: 10 * 60, // Cache duration in seconds
      },
    },
    plugins: plugins,
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") {
          return;
        }
        if (process.env.ALLOWED_EMAIL_DOMAINS) {
          const allowedDomains = (
            process.env.ALLOWED_EMAIL_DOMAINS ?? ""
          ).split(",");
          const emailDomain = ctx.body?.email.split("@").pop();
          if (!emailDomain || !allowedDomains.includes(emailDomain)) {
            throw new HTTPException(400, {
              message: "INVALID_EMAIL_DOMAIN",
            });
          }
        }

        // Sign-up is invite-only. The sign-up form sends the token from the invite link in this header.
        const inviteToken = ctx.headers?.get(INVITE_TOKEN_HEADER);
        const email = ctx.body?.email;
        const invite = inviteToken
          ? await findPendingInvite(inviteToken)
          : null;
        if (
          !invite ||
          typeof email !== "string" ||
          invite.email !== email.toLowerCase()
        ) {
          throw new APIError("FORBIDDEN", {
            message:
              "Sign-up is invite-only. This invite is invalid, expired, already used or for a different email. Ask an admin for a new invite.",
          });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // A /sign-up/email request only gets this far once the before hook has accepted its invite.
          // The invite link proved the inbox, so the account starts out verified.
          before: async (user, ctx) => {
            if (ctx?.path === "/sign-up/email") {
              return { data: { ...user, emailVerified: true } };
            }
          },
          after: async (user, ctx) => {
            const inviteToken = ctx?.headers?.get(INVITE_TOKEN_HEADER);
            if (ctx?.path === "/sign-up/email" && inviteToken) {
              await markInviteAccepted(inviteToken);
            }
          },
        },
      },
    },
    rateLimit: {
      window: 300,
      max: 60,
    },
    advanced: {
      database: {
        generateId: false,
      },
      ...(process.env.BASE_DOMAIN
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: process.env.BASE_DOMAIN,
            },
          }
        : {}),
    },
    logger: {
      disabled: false,
      disableColors: process.env.NODE_ENV !== "development",
      level: process.env.NODE_ENV === "development" ? "debug" : "error",
    },
    experimental: { joins: true },
  });
}

export type Auth = ReturnType<typeof buildAuth>;
export type Session = Auth["$Infer"]["Session"];

let _auth: Auth | null = null;

export function auth(): Auth {
  if (!_auth) {
    _auth = buildAuth();
  }
  return _auth;
}
