import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignout } from "./signin-audit";
import { parentCodePlugin } from "./parent-code-plugin";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification } from "@/lib/db/schema";
import { env } from "@/env";

/**
 * Every Better Auth route a parent doesn't need. Several write (/update-user, the revoke routes, /unlink-account) and
 * none of them is audited, so they answer 404 (Better Auth matches these exactly, before routing). Left reachable:
 * /get-session, /sign-out, /portal-code/send, /portal-code/verify, /ok, /error, and two routes with a path parameter
 * that can't be listed and can't act here (/callback/:id has no provider; /reset-password/:token has no password).
 */
export const PARENT_DISABLED_PATHS = [
  "/sign-in/social", "/sign-up/email", "/sign-in/email", "/reset-password", "/request-password-reset", "/verify-password",
  "/verify-email", "/send-verification-email", "/change-email", "/change-password", "/update-session", "/update-user",
  "/delete-user", "/delete-user/callback", "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/link-social", "/list-accounts", "/unlink-account", "/refresh-token", "/get-access-token", "/account-info",
];

// The portal's own email-code door (spec §1); the External ID door is gone.
function buildParentAuth() {
  return betterAuth({
    appName: "Booster Rocket",
    baseURL: env.APP_URL,
    basePath: "/api/auth/parent",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: parentAuthUser, session: parentAuthSession, account: parentAuthAccount, verification: parentAuthVerification },
    }),
    emailAndPassword: { enabled: false },
    disabledPaths: PARENT_DISABLED_PATHS,
    account: { accountLinking: { enabled: false } },
    // Behind Cloudflare: the tunnel sets cf-connecting-ip and the app port is never published, so only that header is trusted.
    advanced: { cookiePrefix: "br_parent", ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: {
      // The portal writes the parent `signin` row itself, with the family entered (family-choice.ts).
      session: { delete: { after: (session, ctx) => recordSignout("parent", session, ctx) } },
    },
    // Spec §1: 7 days from sign-in, never extended; no cookie cache, so ended sessions stop at the next request.
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      disableSessionRefresh: true,
      additionalFields: { familyQboId: { type: "string", required: false, input: false } },
    },
    // Every sign-in user belongs to a person record, set when the person is made. input: false: a parent can't change the
    // person link through /update-user.
    user: { additionalFields: { parentId: { type: "string", required: true, input: false } } },
    plugins: [parentCodePlugin()],
  });
}

export type ParentAuth = ReturnType<typeof buildParentAuth>;
let built: ParentAuth | null = null;

/** The parent Better Auth instance. */
export async function getParentAuth(): Promise<ParentAuth> {
  built ??= buildParentAuth();
  return built;
}
