import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { qboConnection, setting, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { errorNeedsAdmin, qboEndpoints, QboError, QBO_SCOPE } from "./endpoints";
import { QBO_AAD, qboGet, sealTokens, tokenRequest, type TokenSet } from "./client";
import { clearRosterOfOtherCompany, dropSwitchAsk, getRosterSource, getSwitchRecord, setSwitchRecord, storedSwitchOf, SWITCH_KEY, type SwitchRecord } from "@/lib/roster/source";

export type QboOp = { actor: Actor; ip: string | null; permission?: string };
export type QboAppDraft = { clientId: string; clientSecret: string | null; environment: QboEnvironment };
/**
 * Why a connect was refused. `roster_company`: the portal's families were read from another company, and no Admin
 * asked first, on the switch page, to move the portal to a different one (stage 4's slice M8: a switch ends every
 * family's link to the books, open question 16 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md), or
 * the ask didn't hold: made for another sign-in to Intuit, by someone else, expired, spent, or made while the roster
 * named another company than it does now.
 */
export type ConnectRefusal = "state" | "denied" | "other_company" | "roster_company" | "intuit" | "not_configured";
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

// Defined beside QboError so the client can ask it too (parent reads refuse at once) without importing this module.
export { errorNeedsAdmin };

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
    // An ask to switch companies goes with the state it was made for.
    if (keysChanged) await dropSwitchAsk(tx);
    if (c) await tx.update(qboConnection).set({ clientId: d.clientId, environment: d.environment, ...secret, ...dropState, updatedAt: new Date() });
    else await tx.insert(qboConnection).values({ clientId: d.clientId, environment: d.environment, clientSecretCiphertext: sealed!.ciphertext, clientSecretKeyId: sealed!.keyId });
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.save", permission: o.permission, ...TARGET, ip: o.ip,
      before: c ? { clientId: c.clientId, environment: c.environment } : null,
      after: { clientId: d.clientId, environment: d.environment, secretChanged: sealed !== null } }, tx);
    return { ok: true as const };
  });
}

/**
 * Asks Intuit to revoke a refresh token (and the access token that came with it). Best effort: true only when Intuit
 * confirmed it; an unreachable Intuit, a timeout or a refusal is false. It never throws and keeps nothing of the answer.
 */
