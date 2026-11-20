// Asking again (the sign-in release, slice SI-5a; open question 28 of the app-owned families spec): before a change of
// how a parent signs in (their password, their sign-in email; from SI-5b, SI-6 and SI-7 forgetting a device, the
// authenticator app and passkeys), the session that asks must have proved the password and the second step within the
// last 10 minutes (provedRecently(), ./reask-rule.ts, of `parent_auth_session.strong_at`). A sign-in with the emailed
// code or a set-up link stamps it (recordStrongSignin(), devices.ts); one on a remembered device does not; otherwise the
// parent proves it again here, on the page they are on, through the door's own checks: the password
// (checkPasswordSignin(), password-signin.ts, for the session's own address; a page request carries no device cookie,
// whose path is /api/auth/parent, so since slice SI-5b the device is the one the session names, `device_id`, and its
// tries are counted against that device when it is the person's and unexpired, else against the person, `password_reask_parent`),
// then the second step: the emailed code (sendSecondStepCode() for a change, verifySigninCode(), signinStands(),
// signin-codes.ts), or, since slice SI-6a, for a person with an authenticator app in force, the app's code or a backup
// code, and no code is sent (verifySecondFactor(), signinStands(); open questions 24 and 28). A remembered device is never
// a second step here: it is the very phone the question's reason speaks of ("a 90-day session on an unlocked phone
// should not be enough to take the sign-in over"). Nothing here makes a session, sets a cookie or calls the finish: it
// stamps the `strong_at` of the session that asked, and nothing else. Server only; parent code.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthAccount, parentAuthSession, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { env } from "@/env";
import type { ParentCtx } from "@/lib/guards";
import { MOST_TYPED_PASSWORD, checkPasswordSignin } from "./password-signin";
import { CODE_TTL_MS, refuseCodeWithoutStep, sendSecondStepCode, signinStands, verifySecondFactor, verifySigninCode, type PasswordProof, type SecondFactorProof, type StepPerson } from "./signin-codes";
import { hasAuthenticator } from "./authenticator";
import { lockedPerson, parentActor } from "./sessions";
import { provedRecently } from "./reask-rule";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

/** Who is asking: the session and its person, from the guard (ParentCtx) and never from the browser. */
type Asker = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;
/** A query runner: the database, or the caller's transaction. */
type Reader = Pick<typeof db, "select">;

/**
 * The session's own proof of the password and a second step, as `strong_at` holds it, or null: none yet, or no such
 * session of this person (ended, or another's). `strong_at` is set only by a proof the session made itself: a sign-in
 * with the emailed code or a set-up link (recordStrongSignin(), devices.ts), or asking again (askAgainCode(), below). A
 * sign-in on a remembered device proved only the password at that moment, and sets none.
 */
export async function sessionStrongAt(q: Reader, s: { sessionId: string; parentId: string }): Promise<Date | null> {
  const [row] = await q.select({ strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt) }).from(parentAuthSession)
    .where(and(eq(parentAuthSession.id, s.sessionId),
      inArray(parentAuthSession.userId, q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, s.parentId)))));
  return row?.strongAt ?? null;
}

/**
 * The remembered device this session of this person was made on (`parent_auth_session.device_id`, since slice SI-5b),
 * or null: none (a session from before SI-5b, or one whose device was forgotten), or no such session of this person.
 * Whether the device is still the person's and unexpired is for its reader to check (deviceOfAddress(), the sign-in
 * settings' list): the row may have run out.
 */
export async function sessionDeviceId(q: Reader, s: { sessionId: string; parentId: string }): Promise<string | null> {
  const [row] = await q.select({ deviceId: parentAuthSession.deviceId }).from(parentAuthSession)
    .where(and(eq(parentAuthSession.id, s.sessionId),
      inArray(parentAuthSession.userId, q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, s.parentId)))));
  return row?.deviceId ?? null;
}

/**
 * Whether this session of this person proved itself within the window at `now` (provedRecently()). Read by the page to
 * choose what it draws, and again by each change inside its own transaction (`q`), before it writes.
 */
export async function sessionProvedRecently(q: Reader, s: { sessionId: string; parentId: string }, now = new Date()): Promise<boolean> {
  return provedRecently(await sessionStrongAt(q, s), now);
}

