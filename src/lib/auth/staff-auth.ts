import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { staffAuthUser, staffAuthSession, staffAuthAccount, staffAuthVerification } from "@/lib/db/schema";
import { env, staffEntraEnabled, staffGoogleEnabled } from "@/env";

export const staffAuth = betterAuth({
  appName: "Booster Rocket staff",
  baseURL: env.APP_URL,
  basePath: "/api/auth/staff",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user: staffAuthUser, session: staffAuthSession, account: staffAuthAccount, verification: staffAuthVerification },
  }),
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false } },
  advanced: { cookiePrefix: "br_staff" },
  session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
  socialProviders: {
    ...(staffEntraEnabled ? { microsoft: {
      clientId: env.STAFF_ENTRA_CLIENT_ID!, clientSecret: env.STAFF_ENTRA_CLIENT_SECRET!,
      tenantId: env.STAFF_ENTRA_TENANT_ID!, // single-tenant: only the club's own directory
    } } : {}),
    ...(staffGoogleEnabled ? { google: {
      clientId: env.STAFF_GOOGLE_CLIENT_ID!, clientSecret: env.STAFF_GOOGLE_CLIENT_SECRET!,
    } } : {}),
  },
});
