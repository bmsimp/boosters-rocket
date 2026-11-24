// The portal's signed calls to Boosters Rocket Connect, the relay (its SPEC.md sections 2 and 4; the portal's half is
// docs/superpowers/specs/2026-11-24-connect-through-boosters-rocket-design.md): check the registration, start a connect,
// redeem its return, refresh the tokens, revoke them, and forget a connect the portal refused. Every call is signed with
// the portal's own key (./relay-sign.ts), sent to QBO_RELAY_URL only (./relay-address.ts), never follows a redirect and
// gives up after 15 seconds. The relay's answers are untrusted: the go address must be the relay's own, the company is
// digits, the tokens are read as Intuit's are, and nothing it says is kept or shown but a fixed word. Every answer, or
// the lack of one, is marked for Health (RELAY_MARK): times and a fixed word, never a token, a code, a body or an id.
//
// Staff and worker code only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): it opens the portal's
// private key to sign, and carries the club's refresh token.
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboRelay, setting, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { QboError } from "./endpoints";
import { intuitRefusal, QBO_AAD, tokenSetFrom, type TokenSet } from "./client";
import { qboRelayUrl } from "./relay-address";
import { importRelayKey, signedHeaders } from "./relay-sign";

const TIMEOUT_MS = 15_000;
export const RELAY_PATHS = {
  start: "/v1/connect/start", redeem: "/v1/connect/redeem", refresh: "/v1/token/refresh", revoke: "/v1/token/revoke",
  check: "/v1/portal/check", forget: "/v1/connection/forget",
} as const;
const GO_PATH = "/v1/connect/go/";

/** When the relay last answered and last failed, and how, for the Health page's line about it (slice 4). */
export const RELAY_MARK = "health.mark.quickbooks_relay";
export const RELAY_FAIL_WORDS = ["unauthorized", "busy", "unreachable", "relay_error"] as const;
export type RelayFailWord = (typeof RELAY_FAIL_WORDS)[number];
export type RelayMark = { lastOkAt: string | null; lastFailAt: string | null; lastFailWord: RelayFailWord | null };
const EMPTY_MARK: RelayMark = { lastOkAt: null, lastFailAt: null, lastFailWord: null };

export async function readRelayMark(): Promise<RelayMark | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, RELAY_MARK));
  return row ? { ...EMPTY_MARK, ...(row.value as Partial<RelayMark>) } : null;
}

/**
 * Records one signed call's outcome. Under a lock of its key, so two calls at once take turns and neither is lost.
 * Never throws: a mark that can't be written must not stop a refresh, and the next call writes it again. It runs
 * outside the caller's transaction, so a refresh that rolls back still leaves its mark.
 */
async function markRelay(outcome: { ok: true } | { ok: false; word: RelayFailWord }, now = new Date()): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.mark:${RELAY_MARK}`}))`);
      const [row] = await tx.select().from(setting).where(eq(setting.key, RELAY_MARK));
      const before: RelayMark = row ? { ...EMPTY_MARK, ...(row.value as Partial<RelayMark>) } : EMPTY_MARK;
      const at = now.toISOString();
      const next: RelayMark = outcome.ok ? { ...before, lastOkAt: at } : { ...before, lastFailAt: at, lastFailWord: outcome.word };
      await tx.insert(setting).values({ key: RELAY_MARK, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: now } });
    });
  } catch {
    // Nothing to do: the next call writes it again.
  }
}

/** The words of each failure that isn't Intuit's own. The code goes in `last_error` and decides what Health says. */
const FAILURES = {
  relay_unauthorized: "Boosters Rocket didn't accept this portal's request. Check that the server's clock is right, then email support@boostersrocket.com.",
  relay_busy: "Boosters Rocket is busy just now. The portal will try again.",
  relay_unreachable: "Couldn't reach Boosters Rocket.",
  relay_error: "Boosters Rocket's answer couldn't be read.",
  relay_refused: "Boosters Rocket didn't start the connection. Check the portal id, then email support@boostersrocket.com.",
  relay_code: "That connection took too long to finish. Press Connect again.",
  relay_not_registered: "This portal isn't registered with Boosters Rocket yet.",
} as const;
export type RelayFailureCode = keyof typeof FAILURES;
const failure = (code: RelayFailureCode) => new QboError(FAILURES[code], code);

/** The registration a call was signed under: the portal id and the public key (never the private half). */
export type SignedAs = { portalId: string; publicKey: string };
type Signer = SignedAs & { key: CryptoKey };

