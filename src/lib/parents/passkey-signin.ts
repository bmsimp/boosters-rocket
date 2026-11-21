// A passkey at the door (the sign-in release, slice SI-7a; section 6 of the app-owned families spec, "Passkeys
// anywhere", and open questions 24, 30 and 35): /portal-passkey/check (src/lib/auth/parent-code-plugin.ts). The browser
// runs the passkey library's ceremony (no address asked: the browser offers the passkey) and posts its assertion here,
// never to the library's own verify path. With no pending step a passkey is a whole sign-in (two steps in one: the
// device unlocked by face, fingerprint or PIN, and the portal's address); with a pending step of the same person it is
// the second step after their password. Either way it ends in the one finish (finishParentSignin()). Server only.
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { enterableGuardianRows, lockedPerson, parentActor } from "./sessions";
import { getParentSettings, parentDoorClosed } from "./settings";
import { credentialNow, newestSignOutEverywhere, samePassword, takeIpLimit, type PasskeyProof, type PasswordProof } from "./signin-codes";
import { passkeyNamed, usePasskey } from "./passkeys";

/** The most an assertion may be as sent, as JSON: a browser's is under 2 KiB. */
export const MOST_SENT_ASSERTION = 16 * 1024;
/** Each field of an assertion, as the passkey library's browser ceremony sends it, with the most it may hold. */
const TOP_FIELDS = { id: 1024, rawId: 1024, type: 32, authenticatorAttachment: 32 } as const;
const RESPONSE_FIELDS = { clientDataJSON: 8192, authenticatorData: 4096, signature: 1024, userHandle: 1024 } as const;
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** An assertion as the library's ceremony sends it, every field a bounded string: what the library is given. */
export type Assertion = { id: string; rawId: string; type: string; authenticatorAttachment?: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string } };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Copies the fields named into a fresh object, each a string of at most its length; null for anything else (an unknown key included). */
function boundedStrings(v: Record<string, unknown>, fields: Record<string, number>, required: string[], skip: string[] = []): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    if (skip.includes(k)) continue;
    const most = fields[k];
    if (most === undefined || typeof value !== "string" || value.length > most) return null;
    out[k] = value;
  }
  return required.every((k) => k in out) ? out : null;
}

/**
 * The body's assertion, read as untrusted: an object of at most MOST_SENT_ASSERTION as JSON, with only the fields the
 * library's ceremony sends, each a string of bounded length, the authenticator data base64url. Anything else is null.
 */
export function readAssertion(raw: unknown): Assertion | null {
  if (!isRecord(raw)) return null;
  let size: number;
  try { size = JSON.stringify(raw).length; } catch { return null; }
  if (size > MOST_SENT_ASSERTION) return null;
  if (!isRecord(raw.response)) return null;
  const top = boundedStrings(raw, TOP_FIELDS, ["id", "rawId", "type"], ["response"]);
  const response = boundedStrings(raw.response, RESPONSE_FIELDS, ["clientDataJSON", "authenticatorData", "signature"]);
  if (!top || !response || !BASE64URL.test(response.authenticatorData!)) return null;
  return { ...(top as Omit<Assertion, "response">), response: response as Assertion["response"] };
}

/**
 * Whether the authenticator data, the bytes the signature covers, says the user was present (0x01) and verified (0x04):
 * read by the portal itself from byte 32 (after the relying party id's 32-byte hash), whatever the library checks.
 */
export function presentAndVerified(authenticatorData: string): boolean {
  const bytes = Buffer.from(authenticatorData, "base64url");
  return bytes.length >= 37 && (bytes[32]! & 0x05) === 0x05;
}

/** The library's verification of an assertion (verifyAssertion(), src/lib/auth/passkey-check.ts), given by the caller. */
export type VerifyAssertion = (assertion: Assertion) => Promise<{ ok: true; passkey: { passkeyId: string; parentId: string } }
  | { ok: false; reason: "challenge_used" | "passkey_unknown" | "passkey_failed" }>;

