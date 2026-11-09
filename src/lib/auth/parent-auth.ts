import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { db } from "@/lib/db/client";
import { recordSignin, recordSignout } from "./signin-audit";
import { captureParentObjectId, PARENT_PROVIDER_ID } from "./parent-object-id";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification } from "@/lib/db/schema";
import { env } from "@/env";
import { loadProviders, parentDiscoveryUrl, type LoadedProviders } from "./providers";

export { PARENT_PROVIDER_ID };

function buildParentAuth(p: LoadedProviders) {
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
      session: {
        create: { after: (session, ctx) => recordSignin("parent", session, ctx) },
        delete: { after: (session, ctx) => recordSignout("parent", session, ctx) },
      },
      // Better Auth drops `input: false` fields from provider profiles, so the verified `oid` is captured here instead.
      account: {
        create: { after: async (account, ctx) => { await captureParentObjectId(account, undefined, ctx); } },
        update: { after: async (account, ctx) => { if (account) await captureParentObjectId(account, undefined, ctx); } },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
    // input: false keeps parents from setting objectId via /update-user; captureParentObjectId writes it.
    user: { additionalFields: { objectId: { type: "string", required: false, input: false } } },
    plugins: p.parent ? [genericOAuth({
      config: [{
        providerId: PARENT_PROVIDER_ID,
        discoveryUrl: parentDiscoveryUrl(p.parent.config),
        clientId: p.parent.config.clientId,
        clientSecret: p.parent.secret,
        scopes: ["openid", "email", "profile"],
        pkce: true,
        // The oid claim must come from a signature-verified ID token, so refuse to run without one.
        requireIdTokenVerification: true,
      }],
    })] : [],
  });
}

export type ParentAuth = ReturnType<typeof buildParentAuth>;
let built: { version: number; auth: ParentAuth } | null = null;

/** The parent Better Auth instance for the current stored providers; rebuilt after a provider is saved. */
export async function getParentAuth(): Promise<ParentAuth> {
  const p = await loadProviders();
  if (!built || built.version !== p.version) built = { version: p.version, auth: buildParentAuth(p) };
  return built.auth;
}
