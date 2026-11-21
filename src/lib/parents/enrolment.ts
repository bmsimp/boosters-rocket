// Strict's enrolment, as the presses read and finish it (the sign-in release, slice SI-10a; section 6 of the app-owned
// families spec, "Signing in", and open questions 21, 22 and 25). An enrolling session (parent_auth_session.enrol_until,
// set by the one finish for a password alone under Strict, src/lib/auth/parent-signin-finish.ts) may do exactly two
// things: add a passkey (passkey-settings.ts) or set up and confirm an authenticator app (authenticator-settings.ts).
// Each of those asks sessionMayAddFactor() where it asked for a proof within the window, and the transaction that puts
// the person's first factor in force makes the session whole (completeEnrolment()). Every other press keeps asking for
// a real proof (sessionProvedRecently(), asking-again.ts), so an enrolling session is refused there. Said plainly: the
// enrolment is reached by the password alone, so until a guardian adds a factor a stolen password lets a stranger add
// theirs; the emailed code takes no part, and no remembered device does. Server only; parent code.
import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parentAuthSession, parentAuthUser, setting } from "@/lib/db/schema";
import { sessionProvedRecently } from "./asking-again";
import { sessionStanding } from "./enrolment-rule";
import { hasSecondFactor } from "./passkeys";
import { PARENTS_KEY, parseParentSettings } from "./settings";

/** A query runner: the database, or the caller's transaction. */
type Reader = Pick<typeof db, "select">;
type Session = { sessionId: string; parentId: string };

/** The person's sign-in account ids (one at most), for a session's `user_id`. */
const usersOf = (q: Reader, parentId: string) => q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId));

/** This session's `enrol_until`, when it is this person's and has one; null otherwise (not enrolling, ended, or another's). */
export async function sessionEnrolUntil(q: Reader, s: Session): Promise<Date | null> {
  // Read through sql<Date>: drizzle's inferred type of a column of the Better Auth tables comes out as never (schema.ts).
  const [row] = await q.select({ until: sql<Date | null>`${parentAuthSession.enrolUntil}`.mapWith(parentAuthSession.enrolUntil) }).from(parentAuthSession)
    .where(and(eq(parentAuthSession.id, s.sessionId), inArray(parentAuthSession.userId, usersOf(q, s.parentId))));
  return row?.until ?? null;
}

/** The club's level, read through `q` (the caller's transaction, under its locks, or the database). */
async function levelNow(q: Reader): Promise<"standard" | "strict"> {
  const [row] = await q.select({ value: setting.value }).from(setting).where(eq(setting.key, PARENTS_KEY));
  return row ? parseParentSettings(row.value).level : "standard";
}

/**
 * Whether this session of this person is enrolling at `now` (sessionStanding(), enrolment-rule.ts): its `enrol_until`
 * set and not passed, the club at Strict, and the person with no second factor in force.
 */
export async function sessionEnrolling(q: Reader, s: Session, now = new Date()): Promise<boolean> {
  const enrolUntil = await sessionEnrolUntil(q, s);
  if (enrolUntil === null) return false;
  const [level, factor] = await Promise.all([levelNow(q), hasSecondFactor(s.parentId, q)]);
  return sessionStanding({ level, enrolUntil, hasSecondFactor: factor, now }).standing === "enrolling";
}

/**
 * Whether this session may add a second factor now (the lead's decision 6 of SI-10a): proved within the window, as
 * sessionProvedRecently() reads it, or enrolling (sessionEnrolling()). The one check of the passkey's add
 * (mayAddPasskey(), passkey-settings.ts) and the app's set-up and confirm (authenticator-settings.ts), read before each
 * and again under the person's row wherever they read the window again.
 */
export async function sessionMayAddFactor(q: Reader, s: Session, now = new Date()): Promise<boolean> {
  return (await sessionProvedRecently(q, s, now)) || sessionEnrolling(q, s, now);
}

/**
 * The end of an enrolment, in the transaction that puts the person's first factor in force (the passkey's row recorded,
 * or the app's confirm), which holds the person's row and writes the audit row: when this session is enrolling, its
 * `enrol_until` cleared and its `strong_at` set to `now`, on this session's row alone (by its id, its user the
 * person's, and only while `enrol_until` is set), so the session is whole from the moment the person holds a factor.
 * True when it was enrolling (the audit row then says `enrolled: true`). Lock order as above lockedPerson()
 * (sessions.ts): the person's row, then the session's.
 */
export async function completeEnrolment(tx: Tx, s: Session, now: Date): Promise<boolean> {
  const rows = await tx.update(parentAuthSession).set({ enrolUntil: null, strongAt: now, updatedAt: now })
    .where(and(eq(parentAuthSession.id, s.sessionId), isNotNull(parentAuthSession.enrolUntil), inArray(parentAuthSession.userId, usersOf(tx, s.parentId))))
    .returning({ id: parentAuthSession.id });
  return rows.length > 0;
}
