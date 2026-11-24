import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { qboConnection, qboRelay, setting, type QboEnvironment, type QboMode } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { errorNeedsAdmin, QboError, QBO_SCOPE } from "./endpoints";
import { oauthEndpoints } from "./discovery";
import { ownAppOf, QBO_AAD, qboGet, sealTokens, tokenRequest, type QboApp, type TokenSet } from "./client";
import { relayForget, relayRedeem, relayRevoke, relayStart } from "./relay";
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
export type ConnectRefusal = "state" | "denied" | "other_company" | "roster_company" | "intuit" | "not_configured"
  // Through Boosters Rocket (spec §5, Connect): the redemption refused or late; the relay refused the portal, was busy,
  // or couldn't be reached or read.
  | "relay_code" | "relay_refused" | "relay_busy" | "relay_unreachable";
export type QboConnectionView = {
  /**
   * Step 1 is done, or a connection is held: in own-app mode the Intuit app's keys are saved, in relay mode the portal
   * is registered (its key made and its id saved).
   */
  configured: boolean;
  /** What the next Connect does; relay for a new club. `tokenMode`: which app issued the tokens held now, null while none. */
  connectMode: QboMode; tokenMode: QboMode | null;
  /** The registration with Boosters Rocket (relay-registration.ts). Never the key. */
  relayStage: RelayStage; clientId: string | null; environment: QboEnvironment | null; connected: boolean; companyName: string | null;
  connectedAt: string | null; lastTokenRefreshAt: string | null; refreshExpiresAt: string | null; lastError: string | null; lastErrorAt: string | null;
  /** The recorded error can only be fixed by an Admin connecting again, so the worker stops trying (spec §4). */
  needsAdmin: boolean;
};

/**
 * The registration with Boosters Rocket, read from qbo_relay (relay-registration.ts makes it): not registered yet (no
 * key), waiting for the id (a key and no id), or ready to connect (both).
 */
export type RelayStage = "not_registered" | "waiting" | "ready";
export function relayStageOf(r: { portalId: string | null } | null | undefined): RelayStage {
  return !r ? "not_registered" : r.portalId ? "ready" : "waiting";
}

const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
const TARGET = { targetType: "qbo_connection", targetId: "singleton" } as const;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const DISCONNECTED = {
  realmId: null, companyName: null, accessTokenCiphertext: null, accessTokenKeyId: null, accessExpiresAt: null, refreshTokenCiphertext: null,
  refreshTokenKeyId: null, refreshExpiresAt: null, connectedAt: null, connectedBy: null, lastTokenRefreshAt: null, lastError: null, lastErrorAt: null,
  stateHash: null, stateStaffUserId: null, stateExpiresAt: null, tokenMode: null,
} as const;

export async function getConnection(tx?: Tx) {
  const [c] = await (tx ?? db).select().from(qboConnection);
  return c ?? null;
}

/** The address Intuit returns the Admin to. It must be listed, exactly, on the Intuit app. */
export function qboRedirectUri(): string { return `${env.APP_URL.replace(/\/+$/, "")}/api/quickbooks/callback`; }

// Defined beside QboError so the client can ask it too (parent reads refuse at once) without importing this module.
export { errorNeedsAdmin };

