import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, type CryptoKey } from "jose";
import { eq } from "drizzle-orm";

// Discovery URL and client id only (no secret), so the default verifier is configured but the
// generic OAuth plugin stays off and does no network discovery of its own.
const DISCOVERY = "https://parent-idp.test/tenant/v2.0/.well-known/openid-configuration";
vi.hoisted(() => {
  process.env.PARENT_OIDC_DISCOVERY_URL = "https://parent-idp.test/tenant/v2.0/.well-known/openid-configuration";
  process.env.PARENT_OIDC_CLIENT_ID = "parent-client-id";
});

import { db } from "@/lib/db/client";
import { parentAuthUser, auditLog } from "@/lib/db/schema";
import { parentAuth, PARENT_PROVIDER_ID } from "@/lib/auth/parent-auth";
import { resolveGuardian } from "@/lib/auth/resolve";
import { resetDb, seedGuardian } from "../helpers/db";

const ISSUER = "https://parent-idp.test/tenant/v2.0";
const JWKS_URI = "https://parent-idp.test/tenant/discovery/v2.0/keys";
const OID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
let key: CryptoKey;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === DISCOVERY) return Response.json({ issuer: ISSUER, jwks_uri: JWKS_URI, id_token_signing_alg_values_supported: ["RS256"] });
    if (url === JWKS_URI) return Response.json({ keys: [jwk] });
    return realFetch(input);
  });
});
afterAll(() => { vi.unstubAllGlobals(); });

const token = (sub: string) => new SignJWT({ oid: OID, email: "ana@example.com" })
  .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience("parent-client-id")
  .setSubject(sub).setIssuedAt().setExpirationTime("1h").sign(key);

describe("parent Better Auth instance account hooks", () => {
  beforeEach(resetDb);

  it("captures the verified oid when Better Auth creates the parent account, so the guardian resolves", async () => {
    const g = await seedGuardian({ name: "Ana Ramirez", familyQboId: "123", objectId: OID, status: "invited" });
    const ctx = await parentAuth.$context;
    const [user] = await db.insert(parentAuthUser).values({ id: "pu1", name: "Ana", email: "ana@example.com", emailVerified: true }).returning();
    if (!user) throw new Error("seed failed");
    await ctx.internalAdapter.createAccount({ userId: user.id, providerId: PARENT_PROVIDER_ID, accountId: "sub-ana", idToken: await token("sub-ana") });
    const [row] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, user.id));
    expect(row?.objectId).toBe(OID);
    expect((await db.select().from(auditLog)).filter((a) => a.action === "parent.object_id_set")).toHaveLength(1);
    expect(await resolveGuardian(user.id)).toMatchObject({ door: "parent", guardianId: g.id });
  });

  it("backfills on a later sign-in (account update) for a user created before the fix", async () => {
    const ctx = await parentAuth.$context;
    const [user] = await db.insert(parentAuthUser).values({ id: "pu1", name: "Ana", email: "ana@example.com", emailVerified: true }).returning();
    if (!user) throw new Error("seed failed");
    const acc = await ctx.internalAdapter.createAccount({ userId: user.id, providerId: PARENT_PROVIDER_ID, accountId: "sub-ana", idToken: null });
    expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, user.id)))[0]?.objectId).toBeNull();
    await ctx.internalAdapter.updateAccount(acc.id, { idToken: await token("sub-ana") });
    expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, user.id)))[0]?.objectId).toBe(OID);
    const reasons = (await db.select().from(auditLog)).filter((a) => a.action === "parent.object_id_unverified").map((a) => a.after);
    expect(reasons).toEqual([{ reason: "no_id_token" }]);
    expect((await db.select().from(auditLog)).filter((a) => a.action === "parent.object_id_set").map((a) => a.after)).toEqual([{ objectId: OID }]);
  });
});
