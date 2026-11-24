// The portal's registration with Boosters Rocket Connect, the relay (docs/superpowers/specs/2026-11-24-connect-through-
// boosters-rocket-design.md §5, "Registration"): its stage, read from qbo_relay; making the portal's key; saving the
// portal id the relay's owner emails back; and the check that the relay knows the portal by them. The private key is
// made here and sealed at once: it is never returned, shown, logged or audited (rows name the public key's first 8
// characters at most). Nothing here reads a family.
//
// Staff code only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import { sql } from "drizzle-orm";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { qboConnection, qboRelay } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { QBO_AAD } from "./client";
import { newRelayKey } from "./relay-sign";
import { relayCheck, type RelayCheck } from "./relay";
import { relayStageOf, type RelayStage } from "./connection";

type Op = { actor: Actor; staffUserId: string; ip: string | null; permission?: string };
type Done = { ok: true; message: string } | { ok: false; errors: string[] };

export const SUPPORT_EMAIL = "support@boostersrocket.com";
const TARGET = { targetType: "qbo_relay", targetId: "singleton" } as const;
const PORTAL_ID = /^brp_[a-z0-9]{16}$/;
/** The only words an audit row holds of the key: enough to tell two keys apart, nothing that signs. */
const keyName = (publicKey: string | null | undefined) => (publicKey ? publicKey.slice(0, 8) : null);

export type RelayRegistrationView = { stage: RelayStage; publicKey: string | null; portalId: string | null };

/** What the setup page shows of the registration: the stage and the two public halves. Never the private key. */
export async function relayRegistrationView(): Promise<RelayRegistrationView> {
  const [r] = await db.select({ publicKey: qboRelay.publicKey, portalId: qboRelay.portalId }).from(qboRelay);
  return { stage: relayStageOf(r), publicKey: r?.publicKey ?? null, portalId: r?.portalId ?? null };
}

/** The portal's address, as the relay registers it: APP_URL with no trailing slash. */
export const portalAddress = (): string => env.APP_URL.replace(/\/+$/, "");

/**
 * Whether the relay can send people back to this address: https, or http on this machine alone (a portal tried out on
 * a laptop). An http address on any other host can't be registered, so its stage offers no form.
 */
export function addressFitsRelay(address: string): boolean {
  try {
    const u = new URL(address);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

/** "Write the email": the Admin's mail app, opened with what the relay's owner needs. All of it is public. */
export function registrationMailto(o: { clubName: string; address: string; publicKey: string }): string {
  const subject = `Register a Boosters Rocket portal: ${o.clubName}`;
  const body = [
    "Please register this portal with Boosters Rocket Connect.", "",
    `Club: ${o.clubName}`, `Portal address: ${o.address}`, `Public key: ${o.publicKey}`,
  ].join("\n");
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Why the registration can't change just now, or null when it can: tokens issued through the relay are held
 * (`connected`: Disconnect first), or a connect through the relay is in progress, its state not yet expired (the
 * minutes until it is). A connect is signed by the id and key it started under, so neither changes under it.
 */
async function registrationHeld(tx: Tx, now = Date.now()): Promise<"connected" | { connectingMinutes: number } | null> {
  // Locked, so a connect storing its tokens at the same moment waits for this change, or this for it.
  const [c] = await tx.select({ tokenMode: qboConnection.tokenMode, stateMode: qboConnection.stateMode, stateExpiresAt: qboConnection.stateExpiresAt })
    .from(qboConnection).for("update");
  if (c?.tokenMode === "relay") return "connected";
  const left = c?.stateMode === "relay" && c.stateExpiresAt ? c.stateExpiresAt.getTime() - now : 0;
  return left > 0 ? { connectingMinutes: Math.ceil(left / 60_000) } : null;
}

/** The answer while a connect through the relay is in progress: its state expires within ten minutes. */
export const connectInProgress = (minutes: number): string =>
  `A connect through Boosters Rocket is in progress. Finish it, or wait ${minutes} ${minutes === 1 ? "minute" : "minutes"}, then try again.`;

/**
 * Makes the portal's key pair and seals its private half (`qbo:relay-key`), in one transaction with its audit row. The
 * first key is made once: pressed again, it changes nothing. `replace` is "Make a new key", offered only while nothing
 * is connected, or being connected, through the relay and refused otherwise: it replaces both halves and clears the saved portal id, since
 * the relay knows the portal by the old key until its owner registers the new one.
 */
export async function makeRelayKey(o: Op, replace: boolean): Promise<Done> {
  const key = await newRelayKey(); // outside the transaction: no lock is held while it is made
  const sealed = secretBox().seal(key.privateKeyPkcs8, QBO_AAD.relayKey);
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.qbo_relay'))`);
    const [r] = await tx.select().from(qboRelay).for("update");
    if (r && !replace) return { ok: true as const, message: "This portal's key is already made." };
    if (!r && replace) return { ok: false as const, errors: ["This portal has no key to replace yet. Make its key first."] };
    const held = r ? await registrationHeld(tx) : null;
    if (held === "connected") {
      return { ok: false as const, errors: ["QuickBooks is connected through Boosters Rocket with this key. Disconnect first, from QuickBooks settings, then make a new key."] };
    }
    if (held) return { ok: false as const, errors: [connectInProgress(held.connectingMinutes)] };
    const values = {
      publicKey: key.publicKey, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId, keyMadeAt: now, keyMadeBy: o.staffUserId,
      portalId: null, portalIdSavedAt: null, portalIdSavedBy: null, updatedAt: now,
    };
    if (r) await tx.update(qboRelay).set(values);
    else await tx.insert(qboRelay).values(values);
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.relay.key_made", permission: o.permission, ...TARGET, ip: o.ip,
      before: r ? { publicKey: keyName(r.publicKey), portalId: r.portalId } : null,
      after: { publicKey: keyName(key.publicKey), portalId: null } }, tx);
    return { ok: true as const, message: r ? "A new key is made. Email the new public key to Boosters Rocket, and save the new portal id they send back." : "This portal's key is made." };
  });
}

