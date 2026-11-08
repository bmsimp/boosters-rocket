import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type CryptoKey, type JWTPayload } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthUser, auditLog } from "@/lib/db/schema";
import { captureParentObjectId, createParentIdTokenVerifier, PARENT_PROVIDER_ID, type ParentIdTokenVerifier } from "@/lib/auth/parent-object-id";
import { resolveGuardian } from "@/lib/auth/resolve";
import { resetDb, seedGuardian } from "../helpers/db";

const ISSUER = "https://tenant.ciamlogin.com/tenant/v2.0";
const AUDIENCE = "parent-client-id";
const OID = "11111111-2222-3333-4444-555555555555";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let verify: ParentIdTokenVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  verify = createParentIdTokenVerifier({ jwks: createLocalJWKSet({ keys: [jwk] }), issuer: ISSUER, audience: AUDIENCE, algorithms: ["RS256"] });
});

async function idToken(claims: JWTPayload = {}, opts: { key?: CryptoKey; iss?: string; aud?: string; exp?: number | string } = {}) {
  return new SignJWT({ oid: OID, email: "ana@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? AUDIENCE).setSubject("sub-ana")
    .setIssuedAt().setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? signingKey);
}

async function parentUser(id: string, objectId: string | null = null) {
  await db.insert(parentAuthUser).values({ id, name: "Ana", email: `${id}@example.com`, emailVerified: true, objectId });
}
const account = (userId: string, token: string | null) => ({ userId, providerId: PARENT_PROVIDER_ID, accountId: "sub-ana", idToken: token });
const objectIdOf = async (id: string) => (await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, id)))[0]?.objectId;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((a) => a.action === action);