/** The person's `credential` row as it stands, by its id and `updated_at`, or null when they have no password. */
export async function currentPassword(q: Reader, parentId: string): Promise<PasswordProof | null> {
  const [row] = await q.select({ credentialId: parentAuthAccount.id,
    // Read through sql<Date>: drizzle's inferred type of this column of the Better Auth tables comes out as never (schema.ts).
    credentialUpdatedAt: sql<Date>`${parentAuthAccount.updatedAt}`.mapWith(parentAuthAccount.updatedAt) }).from(parentAuthAccount)
    .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthAccount.userId))
    .where(and(eq(parentAuthUser.parentId, parentId), eq(parentAuthAccount.providerId, "credential")));
  return row ?? null;
}

/*
 * The stamp: what the page carries between the right password and the code. Never a cookie (only the door's modules set
 * one, tests/unit/one-way-in.test.ts) and never a row. It is the step's end (CODE_TTL_MS after the right password, never
 * extended) and an HMAC-SHA256, keyed with the server secret, over a string that names its purpose, this session's id,
 * the person, the address the password was proved with and the `credential` row it was checked against (its id and its
 * `updated_at`), and that end. None of those ids is in the stamp itself: the reader works the HMAC out again from the
 * session the guard gives it and the person's password as it stands, and compares the two in constant time. So a stamp
 * made for another session or person, or before the password changed, or one past its end, is no stamp.
 */
const STAMP_SHAPE = /^(\d{13})\.([A-Za-z0-9_-]{43})$/;
/** The most a stamp may be as sent: anything longer is not one, and is refused before it is looked at. */
export const MOST_SENT_STAMP = 64;
/** The most a code field may hold as sent, as at the door's code step. */
const MOST_SENT_CODE = 20;

/*
 * Since slice SI-6b the HMAC also names which second step the stamp asked for (`code` or `app`), with no change to the
 * stamp's shape: the reader works out both and takes the one that matches, so a stamp that asked for the app is read as
 * the app's step even once the app has been turned off (decision 10 of SI-6b: that step then ends).
 */
type StampStep = "code" | "app";
const stampMac = (s: { sessionId: string; parentId: string; email: string }, password: PasswordProof, endsAt: number, step: StampStep): Buffer =>
  createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`asking-again:${s.sessionId}:${s.parentId}:${s.email}:${password.credentialId}:${password.credentialUpdatedAt.getTime()}:${endsAt}:${step}`).digest();

function makeStamp(s: { sessionId: string; parentId: string; email: string }, password: PasswordProof, endsAt: Date, step: StampStep): string {
  return `${endsAt.getTime()}.${stampMac(s, password, endsAt.getTime(), step).toString("base64url")}`;
}

/**
 * The step a stamp names for the asker, with which second step it asked for, or null: not a stamp's shape, past its end
 * (or an end no stamp could have), the person with no password now, or an HMAC that is not the one this session,
 * person, address and password make, for either step (both are compared, in constant time each).
 */
async function readStamp(raw: unknown, who: Asker, now: Date): Promise<(StepPerson & { step: StampStep }) | null> {
  if (typeof raw !== "string" || raw.length > MOST_SENT_STAMP) return null;
  const m = STAMP_SHAPE.exec(raw);
  if (!m) return null;
  const endsAt = Number(m[1]);
  if (!(endsAt > now.getTime() && endsAt <= now.getTime() + CODE_TTL_MS)) return null;
  const password = await currentPassword(db, who.parentId);
  if (!password) return null;
  const got = Buffer.from(m[2]!, "base64url");
  let step: StampStep | null = null;
  for (const s of ["code", "app"] as const) {
    const want = stampMac(who, password, endsAt, s);
    if (got.length === want.length && timingSafeEqual(got, want)) step = s;
  }
  if (!step) return null;
  return { parentId: who.parentId, email: who.email, password, endsAt: new Date(endsAt), step };
}

/**
 * What a step of asking again answers: the right password gives the stamp to send back with the code, and which second
 * step to ask for (`step`): the code it emailed (`code`), or, since slice SI-6a, the person's authenticator app's code
 * or a backup code (`app`), when nothing is emailed.
 */
