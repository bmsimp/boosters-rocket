// Asking again (the sign-in release, slice SI-5a; open question 28 of the app-owned families spec): before a change of
// how a parent signs in (their password, their sign-in email; from SI-5b, SI-6 and SI-7 forgetting a device, the
// authenticator app and passkeys), the session that asks must have proved the password and the second step within the
// last 10 minutes (provedRecently(), ./reask-rule.ts, of `parent_auth_session.strong_at`). A sign-in with the emailed
// code or a set-up link stamps it (recordStrongSignin(), devices.ts); one on a remembered device stamps it too, and that
// stamp is not taken (sessionStrongAt()); otherwise the parent proves it again here, on the page they are on, through the
// door's own checks, called as they are: the password (checkPasswordSignin(), password-signin.ts, for the session's
// own address and with no device: a page request carries no device cookie, whose path is /api/auth/parent), then the
// emailed code (sendSecondStepCode(), verifySigninCode(), signinStands(), signin-codes.ts). A remembered device is never
// a second step here: it is the very phone the question's reason speaks of ("a 90-day session on an unlocked phone
// should not be enough to take the sign-in over"). Nothing here makes a session, sets a cookie or calls the finish: it
// stamps the `strong_at` of the session that asked, and nothing else. Server only; parent code.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { env } from "@/env";
import type { ParentCtx } from "@/lib/guards";
import { MOST_TYPED_PASSWORD, checkPasswordSignin } from "./password-signin";
import { CODE_TTL_MS, refuseCodeWithoutStep, sendSecondStepCode, signinStands, verifySigninCode, type PasswordProof, type StepPerson } from "./signin-codes";
import { lockedPerson, parentActor } from "./sessions";
import { provedRecently } from "./reask-rule";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

/** Who is asking: the session and its person, from the guard (ParentCtx) and never from the browser. */
type Asker = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;
/** A query runner: the database, or the caller's transaction. */
type Reader = Pick<typeof db, "select">;

/**
 * The session's own proof of the password and a second step, as `strong_at` holds it, or null: none yet, no such
 * session of this person (ended, or another's), or a `strong_at` a remembered device stamped. recordStrongSignin()
 * (devices.ts, SI-3b's) stamps `strong_at` for every sign-in it finishes, a password on a remembered device too, where
 * the device stood in for the emailed code; here a remembered device is never a second step, so that stamp opens no
 * window. It is told apart by what the same transaction wrote: a remembered device's sign-in moves that device's
 * `last_used_at` to the very instant it stamps (one `now`), on a row made earlier, while a code's or a set-up link's
 * sign-in makes a new device at that instant (`created_at` equal to `last_used_at`), and asking again touches no device.
 * Until SI-5b records on the session the device it was made on (and renews a device by use, which would move the
 * instant on), this is how the window knows; SI-5b replaces it with that record.
 */
export async function sessionStrongAt(q: Reader, s: { sessionId: string; parentId: string }): Promise<Date | null> {
  const [row] = await q.select({
    strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt),
    byRememberedDevice: sql<boolean>`exists (select 1 from ${parentDevice} where ${parentDevice.parentId} = ${s.parentId}
      and ${parentDevice.lastUsedAt} = ${parentAuthSession.strongAt} and ${parentDevice.createdAt} < ${parentDevice.lastUsedAt})`,
  }).from(parentAuthSession)
    .where(and(eq(parentAuthSession.id, s.sessionId),
      inArray(parentAuthSession.userId, q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, s.parentId)))));
  if (!row || row.byRememberedDevice) return null;
  return row.strongAt ?? null;
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

const stampMac = (s: { sessionId: string; parentId: string; email: string }, password: PasswordProof, endsAt: number): Buffer =>
  createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`asking-again:${s.sessionId}:${s.parentId}:${s.email}:${password.credentialId}:${password.credentialUpdatedAt.getTime()}:${endsAt}`).digest();

function makeStamp(s: { sessionId: string; parentId: string; email: string }, password: PasswordProof, endsAt: Date): string {
  return `${endsAt.getTime()}.${stampMac(s, password, endsAt.getTime()).toString("base64url")}`;
}

/**
 * The step a stamp names for the asker, or null: not a stamp's shape, past its end (or an end no stamp could have), the
 * person with no password now, or an HMAC that is not the one this session, person, address and password make.
 */
