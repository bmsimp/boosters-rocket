import { and, eq, isNull } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, errors, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { db } from "@/lib/db/client";
import { parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { loadProviders, providersVersion, parentDiscoveryUrl } from "./providers";

import { PARENT_PROVIDER_ID } from "./parent-provider-id";
export { PARENT_PROVIDER_ID };

/** Verifies an ID token's signature and claims; resolves to its payload or throws. */
export type ParentIdTokenVerifier = (idToken: string) => Promise<JWTPayload>;

export type CaptureOutcome = "set" | "unchanged" | "conflict" | "unverified" | "user_missing" | "skipped";

/** The account fields the capture needs; Better Auth's account hooks pass the whole row. */
export type ParentAccount = { userId: string; providerId: string; accountId: string; idToken?: string | null };

/** The Better Auth hook context, when there is a request behind the write. */
export type HookContext = { headers?: Headers; request?: Request } | null | undefined;

// Same skew and required claims as Better Auth's own ID token check (@better-auth/core oauth2/verify-id-token).
const CLOCK_TOLERANCE_SECONDS = 30;
const REQUIRED_CLAIMS = ["iss", "sub", "aud", "exp", "iat"];

export function createParentIdTokenVerifier(o: { jwks: JWTVerifyGetKey; issuer: string; audience: string; algorithms?: string[] }): ParentIdTokenVerifier {
  return async (idToken) => (await jwtVerify(idToken, o.jwks, {
    issuer: o.issuer, audience: o.audience, algorithms: o.algorithms,
    requiredClaims: REQUIRED_CLAIMS, clockTolerance: CLOCK_TOLERANCE_SECONDS,
  })).payload;
}

class DiscoveryError extends Error {}

/** Builds the verifier from the provider's discovery document: its issuer, its JWKS, our client id as audience. */
async function discoverVerifier(): Promise<ParentIdTokenVerifier> {
  const parent = (await loadProviders()).parent;
  if (!parent) throw new DiscoveryError("parent door not configured");
  const url = parentDiscoveryUrl(parent.config);
  const audience = parent.config.clientId;
  let doc: { issuer?: unknown; jwks_uri?: unknown; id_token_signing_alg_values_supported?: unknown };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (e) {
    throw new DiscoveryError(`discovery fetch failed: ${(e as Error).message}`);
  }
  if (typeof doc.issuer !== "string" || !doc.issuer || typeof doc.jwks_uri !== "string" || !doc.jwks_uri) {
    throw new DiscoveryError("discovery document has no issuer or jwks_uri");
  }
  const algs = doc.id_token_signing_alg_values_supported;
  return createParentIdTokenVerifier({
    jwks: createRemoteJWKSet(new URL(doc.jwks_uri, url)),
    issuer: doc.issuer,
    audience,
    algorithms: Array.isArray(algs) && algs.length > 0 && algs.every((a) => typeof a === "string") ? algs : undefined,
  });
}

// Cached per provider version (the remote JWKS caches and refreshes keys itself); a failed discovery is retried next time.
let defaultVerifier: { version: number; value: Promise<ParentIdTokenVerifier> } | null = null;
function getDefaultVerifier(): Promise<ParentIdTokenVerifier> {
  const v = providersVersion();
  if (!defaultVerifier || defaultVerifier.version !== v) {
    const value = discoverVerifier().catch((e) => { if (defaultVerifier?.version === v) defaultVerifier = null; throw e; });
    defaultVerifier = { version: v, value };
  }
  return defaultVerifier.value;
}

function invalidTokenReason(e: unknown): string {
  if (e instanceof errors.JWTClaimValidationFailed) return `invalid_token:${e.code}:${e.claim}`;
  if (e instanceof errors.JOSEError) return `invalid_token:${e.code}`;
  return "invalid_token";
}

/**
 * Records the parent's External ID object id (`oid`) on their auth user, taken only from an ID token
 * this function has itself verified (signature against the provider's JWKS, issuer, audience, expiry).
 *
 * Better Auth cannot do this: `objectId` is `input: false` so a parent cannot set it through
 * /update-user, and Better Auth also drops `input: false` fields from provider profiles. So this runs
 * from the parent instance's account create/update hooks, once Better Auth has stored the account.
 *
 * Fails closed: an unverifiable token or one without `oid` changes nothing, so resolveGuardian keeps
 * refusing the parent. A stored object id is never overwritten; a different verified `oid` is audited.
 */
export async function captureParentObjectId(account: ParentAccount, verify?: ParentIdTokenVerifier, ctx?: HookContext): Promise<CaptureOutcome> {
  if (account.providerId !== PARENT_PROVIDER_ID) return "skipped";
  const { userId } = account;
  const h = ctx?.headers ?? ctx?.request?.headers;
  const ip = h ? clientIpFrom(h) : null;
  const audit = (action: string, label: string | null, before: unknown, after: unknown) => writeAudit({
    actor: { door: "parent", id: null, label }, action, targetType: "parent_auth_user", targetId: userId, before, after, ip });

  const [u] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, userId));
  if (!u) {
    await audit("parent.object_id_unverified", null, undefined, { reason: "user_missing" });
    return "user_missing";
  }
  // A refresh re-saves the old ID token, so once an object id is bound an *expired* re-check is expected
  // and not audited. Every other failure signals something wrong and is always audited.
  const unverified = async (reason: string, expired = false): Promise<CaptureOutcome> => {
    if (!(expired && u.objectId !== null)) await audit("parent.object_id_unverified", u.email, undefined, { reason });
    return "unverified";
  };
  if (!account.idToken) return unverified("no_id_token");

  let verifier: ParentIdTokenVerifier;
  try {
    verifier = verify ?? await getDefaultVerifier();
  } catch (e) {
    return unverified(e instanceof DiscoveryError ? "discovery_failed" : "verifier_unavailable");
  }
  let payload: JWTPayload;
  try {
    payload = await verifier(account.idToken);
  } catch (e) {
    return unverified(invalidTokenReason(e), e instanceof errors.JWTExpired);
  }
  // The account is keyed by the token's subject; a token for someone else must not bind this user.
  if (payload.sub !== account.accountId) return unverified("subject_mismatch");
  const oid = payload.oid;
  if (typeof oid !== "string" || oid.length === 0) return unverified("missing_oid");

  const [set] = await db.update(parentAuthUser).set({ objectId: oid, updatedAt: new Date() })
    .where(and(eq(parentAuthUser.id, userId), isNull(parentAuthUser.objectId))).returning({ id: parentAuthUser.id });
  if (set) {
    await audit("parent.object_id_set", u.email, { objectId: null }, { objectId: oid });
    return "set";
  }

  // Re-read: another sign-in may have bound it between the first read and the update.
  const [now] = await db.select({ objectId: parentAuthUser.objectId }).from(parentAuthUser).where(eq(parentAuthUser.id, userId));
  if (!now) return "user_missing";
  if (now.objectId === oid) return "unchanged";
  await audit("parent.object_id_conflict", u.email, { objectId: now.objectId }, { objectId: oid });
  return "conflict";
}
