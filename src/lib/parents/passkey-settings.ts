// A parent's passkeys in their sign-in settings (/family/sign-in; the sign-in release, slice SI-7b; section 6 of the
// app-owned families spec, "Passkeys anywhere": "Several passkeys per guardian, each named, listed and removable", and
// open questions 25, 28 and 33): adding one (the passkey library's registration, ended in the portal's own
// /portal-passkey/add, src/lib/auth/parent-code-plugin.ts), naming one, and removing one. Everything is for the
// session's own person (`parentId`, `sessionId`): a passkey's row id from the page is looked for only among that
// person's own passkeys, and nothing of another person's is read, shown, named or removed. The rows themselves are read
// and written by passkeys.ts alone, but for the one row the library inserts as it verifies. No row, log line or answer
// holds a credential id, a public key, a counter, an AAGUID, transports or the browser's answer. Nothing here makes or
// ends a session or forgets a device; since slice SI-10a the add may be made by an enrolling session (Strict's
// enrolment, enrolment.ts), which the add's own transaction then makes whole (`enrol_until` cleared, `strong_at` set):
// the one place here that touches a session. Server only; parent code.
import "server-only";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { currentPassword, sessionProvedRecently, sessionStrongAt } from "./asking-again";
import { completeEnrolment, sessionMayAddFactor } from "./enrolment";
import { hasAuthenticator, makeBackupCodes, removeBackupCodes } from "./authenticator";
import { namePasskey, passkeyCount, passkeyOfPerson, passkeysAddedBefore, readPasskeyName, removePasskey } from "./passkeys";
import { giveBackRateLimit, takeRateLimit, takeRateLimitPlace } from "./rate-limit";
import { provedRecently } from "./reask-rule";
import { enterableGuardianRows, lockedPerson, parentActor } from "./sessions";
import { PARENTS_KEY, getParentSettings, parentDoorClosed } from "./settings";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

type Me = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;
/** The session a request to the add carries, as the library read it: its id and its person. */
export type Adder = { sessionId: string; parentId: string; email: string };
export type PasskeyResult = { ok: true; message: string } | { ok: false; errors: string[] };

const PROVE_AGAIN = { ok: false as const, errors: [COPY.proveAgain] };
const TOO_MANY_PRESSES = { ok: false as const, errors: [COPY.tooManyPresses] };
const NOT_FOUND = { ok: false as const, errors: [COPY.passkeyNotFound] };
const BAD_NAME = { ok: false as const, errors: [COPY.passkeyNameBad] };