/** The pending step a passkey may finish (src/lib/auth/parent-signin-step.ts): its person, address and password. */
export type PasskeyStep = { parentId: string; email: string; password: PasswordProof } | null;

/**
 * A passkey that went through: the person and their address as the check read it under their row, the proof for the
 * finish, and whether it stood alone. A refusal is one answer, `ended` when it ended the pending step.
 */
export type PasskeyCheck = { ok: true; person: { id: string; email: string }; proof: PasskeyProof; alone: boolean }
  | { ok: false; reason: "rejected" | "rate_limited"; ended: boolean };
const REJECTED: PasskeyCheck = { ok: false, reason: "rejected", ended: false };
const REJECTED_ENDED: PasskeyCheck = { ok: false, reason: "rejected", ended: true };
const LIMITED: PasskeyCheck = { ok: false, reason: "rate_limited", ended: false };
const ANON: Actor = { door: "parent", id: null, label: null };

/** Why a passkey signed nobody in, for its audit row only. */
type Refusal = "not_an_assertion" | "not_verified" | "passkey_unreadable" | "challenge_used" | "passkey_unknown" | "passkey_failed"
  | "other_person" | "address_changed" | "password_changed" | "signins_off" | "blocked" | "no_enabled_guardian" | "passkey_gone";

/** A refusal of the passkey itself: `signin.second_step_wrong` against the person its credential id names, else `signin.refused` naming nobody. No `try`: a passkey takes no place. */
async function wrongPasskey(reason: Refusal, who: { id: string; email: string } | null, ip: string | null) {
  if (!who) { await writeAudit({ actor: ANON, action: "signin.refused", after: { reason, factor: "passkey" }, ip }); return; }
  await writeAudit({ actor: parentActor(who), action: "signin.second_step_wrong", targetType: "parent", targetId: who.id,
    after: { factor: "passkey", reason }, ip });
}
/** A refusal by the door's own checks: `signin.refused` against the person. */
async function refused(reason: Refusal, who: { id: string; email: string }, ip: string | null) {
  await writeAudit({ actor: parentActor(who), action: "signin.refused", targetType: "parent", targetId: who.id, after: { reason, factor: "passkey" }, ip });
}
/** The person's address as the portal holds it, for the rows of a passkey whose person isn't the step's. */
async function personOf(parentId: string): Promise<{ id: string; email: string; blocked: boolean } | null> {
  const [p] = await db.select({ id: parent.id, email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, parentId));
  return p ?? null;
}

/**
 * The passkey's check, for the person its passkey belongs to (never a typed address), in this order:
 * (a) the check's limit per IP address (`code_check_ip`, takeIpLimit(): skipped with no address), its first refusal
 *     audited naming nobody; a passkey takes no place under `second_step_parent` and none is stopped by one (the spec's
 *     risks table: "a passkey that signs in whatever the wrong tries"), nor by the address's or a device's count of
 *     wrong passwords, so a stranger filling those can't shut the person out;
 * (b) the assertion (readAssertion()): anything else is the refusal (`not_an_assertion`), counted only by (a);
 * (c) the user present and verified flags, read by the portal from the authenticator data (presentAndVerified():
 *     `not_verified` otherwise), whatever the library checks;
 * (d) with a pending step, the passkey its credential id names must be the step's person (`other_person`, the step
 *     kept), checked before the library is asked, so another person's passkey spends nothing of theirs; a stored public
 *     key that won't decode is `passkey_unreadable`, never a throw; then the library's own verification in process
 *     (`verify`, verifyAssertion()), which spends the challenge once (an assertion replayed or sent twice at once is
 *     verified once: `challenge_used`), checks the origin and the relying party id the instance names, user
 *     verification, the signature and the counter (`passkey_failed`, `passkey_unknown`), and writes the new counter;
 * (e) the door's own checks for the passkey's person: with a pending step their address and `credential` row still the
 *     step's (`address_changed`, `password_changed`, each ending the step); sign-ins on, not blocked, a row that counts
 *     (each ending a pending step); a passkey stands at both levels (open question 35);
 * (f) in one transaction under the person's row (lockedPerson()): not blocked, their address (the step's, with one),
 *     the passkey still theirs with its `last_used_at` set (usePasskey(): `passkey_gone`), their newest "Sign out
 *     everywhere" read for the proof (`signedOutSeen`), and `signin.second_step` (`factor: "passkey"`, `alone`).
 * Every refusal is one answer; its reason is in its row alone: `signin.second_step_wrong` (`factor: "passkey"`, no
 * `try`) for a passkey that didn't verify whose person its credential id names, `signin.refused` naming nobody when it
 * names none, and `signin.refused` against the person for the door's own checks. No row, log line or answer holds a
 * credential id, a public key, a counter, a challenge, a user handle or the assertion.
 */
