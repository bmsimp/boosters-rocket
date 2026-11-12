import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { qboConnection, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { qboEndpoints, QboError, QBO_SCOPE } from "./endpoints";
import { QBO_AAD, qboGet, sealTokens, tokenRequest, type TokenSet } from "./client";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";

export type QboOp = { actor: Actor; ip: string | null; permission?: string };
export type QboAppDraft = { clientId: string; clientSecret: string | null; environment: QboEnvironment };
export type ConnectRefusal = "state" | "denied" | "other_company" | "intuit" | "not_configured";
export type QboConnectionView = {
  configured: boolean; clientId: string | null; environment: QboEnvironment | null; connected: boolean; companyName: string | null;
  connectedAt: string | null; lastTokenRefreshAt: string | null; refreshExpiresAt: string | null; lastError: string | null; lastErrorAt: string | null;
  /** The recorded error can only be fixed by an Admin connecting again, so the worker stops trying (spec §4). */
  needsAdmin: boolean;
};

const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
const TARGET = { targetType: "qbo_connection", targetId: "singleton" } as const;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const DISCONNECTED = {
  realmId: null, companyName: null, accessTokenCiphertext: null, accessTokenKeyId: null, accessExpiresAt: null, refreshTokenCiphertext: null,
  refreshTokenKeyId: null, refreshExpiresAt: null, connectedAt: null, connectedBy: null, lastTokenRefreshAt: null, lastError: null, lastErrorAt: null,
  stateHash: null, stateStaffUserId: null, stateExpiresAt: null,
} as const;

export async function getConnection(tx?: Tx) {
  const [c] = await (tx ?? db).select().from(qboConnection);
  return c ?? null;
}

/** The address Intuit returns the Admin to. It must be listed, exactly, on the Intuit app. */
export function qboRedirectUri(): string { return `${env.APP_URL.replace(/\/+$/, "")}/api/quickbooks/callback`; }

/**
 * Whether a recorded connection error (`<sentence> (<code>)`) is one only an Admin can fix by connecting again:
 * Intuit no longer accepts the refresh token, or this server can't read the saved keys. Retrying either changes nothing.
 */
export function errorNeedsAdmin(lastError: string | null | undefined): boolean {
  return /\((invalid_grant|unreadable)\)$/.test(lastError ?? "");
}

/** What the settings pages may show: never the secret, a token or the company's ID. */
export async function connectionView(): Promise<QboConnectionView> {
  const c = await getConnection();
  return {
    configured: c !== null, clientId: c?.clientId ?? null, environment: c?.environment ?? null, connected: Boolean(c?.realmId && c.refreshTokenCiphertext),
    companyName: c?.companyName ?? null, connectedAt: iso(c?.connectedAt), lastTokenRefreshAt: iso(c?.lastTokenRefreshAt),
    refreshExpiresAt: iso(c?.refreshExpiresAt), lastError: c?.lastError ?? null, lastErrorAt: iso(c?.lastErrorAt), needsAdmin: errorNeedsAdmin(c?.lastError),
  };
}

export function parseQboAppForm(f: Record<string, string>, hasSecret: boolean): { ok: true; draft: QboAppDraft } | { ok: false; errors: string[] } {
  const clientId = (f.clientId ?? "").trim(), secret = (f.clientSecret ?? "").trim(), environment = (f.environment ?? "").trim();
  const errors: string[] = [];
  if (!/^[\w-]{10,200}$/.test(clientId)) errors.push("Enter the Client ID from your Intuit app's Keys and credentials page.");
  if (!secret && !hasSecret) errors.push("Enter the Client secret from your Intuit app's Keys and credentials page.");
  if (secret.length > 500) errors.push("That Client secret is too long.");
  if (environment !== "sandbox" && environment !== "production") errors.push("Choose sandbox or production.");
  return errors.length ? { ok: false, errors } : { ok: true, draft: { clientId, clientSecret: secret || null, environment: environment as QboEnvironment } };
}

/** Saves the Intuit app's keys. A blank secret keeps the saved one. */
export async function saveQboApp(d: QboAppDraft, o: QboOp): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (c?.realmId && (c.clientId !== d.clientId || c.environment !== d.environment)) {
      return { ok: false as const, errors: ["Disconnect QuickBooks before changing the Client ID or the environment."] };
    }
    if (!c && !d.clientSecret) return { ok: false as const, errors: ["Enter the Client secret from your Intuit app's Keys and credentials page."] };
    const sealed = d.clientSecret ? secretBox().seal(d.clientSecret, QBO_AAD.secret) : null;
    const secret = sealed ? { clientSecretCiphertext: sealed.ciphertext, clientSecretKeyId: sealed.keyId } : {};
    // A connect started under the old keys must not finish under the new ones.
    const keysChanged = c !== undefined && (c.clientId !== d.clientId || c.environment !== d.environment);
    const dropState = keysChanged ? { stateHash: null, stateStaffUserId: null, stateExpiresAt: null } : {};
    if (c) await tx.update(qboConnection).set({ clientId: d.clientId, environment: d.environment, ...secret, ...dropState, updatedAt: new Date() });
    else await tx.insert(qboConnection).values({ clientId: d.clientId, environment: d.environment, clientSecretCiphertext: sealed!.ciphertext, clientSecretKeyId: sealed!.keyId });
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.save", permission: o.permission, ...TARGET, ip: o.ip,
      before: c ? { clientId: c.clientId, environment: c.environment } : null,
      after: { clientId: d.clientId, environment: d.environment, secretChanged: sealed !== null } }, tx);
    return { ok: true as const };
  });
}