/**
 * The portal's id and its signing key, opened from qbo_relay. Refused when the portal isn't registered yet. `as` signs
 * under an earlier registration instead: its id, with the key held now, and only while that key is still the one it
 * named (a new key can't sign for the old one).
 */
async function relaySigner(as?: SignedAs): Promise<Signer> {
  const [r] = await db.select().from(qboRelay);
  if (!r?.portalId || (as && as.publicKey !== r.publicKey)) throw failure("relay_not_registered");
  const portalId = as?.portalId ?? r.portalId;
  try {
    return { portalId, publicKey: r.publicKey, key: await importRelayKey(secretBox().open({ ciphertext: r.privateKeyCiphertext, keyId: r.privateKeyKeyId }, QBO_AAD.relayKey)) };
  } catch (e) {
    if (e instanceof SecretBoxError) throw new QboError("The portal's Boosters Rocket key can't be read with this server's encryption key.", "unreadable");
    throw e;
  }
}

/**
 * One signed POST. Answers the relay's status and JSON body for a 200 or a 400 (the call decides what a 400 means);
 * throws, after marking it, for no answer (`relay_unreachable`), a 401 (`relay_unauthorized`), a 429 (`relay_busy`)
 * and any other status (`relay_unreachable` for a 5xx, `relay_error` otherwise). The body is signed as the exact
 * bytes sent.
 */
async function signedPost(path: string, payload: Record<string, unknown>, o: { as?: SignedAs } = {}): Promise<{ status: 200 | 400; body: unknown; signedAs: SignedAs }> {
  const signer = await relaySigner(o.as);
  const signedAs = { portalId: signer.portalId, publicKey: signer.publicKey };
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetch(`${qboRelayUrl()}${path}`, {
      method: "POST", body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...(await signedHeaders({ portalId: signer.portalId, privateKey: signer.key, verb: "POST", path, body })), accept: "application/json" },
    });
  } catch {
    await markRelay({ ok: false, word: "unreachable" });
    throw failure("relay_unreachable");
  }
  if (res.status === 200 || res.status === 400) {
    let answer: unknown;
    try { answer = await res.json(); } catch {
      await markRelay({ ok: false, word: "relay_error" });
      throw failure("relay_error");
    }
    await markRelay({ ok: true });
    return { status: res.status, body: answer, signedAs };
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 401) { await markRelay({ ok: false, word: "unauthorized" }); throw failure("relay_unauthorized"); }
  if (res.status === 429) { await markRelay({ ok: false, word: "busy" }); throw failure("relay_busy"); }
  await markRelay({ ok: false, word: "relay_error" });
  throw failure(res.status >= 500 ? "relay_unreachable" : "relay_error");
}

const field = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined);

/**
 * The address to send an Admin's browser to, if the relay's answer is one of its own one-time go addresses: the relay's
 * origin, its go path and a ticket of URL-safe characters, nothing else. Null for anything else.
 */
export function relayGoAddress(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 500) return null;
  const prefix = `${qboRelayUrl()}${GO_PATH}`;
  if (!url.startsWith(prefix) || !/^[A-Za-z0-9_-]{16,200}$/.test(url.slice(prefix.length))) return null;
  try {
    const u = new URL(url);
    return u.origin === qboRelayUrl() && u.search === "" && u.hash === "" && u.username === "" && u.password === "" ? url : null;
  } catch {
    return null;
  }
}

/** Connect, step 1: a one-time address on the relay for this attempt. `portalState` is the portal's own single-use state. */
export async function relayStart(environment: QboEnvironment, portalState: string): Promise<string> {
  const r = await signedPost(RELAY_PATHS.start, { environment, portal_state: portalState });
  const go = r.status === 200 ? relayGoAddress(field(r.body, "url")) : null;
  if (!go) throw failure("relay_refused");
  return go;
}

/** `signedAs`: the registration the redemption was signed under, which the store checks is still the portal's. */
export type Redeemed = { tokens: TokenSet; realmId: string; environment: QboEnvironment; signedAs: SignedAs };

/**
 * Connect, the return: the tokens for a redemption code, once. The relay's answer must be for this attempt (its
 * `portal_state` the state just spent) and this environment; its `realm_id` is the company. Anything else, a refused
 * code or a late one, is `relay_code`.
 */
