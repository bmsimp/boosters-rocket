import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { db } from "@/lib/db/client";
import { recordSignin } from "./signin-audit";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification } from "@/lib/db/schema";
import { env, parentDoorEnabled } from "@/env";

export const PARENT_PROVIDER_ID = "parent-oidc";

export const parentAuth = betterAuth({
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
  databaseHooks: { session: { create: { after: (session, ctx) => recordSignin("parent", session, ctx) } } },
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  user: { additionalFields: { objectId: { type: "string", required: false, input: false } } },
  plugins: parentDoorEnabled ? [genericOAuth({
    config: [{
      providerId: PARENT_PROVIDER_ID,
      discoveryUrl: env.PARENT_OIDC_DISCOVERY_URL!,
      clientId: env.PARENT_OIDC_CLIENT_ID!,
      clientSecret: env.PARENT_OIDC_CLIENT_SECRET!,
      scopes: ["openid", "email", "profile"],
      pkce: true,
      // The oid claim must come from a signature-verified ID token, so refuse to run without one.
      requireIdTokenVerification: true,
      // Entra External ID puts the directory object id in `oid`; that is what Graph provisioning records.
      mapProfileToUser: (profile) => ({
        objectId: typeof profile.oid === "string" ? profile.oid : null,
      }),
    }],
  })] : [],
});
