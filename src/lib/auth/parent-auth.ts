import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignout } from "./signin-audit";
import { parentCodePlugin } from "./parent-code-plugin";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification } from "@/lib/db/schema";
import { env } from "@/env";

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