async function revokeAtIntuit(refreshToken: string, app: { clientId: string; clientSecret: string }): Promise<boolean> {
  try {
    const res = await fetch(qboEndpoints().revoke, {
      method: "POST", body: JSON.stringify({ token: refreshToken }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, accept: "application/json", "content-type": "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

type Begun = { ok: true; url: string } | { ok: false; reason: "not_configured" };
const newState = (staffUserId: string) => {
  const state = randomBytes(32).toString("base64url");
  return { state, set: { stateHash: sha256(state), stateStaffUserId: staffUserId, stateExpiresAt: new Date(Date.now() + STATE_TTL_MS), updatedAt: new Date() } };
};
const intuitUrl = (clientId: string, state: string) =>
  `${qboEndpoints().authorize}?${new URLSearchParams({ client_id: clientId, response_type: "code", scope: QBO_SCOPE, redirect_uri: qboRedirectUri(), state })}`;

/**
 * Starts a connect: a new single-use state for this Admin (replacing any earlier one) and the Intuit address to send
 * them to. Any ask to switch companies is dropped with the state it was made for, so this connect is a plain one: the
 * same company again, or a first one. A stored switch whose clear hasn't run yet is kept for the clear: signing in
 * again then renews the company it switched to (completeConnect()), and the next roster refresh still finishes it.
 */
export async function beginConnect(staffUserId: string): Promise<Begun> {
  const { state, set } = newState(staffUserId);
  const c = await db.transaction(async (tx) => {
    const [row] = await tx.update(qboConnection).set(set).returning();
    await dropSwitchAsk(tx);
    return row;
  });
  return c ? { ok: true, url: intuitUrl(c.clientId, state) } : { ok: false, reason: "not_configured" };
}

/**
 * Starts a connect after an Admin said, on the switch page, that they mean to connect a different company (stage 4's
 * slice M8, the owner's choice 1): the state as beginConnect() writes it and, in the same transaction, the ask
 * (SWITCH_KEY: the state's hash and expiry, this Admin, and the roster's company as read now), audited. Only a connect
 * made with this state may then store a company other than the roster's (completeConnect()). While the roster names no
 * company there is nothing to switch from, and it starts a plain connect.
 */
export async function beginSwitchConnect(staffUserId: string, o: QboOp): Promise<Begun> {
  const { state, set } = newState(staffUserId);
  const c = await db.transaction(async (tx) => {
    const [row] = await tx.update(qboConnection).set(set).returning();
    if (!row) return undefined;
    const fromRealmId = await getRosterSource(tx);
    if (fromRealmId === null) { await dropSwitchAsk(tx); return row; }
    await setSwitchRecord(tx, { asked: { stateHash: set.stateHash, staffUserId, expiresAt: set.stateExpiresAt.toISOString(), fromRealmId } });
    await writeAudit({ actor: o.actor, action: "quickbooks.switch.asked", permission: o.permission, ...TARGET, after: { fromRealmId }, ip: o.ip }, tx);
    return row;
  });
  return c ? { ok: true, url: intuitUrl(c.clientId, state) } : { ok: false, reason: "not_configured" };
}

/**
 * Whether an ask lets this connect store a company other than the roster's (the owner's choice 1, decided here alone):
 * made with this connect's state, by this Admin, not expired, and while the roster named the company it names now.
 * Without the confirm page, this would answer true while the roster names a company, and no ask would be needed.
 */
function askHolds(r: SwitchRecord | null, now: { stateHash: string | null; staffUserId: string; rosterRealmId: string | null }): boolean {
  if (!r || !("asked" in r) || now.stateHash === null || now.rosterRealmId === null) return false;
  const a = r.asked, expires = Date.parse(a.expiresAt);
  return a.stateHash === now.stateHash && a.staffUserId === now.staffUserId && Number.isFinite(expires) && expires > Date.now() && a.fromRealmId === now.rosterRealmId;
}

/**
 * Whether this company may be connected without a switch: the one the roster cache was read from, or any while the
 * cache names none (a first connect). Another company is connected only against an Admin's ask (askHolds()), and then
 * the change-of-company clear runs (clearRosterOfOtherCompanyLocked(), step 3b below).
 */
async function sameRosterCompany(realmId: string, tx: Tx): Promise<boolean> {
  const source = await getRosterSource(tx);
  return source === null || source === realmId;
}

/** Finishes a connect when Intuit sends the Admin back (spec §3 Rules for the connection). */
export async function completeConnect(
  p: { code: string | null; state: string | null; realmId: string | null; error: string | null },
  o: { staffUserId: string; actor: Actor; ip: string | null; permission?: string },
): Promise<{ ok: true } | { ok: false; reason: ConnectRefusal }> {
  // `revoked` is recorded only when Intuit had issued tokens that the portal then didn't keep (see step 3).
  const refuse = async (reason: ConnectRefusal, extra: { code?: string; revoked?: boolean } = {}) => {
    await writeAudit({ actor: o.actor, action: "quickbooks.connect_refused", permission: o.permission, ...TARGET, after: { reason, ...extra }, ip: o.ip });
    return { ok: false as const, reason };
  };
  // 1. Spend the state. It is cleared only when it matches, so a stray return can't cancel a connect in progress.
  const claim = await db.transaction(async (tx): Promise<{ ok: true; switchFrom: string | null; clientId: string; clientSecret: string; environment: QboEnvironment } | { ok: false; reason: ConnectRefusal }> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return { ok: false, reason: "not_configured" };
    const given = Buffer.from(sha256(p.state ?? ""), "hex"), kept = Buffer.from(c.stateHash ?? "", "hex");
    const good = Boolean(p.state) && kept.length === given.length && timingSafeEqual(given, kept)
      && c.stateStaffUserId === o.staffUserId && c.stateExpiresAt !== null && c.stateExpiresAt.getTime() > Date.now();
    if (!good) return { ok: false, reason: "state" };
    // The ask to switch companies, if any, is spent with the state it was made for (a stored switch is the clear's).
    const ask = await getSwitchRecord(tx);
    await tx.update(qboConnection).set({ stateHash: null, stateStaffUserId: null, stateExpiresAt: null, updatedAt: new Date() });
    if (ask && "asked" in ask) await dropSwitchAsk(tx);
    if (p.error || !p.code || !p.realmId || !/^\d{1,32}$/.test(p.realmId)) return { ok: false, reason: "denied" };
    if (c.realmId && c.realmId !== p.realmId) return { ok: false, reason: "other_company" };
    // The company the roster was read from, or another only against the ask: nothing is exchanged or stored otherwise.
    // One exception: signing in again to the company a stored switch moved to, while it is still connected and that
    // switch's clear hasn't run (step 3b threw, and no refresh has finished it), renews it, and the clear then runs.
    let switchFrom: string | null = null;
    if (!(await sameRosterCompany(p.realmId!, tx))) {
      const rosterRealmId = await getRosterSource(tx);
      const renewing = c.realmId === p.realmId && storedSwitchOf(ask, rosterRealmId, p.realmId);
      if (!renewing && !askHolds(ask, { stateHash: c.stateHash, staffUserId: o.staffUserId, rosterRealmId })) return { ok: false, reason: "roster_company" };
      switchFrom = rosterRealmId;
    }
    try {
      return { ok: true, switchFrom, clientId: c.clientId, environment: c.environment, clientSecret: secretBox().open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret) };
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
    if (e instanceof QboError) return refuse("intuit", { code: e.code });
    throw e;
  }
  // 3. Store the connection, unless another company got connected while Intuit was answering. From here until the
  // row is saved the portal holds tokens Intuit issued: if it doesn't keep them, it asks Intuit to revoke them, so a
  // refused connect leaves no grant standing. The revoke changes nothing about the refusal.
  const revokeIssued = () => revokeAtIntuit(tokens.refreshToken, claim);
  // When storing throws: Intuit's revoke can cancel the company's whole grant to the app, not just these tokens. So
  // if the row still holds a connection to this company (the Admin was signing in again to renew it), nothing is
  // revoked and that connection carries on. The row is read fresh; if even that fails, nothing is revoked. The
  // failure is audited when it can be, and the original error always goes on to the caller.
  const storeFailed = async (): Promise<void> => {
    let revoked: boolean | undefined;
    try {
      const now = await getConnection();
      const stillConnected = now?.realmId === p.realmId && Boolean(now?.refreshTokenCiphertext);
      if (!stillConnected) revoked = await revokeIssued();
    } catch { /* can't tell what the portal holds: leave Intuit alone */ }
    try {
      await writeAudit({ actor: o.actor, action: "quickbooks.connect_refused", permission: o.permission, ...TARGET,
        after: revoked === undefined ? { reason: "store_failed" } : { reason: "store_failed", revoked }, ip: o.ip });
    } catch { /* the audit write must not replace the error that brought us here */ }
  };
  const stored = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return "other_company" as const;
    // The tokens belong to the app and environment the code was exchanged under; the keys may have changed since.
    if (c.clientId !== claim.clientId || c.environment !== claim.environment) return "state" as const;
    if (c.realmId && c.realmId !== p.realmId) return "other_company" as const;
    // Checked again under the row lock: another company only for a switch from the company the ask was made against,
    // still the roster's.
    const switching = !(await sameRosterCompany(p.realmId!, tx));
    if (switching && (claim.switchFrom === null || (await getRosterSource(tx)) !== claim.switchFrom)) return "roster_company" as const;
    await tx.update(qboConnection).set({ realmId: p.realmId, connectedAt: new Date(), connectedBy: o.staffUserId, ...sealTokens(tokens) });
    // The switch is recorded in the store's transaction, so a clear that doesn't run below is still run by the roster
    // refresh, for this switch alone; a connect that switches nothing leaves no record behind.
    if (switching) await setSwitchRecord(tx, { stored: { fromRealmId: claim.switchFrom!, toRealmId: p.realmId!, staffUserId: o.staffUserId, at: new Date().toISOString() } });
    else await tx.delete(setting).where(eq(setting.key, SWITCH_KEY));
    return switching ? "switched" as const : "stored" as const;
  }).catch(async (e: unknown) => { await storeFailed(); throw e; });
  if (stored !== "stored" && stored !== "switched") return refuse(stored, { revoked: await revokeIssued() });
  const switched = stored === "switched";
  // 3b. A company other than the one the cache was read from (a switch the ask allowed) clears what belonged to that one
  // before anything reads the new one (open question 16), and spends the recorded switch; the same company, or none,
  // clears nothing. Run after the row lock above is released, never inside it (see clearRosterOfOtherCompany). Should
  // it throw after a switch, the connection still stands: until the clear runs, every reader of the window holds back
  // the old company's records (connectedToAnotherCompany(), src/lib/families/links.ts), and the next roster refresh
  // (the callback's own, or the worker's) runs the clear for the recorded switch before it saves anything.
  try {
    await clearRosterOfOtherCompany(p.realmId!, { actor: o.actor, ip: o.ip });
  } catch (e) {
    if (!switched) throw e;
    // Logged and audited, so the audit log says a switch's clear is still to run, not only the roster's failed runs.
    const error = e instanceof Error ? e.name.slice(0, 40) : "unknown";
    console.error(`[quickbooks] The switch from company ${claim.switchFrom} to ${p.realmId} is stored, but its clear failed (${error}); the next roster refresh runs it.`);
    try {
      await writeAudit({ actor: o.actor, action: "quickbooks.switch.clear_failed", permission: o.permission, ...TARGET,
        after: { fromRealmId: claim.switchFrom, toRealmId: p.realmId, error }, ip: o.ip });
    } catch { /* the connection stands whatever the audit write does */ }
  }
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
  await writeAudit({ actor: o.actor, action: "quickbooks.connect", permission: o.permission, ...TARGET, after: { companyName, realmId: p.realmId, environment: claim.environment, ...(switched ? { switchedFrom: claim.switchFrom } : {}) }, ip: o.ip });
  return { ok: true };
}

/** Asks Intuit to revoke the tokens, then forgets them. The keys and the cache stay (spec §3). */
export async function disconnect(o: QboOp): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: "not_connected" }> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, reason: "not_connected" };
  let revoked = false;
  try {
    const box = secretBox();
    const clientSecret = box.open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret);
    const token = box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh);
    revoked = await revokeAtIntuit(token, { clientId: c.clientId, clientSecret });
  } catch {
    revoked = false; // the keys unreadable (Intuit unreachable is false already): the tokens are still deleted here
  }
  await db.transaction(async (tx) => {
    await tx.update(qboConnection).set({ ...DISCONNECTED, updatedAt: new Date() });
    await writeAudit({ actor: o.actor, action: "quickbooks.disconnect", permission: o.permission, ...TARGET, before: { companyName: c.companyName, realmId: c.realmId }, after: { revoked }, ip: o.ip }, tx);
  });
  return { ok: true, revoked };
}