export type AskAgainAnswer = { ok: true; message: string; stamp: string; step: "code" | "app" } | { ok: false; errors: string[] };
/** `ended`: the app's step can't go on (since slice SI-6b), so the page goes back to the password; it never says why. */
export type ProvedAnswer = { ok: true; message: string } | { ok: false; errors: string[]; ended?: true };
const PASSWORD_REFUSED = { ok: false as const, errors: [COPY.passwordRejected] };
const CODE_REFUSED = { ok: false as const, errors: [COPY.codeRejected] };
const APP_REFUSED = { ok: false as const, errors: [COPY.appRejected] };
const APP_STEP_OVER = { ok: false as const, errors: [COPY.appRejected, COPY.stepOver], ended: true as const };
const TOO_MANY = { ok: false as const, errors: [COPY.tooManyTries] };

/**
 * The first step: the session's own password. The door's check (checkPasswordSignin()), for the session's address
 * (`ctx.email`, never a typed one) and with the device this session names (sessionDeviceId(), by its row: since slice
 * SI-5b), its tries counted against that device when it is the person's and unexpired (`password_try_device`, the count
 * a password at the door on that device fills too), and otherwise against the session's person (`password_reask_parent`,
 * its TryCount), never the address's count: a stranger who keeps `password_try_email` full at the door can't stop the
 * parent proving it's them, and wrong tries here don't fill the door's count for the address. The per-IP flood
 * stop (`password_try_ip`), the wait for a turn, its refusals and its rows are the door's (a right
 * password writes `signin.second_step_asked`, left as the door writes it: the row after it, `signin.proved_again`, says
 * the code was for asking again). Anything but a string of at most MOST_TYPED_PASSWORD is the refusal, uncounted. Every
 * refusal is one answer, and over a limit or turned away by a full wait, the door's words. A right password always
 * sends the code (sendSecondStepCode() for a change, whose mail says so; with its own limits, wait and rows; its mail is
 * not awaited, and the answer never says what became of it), for a step ending CODE_TTL_MS after the password proved right, which the stamp carries.
 * Since slice SI-6a a person with an authenticator app in force (the door's own read, PasswordCheck.step) is sent no
 * code: the answer asks for the app's code or a backup code (`step: "app"`), with the same stamp. Under Strict the door
 * refuses a person with no second factor (`strict_no_factor`), so only an app holder is asked again there.
 */
export async function askAgainPassword(ctx: Asker, password: unknown, now = new Date()): Promise<AskAgainAnswer> {
  if (typeof password !== "string" || password.length > MOST_TYPED_PASSWORD) return PASSWORD_REFUSED;
  const deviceId = await sessionDeviceId(db, ctx);
  const check = await checkPasswordSignin(ctx.email, password, deviceId ? { deviceId } : null, ctx.ip, now, undefined, { kind: "password_reask_parent", subject: ctx.parentId });
  if (!check.ok) return check.limited ? TOO_MANY : PASSWORD_REFUSED;
  if (check.person.id !== ctx.parentId) return PASSWORD_REFUSED; // one address is one person: never another's
  const endsAt = new Date(check.at.getTime() + CODE_TTL_MS);
  const asker = { sessionId: ctx.sessionId, parentId: ctx.parentId, email: check.person.email };
  if (check.step === "second_factor") return { ok: true, message: COPY.appAsked, stamp: makeStamp(asker, check.password, endsAt, "app"), step: "app" };
  const { delivery, app } = await sendSecondStepCode({ parentId: ctx.parentId, email: check.person.email, password: check.password, endsAt }, ctx.ip, check.at, "change");
  void delivery;
  // An app that came into force after the password's reads: nothing was sent, and the app is asked for.
  if (app) return { ok: true, message: COPY.appAsked, stamp: makeStamp(asker, check.password, endsAt, "app"), step: "app" };
  return { ok: true, message: COPY.codeSent, stamp: makeStamp(asker, check.password, endsAt, "code"), step: "code" };
}