/** What the settings pages may show: never the secret, a token, the company's ID or the portal's private key. */
export async function connectionView(): Promise<QboConnectionView> {
  const [c, [r]] = await Promise.all([getConnection(), db.select({ portalId: qboRelay.portalId }).from(qboRelay)]);
  const connectMode = c?.connectMode ?? "relay", relayStage = relayStageOf(r);
  const connected = Boolean(c?.realmId && c.refreshTokenCiphertext);
  const stepOneDone = connectMode === "own_app" ? Boolean(c?.clientId) : relayStage === "ready";
  return {
    configured: connected || stepOneDone, connectMode, tokenMode: c?.tokenMode ?? null, relayStage, clientId: c?.clientId ?? null, environment: c?.environment ?? null, connected,
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
    // Saving the keys is choosing the club's own app (they are offered only under that choice): never while tokens
    // issued through the relay are held, since moving back would revoke a grant other portals may share.
    if (c?.tokenMode === "relay") return { ok: false as const, errors: [LEAVE_RELAY_FIRST] };
    if (c?.realmId && (c.clientId !== d.clientId || c.environment !== d.environment)) {
      return { ok: false as const, errors: ["Disconnect QuickBooks before changing the Client ID or the environment."] };
    }
    if (!c?.clientSecretCiphertext && !d.clientSecret) return { ok: false as const, errors: ["Enter the Client secret from your Intuit app's Keys and credentials page."] };
    const sealed = d.clientSecret ? secretBox().seal(d.clientSecret, QBO_AAD.secret) : null;
    const secret = sealed ? { clientSecretCiphertext: sealed.ciphertext, clientSecretKeyId: sealed.keyId } : {};
    // A connect started under the old keys must not finish under the new ones.
    const keysChanged = c !== undefined && (c.clientId !== d.clientId || c.environment !== d.environment);
    const dropState = keysChanged ? { stateHash: null, stateStaffUserId: null, stateExpiresAt: null } : {};
    // An ask to switch companies goes with the state it was made for.
    if (keysChanged) await dropSwitchAsk(tx);
    if (c) await tx.update(qboConnection).set({ clientId: d.clientId, environment: d.environment, ...secret, ...dropState, connectMode: "own_app", updatedAt: new Date() });
    else await tx.insert(qboConnection).values({ clientId: d.clientId, environment: d.environment, clientSecretCiphertext: sealed!.ciphertext, clientSecretKeyId: sealed!.keyId, connectMode: "own_app" });
    const modeBefore = c?.connectMode ?? "relay";
    if (modeBefore !== "own_app") {
      await writeAudit({ actor: o.actor, action: "settings.quickbooks.mode", permission: o.permission, ...TARGET, ip: o.ip,
        before: { connectMode: modeBefore }, after: { connectMode: "own_app" } }, tx);
    }
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.save", permission: o.permission, ...TARGET, ip: o.ip,
      before: c ? { clientId: c.clientId, environment: c.environment } : null,
      after: { clientId: d.clientId, environment: d.environment, secretChanged: sealed !== null } }, tx);
    return { ok: true as const };
  });
}

/** Leaving relay mode while connected through it: refused (spec §3), so the shared grant is never revoked unasked. */
export const LEAVE_RELAY_FIRST = "QuickBooks is connected through Boosters Rocket. Disconnect first, from QuickBooks settings, then choose the club's own Intuit app.";
const NEEDS_KEYS = "Save the Intuit app's keys below to use the club's own app. Saving them saves this choice too.";

export function parseConnectMode(raw: unknown): QboMode | null {
  return raw === "relay" || raw === "own_app" ? raw : null;
}

/**
 * Saves how the portal connects (setup step 1, "How to connect"), audited with before and after
 * (`settings.quickbooks.mode`). The same choice again changes nothing. Own-app to relay is always allowed: the own
 * app's tokens keep refreshing until the Admin connects again (`token_mode`). Relay to own-app is refused while tokens
 * issued through the relay are held, and needs the Intuit app's keys saved, which saveQboApp() does and so makes the
 * choice itself. A connect started under the other mode doesn't finish under this one: its state is dropped, with any
 * ask to switch companies made with it.
 */
export async function saveConnectMode(mode: QboMode, o: QboOp): Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(qboConnection).for("update");
    const before = c?.connectMode ?? "relay";
    if (before === mode) return { ok: true as const, message: "Nothing changed." };
    if (mode === "own_app" && c?.tokenMode === "relay") return { ok: false as const, errors: [LEAVE_RELAY_FIRST] };
    if (mode === "own_app" && !c?.clientId) return { ok: false as const, errors: [NEEDS_KEYS] };
    await tx.update(qboConnection).set({ connectMode: mode, stateHash: null, stateStaffUserId: null, stateExpiresAt: null, stateMode: null, updatedAt: new Date() });
    await dropSwitchAsk(tx);
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.mode", permission: o.permission, ...TARGET, ip: o.ip,
      before: { connectMode: before }, after: { connectMode: mode } }, tx);
    return { ok: true as const, message: mode === "relay" ? "Saved. The portal connects through Boosters Rocket from the next Connect." : "Saved. The portal connects with the club's own Intuit app." };
  });
}