export async function relayRedeem(code: string, expect: { portalState: string; environment: QboEnvironment }): Promise<Redeemed> {
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(code)) throw failure("relay_code");
  const r = await signedPost(RELAY_PATHS.redeem, { code });
  if (r.status !== 200) throw failure("relay_code");
  const realmId = field(r.body, "realm_id"), environment = field(r.body, "environment"), portalState = field(r.body, "portal_state");
  if (portalState !== expect.portalState || environment !== expect.environment) throw failure("relay_code");
  if (typeof realmId !== "string" || !/^\d{1,32}$/.test(realmId)) throw failure("relay_error");
  const tokens = tokenSetFrom(r.body);
  if (!tokens) throw failure("relay_error");
  return { tokens, realmId, environment: expect.environment, signedAs: r.signedAs };
}

/**
 * A refresh through the relay, which adds its secret and passes Intuit's answer back: new tokens, or Intuit's own
 * refusal (`invalid_grant` and the like, a 400) as the portal reads Intuit's. The caller stores the new refresh token
 * before it does anything else with the answer.
 */
export async function relayRefresh(environment: QboEnvironment, refreshToken: string): Promise<TokenSet> {
  const r = await signedPost(RELAY_PATHS.refresh, { environment, refresh_token: refreshToken });
  if (r.status === 400) throw intuitRefusal(r.body, 400, null);
  const tokens = tokenSetFrom(r.body);
  if (!tokens) throw failure("relay_error");
  return tokens;
}

/**
 * Asks the relay to revoke the refresh token at Intuit and to end its record of this portal's connection to the
 * company. Best effort, as revokeAtIntuit() is: true only when the relay says Intuit confirmed it; it never throws.
 */
export async function relayRevoke(environment: QboEnvironment, refreshToken: string, realmId: string): Promise<boolean> {
  try {
    const r = await signedPost(RELAY_PATHS.revoke, { environment, token: refreshToken, realm_id: realmId });
    return r.status === 200 && field(r.body, "revoked") === true;
  } catch {
    return false;
  }
}

/**
 * A refused connect (another company, no switch asked for, a store that failed): asks the relay to end its record that
 * this portal holds the company, without revoking anything at Intuit, since the grant may be another portal's too (the
 * spec's section 3). The relay answers 200 `{"status":"ok"}` whether it had a record or not. Best effort: true only for
 * that answer; it never throws. `as` sends it under the registration that redeemed the connect, when the portal's has
 * changed since: under its id, if this portal's key is still the one registered for it; with a new key nothing is sent,
 * since nothing here can sign for the old one.
 */
export async function relayForget(environment: QboEnvironment, realmId: string, as?: SignedAs): Promise<boolean> {
  if (!/^\d{1,32}$/.test(realmId)) return false;
  try {
    const r = await signedPost(RELAY_PATHS.forget, { environment, realm_id: realmId }, { as });
    return r.status === 200 && field(r.body, "status") === "ok";
  } catch {
    return false;
  }
}

export type RelayCheck =
  | { answer: "registered"; name: string; environments: QboEnvironment[] }
  | { answer: "not_matching" }
  | { answer: "unreachable" };

/**
 * Registration's check (spec section 5, "Checking the registration"): whether the relay knows this portal by the id
 * saved and the key it signs with. A 200 is "registered", with the name the relay holds (text only, at most 200
 * characters; shown as text and never kept) and the environments it allows (only the two it may name); a 401 is
 * "not_matching" (the id or the key isn't what was registered, or the portal was revoked); anything else, a 429
 * included, is "unreachable", to try again. It never throws for the relay's answer, and changes nothing but the mark.
 */
export async function relayCheck(): Promise<RelayCheck> {
  let r: { status: 200 | 400; body: unknown };
  try {
    r = await signedPost(RELAY_PATHS.check, {});
  } catch (e) {
    if (e instanceof QboError && e.code === "relay_unauthorized") return { answer: "not_matching" };
    if (e instanceof QboError) return { answer: "unreachable" };
    throw e;
  }
  const portal = field(r.body, "portal"), name = field(portal, "name"), environments = field(portal, "environments");
  if (r.status !== 200 || field(r.body, "status") !== "ok" || typeof name !== "string") return { answer: "unreachable" };
  const allowed = Array.isArray(environments) ? (["production", "sandbox"] as const).filter((e) => environments.includes(e)) : [];
  return { answer: "registered", name: name.trim().slice(0, 200), environments: allowed };
}