async function readStamp(raw: unknown, who: Asker, now: Date): Promise<StepPerson | null> {
  if (typeof raw !== "string" || raw.length > MOST_SENT_STAMP) return null;
  const m = STAMP_SHAPE.exec(raw);
  if (!m) return null;
  const endsAt = Number(m[1]);
  if (!(endsAt > now.getTime() && endsAt <= now.getTime() + CODE_TTL_MS)) return null;
  const password = await currentPassword(db, who.parentId);
  if (!password) return null;
  const want = stampMac(who, password, endsAt);
  const got = Buffer.from(m[2]!, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { parentId: who.parentId, email: who.email, password, endsAt: new Date(endsAt) };
}

/** What a step of asking again answers: the right password gives the stamp to send back with the code. */
export type AskAgainAnswer = { ok: true; message: string; stamp: string } | { ok: false; errors: string[] };
export type ProvedAnswer = { ok: true; message: string } | { ok: false; errors: string[] };
const PASSWORD_REFUSED = { ok: false as const, errors: [COPY.passwordRejected] };
const CODE_REFUSED = { ok: false as const, errors: [COPY.codeRejected] };
const TOO_MANY = { ok: false as const, errors: [COPY.tooManyTries] };

/**
 * The first step: the session's own password. The door's check, called as it is (checkPasswordSignin()), for the
 * session's address (`ctx.email`, never a typed one) and with no device token, so its limits are the door's for an
 * address (`password_try_email`, `password_try_ip`), with its wait for a turn, its refusals and its rows (a right
 * password writes `signin.second_step_asked`, left as the door writes it: the row after it, `signin.proved_again`, says
 * the code was for asking again). Anything but a string of at most MOST_TYPED_PASSWORD is the refusal, uncounted. Every
 * refusal is one answer, and over a limit or turned away by a full wait, the door's words. A right password always
 * sends the code (sendSecondStepCode(), with its own limits, wait and rows; its mail is not awaited, and the answer never
 * says what became of it), for a step ending CODE_TTL_MS after the password proved right, which the stamp carries.
 * Under Strict the door refuses (`strict_no_factor`), and so nothing is asked again until SI-6 and SI-7.
 */
export async function askAgainPassword(ctx: Asker, password: unknown, now = new Date()): Promise<AskAgainAnswer> {
  if (typeof password !== "string" || password.length > MOST_TYPED_PASSWORD) return PASSWORD_REFUSED;
  const check = await checkPasswordSignin(ctx.email, password, null, ctx.ip, now);
  if (!check.ok) return check.limited ? TOO_MANY : PASSWORD_REFUSED;
  if (check.person.id !== ctx.parentId) return PASSWORD_REFUSED; // one address is one person: never another's
  const endsAt = new Date(check.at.getTime() + CODE_TTL_MS);
  const { delivery } = await sendSecondStepCode({ parentId: ctx.parentId, email: check.person.email, password: check.password, endsAt }, ctx.ip, check.at);
  void delivery;
  return { ok: true, message: COPY.codeSent, stamp: makeStamp({ sessionId: ctx.sessionId, parentId: ctx.parentId, email: check.person.email }, check.password, endsAt) };
}

/**
 * The second step: the code, with the stamp the first step gave. The stamp is read for this session and person
 * (readStamp()); with none, the code signs nothing (refuseCodeWithoutStep(), counted and audited as the door counts a
 * code with no pending step). Then the door's checks, called as they are: verifySigninCode() for the stamp's person and
 * password (its 10 minutes, 5 tries, `code_check_ip` and rows), and signinStands() for that password and code. Then, in
 * one transaction in the order above lockedPerson() (the person's row, then their sessions), the person still at the
 * address and not blocked, and this session's `strong_at` set to now, this session's alone, audited
 * `signin.proved_again`. Every refusal is one answer, and over a limit the door's words.
 */
export async function askAgainCode(ctx: Asker, stamp: unknown, code: unknown, now = new Date()): Promise<ProvedAnswer> {
  if (typeof code !== "string" || code.length > MOST_SENT_CODE) return CODE_REFUSED;
  const step = await readStamp(stamp, ctx, now);
  if (!step) return (await refuseCodeWithoutStep(ctx.ip, now)) === "rate_limited" ? TOO_MANY : CODE_REFUSED;
  const verified = await verifySigninCode({ parentId: step.parentId, email: step.email, password: step.password }, code, ctx.ip, now);
  if (!verified.ok) return verified.reason === "rate_limited" ? TOO_MANY : CODE_REFUSED;
  if (!(await signinStands(step.parentId, step.email, ctx.ip, { password: step.password, codeId: verified.codeId }, now))) return CODE_REFUSED;
  const stamped = await db.transaction(async (tx) => {
    const live = await lockedPerson(tx, ctx.parentId);
    if (!live || live.blocked || live.email !== step.email) return false;
    const rows = await tx.update(parentAuthSession).set({ strongAt: now })
      .where(and(eq(parentAuthSession.id, ctx.sessionId),
        inArray(parentAuthSession.userId, tx.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, ctx.parentId)))))
      .returning({ id: parentAuthSession.id });
    if (rows.length === 0) return false;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: live.email }), action: "signin.proved_again", targetType: "parent", targetId: ctx.parentId,
      after: { step: "emailed_code" }, ip: ctx.ip }, tx);
    return true;
  });
  return stamped ? { ok: true, message: COPY.proved } : CODE_REFUSED;
}