/**
 * Asks Intuit to revoke a refresh token (and the access token that came with it). Best effort: true only when Intuit
 * confirmed it; an unreachable Intuit, a timeout or a refusal is false. It never throws and keeps nothing of the answer.
 */
async function revokeAtIntuit(refreshToken: string, app: { clientId: string; clientSecret: string }, environment: QboEnvironment): Promise<boolean> {
  try {
    const res = await fetch((await oauthEndpoints(environment)).revoke, {
      method: "POST", body: JSON.stringify({ token: refreshToken }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, accept: "application/json", "content-type": "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Why a connect couldn't start: not set up (own-app keys, or the relay registration), no QuickBooks chosen, the other
 * one chosen while connected (`environment_locked`), or the relay's three (spec §5, Connect, 3), which are audited.
 */
export type StartRefusal = "not_configured" | "environment" | "environment_locked" | "relay_refused" | "relay_busy" | "relay_unreachable";
type Begun = { ok: true; url: string } | { ok: false; reason: StartRefusal };
type StateSet = { stateHash: string; stateStaffUserId: string; stateExpiresAt: Date; updatedAt: Date };
const newState = (staffUserId: string): { state: string; set: StateSet } => {
  const state = randomBytes(32).toString("base64url");
  return { state, set: { stateHash: sha256(state), stateStaffUserId: staffUserId, stateExpiresAt: new Date(Date.now() + STATE_TTL_MS), updatedAt: new Date() } };
};
const intuitUrl = async (clientId: string, environment: QboEnvironment, state: string) =>
  `${(await oauthEndpoints(environment)).authorize}?${new URLSearchParams({ client_id: clientId, response_type: "code", scope: QBO_SCOPE, redirect_uri: qboRedirectUri(), state })}`;

/** A relay failure (relay.ts's codes) as the reason a connect stops. */
function relayReason(code: string): "relay_code" | "relay_refused" | "relay_busy" | "relay_unreachable" {
  if (code === "relay_code") return "relay_code";
  if (code === "relay_busy") return "relay_busy";
  if (code === "relay_unreachable" || code === "relay_error") return "relay_unreachable";
  return "relay_refused"; // relay_unauthorized, relay_refused, relay_not_registered, unreadable: the registration
}

/**
 * Starts a connect, plain or a switch, in the mode the Admin chose (`connect_mode`): a new single-use state for this
 * Admin (replacing any earlier one), made for that mode (`state_mode`), and the address to send them to. In own-app
 * mode that is Intuit's, with the club's app's Client ID. In relay mode the row's environment is the one chosen with
 * the press (refused while connected to the other), the row is made if the club has none yet, and, after the
 * transaction (no row lock is held while the relay answers), the relay is asked for its one-time go address, signed:
 * a refusal, a busy relay or none at all stops here, audited. `ask` writes a switch's ask in the state's transaction;
 * without it any ask is dropped.
 */
async function startConnect(staffUserId: string, o: { environment?: QboEnvironment; op?: QboOp }, ask: ((tx: Tx, set: StateSet) => Promise<void>) | null): Promise<Begun> {
  const { state, set } = newState(staffUserId);
  const begun = await db.transaction(async (tx): Promise<{ ok: true; mode: QboMode; clientId: string | null; environment: QboEnvironment } | { ok: false; reason: StartRefusal }> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    const mode = c?.connectMode ?? "relay";
    let environment: QboEnvironment;
    if (mode === "own_app") {
      if (!c) return { ok: false, reason: "not_configured" };
      await tx.update(qboConnection).set({ ...set, stateMode: "own_app" });
      environment = c.environment;
    } else {
      const [r] = await tx.select({ portalId: qboRelay.portalId }).from(qboRelay);
      if (!r?.portalId) return { ok: false, reason: "not_configured" };
      const chosen = o.environment ?? c?.environment;
      if (!chosen) return { ok: false, reason: "environment" };
      if (c?.realmId && c.environment !== chosen) return { ok: false, reason: "environment_locked" };
      environment = chosen;
      if (c) await tx.update(qboConnection).set({ ...set, stateMode: "relay", environment });
      else await tx.insert(qboConnection).values({ ...set, stateMode: "relay", environment, connectMode: "relay" });
    }
    if (ask) await ask(tx, set);
    else await dropSwitchAsk(tx);
    return { ok: true, mode, clientId: c?.clientId ?? null, environment };
  });
  if (!begun.ok) return begun;
  if (begun.mode === "own_app") return begun.clientId ? { ok: true, url: await intuitUrl(begun.clientId, begun.environment, state) } : { ok: false, reason: "not_configured" };
  try {
    return { ok: true, url: await relayStart(begun.environment, state) };
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const why = relayReason(e.code), reason = why === "relay_code" ? "relay_refused" : why;
    if (o.op) {
      await writeAudit({ actor: o.op.actor, action: "quickbooks.relay.connect_refused", permission: o.op.permission, ...TARGET, ip: o.op.ip,
        after: { reason, step: "start", code: e.code, environment: begun.environment } });
    }
    return { ok: false, reason };
  }
}

/**
 * Starts a connect: a new single-use state for this Admin and the address to send them to (startConnect()). In relay
 * mode `environment` is the Admin's choice of QuickBooks, and `op` audits a refusal by the relay. Any ask to switch
 * companies is dropped with the state it was made for, so this connect is a plain one: the same company again, or a
 * first one. A stored switch whose clear hasn't run yet is kept for the clear: signing in again then renews the company
 * it switched to (completeConnect()), and the next roster refresh still finishes it.
 */
export async function beginConnect(staffUserId: string, o: { environment?: QboEnvironment; op?: QboOp } = {}): Promise<Begun> {
  return startConnect(staffUserId, o, null);
}

/**
 * Starts a connect after an Admin said, on the switch page, that they mean to connect a different company (stage 4's
 * slice M8, the owner's choice 1): the state as beginConnect() writes it and, in the same transaction, the ask
 * (SWITCH_KEY: the state's hash and expiry, this Admin, and the roster's company as read now), audited. Only a connect
 * made with this state may then store a company other than the roster's (completeConnect()). While the roster names no
 * company there is nothing to switch from, and it starts a plain connect. In relay mode it connects to the QuickBooks
 * (real or sandbox) already saved.
 */
export async function beginSwitchConnect(staffUserId: string, o: QboOp): Promise<Begun> {
  return startConnect(staffUserId, { op: o }, async (tx, set) => {
    const fromRealmId = await getRosterSource(tx);
    if (fromRealmId === null) { await dropSwitchAsk(tx); return; }
    await setSwitchRecord(tx, { asked: { stateHash: set.stateHash, staffUserId, expiresAt: set.stateExpiresAt.toISOString(), fromRealmId } });
    await writeAudit({ actor: o.actor, action: "quickbooks.switch.asked", permission: o.permission, ...TARGET, after: { fromRealmId }, ip: o.ip }, tx);
  });
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

type ConnectOp = { staffUserId: string; actor: Actor; ip: string | null; permission?: string };
type IntuitReturn = { code: string | null; state: string | null; realmId: string | null; error: string | null };
type RelayReturn = { code: string | null; state: string | null; error: string | null };
type Finished = { ok: true; oldGrantRevoked?: boolean } | { ok: false; reason: ConnectRefusal };

/** Finishes a connect when Intuit sends the Admin back, with the club's own Intuit app (spec §3 Rules for the connection). */
export async function completeConnect(p: IntuitReturn, o: ConnectOp): Promise<{ ok: true } | { ok: false; reason: ConnectRefusal }> {
  const r = await finishConnect("own_app", p, o);
  return r.ok ? { ok: true } : r;
}

/**
 * Finishes a connect through Boosters Rocket when the relay sends the Admin back (spec §5, Connect, 5): the same steps
 * as completeConnect(), but the return carries the relay's redemption code, not Intuit's, and no company: the tokens
 * and the company come from redeeming the code, signed, server to server. `oldGrantRevoked` is said only after a move
 * from the club's own app: whether Intuit confirmed it ended the old app's access.
 */
export async function completeRelayConnect(p: RelayReturn, o: ConnectOp): Promise<Finished> {
  return finishConnect("relay", { ...p, realmId: null }, o);
}

type Claimed = { ok: true; switchFrom: string | null; environment: QboEnvironment; app: QboApp | null } | { ok: false; reason: ConnectRefusal };
type OldGrant = { refreshToken: string; app: QboApp; environment: QboEnvironment } | null;
type Stored = { kind: "stored" | "switched"; switchFrom: string | null; moved: boolean; old: OldGrant } | { kind: "state" | "other_company" | "roster_company" };

/**
 * The one finish of a connect, in either mode. Only step 2, turning the return into tokens, and what is done with
 * tokens the portal doesn't keep, differ by mode; the state, the company and switch checks and the store are one.
 */
async function finishConnect(mode: QboMode, p: IntuitReturn, o: ConnectOp): Promise<Finished> {
  const relay = mode === "relay";
  // `revoked` is recorded only when Intuit had issued tokens that the portal then didn't keep (see step 3).
  const refuse = async (reason: ConnectRefusal, extra: Record<string, unknown> = {}) => {
    await writeAudit({ actor: o.actor, action: relay ? "quickbooks.relay.connect_refused" : "quickbooks.connect_refused", permission: o.permission, ...TARGET, after: { reason, ...extra }, ip: o.ip });
    return { ok: false as const, reason };
  };
  // 1. Spend the state. It is cleared only when it matches, so a stray return can't cancel a connect in progress. It
  // must have been made for this mode: a state made for the relay finishes only at the relay's callback, and the other
  // way round.
  const claim = await db.transaction(async (tx): Promise<Claimed> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return { ok: false, reason: "not_configured" };
    const given = Buffer.from(sha256(p.state ?? ""), "hex"), kept = Buffer.from(c.stateHash ?? "", "hex");
    const good = Boolean(p.state) && kept.length === given.length && timingSafeEqual(given, kept)
      && c.stateStaffUserId === o.staffUserId && c.stateExpiresAt !== null && c.stateExpiresAt.getTime() > Date.now() && c.stateMode === mode;
    if (!good) return { ok: false, reason: "state" };
    // The ask to switch companies, if any, is spent with the state it was made for (a stored switch is the clear's).
    const ask = await getSwitchRecord(tx);
    await tx.update(qboConnection).set({ stateHash: null, stateStaffUserId: null, stateExpiresAt: null, stateMode: null, updatedAt: new Date() });
    if (ask && "asked" in ask) await dropSwitchAsk(tx);
    if (relay) {
      // The relay names its own failures: Intuit refused the code it was given (`intuit`), or the Admin said no.
      if (p.error || !p.code) return { ok: false, reason: p.error === "intuit" ? "intuit" : "denied" };
      // The company is known only once the code is redeemed. Here only whether the ask holds is decided, while it is
      // still the one made with this state; the company checks are made under the row lock, when storing (step 3).
      const rosterRealmId = await getRosterSource(tx);
      const askFrom = askHolds(ask, { stateHash: c.stateHash, staffUserId: o.staffUserId, rosterRealmId }) ? rosterRealmId : null;
      return { ok: true, switchFrom: askFrom, environment: c.environment, app: null };
    }
    if (p.error || !p.code || !p.realmId || !/^\d{1,32}$/.test(p.realmId)) return { ok: false, reason: "denied" };
    if (c.realmId && c.realmId !== p.realmId) return { ok: false, reason: "other_company" };
    // The company the roster was read from, or another only against the ask: nothing is exchanged or stored otherwise.
    // One exception: signing in again to the company a stored switch moved to, while it is still connected and that
    // switch's clear hasn't run (step 3b threw, and no refresh has finished it), renews it, and the clear then runs.
    let switchFrom: string | null = null;
    if (!(await sameRosterCompany(p.realmId, tx))) {
      const rosterRealmId = await getRosterSource(tx);
      const renewing = c.realmId === p.realmId && storedSwitchOf(ask, rosterRealmId, p.realmId);
      if (!renewing && !askHolds(ask, { stateHash: c.stateHash, staffUserId: o.staffUserId, rosterRealmId })) return { ok: false, reason: "roster_company" };
      switchFrom = rosterRealmId;
    }
    try {
      const app = ownAppOf(c);
      return app ? { ok: true, switchFrom, app, environment: c.environment } : { ok: false, reason: "not_configured" };
    } catch (e) {
      if (e instanceof SecretBoxError) return { ok: false, reason: "not_configured" };
      throw e;
    }
  });
  if (!claim.ok) return refuse(claim.reason);
  // 2. Turn the return into tokens, with no row lock held while Intuit or the relay answers: Intuit's code exchanged
  // with the club's app, or the relay's redemption code redeemed, signed (the answer must be for this attempt, its
  // `portal_state` the state just spent, and this environment; its `realm_id` is the company).
  let tokens: TokenSet, realmId: string;
  if (relay) {
    try {
      const r = await relayRedeem(p.code!, { portalState: p.state!, environment: claim.environment });
      tokens = r.tokens; realmId = r.realmId;
    } catch (e) {
      if (e instanceof QboError) return refuse(relayReason(e.code), { code: e.code });
      throw e;
    }
  } else {
    realmId = p.realmId!;
    try {
      tokens = await tokenRequest({ grant_type: "authorization_code", code: p.code!, redirect_uri: qboRedirectUri() }, claim.app!, claim.environment);
    } catch (e) {
      if (e instanceof QboError) return refuse("intuit", { code: e.code });
      throw e;
    }
  }
  // 3. Store the connection, unless another company got connected while Intuit was answering. From here until the
  // row is saved the portal holds tokens Intuit issued. Tokens of the club's own app that it doesn't keep, it asks
  // Intuit to revoke, so a refused connect leaves no grant standing. Tokens issued through the relay are never revoked
  // here: the relay's one app holds one grant per company, which another portal (a trial copy of this one) may be
  // using. They are dropped, and the relay is asked to forget that this portal connected the company. Neither changes
  // anything about the refusal.
  const dropIssued = async (): Promise<Record<string, unknown>> => relay
    ? { revoked: false, why: "shared_grant", forgotten: await relayForget(claim.environment, realmId) }
    : { revoked: await revokeAtIntuit(tokens.refreshToken, claim.app!, claim.environment) };
  // Whether the row still holds a connection to this company, read fresh (the Admin was signing in again to renew it):
  // then nothing is revoked or forgotten, and that connection carries on.
  const stillHeld = async () => { const now = await getConnection(); return now?.realmId === realmId && Boolean(now?.refreshTokenCiphertext); };
  // When storing throws: Intuit's revoke can cancel the company's whole grant to the app, not just these tokens, and
  // the relay's forget ends its record of the company. So neither is sent while the row still holds this company; if
  // even the read fails, nothing is sent. The failure is audited when it can be, and the original error always goes on
  // to the caller.
  const storeFailed = async (): Promise<void> => {
    let dropped: Record<string, unknown> = relay ? { revoked: false, why: "shared_grant" } : {};
    try {
      if (!(await stillHeld())) dropped = await dropIssued();
    } catch { /* can't tell what the portal holds: leave Intuit and the relay alone */ }
    try {
      await writeAudit({ actor: o.actor, action: relay ? "quickbooks.relay.connect_refused" : "quickbooks.connect_refused", permission: o.permission, ...TARGET, after: { reason: "store_failed", ...dropped }, ip: o.ip });
    } catch { /* the audit write must not replace the error that brought us here */ }
  };
  const stored = await db.transaction(async (tx): Promise<Stored> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return { kind: "other_company" };
    // The tokens belong to the app and environment they were issued under; the keys or the mode may have changed since.
    const sameApp = relay ? c.connectMode === "relay" : c.clientId === claim.app!.clientId;
    if (!sameApp || c.environment !== claim.environment) return { kind: "state" };
    if (c.realmId && c.realmId !== realmId) return { kind: "other_company" };
    // Checked again under the row lock: another company only for a switch from the company the ask was made against,
    // still the roster's. Through the relay the company is known only now, so the renewal of a stored switch's company
    // (which step 1 allows for the club's own app) is decided here.
    const switching = !(await sameRosterCompany(realmId, tx));
    let switchFrom = claim.switchFrom;
    if (switching && relay && switchFrom === null) {
      const rosterRealmId = await getRosterSource(tx);
      if (c.realmId === realmId && storedSwitchOf(await getSwitchRecord(tx), rosterRealmId, realmId)) switchFrom = rosterRealmId;
    }
    if (switching && (switchFrom === null || (await getRosterSource(tx)) !== switchFrom)) return { kind: "roster_company" };
    // A move from the club's own app to the relay (the same company, connected with own-app tokens): the old refresh
    // token is taken under this lock, to be revoked at Intuit with the old keys once the new tokens are stored. Renewing
    // through the relay revokes nothing: the old tokens are of the same app and grant as the new.
    const moved = relay && c.tokenMode === "own_app" && c.realmId === realmId;
    let old: OldGrant = null;
    if (moved && c.refreshTokenCiphertext && c.refreshTokenKeyId) {
      try {
        const box = secretBox(), app = ownAppOf(c, box);
        if (app) old = { refreshToken: box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh), app, environment: c.environment };
      } catch (e) {
        if (!(e instanceof SecretBoxError)) throw e; // unreadable here: the old grant can't be revoked from here
      }
    }
    await tx.update(qboConnection).set({ realmId, connectedAt: new Date(), connectedBy: o.staffUserId, tokenMode: mode, ...sealTokens(tokens) });
    // The switch is recorded in the store's transaction, so a clear that doesn't run below is still run by the roster
    // refresh, for this switch alone; a connect that switches nothing leaves no record behind.
    if (switching) await setSwitchRecord(tx, { stored: { fromRealmId: switchFrom!, toRealmId: realmId, staffUserId: o.staffUserId, at: new Date().toISOString() } });
    else await tx.delete(setting).where(eq(setting.key, SWITCH_KEY));
    return { kind: switching ? "switched" : "stored", switchFrom, moved, old };
  }).catch(async (e: unknown) => { await storeFailed(); throw e; });
  if (stored.kind !== "stored" && stored.kind !== "switched") {
    // Through the relay, the company is forgotten only while this portal doesn't hold it: forgetting a company still
    // connected here would end the relay's record of that connection.
    const keep = relay && (await stillHeld());
    return refuse(stored.kind, keep ? { revoked: false, why: "shared_grant", forgotten: false } : await dropIssued());
  }
  const switched = stored.kind === "switched";
  // 3a. After a move from the club's own app, its grant is revoked with its own keys, now the new tokens are stored. If
  // Intuit doesn't confirm it, the old app's access may still stand in QuickBooks' Apps list, and the Admin is told so.
  let oldGrantRevoked: boolean | undefined;
  if (stored.moved) {
    oldGrantRevoked = stored.old ? await revokeAtIntuit(stored.old.refreshToken, stored.old.app, stored.old.environment) : false;
    await writeAudit({ actor: o.actor, action: "quickbooks.relay.old_grant_revoked", permission: o.permission, ...TARGET, after: { realmId, revoked: oldGrantRevoked }, ip: o.ip });
  }
  // 3b. A company other than the one the cache was read from (a switch the ask allowed) clears what belonged to that one
  // before anything reads the new one (open question 16), and spends the recorded switch; the same company, or none,
  // clears nothing. Run after the row lock above is released, never inside it (see clearRosterOfOtherCompany). Should
  // it throw after a switch, the connection still stands: until the clear runs, every reader of the window holds back
  // the old company's records (connectedToAnotherCompany(), src/lib/families/links.ts), and the next roster refresh
  // (the callback's own, or the worker's) runs the clear for the recorded switch before it saves anything.
  try {
    await clearRosterOfOtherCompany(realmId, { actor: o.actor, ip: o.ip });
  } catch (e) {
    if (!switched) throw e;
    // Audited, not logged (nothing here writes to the log), so the audit log says a switch's clear is still to run,
    // not only the roster's failed runs; the stored switch stays for the next refresh to spend.
    const error = e instanceof Error ? e.name.slice(0, 40) : "unknown";
    try {
      await writeAudit({ actor: o.actor, action: "quickbooks.switch.clear_failed", permission: o.permission, ...TARGET,
        after: { fromRealmId: stored.switchFrom, toRealmId: realmId, error }, ip: o.ip });
    } catch { /* the connection stands whatever the audit write does */ }
  }
  // 4. The company's name, for people. The connection stands even if this read fails.
  let companyName: string | null = null;
  try {
    const info = (await qboGet(`companyinfo/${encodeURIComponent(realmId)}`)) as { CompanyInfo?: { CompanyName?: unknown } };
    if (typeof info.CompanyInfo?.CompanyName === "string") companyName = info.CompanyInfo.CompanyName.slice(0, 200);
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
  }
  // Only while this company is still the connected one: a disconnect during the read must not get a name back.
  await db.update(qboConnection).set({ companyName, updatedAt: new Date() }).where(eq(qboConnection.realmId, realmId));
  const switchedFrom = switched ? { switchedFrom: stored.switchFrom } : {};
  if (relay) {
    await writeAudit({ actor: o.actor, action: "quickbooks.relay.connect", permission: o.permission, ...TARGET, ip: o.ip,
      after: { companyName, realmId, environment: claim.environment, movedFromOwnApp: stored.moved, ...switchedFrom } });
    return oldGrantRevoked === undefined ? { ok: true } : { ok: true, oldGrantRevoked };
  }
  await writeAudit({ actor: o.actor, action: "quickbooks.connect", permission: o.permission, ...TARGET, after: { companyName, realmId, environment: claim.environment, ...switchedFrom }, ip: o.ip });
  return { ok: true };
}

/**
 * The Admin's answer to the shared-grant warning (spec §5, Disconnect): every portal connected to a QuickBooks company
 * through Boosters Rocket shares one grant, so disconnecting one may disconnect the others too.
 */
export const DISCONNECT_ACK_NEEDED = "Tick the box to say you understand, then try again.";

/**
 * Asks Intuit to revoke the tokens, then forgets them, whatever the answer. The keys, the registration and the cache stay
 * (spec §3). Tokens of the club's own app are revoked with its keys (`quickbooks.disconnect`); tokens issued through
 * Boosters Rocket are revoked through it, with the company so the relay ends its record of the connection too, and only
 * once the Admin has acknowledged that this may end other portals' connections to the company
 * (`quickbooks.relay.disconnect`, `acknowledged: true`). Without that it changes nothing and sends nothing.
 */
export async function disconnect(o: QboOp & { acknowledged?: boolean }): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: "not_connected" | "not_acknowledged" }> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, reason: "not_connected" };
  const relay = c.tokenMode === "relay";
  if (relay && o.acknowledged !== true) return { ok: false, reason: "not_acknowledged" };
  let revoked = false;
  try {
    const box = secretBox();
    const token = box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh);
    // Tokens issued through the relay are never revoked with the club's own keys, which didn't issue them.
    const app = relay ? null : ownAppOf(c, box);
    revoked = relay ? await relayRevoke(c.environment, token, c.realmId) : app ? await revokeAtIntuit(token, app, c.environment) : false;
  } catch {
    revoked = false; // the keys unreadable (Intuit or the relay unreachable is false already): the tokens are still deleted here
  }
  const before = { companyName: c.companyName, realmId: c.realmId };
  await db.transaction(async (tx) => {
    await tx.update(qboConnection).set({ ...DISCONNECTED, updatedAt: new Date() });
    await writeAudit(relay
      ? { actor: o.actor, action: "quickbooks.relay.disconnect", permission: o.permission, ...TARGET, before, after: { acknowledged: true, revoked, environment: c.environment }, ip: o.ip }
      : { actor: o.actor, action: "quickbooks.disconnect", permission: o.permission, ...TARGET, before, after: { revoked }, ip: o.ip }, tx);
  });
  return { ok: true, revoked };
}