describe("captureParentObjectId", () => {
  beforeEach(resetDb);

  it("sets object_id from the oid of a verified ID token", async () => {
    await parentUser("p1");
    const ctx = { headers: new Headers({ "cf-connecting-ip": "203.0.113.7" }) };
    expect(await captureParentObjectId(account("p1", await idToken()), verify, ctx)).toBe("set");
    expect(await objectIdOf("p1")).toBe(OID);
    const [a] = await audits("parent.object_id_set");
    expect(a).toMatchObject({ door: "parent", actorId: null, actorLabel: "p1@example.com", targetType: "parent_auth_user", targetId: "p1",
      before: { objectId: null }, after: { objectId: OID }, ip: "203.0.113.7" });
  });

  it("backfills a user created while object_id was never captured (later sign-in, account update)", async () => {
    await parentUser("p2", null);
    await captureParentObjectId(account("p2", await idToken()), verify);
    expect(await objectIdOf("p2")).toBe(OID);
    expect(await audits("parent.object_id_unverified")).toHaveLength(0);
    const [a] = await audits("parent.object_id_set");
    expect(a).toMatchObject({ targetId: "p2", before: { objectId: null }, after: { objectId: OID }, ip: null });
  });

  it("is a no-op when the stored object_id already matches", async () => {
    await parentUser("p3", OID);
    expect(await captureParentObjectId(account("p3", await idToken()), verify)).toBe("unchanged");
    expect(await objectIdOf("p3")).toBe(OID);
    expect(await audits("parent.object_id_conflict")).toHaveLength(0);
    expect(await audits("parent.object_id_set")).toHaveLength(0);
  });

  it("does not audit an expired re-check when the object id is already set (refresh re-saves the old token)", async () => {
    await parentUser("p3b", OID);
    const stale = await idToken({}, { exp: Math.floor(Date.now() / 1000) - 3600 });
    expect(await captureParentObjectId(account("p3b", stale), verify)).toBe("unverified");
    expect(await objectIdOf("p3b")).toBe(OID);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it.each([
    ["subject mismatch", async () => ({ ...account("p3c", await idToken()), accountId: "sub-someone-else" }), /^subject_mismatch$/],
    ["bad signature", async () => account("p3c", await idToken({}, { key: otherKey })), /^invalid_token:ERR_JWS_SIGNATURE_VERIFICATION_FAILED$/],
    ["wrong issuer", async () => account("p3c", await idToken({}, { iss: "https://evil.example.com/v2.0" })), /^invalid_token:.*:iss$/],
    ["missing oid", async () => account("p3c", await idToken({ oid: undefined })), /^missing_oid$/],
    ["no ID token", async () => account("p3c", null), /^no_id_token$/],
  ])("still audits a %s when the object id is already set", async (_label, make, reason) => {
    await parentUser("p3c", OID);
    expect(await captureParentObjectId(await make(), verify)).toBe("unverified");
    expect(await objectIdOf("p3c")).toBe(OID);
    const rows = await audits("parent.object_id_unverified");
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as { reason: string }).reason).toMatch(reason);
  });

  it("reports and audits a missing auth user instead of skipping", async () => {
    expect(await captureParentObjectId(account("ghost", await idToken()), verify)).toBe("user_missing");
    const [a] = await audits("parent.object_id_unverified");
    expect(a).toMatchObject({ targetId: "ghost", after: { reason: "user_missing" } });
  });

  it.each([
    ["bad signature", () => idToken({}, { key: otherKey })],
    ["wrong issuer", () => idToken({}, { iss: "https://evil.example.com/v2.0" })],
    ["wrong audience", () => idToken({}, { aud: "someone-else" })],
    ["expired", () => idToken({}, { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["not a JWT", async () => "not-a-jwt"],
  ])("leaves object_id unset and audits a token with a %s", async (_label, make) => {
    await parentUser("p4");
    expect(await captureParentObjectId(account("p4", await make()), verify)).toBe("unverified");
    expect(await objectIdOf("p4")).toBeNull();
    const [a] = await audits("parent.object_id_unverified");
    expect(a).toMatchObject({ door: "parent", targetType: "parent_auth_user", targetId: "p4" });
    expect((a!.after as { reason: string }).reason).toMatch(/^invalid_token/);
  });

  it("leaves object_id unset and audits a verified token without an oid", async () => {
    await parentUser("p5");
    expect(await captureParentObjectId(account("p5", await idToken({ oid: undefined })), verify)).toBe("unverified");
    expect(await captureParentObjectId(account("p5", await idToken({ oid: "" })), verify)).toBe("unverified");
    expect(await objectIdOf("p5")).toBeNull();
    const rows = await audits("parent.object_id_unverified");
    expect(rows.map((r) => (r.after as { reason: string }).reason)).toEqual(["missing_oid", "missing_oid"]);
  });

  it("refuses a verified token whose subject is not this account's", async () => {
    await parentUser("p6");
    const res = await captureParentObjectId({ ...account("p6", await idToken()), accountId: "sub-someone-else" }, verify);
    expect(res).toBe("unverified");
    expect(await objectIdOf("p6")).toBeNull();
    expect((await audits("parent.object_id_unverified"))[0]!.after).toEqual({ reason: "subject_mismatch" });
  });

  it("audits an account with no ID token", async () => {
    await parentUser("p7");
    expect(await captureParentObjectId(account("p7", null), verify)).toBe("unverified");
    expect((await audits("parent.object_id_unverified"))[0]!.after).toEqual({ reason: "no_id_token" });
  });

  it("never overwrites a different stored object_id, and audits the conflict", async () => {
    await parentUser("p8", "oid-already-there");
    expect(await captureParentObjectId(account("p8", await idToken()), verify)).toBe("conflict");
    expect(await objectIdOf("p8")).toBe("oid-already-there");
    const [c] = await audits("parent.object_id_conflict");
    expect(c).toMatchObject({ door: "parent", targetType: "parent_auth_user", targetId: "p8" });
    expect(await resolveGuardian("p8")).toBeNull();
  });

  it("ignores accounts from other providers", async () => {
    await parentUser("p9");
    expect(await captureParentObjectId({ ...account("p9", await idToken()), providerId: "google" }, verify)).toBe("skipped");
    expect(await objectIdOf("p9")).toBeNull();
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("lets resolveGuardian admit the seeded guardian once the oid is captured", async () => {
    const g = await seedGuardian({ name: "Ana Ramirez", familyQboId: "123", objectId: OID, status: "invited" });
    await parentUser("p10");
    expect(await resolveGuardian("p10")).toBeNull(); // the bug: no object id, refused
    await captureParentObjectId(account("p10", await idToken()), verify);
    expect(await resolveGuardian("p10")).toMatchObject({ door: "parent", guardianId: g.id, familyQboId: "123" });
  });
});
