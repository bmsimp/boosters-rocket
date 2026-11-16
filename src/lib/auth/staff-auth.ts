import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignin, recordSignout } from "./signin-audit";
import { staffAuthUser, staffAuthSession, staffAuthAccount, staffAuthVerification } from "@/lib/db/schema";
import { env } from "@/env";
import { loadProviders, type LoadedProviders } from "./providers";
import { createEntraAssertionGetter } from "./client-assertion";
import { CLIENT_ADDRESS, stampingHandler } from "./client-address";

function buildStaffAuth(p: LoadedProviders) {
  return betterAuth({
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
    // The visitor's address comes from the portal's one reading of it (client-address.ts), not from a header named here.
    advanced: { cookiePrefix: "br_staff", ipAddress: CLIENT_ADDRESS },
    databaseHooks: { session: {
      create: { after: (session, ctx) => recordSignin("staff", session, ctx) },
      delete: { after: (session, ctx) => recordSignout("staff", session, ctx) },
    } },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    socialProviders: {
      ...(p.staffMicrosoft ? { microsoft: {
        clientId: p.staffMicrosoft.config.clientId,
        tenantId: p.staffMicrosoft.config.tenantId, // single-tenant: only the club's own directory
        // Certificate credential (private_key_jwt); there is no client secret. Better Auth calls this for the code
        // exchange and for refreshes, passing the real token endpoint, which becomes the assertion's audience.
        clientAssertion: createEntraAssertionGetter({ ...p.staffMicrosoft.assertion, clientId: p.staffMicrosoft.config.clientId }),
      } } : {}),
      ...(p.staffGoogle ? { google: { clientId: p.staffGoogle.config.clientId, clientSecret: p.staffGoogle.secret } } : {}),
    },
  });
}

export type StaffAuth = ReturnType<typeof buildStaffAuth>;
let built: { version: number; auth: StaffAuth } | null = null;

/** The staff Better Auth instance for the current stored providers; rebuilt after a provider is saved. */
export async function getStaffAuth(): Promise<StaffAuth> {
  const p = await loadProviders();
  if (!built || built.version !== p.version) built = { version: p.version, auth: stampingHandler(buildStaffAuth(p)) };
  return built.auth;
}