/**
 * The second step: the code, with the stamp the first step gave. The stamp is read for this session and person
 * (readStamp()); with none, the code signs nothing (refuseCodeWithoutStep(), counted and audited as the door counts a
 * code with no pending step), and, like a code over the field's length, refused in the app's words for a person with an
 * app in force (COPY.appRejected, which says to start again with the password) and the emailed code's otherwise. Then the door's checks, called as they are: for a person with an authenticator app in
 * force (since slice SI-6a), verifySecondFactor() for the stamp's person and password (the app's code or a backup code,
 * with its limits, replay guard and rows), otherwise verifySigninCode() (its 10 minutes, 5 tries, `code_check_ip` and
 * rows); and signinStands() for that password and what was spent. Then, in one transaction in the order above
 * lockedPerson() (the person's row, then their sessions), the person still at the address and not blocked, and this
 * session's `strong_at` set to now, this session's alone, audited `signin.proved_again` with the step that proved it
 * (`emailed_code`, `authenticator` or `backup_code`). Every refusal is one answer, and over a limit the door's words.
 * Since slice SI-6b a stamp that asked for the app is checked as the app's step even once the app has been turned off:
 * that step then ends (verifySecondFactor()'s `no_app`), answered with the app's words and that they start again with
 * their password, `ended: true`, and the page goes back to its password field.
 */
export async function askAgainCode(ctx: Asker, stamp: unknown, code: unknown, now = new Date()): Promise<ProvedAnswer> {
  // Refused before any step is read (a code no field could send, a stamp that is no stamp or past its end): the words
  // of the step the person would be asked for. The session names the person already, so this tells nobody anything,
  // and an app holder, who was never emailed anything, is never told to look for an email.
  const refused = async () => (await hasAuthenticator(ctx.parentId)) ? APP_REFUSED : CODE_REFUSED;
  if (typeof code !== "string" || code.length > MOST_SENT_CODE) return refused();
  const step = await readStamp(stamp, ctx, now);
  if (!step) return (await refuseCodeWithoutStep(ctx.ip, now)) === "rate_limited" ? TOO_MANY : refused();
  const proved = await proveSecondStep(step, code, ctx.ip, now);
  if (!proved.ok) return proved.limited ? TOO_MANY : proved.app ? (proved.ended ? APP_STEP_OVER : APP_REFUSED) : CODE_REFUSED;
  if (!(await signinStands(step.parentId, step.email, ctx.ip, { password: step.password, ...proved.proof }, now))) return proved.app ? APP_REFUSED : CODE_REFUSED;
  const stamped = await db.transaction(async (tx) => {
    const live = await lockedPerson(tx, ctx.parentId);
    if (!live || live.blocked || live.email !== step.email) return false;
    const rows = await tx.update(parentAuthSession).set({ strongAt: now })
      .where(and(eq(parentAuthSession.id, ctx.sessionId),
        inArray(parentAuthSession.userId, tx.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, ctx.parentId)))))
      .returning({ id: parentAuthSession.id });
    if (rows.length === 0) return false;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: live.email }), action: "signin.proved_again", targetType: "parent", targetId: ctx.parentId,
      after: { step: proved.step }, ip: ctx.ip }, tx);
    return true;
  });
  return stamped ? { ok: true, message: COPY.proved } : proved.app ? APP_REFUSED : CODE_REFUSED;
}

/** The second step a stamp's person proved, with what it spent, or a refusal (`app` when it was the app's step that refused). */
type Proved = { ok: true; app: boolean; step: "emailed_code" | "authenticator" | "backup_code"; proof: { codeId: string } | SecondFactorProof }
  | { ok: false; app: boolean; limited: boolean; ended: boolean };

/**
 * The person's own second step, as the door takes it: their authenticator app's code or a backup code when they have an
 * app in force, or when the stamp asked for the app (verifySecondFactor(), which, since slice SI-6b, refuses and ends the
 * step of a person whose app was turned off since, `no_app`), otherwise the emailed code (verifySigninCode()). An app
 * turned on between the password and the code leaves a code mailed before it to be refused at signinStands()
 * (`second_factor_in_force`).
 */
async function proveSecondStep(step: StepPerson & { step: "code" | "app" }, code: string, ip: string | null, now: Date): Promise<Proved> {
  const who = { parentId: step.parentId, email: step.email, password: step.password };
  if (step.step === "app" || await hasAuthenticator(step.parentId)) {
    const r = await verifySecondFactor(who, code, ip, now);
    return r.ok ? { ok: true, app: true, step: r.factor, proof: r.proof } : { ok: false, app: true, limited: r.reason === "rate_limited", ended: r.ended };
  }
  const r = await verifySigninCode(who, code, ip, now);
  return r.ok ? { ok: true, app: false, step: "emailed_code", proof: { codeId: r.codeId } } : { ok: false, app: false, limited: r.reason === "rate_limited", ended: r.ended };
}