/** The portal id as typed, checked: `brp_` and 16 lowercase letters or digits, as Boosters Rocket sends it. */
export function parsePortalId(raw: unknown): { ok: true; portalId: string } | { ok: false; errors: string[] } {
  const v = typeof raw === "string" ? raw.trim() : "";
  return PORTAL_ID.test(v) ? { ok: true, portalId: v }
    : { ok: false, errors: ["Enter the portal id from Boosters Rocket's email: brp_ and 16 letters or digits, like brp_a1b2c3d4e5f6g7h8."] };
}

/**
 * Saves the portal id, audited with before and after. Needs the key first: the id is the relay's name for that key.
 * Refused, as "Make a new key" is, while tokens issued through the relay are held: the relay keeps its record of the
 * connection under the id that connected, so refresh and revoke under another id would no longer match it. Refused too
 * while a connect through the relay is in progress, which is redeemed under the id it started with. The same id again
 * changes nothing.
 */
export async function savePortalId(portalId: string, o: Op): Promise<Done> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.qbo_relay'))`);
    const [r] = await tx.select().from(qboRelay).for("update");
    if (!r) return { ok: false as const, errors: ["Make this portal's key first."] };
    if (r.portalId === portalId) return { ok: true as const, message: "Nothing changed." };
    const held = await registrationHeld(tx);
    if (held === "connected") {
      return { ok: false as const, errors: ["QuickBooks is connected through Boosters Rocket under this portal id. Disconnect first, from QuickBooks settings, then change the id."] };
    }
    if (held) return { ok: false as const, errors: [connectInProgress(held.connectingMinutes)] };
    const now = new Date();
    await tx.update(qboRelay).set({ portalId, portalIdSavedAt: now, portalIdSavedBy: o.staffUserId, updatedAt: now });
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.relay.portal_id", permission: o.permission, ...TARGET, ip: o.ip,
      before: { portalId: r.portalId }, after: { portalId, publicKey: keyName(r.publicKey) } }, tx);
    return { ok: true as const, message: "The portal id is saved." };
  });
}

/**
 * Asks the relay whether it knows the portal by the saved id and key (relayCheck()). Changes nothing here: the id stays
 * saved whatever it answers, and a wrong one is still refused by the relay at Connect. Null while no id is saved.
 */
export async function checkRegistration(): Promise<RelayCheck | null> {
  const [r] = await db.select({ portalId: qboRelay.portalId }).from(qboRelay);
  return r?.portalId ? relayCheck() : null;
}