/** A passkey's row id as the library makes them: anything else is no passkey of anyone's, refused before a read. */
export const isPasskeyId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** The parents' settings lock, shared, before the person's row, for a press that reads the club's level (as authenticator-settings.ts holds it). */
const holdParentSettings = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${PARENTS_KEY}))`);

/**
 * The person's row FOR UPDATE, as SI-6b's presses take it (heldPerson(), authenticator-settings.ts), for the add's record
 * and a remove: each decides by the person's passkeys (their first, their last), so two presses of one person, in two
 * tabs or on two devices, go one at a time, and neither decides counting a passkey the other is removing or adding.
 * lockedPerson()'s FOR KEY SHARE would let them run side by side. Renaming decides nothing by them, and keeps
 * lockedPerson(). Null when the person is gone.
 */
async function heldPerson(tx: Tx, parentId: string): Promise<{ email: string; blocked: boolean } | null> {
  const [p] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, parentId)).for("update");
  return p ?? null;
}

/**
 * Whether this session of this person may add a passkey now (decisions 1 and 2 of SI-7b): sign-ins on, the person
 * there and not blocked, a row that counts, a password chosen (a person with none is offered the set-up link first and
 * nothing else), and the session proved within the window (sessionProvedRecently(): the portal's window, never the
 * session's age) or, since slice SI-10a, enrolling (Strict's enrolment: sessionMayAddFactor(), enrolment.ts). Read by
 * the library's options path before it makes a challenge (parent-code-plugin.ts) and again by the add itself, before
 * the library's verification. Adding is offered at both levels.
 */
export async function mayAddPasskey(s: { sessionId: string; parentId: string }, now = new Date()): Promise<boolean> {
  if (parentDoorClosed(await getParentSettings())) return false;
  const [p] = await db.select({ blocked: parent.blocked }).from(parent).where(eq(parent.id, s.parentId));
  if (!p || p.blocked) return false;
  if ((await enterableGuardianRows(s.parentId)).length === 0) return false;
  if ((await currentPassword(db, s.parentId)) === null) return false;
  return sessionMayAddFactor(db, s, now);
}

/** The most the browser's answer to a registration may be, as JSON: a browser's is a few KiB. */
export const MOST_SENT_REGISTRATION = 32 * 1024;
const TOP_FIELDS: Record<string, number> = { id: 1024, rawId: 1024, type: 32, authenticatorAttachment: 32 };
const RESPONSE_FIELDS: Record<string, number> = { clientDataJSON: 8192, attestationObject: 16384, authenticatorData: 8192, publicKey: 4096 };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The browser's answer to a registration, read as untrusted: an object of at most MOST_SENT_REGISTRATION as JSON, with
 * only the fields the library's browser ceremony sends (@simplewebauthn/browser's startRegistration(), less its
 * extension results), each a string of bounded length, but two the ceremony sends as they are: `transports`, a list of
 * at most 8 strings of at most 32 characters, and `publicKeyAlgorithm`, a whole number. Anything else is null.
 */
export function readRegistration(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  let size: number;
  try { size = JSON.stringify(raw).length; } catch { return null; }
  if (size > MOST_SENT_REGISTRATION || !isRecord(raw.response)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "response") continue;
    const most = TOP_FIELDS[k];
    if (most === undefined || typeof v !== "string" || v.length > most) return null;
    out[k] = v;
  }
  const response: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.response)) {
    if (k === "transports") {
      if (!Array.isArray(v) || v.length > 8 || !v.every((t) => typeof t === "string" && t.length <= 32)) return null;
      response[k] = [...v];
      continue;
    }
    if (k === "publicKeyAlgorithm") {
      if (typeof v !== "number" || !Number.isInteger(v)) return null;
      response[k] = v;
      continue;
    }
    const most = RESPONSE_FIELDS[k];
    if (most === undefined || typeof v !== "string" || v.length > most) return null;
    response[k] = v;
  }
  if (typeof out.id !== "string" || typeof out.rawId !== "string" || out.type !== "public-key") return null;
  if (typeof response.clientDataJSON !== "string" || typeof response.attestationObject !== "string") return null;
  return { ...out, response };
}

/** The library's verification and insert of one registration (verifyRegistration(), src/lib/auth/passkey-check.ts), given by the caller. */
export type VerifyRegistration = (answer: Record<string, unknown>) => Promise<{ ok: true; passkeyId: string }
  | { ok: false; reason: "not_verified" | "already_added" | "challenge_used" | "registration_failed" }>;

/** What the add answers the browser: added (with the backup codes, once, for a first passkey with no app), or why not. */
export type AddAnswer = { ok: true; codes?: string[] } | { ok: false; error: "rejected" | "rate_limited" | "prove_again" | "already_added" };
const REJECTED = { ok: false as const, error: "rejected" as const };

/** Why a passkey wasn't added, for its audit row only. */
type AddRefusal = "not_a_registration" | "bad_name" | "not_allowed" | "not_verified" | "already_added" | "challenge_used" | "registration_failed" | "not_recorded";

/**
 * Adding a passkey (decision 2 of SI-7b), the work of /portal-passkey/add, for the session the request carries (`who`,
 * the library's own read of its cookie; null with none, the one refusal and nothing else). In this order:
 * (a) the try's place under the person (`signin_settings_parent`, these settings' presses), given back when the
 *     library's verification refuses for a reason the person can't have caused by guessing (nothing to guess here);
 * (b) the body: the answer read bounded (readRegistration()), the name optional (readPasskeyName(): trimmed, at most
 *     50 characters, no line break or control character); anything else the refusal;
 * (c) the checks of the options path again (mayAddPasskey());
 * (d) the library's verification and insert in process (`verify`, verifyRegistration()), never asked for a session;
 *     the portal's afterVerification confirms the user was verified and the credential is held by no passkey already,
 *     before the insert;
 * (e) one transaction under the person's row FOR UPDATE (heldPerson()): not blocked, the new row (by the id the
 *     library answered) still the person's, its name set (the typed one, or none), `parent.passkey.add` (the row's id,
 *     its name, and how many the person now has), and, for a first passkey (none of theirs added before it,
 *     passkeysAddedBefore(), so two adds at once make one set of codes, never none) of a person with no authenticator
 *     app in force, ten backup codes made (makeBackupCodes(), any older ones deleted), `parent.backup_codes.make`; and,
 *     since slice SI-10a, when this session is still enrolling (its window and the club's Strict read again here, and
 *     this passkey the person's first factor), the session made whole (completeEnrolment(), enrolment.ts: `enrol_until`
 *     cleared and `strong_at` set, after the person's row), `enrolled: true` in the add's row; a session that stopped
 *     enrolling meanwhile gets the passkey recorded as a whole session's would be, and the gate ends it. If it
 *     fails, the row the library inserted is deleted (forgetUnrecordedPasskey()). One gap stays: a process that stops
 *     between the library's insert and this transaction's commit (a restart, say) leaves the row with no name, no audit
 *     row and no backup codes. It works, and the person's settings list it as "Passkey added" with its date, where they
 *     can remove it; nothing sweeps such rows yet. And for an enrolling session, one more: in that same gap the
 *     person already holds a passkey (hasPasskey() counts the unrecorded row), so a request of this same session that
 *     the gate reads then (a second tab reloading) ends it (`enrol_ended`); the add then completes nothing (no
 *     `enrolled: true`) and answers its codes to a session that is gone, and the guardian signs in again with the
 *     passkey. Accepted (docs/agents/sign-in.md, "Strict's enrolment"): the passkey is theirs, and nothing is let through.
 * Devices stay remembered, and no session is ended or made; `strong_at` is left as it is but for an enrolment's
 * session, so the new passkey, now the person's newest factor, makes this session's earlier proof stop counting
 * (sessionStrongAt()).
 */
export async function addMyPasskey(who: Adder | null, body: unknown, verify: VerifyRegistration, ip: string | null, now = new Date()): Promise<AddAnswer> {
  if (!who) return REJECTED;
  const actor = parentActor({ id: who.parentId, email: who.email });
  const refuse = async (reason: AddRefusal, answer: AddAnswer = REJECTED) => {
    await writeAudit({ actor, action: "parent.passkey.add_refused", targetType: "parent", targetId: who.parentId, after: { reason }, ip });
    return answer;
  };
  const place = await takeRateLimitPlace("signin_settings_parent", who.parentId, now);
  if (place.take !== "taken") return { ok: false, error: "rate_limited" };
  const raw = isRecord(body) ? body : null;
  const answer = raw ? readRegistration(raw.response) : null;
  if (!raw || !answer || Object.keys(raw).some((k) => k !== "response" && k !== "name")) return refuse("not_a_registration");
  const name = raw.name === undefined ? "" : readPasskeyName(raw.name);
  if (name === null) return refuse("bad_name");
  if (!(await mayAddPasskey(who, now))) return refuse("not_allowed", { ok: false, error: "prove_again" });
  const verified = await verify(answer);
  if (!verified.ok) {
    if (verified.reason === "challenge_used" || verified.reason === "already_added") await giveBackRateLimit(place.placeId);
    return refuse(verified.reason, verified.reason === "already_added" ? { ok: false, error: "already_added" } : REJECTED);
  }
  let recorded: { codes: string[] | null } | "gone";
  try {
    recorded = await db.transaction(async (tx) => {
      const live = await heldPerson(tx, who.parentId);
      if (!live || live.blocked) return "gone" as const;
      if (!(await passkeyOfPerson(tx, who.parentId, verified.passkeyId))) return "gone" as const;
      await namePasskey(tx, who.parentId, verified.passkeyId, name === "" ? null : name);
      const passkeys = await passkeyCount(who.parentId, tx);
      const firstBesideNoApp = (await passkeysAddedBefore(tx, who.parentId, verified.passkeyId)) === 0 && !(await hasAuthenticator(who.parentId, tx));
      // Strict's enrolment: the session is whole once the person holds the passkey, when it is still enrolling: the
      // window and the level read again here, under the person's row, and this passkey the person's first factor (no
      // passkey added before it, no app). Its time is read here, after the library's insert, so the proof is never
      // older than the passkey it follows (sessionStrongAt()).
      const enrolled = await completeEnrolment(tx, who, new Date(Math.max(Date.now(), now.getTime())), firstBesideNoApp);
      const liveActor = parentActor({ id: who.parentId, email: live.email });
      await writeAudit({ actor: liveActor, action: "parent.passkey.add", targetType: "parent", targetId: who.parentId,
        after: { passkeyId: verified.passkeyId, name: name === "" ? null : name, passkeys, ...(enrolled ? { enrolled: true } : {}) }, ip }, tx);
      if (!firstBesideNoApp) return { codes: null };
      const made = await makeBackupCodes(tx, who.parentId, now);
      await writeAudit({ actor: liveActor, action: "parent.backup_codes.make", targetType: "parent", targetId: who.parentId,
        after: { made: made.codes.length, replaced: made.replaced, beside: "passkey" }, ip }, tx);
      return { codes: made.codes };
    });
  } catch {
    recorded = "gone";
  }
  if (recorded === "gone") {
    await forgetUnrecordedPasskey(who, verified.passkeyId, ip);
    return refuse("not_recorded");
  }
  return recorded.codes ? { ok: true, codes: recorded.codes } : { ok: true };
}

/**
 * The row the library inserted for a passkey the portal couldn't record (its transaction failed, or the person was
 * blocked or gone by then), deleted in a transaction of its own under the person's row, audited `parent.passkey.remove`
 * with `reason: "not_recorded"`. Best effort, and its answer says whether it went (false when it didn't): a failure
 * here leaves the row, unnamed and named by no audit row, which the person's settings list as "Passkey added" and its
 * date, where they can remove it, and which a staff reset removes (SI-9); the add answers the refusal either way.
 */
export async function forgetUnrecordedPasskey(who: Adder, passkeyId: string, ip: string | null): Promise<boolean> {
  try {
    return await db.transaction(async (tx) => {
      await heldPerson(tx, who.parentId);
      if (!(await removePasskey(tx, who.parentId, passkeyId))) return false;
      await writeAudit({ actor: parentActor({ id: who.parentId, email: who.email }), action: "parent.passkey.remove", targetType: "parent", targetId: who.parentId,
        after: { passkeyId, reason: "not_recorded", passkeys: await passkeyCount(who.parentId, tx) }, ip }, tx);
      return true;
    });
  } catch {
    return false;
  }
}

/**
 * Naming a passkey ("Rename", decision 3 of SI-7b): not asked again (it changes no way in: open question 28 doesn't
 * list it). The id checked for its shape (isPasskeyId()) and the name as at the add (readPasskeyName(); empty is no
 * name), anything else refused uncounted; then `signin_settings_parent`; then one transaction under the person's row
 * (lockedPerson(), not blocked): the passkey found only among the person's own (one answer for any other id), its name
 * set, `parent.passkey.rename` with the name before and after (the parent's own words, kept in the row, never logged).
 */
export async function renameMyPasskey(ctx: Me, id: unknown, rawName: unknown, now?: Date): Promise<PasskeyResult> {
  if (!isPasskeyId(id)) return NOT_FOUND;
  const name = readPasskeyName(rawName);
  if (name === null) return BAD_NAME;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return TOO_MANY_PRESSES;
  const done = await db.transaction(async (tx) => {
    const live = await lockedPerson(tx, ctx.parentId);
    if (!live || live.blocked) return "gone" as const;
    const row = await passkeyOfPerson(tx, ctx.parentId, id);
    if (!row) return "gone" as const;
    const after = name === "" ? null : name;
    await namePasskey(tx, ctx.parentId, id, after);
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: live.email }), action: "parent.passkey.rename", targetType: "parent", targetId: ctx.parentId,
      before: { passkeyId: id, name: row.name }, after: { passkeyId: id, name: after }, ip: ctx.ip }, tx);
    return "named" as const;
  });
  return done === "named" ? { ok: true, message: COPY.passkeyRenamed } : NOT_FOUND;
}

/**
 * Removing a passkey ("Remove", decision 4 of SI-7b; open questions 28 and 33): asked again. The id checked for its
 * shape, then the window (sessionProvedRecently()), then `signin_settings_parent`, then one transaction: the parents'
 * settings lock shared (the club's level is read), the person's row FOR UPDATE (heldPerson(), not blocked: two
 * removes of one person go one at a time, so neither passes Q33's check counting the other's passkey), the window again
 * under it, the passkey found only among the person's own; then, when it is their last passkey and they have no
 * authenticator app in force: under Strict refused, changing nothing, in words that it is their only second step and
 * to add another first (Q33); under Standard removed, with their backup codes, which stand beside nothing once it goes
 * (removeBackupCodes(); counted in the row). `parent.passkey.remove` with the passkey's id, how many are left and how
 * many backup codes went. A sign-in that verified it just before and whose session is made after is refused at its
 * last check (signinStands(): `passkey_gone`); the next sign-in on a new device asks for the app, or the emailed code.
 */
export async function removeMyPasskey(ctx: Me, id: unknown, now?: Date): Promise<PasskeyResult> {
  if (!isPasskeyId(id)) return NOT_FOUND;
  if (!(await sessionProvedRecently(db, ctx, now))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return TOO_MANY_PRESSES;
  const done = await db.transaction(async (tx) => {
    await holdParentSettings(tx);
    const live = await heldPerson(tx, ctx.parentId);
    if (!live || live.blocked) return "not_proved" as const;
    if (!provedRecently(await sessionStrongAt(tx, ctx), now ?? new Date())) return "not_proved" as const;
    if (!(await passkeyOfPerson(tx, ctx.parentId, id))) return "gone" as const;
    const app = await hasAuthenticator(ctx.parentId, tx);
    const last = (await passkeyCount(ctx.parentId, tx)) === 1;
    const strict = last && (await getParentSettings(tx)).level === "strict";
    if (last && !app && strict) return "strict" as const;
    await removePasskey(tx, ctx.parentId, id);
    const backupCodesDeleted = last && !app ? await removeBackupCodes(tx, ctx.parentId) : 0;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: live.email }), action: "parent.passkey.remove", targetType: "parent", targetId: ctx.parentId,
      after: { passkeyId: id, passkeys: await passkeyCount(ctx.parentId, tx), backupCodesDeleted }, ip: ctx.ip }, tx);
    return last ? (app ? (strict ? "last_beside_app_strict" as const : "last_beside_app" as const) : "last" as const) : "one_of_several" as const;
  });
  if (done === "not_proved") return PROVE_AGAIN;
  if (done === "gone") return NOT_FOUND;
  if (done === "strict") return { ok: false, errors: [COPY.passkeyRemoveStrict] };
  // Beside an app at Strict (slice SI-10b), the app's code is asked at every sign-in: no remembered device spares it.
  return { ok: true, message: done === "last" ? COPY.passkeyRemovedLast : done === "last_beside_app" ? COPY.passkeyRemovedLastApp
    : done === "last_beside_app_strict" ? COPY.passkeyRemovedLastAppStrict : COPY.passkeyRemoved };
}
