import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignout } from "./signin-audit";
import { parentCodePlugin } from "./parent-code-plugin";
import { PARENT_SESSION_SECONDS } from "@/lib/parents/sessions";
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
    // A cheap in-memory cap per IP and path in front of the database limits (signin-codes.ts), so a flood is turned
    // away before it reaches Postgres. Better Auth turns its limiter on only when NODE_ENV is production; that default
    // is kept, so the integration tests don't meet it.
    rateLimit: { customRules: { "/portal-code/send": { window: 60, max: 20 }, "/portal-code/verify": { window: 60, max: 20 } } },
    account: { accountLinking: { enabled: false } },
    // Behind Cloudflare: the tunnel sets cf-connecting-ip and the app port is never published, so only that header is trusted.
    advanced: { cookiePrefix: "br_parent", ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: {
      // The portal writes the parent `signin` row itself, with the family entered (family-choice.ts).
      session: { delete: { after: (session, ctx) => recordSignout("parent", session, ctx) } },
    },
    // Spec §1: 90 days, renewed by use; no cookie cache, so ended sessions stop at the next request. Better Auth only
    // sets the row's first expiry and refuses a row past it. Its own refresh stays off: the portal renews the row
    // itself (renewParentSession in src/lib/parents/sessions.ts, called from identity.ts), and the cookie is set once,
    // at sign-in, to outlive it (parent-code-plugin.ts).
    session: {
      expiresIn: PARENT_SESSION_SECONDS,
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