/** Starts a connect: a new single-use state for this Admin (replacing any earlier one) and the Intuit address to send them to. */
export async function beginConnect(staffUserId: string): Promise<{ ok: true; url: string } | { ok: false; reason: "not_configured" }> {
  const state = randomBytes(32).toString("base64url");
  const [c] = await db.update(qboConnection).set({ stateHash: sha256(state), stateStaffUserId: staffUserId, stateExpiresAt: new Date(Date.now() + STATE_TTL_MS), updatedAt: new Date() }).returning();
  if (!c) return { ok: false, reason: "not_configured" };
  const q = new URLSearchParams({ client_id: c.clientId, response_type: "code", scope: QBO_SCOPE, redirect_uri: qboRedirectUri(), state });
  return { ok: true, url: `${qboEndpoints().authorize}?${q}` };
}

/** Finishes a connect when Intuit sends the Admin back (spec §3 Rules for the connection). */
export async function completeConnect(
  p: { code: string | null; state: string | null; realmId: string | null; error: string | null },
  o: { staffUserId: string; actor: Actor; ip: string | null; permission?: string },
): Promise<{ ok: true } | { ok: false; reason: ConnectRefusal }> {
  const refuse = async (reason: ConnectRefusal, code?: string) => {
    await writeAudit({ actor: o.actor, action: "quickbooks.connect_refused", permission: o.permission, ...TARGET, after: code ? { reason, code } : { reason }, ip: o.ip });
    return { ok: false as const, reason };
  };
  // 1. Spend the state. It is cleared only when it matches, so a stray return can't cancel a connect in progress.
  const claim = await db.transaction(async (tx): Promise<{ ok: true; clientId: string; clientSecret: string; environment: QboEnvironment } | { ok: false; reason: ConnectRefusal }> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return { ok: false, reason: "not_configured" };
    const given = Buffer.from(sha256(p.state ?? ""), "hex"), kept = Buffer.from(c.stateHash ?? "", "hex");
    const good = Boolean(p.state) && kept.length === given.length && timingSafeEqual(given, kept)
      && c.stateStaffUserId === o.staffUserId && c.stateExpiresAt !== null && c.stateExpiresAt.getTime() > Date.now();
    if (!good) return { ok: false, reason: "state" };
    await tx.update(qboConnection).set({ stateHash: null, stateStaffUserId: null, stateExpiresAt: null, updatedAt: new Date() });
    if (p.error || !p.code || !p.realmId || !/^\d{1,32}$/.test(p.realmId)) return { ok: false, reason: "denied" };
    if (c.realmId && c.realmId !== p.realmId) return { ok: false, reason: "other_company" };
    try {
      return { ok: true, clientId: c.clientId, environment: c.environment, clientSecret: secretBox().open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret) };
    } catch (e) {
      if (e instanceof SecretBoxError) return { ok: false, reason: "not_configured" };
      throw e;
    }
  });
  if (!claim.ok) return refuse(claim.reason);
  // 2. Exchange the code. No row lock is held while Intuit answers.
  let tokens: TokenSet;
  try {
    tokens = await tokenRequest({ grant_type: "authorization_code", code: p.code!, redirect_uri: qboRedirectUri() }, claim);
  } catch (e) {
    if (e instanceof QboError) return refuse("intuit", e.code);
    throw e;
  }
  // 3. Store the connection, unless another company got connected while Intuit was answering.
  const stored = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return "other_company" as const;
    // The tokens belong to the app and environment the code was exchanged under; the keys may have changed since.
    if (c.clientId !== claim.clientId || c.environment !== claim.environment) return "state" as const;
    if (c.realmId && c.realmId !== p.realmId) return "other_company" as const;
    await tx.update(qboConnection).set({ realmId: p.realmId, connectedAt: new Date(), connectedBy: o.staffUserId, ...sealTokens(tokens) });
    return "stored" as const;
  });
  if (stored !== "stored") return refuse(stored);
  // 3b. A different company from the one the cache was read from: clear what belonged to that one before anything reads
  // the new one. Run after the row lock above is released, never inside it (see clearRosterOfOtherCompany).
  await clearRosterOfOtherCompany(p.realmId!, { actor: o.actor, ip: o.ip });
  // 4. The company's name, for people. The connection stands even if this read fails.
  let companyName: string | null = null;
  try {
    const info = (await qboGet(`companyinfo/${encodeURIComponent(p.realmId!)}`)) as { CompanyInfo?: { CompanyName?: unknown } };
    if (typeof info.CompanyInfo?.CompanyName === "string") companyName = info.CompanyInfo.CompanyName.slice(0, 200);
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
  }
  // Only while this company is still the connected one: a disconnect during the read must not get a name back.
  await db.update(qboConnection).set({ companyName, updatedAt: new Date() }).where(eq(qboConnection.realmId, p.realmId!));
  await writeAudit({ actor: o.actor, action: "quickbooks.connect", permission: o.permission, ...TARGET, after: { companyName, realmId: p.realmId, environment: claim.environment }, ip: o.ip });
  return { ok: true };
}

/** Asks Intuit to revoke the tokens, then forgets them. The keys and the cache stay (spec §3). */
export async function disconnect(o: QboOp): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: "not_connected" }> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, reason: "not_connected" };
  let revoked = false;
  try {
    const box = secretBox();
    const secret = box.open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret);
    const token = box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh);
    const res = await fetch(qboEndpoints().revoke, {
      method: "POST", body: JSON.stringify({ token }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${secret}`).toString("base64")}`, accept: "application/json", "content-type": "application/json" },
    });
    revoked = res.ok;
  } catch {
    revoked = false; // Intuit unreachable or the keys unreadable: the tokens are still deleted here
  }
  await db.transaction(async (tx) => {
    await tx.update(qboConnection).set({ ...DISCONNECTED, updatedAt: new Date() });
    await writeAudit({ actor: o.actor, action: "quickbooks.disconnect", permission: o.permission, ...TARGET, before: { companyName: c.companyName, realmId: c.realmId }, after: { revoked }, ip: o.ip }, tx);
  });
  return { ok: true, revoked };
}