export async function checkPasskeySignin(raw: unknown, step: PasskeyStep, verify: VerifyAssertion, ip: string | null, now = new Date()): Promise<PasskeyCheck> {
  const byIp = await takeIpLimit("code_check_ip", ip, now);
  if (byIp !== "taken") {
    if (byIp === "first_refusal") await writeAudit({ actor: ANON, action: "signin.refused", after: { reason: "rate_limited", limit: "check_ip", factor: "passkey" }, ip });
    return LIMITED;
  }
  const assertion = readAssertion(raw);
  if (!assertion) { await wrongPasskey("not_an_assertion", null, ip); return REJECTED; }
  const named = await passkeyNamed(assertion.id);
  const namedPerson = named ? await personOf(named.parentId) : null;
  if (!presentAndVerified(assertion.response.authenticatorData)) { await wrongPasskey("not_verified", namedPerson, ip); return REJECTED; }
  if (step && named && named.parentId !== step.parentId) {
    await refused("other_person", { id: step.parentId, email: step.email }, ip);
    return REJECTED;
  }
  if (named && !named.readable) { await wrongPasskey("passkey_unreadable", namedPerson, ip); return REJECTED; }
  const verified = await verify(assertion);
  if (!verified.ok) { await wrongPasskey(verified.reason, namedPerson, ip); return REJECTED; }
  const parentId = verified.passkey.parentId;
  if (step && parentId !== step.parentId) {
    await refused("other_person", { id: step.parentId, email: step.email }, ip);
    return REJECTED;
  }

  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) { await wrongPasskey("passkey_unknown", null, ip); return step ? REJECTED_ENDED : REJECTED; }
  const ends = step ? REJECTED_ENDED : REJECTED;
  if (step) {
    if (p.email !== normalizeEmail(step.email)) { await refused("address_changed", { id: p.id, email: step.email }, ip); return ends; }
    if (!samePassword(await credentialNow(db, p.id, step.password.credentialId), step.password)) { await refused("password_changed", p, ip); return ends; }
  }
  const reason: Refusal | null = parentDoorClosed(await getParentSettings()) ? "signins_off"
    : p.blocked ? "blocked" : (await enterableGuardianRows(p.id)).length === 0 ? "no_enabled_guardian" : null;
  if (reason) { await refused(reason, p, ip); return ends; }

  const alone = step === null;
  const outcome = await db.transaction(async (tx) => {
    const live = await lockedPerson(tx, p.id);
    if (!live || live.blocked) return "blocked" as const;
    if (step && live.email !== normalizeEmail(step.email)) return "address_changed" as const;
    if (!(await usePasskey(tx, p.id, verified.passkey.passkeyId, now))) return "passkey_gone" as const;
    const signedOutSeen = await newestSignOutEverywhere(tx, p.id);
    await writeAudit({ actor: parentActor({ id: p.id, email: live.email }), action: "signin.second_step", targetType: "parent", targetId: p.id,
      after: { factor: "passkey", alone }, ip }, tx);
    return { email: live.email, signedOutSeen };
  });
  if (typeof outcome === "string") { await refused(outcome, p, ip); return outcome === "passkey_gone" ? REJECTED : ends; }
  return { ok: true, person: { id: p.id, email: outcome.email }, proof: { passkeyId: verified.passkey.passkeyId, signedOutSeen: outcome.signedOutSeen }, alone };
}
