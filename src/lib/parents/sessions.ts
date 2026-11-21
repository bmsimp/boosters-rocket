import { and, eq, exists, gt, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthSession, parentAuthUser, parentDevice, parentSigninToken, signinCode, student } from "@/lib/db/schema";
import type { Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { getShape, shapeNamesStudents, type MembershipShape } from "@/lib/roster/shape";
import { getParentSettings } from "./settings";
import { unspentLink } from "./link-state";

export type GuardianRow = typeof guardian.$inferSelect;

export const parentActor = (p: { id: string; email: string }): Actor => ({ door: "parent", id: p.id, label: p.email });

/**
 * Spec §1 The session: a parent stays signed in for 90 days from the last day they used the portal. The session row is
 * the authority: Better Auth refuses and removes a row past its `expiresAt`, and renewParentSession() moves that time
 * on. The cookie only has to outlive the row. It is set once, at sign-in, and never again (a session is read while a
 * page renders, where a new cookie could not be sent), so it gets the longest life browsers allow, 400 days: a parent
 * who keeps using the portal is asked for a code about once a year, and one who stays away 90 days is asked on return.
 */
export const PARENT_SESSION_SECONDS = 90 * 24 * 60 * 60;
export const PARENT_SESSION_COOKIE_SECONDS = 400 * 24 * 60 * 60;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * How long a remembered device is remembered from its last use: a password sign-in on it, or its session's renewal
 * (open question 26). Kept here, beside the session's own life, since the renewal below renews both; devices.ts, which
 * imports this module, exports it on.
 */
export const DEVICE_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Starts the session's 90 days again, at most once a day: a row made or renewed less than a day ago is left alone,
 * without a query. Called for a session the portal has just accepted (src/lib/auth/identity.ts). A row that has run
 * out is never brought back: the update only matches one that is still live.
 *
 * Since the sign-in release's slice SI-5b it renews the session's device with it (open question 26: a device is
 * "renewed by use, like sessions"), in one transaction and in the order above lockedPerson() (devices before sessions):
 * first the device the session names (`parent_auth_session.device_id`), its last use now and its end DEVICE_LIFE_MS on,
 * but only while it is that session's own person's (through `parent_auth_user.parent_id`), unexpired (a device past its
 * end, or forgotten, whose row is gone, is never brought back) and not renewed in the last day (so two renewals at once
 * renew it once), and only while the session itself is still live and due its renewal; then the session, as before. A
 * request that renews nothing reads nothing new. Unaudited, as a session's renewal is (tests/unit/audit-rows.test.ts,
 * NOT_AUDITED): it is the portal keeping what the person already has, and runs on every day's first page.
 */
export async function renewParentSession(s: { id: string; expiresAt: Date }, now = new Date()): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + PARENT_SESSION_SECONDS * 1000);
  const renewable = new Date(expiresAt.getTime() - RENEW_AFTER_MS);
  if (s.expiresAt.getTime() > renewable.getTime()) return false;
  const deviceEnds = new Date(now.getTime() + DEVICE_LIFE_MS);
  const deviceRenewable = new Date(deviceEnds.getTime() - RENEW_AFTER_MS);
  return db.transaction(async (tx) => {
    const thisSession = tx.select({ one: sql`1` }).from(parentAuthSession)
      .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId))
      .where(and(eq(parentAuthSession.id, s.id), eq(parentAuthSession.deviceId, parentDevice.id), eq(parentAuthUser.parentId, parentDevice.parentId),
        gt(parentAuthSession.expiresAt, now), lte(parentAuthSession.expiresAt, renewable)));
    await tx.update(parentDevice).set({ lastUsedAt: now, expiresAt: deviceEnds })
      .where(and(exists(thisSession), gt(parentDevice.expiresAt, now), lte(parentDevice.expiresAt, deviceRenewable)));
    const rows = await tx.update(parentAuthSession).set({ expiresAt, updatedAt: now })
      .where(and(eq(parentAuthSession.id, s.id), gt(parentAuthSession.expiresAt, now), lte(parentAuthSession.expiresAt, renewable)))
      .returning({ id: parentAuthSession.id });
    return rows.length > 0;
  });
}

/**
 * The person's address and block as they stand, read under a lock that a change to either has to wait for. Every
 * change of address (a parent's confirmed change, email-change.ts) updates `parent.email`, a unique column, and
 * Postgres takes FOR UPDATE on the row for that; blocking takes FOR UPDATE itself. FOR KEY SHARE conflicts with FOR
 * UPDATE and nothing else: this read waits for a change that is under way and then sees its result, and a change that
 * starts later waits for the caller's transaction. It does not conflict with FOR NO KEY UPDATE, so a change that
 * leaves the person's address alone does not hold a code request up.
 *
 * Lock order, the same everywhere: the address locks first (lockEmail(), in the order of the addresses), then the
 * person's row (`parent`), then what hangs on the person, in this order: their email change requests, their sign-in
 * codes, their set-up and reset links (`parent_signin_token`), their password (the `credential` row of
 * `parent_auth_account`), their remembered devices (`parent_device`), their sessions. Links are made since the sign-in
 * release's slice SI-2 (mintSigninLink(), signin-links.ts); devices since SI-3b (recordStrongSignin(), devices.ts), and
 * each session names the device it was made on since SI-5b (`parent_auth_session.device_id`). Everything that ends all of a
 * person's sign-in deletes their unused links, a held one on its way included (unspentLink, ./link-state.ts) and forgets their devices, in that
 * place, and keeps their password: blocking, sign-ins switched off, the change-of-company clear, a confirmed change of
 * sign-in email, and closing a person's last open membership (closeMembership(), membership.ts; the lead's choice 10 of
 * the sign-in release). A password reset ends their sign-in too, in the same place, but sets the new password: it spends
 * its own link and deletes their other unspent reset links, a held one included. So:
 * - choosePasswordFromLink() (password-set.ts) takes the row FOR UPDATE, then, as its re-check, its link's row FOR
 *   UPDATE, and only then, for a reset, deletes the unused codes and those spent within a code's life (so the code
 *   door's last check refuses a sign-in whose code was spent before the reset: signinStands(), below), then their
 *   other unspent reset links; then it spends the link, replaces or inserts the password, and for a reset forgets the devices and ends the sessions. That one link ahead of the codes is the one
 *   step out of the order above, and is safe because nothing else takes both without the person's row first: every
 *   writer of a person's links holds that row, and the code check of signin-codes.ts touches no link. A new writer of
 *   both that does not take the person's row first must take the link before the codes too. mintSigninLink() takes the row FOR UPDATE, then replaces the unspent links
 *   of its purpose, a held one included;
 * - confirmMyEmailChange() (email-change.ts) takes both address locks and the row FOR UPDATE, spends its request,
 *   reads (since slice SI-5a) under the row that the person isn't blocked and its own session still exists (stopping
 *   with the address unchanged otherwise), and changes the address, then deletes the person's other requests, then
 *   their unused codes, then their unused links, then their devices, then their sessions; it takes no roster lock and
 *   touches no app records or roster cache (since stage 3's slice 11d);
 * - requestMyEmailChange() takes the row FOR UPDATE, then (since slice SI-5a) reads the asking session's `strong_at`
 *   unlocked, refusing unless it proved itself within the window, then replaces the person's unused request;
 * - blockPerson() (people.ts) takes the row FOR UPDATE, then deletes the unused requests, then the codes, then the
 *   unused links, then the devices, then the sessions; renamePerson() (people.ts) takes the row FOR UPDATE, then the
 *   roster lock shared (at most three seconds, as the guardian writes below), and touches nothing that hangs on it;
 * - the staff writes of guardians.ts take the parents' settings lock shared first (setSignins() and setWelcome() take
 *   it before the people they touch), then the person's locks, and only then the roster lock shared, as renamePerson()
 *   and each other guardian write take the roster after the person's locks: a write that held the roster lock while it
 *   waited for a person another of them holds, as that one asked for the roster, would be a deadlock, which Postgres
 *   ends by aborting one of them. (The email confirm took the roster after the person too until stage 3's slice 11d;
 *   it takes no roster lock now.) No roster read waits for a person's row, so waiting for the roster while holding one
 *   is safe against it; the change-of-company clear, which holds the roster as it takes everyone's rows, could meet
 *   these writes, though nothing the portal runs reaches it until stage 4. So addGuardian() takes the address lock, then the row FOR UPDATE, then the
 *   roster lock, then makes the person if there is none, then takes their guardian row in the family FOR UPDATE;
 *   removeGuardian() and reinstateGuardian() take the row FOR UPDATE (no address lock: the address isn't changed or
 *   claimed), then the roster lock, then the guardian row FOR UPDATE, and removeGuardian() then deletes the person's
 *   unused requests, then, when it closes their last open row, their unused codes, links and devices, then ends
 *   sessions, through closeMembership() (membership.ts). Since stage 3's slice 9h each also queues its guardian's
 *   Parent customer change in that transaction, after the roster lock, and sends nothing in it: every send is after the
 *   commit, holding only the guardian row's "being sent" advisory lock, taken before the transaction and only ever
 *   tried, never waited for. Each waits for the
 *   roster lock at most three seconds, as renamePerson() does, and gives up changing nothing: a roster read holds it
 *   through its whole QuickBooks read, and the person's row must not be held that long, since a code request waits for
 *   it (FOR KEY SHARE, below);
 * - saveDetails() (contact-edits.ts, a parent's save of their phone and mailing address, stage 3's slice 11b) takes the
 *   person's row (or, in books with no parent type, the family's) by its one conditional update, then, through
 *   queueContactChange() (contact-queue.ts), the record's open contact items FOR UPDATE SKIP LOCKED (never waited for),
 *   then closes those it may and inserts its own items (a key share on each membership's family row, by the foreign
 *   key); it takes no roster lock and no "being sent" lock, and waits for none;
 * - setSignins(false) (switches.ts) takes FOR UPDATE, in id order, the row of every person it will touch (an owed
 *   welcome, an unused code, an unused link, a device, a session), then clears the owed welcomes, then deletes the
 *   unused codes, then the unused links, then the devices, then the sessions; setWelcome() takes the rows whose welcome it changes the same way before it changes them;
 * - the daily clean-up (cleanUp(), src/lib/jobs/cleanup.ts) takes FOR UPDATE, in id order, the row of every person
 *   with an expired request, a spent or expired code, a used or expired link, an expired device or an expired session,
 *   then deletes those requests, then the codes, then the links and devices, then the sessions;
 * - clearParentAccess() (company-change.ts), on a change of company, takes FOR UPDATE, in id order, every person's
 *   row, then the open guardian rows, then deletes every request, then the unused codes, then the unused links, then
 *   the devices, then the sessions;
 * - a code request calls this before it touches a code, and a sign-in's last check (signinStands(), signin-codes.ts,
 *   run by the one finish of every sign-in, src/lib/auth/parent-signin-finish.ts) calls it and then reads, unlocked,
 *   what the sign-in spent: the code, or a set-up link's row and the `credential` row the set wrote;
 * - "Set up or reset my password" (askForPasswordLink(), password-request.ts) takes the row FOR UPDATE, reads the
 *   password unlocked, then holds the link (holdSigninLink()); after the send it takes the row FOR UPDATE again and
 *   puts the link in place (putHeldLinkInPlace(), which replaces the unused one), or removes it (dropHeldLink());
 * - the welcome and Resend (welcome.ts, since slice SI-4) take the row FOR UPDATE, read the password unlocked, then
 *   hold the link, as the request page does, and put it in place or remove it after the send the same way
 *   (deliverHeldLink(), link-delivery.ts); the Admin's press (oweSetupMails(), switches.ts) takes the parents'
 *   settings lock, then the rows it marks, in id order, as setWelcome() does;
 * - the second step's code (sendSecondStepCode(), signin-codes.ts, since slice SI-3b) calls this, then reads the
 *   password unlocked, before it touches a code; and a sign-in's strong step (recordStrongSignin(), devices.ts), after
 *   completeParentSignin(), calls this, then makes or renews the person's device, then updates the session row (stamping
 *   `strong_at` for every sign-in that proved a second step, on a new device or a renewed one): the person's row, their
 *   devices, their sessions;
 * - asking again (askAgainCode(), asking-again.ts, since slice SI-5a), once the door's own checks have taken the code,
 *   calls this, then stamps `strong_at` on the session that asked and no other: the person's row, their sessions;
 * - a password change in sign-in settings (changeMyPassword(), signin-settings.ts, since SI-5a) takes the row FOR
 *   UPDATE, reads the session's `strong_at` and the `credential` row unlocked under it (every writer of a password
 *   holds the person's row), then deletes the unused email change requests, then, as a reset does, the unused codes and
 *   those spent within a code's life, then the unspent links, then replaces the password, then forgets the devices,
 *   then ends every session, this one included;
 * - "Sign out everywhere" (signOutEverywhere(), signin-settings.ts, since SI-5a, `parent.sessions.end_all`) takes the
 *   row FOR UPDATE, then deletes the unused email change requests, then the unused codes and those spent within a
 *   code's life, then forgets the devices, then ends every session; it keeps the password and the links;
 * - a session's renewal (renewParentSession(), above, since SI-5b), at most once a day, takes no person's row: it
 *   updates the device the session names (the device's row), then the session's row, in one transaction, so it waits
 *   behind a block, a reset or any other writer that has taken the device or the session first, and finds them gone;
 * - forgetting a device in sign-in settings (forgetMyDevice() and forgetMyOtherDevices(), signin-settings.ts, since
 *   SI-5b) takes the row FOR UPDATE, reads the session's `strong_at` unlocked under it, then deletes the device, or every
 *   device but the session's own (which sets `device_id` null on the sessions that named them), and touches no session
 *   otherwise;
 * - a person's authenticator app and backup codes (`parent_authenticator`, `parent_backup_code`, since slice SI-6a,
 *   read and written only by authenticator.ts): a try at the second step (verifySecondFactor(), signin-codes.ts) calls
 *   this, then reads the password and the person's newest "Sign out everywhere" row, then takes the app's code (its
 *   `last_used_step`, sealing the secret again under the current key when it was sealed under the one before) or spends
 *   a backup code by one conditional update each; a sign-in's last check (signinStands()) reads them, and that newest
 *   row, unlocked under the person's row; the clean-up deletes them
 *   after the person's rows and links, before the devices. Nothing that ends all of a person's sign-in removes them (a
 *   block, a reset, a password change, Sign out everywhere, a change of sign-in email, sign-ins switched off, a change
 *   of company, a last membership closed: each keeps them as it keeps the password). The one writer that takes them
 *   beside those, the staff reset (resetSignin(), signin-reset.ts, since SI-9a, below), takes them after the person's
 *   row and their password, and before their devices;
 * - the authenticator app's presses in sign-in settings (authenticator-settings.ts, since slice SI-6b) each take the
 *   person's row FOR UPDATE and read the session's `strong_at` under it (with when the person's app came into force,
 *   since a proof older than it doesn't count: sessionStrongAt(), asking-again.ts; so do the password change, the email
 *   request and the forgets above, reading the app row unlocked under the person's row, as every writer of it holds it);
 *   setting it up and turning it off, which read the club's level, take the parents' settings lock shared before the
 *   person's row (as the staff writes of guardians.ts do, below), so a change of level never falls between their read
 *   and their write; then: setting it up deletes the person's
 *   unfinished set-up and inserts the new one (their app row); confirming it reads and then updates the unfinished app
 *   row, then deletes their unused emailed codes, then deletes their backup codes and inserts ten new ones; new backup
 *   codes delete and insert the backup codes alone; turning it off deletes the app row, then the backup codes. None of
 *   them touches a device or a session. A try at the second step (verifySecondFactor(), above) holds the person's row
 *   FOR KEY SHARE, which a press's FOR UPDATE waits for and is waited for by, before it reads the app or a code, so a
 *   try sees an app as it was before a press or after it, never midway;
 * - a person's passkeys (`parent_auth_passkey`, since slice SI-7a, read and written by the portal only in passkeys.ts;
 *   the passkey library writes a passkey's counter itself, outside any portal transaction, as it verifies): a passkey's
 *   check at the door (checkPasskeySignin(), passkey-signin.ts) calls this, then sets the passkey's `last_used_at` by
 *   one conditional update (still the person's) and reads their newest "Sign out everywhere" row; a sign-in's last
 *   check (signinStands()) reads the passkey unlocked under the person's row. Nothing that ends all of a person's
 *   sign-in removes them, as for the app (a block, a reset, a password change, Sign out everywhere, a change of sign-in
 *   email, sign-ins switched off, a change of company, a last membership closed, turning the app off). The staff reset
 *   (resetSignin(), since SI-9a, below) takes them after the person's row, after the app and backup codes, before
 *   their devices;
 * - a person's passkeys in sign-in settings (passkey-settings.ts, since slice SI-7b): adding one is the passkey
 *   library's insert of the row first, as it verifies, outside any transaction of the portal's and before the
 *   person's row is taken; then one transaction that takes the person's row FOR UPDATE (not this function's KEY SHARE:
 *   the add's record and a remove each decide by the person's passkeys, their first or their last, so two of them go
 *   one at a time, as SI-6b's presses do), reads the new row (still theirs) and names it, counts their passkeys and
 *   those added before it, reads their app, and for a first passkey with no app deletes their backup codes and inserts
 *   ten new ones (a failure there deletes the row the library inserted, in a transaction of its own that takes the
 *   person's row FOR UPDATE first); renaming one calls this, then reads and updates the passkey; removing one takes the
 *   parents' settings lock shared (the club's level is read), then the person's row FOR UPDATE, reads the session's
 *   `strong_at` under it, reads the passkey, their app and their passkeys' count, then deletes the passkey and, with
 *   its last one and no app, their backup codes.
 *   Asking again with a passkey (provePasskeyAgain(), asking-again.ts) calls this, sets the passkey's `last_used_at`,
 *   then updates the session's `strong_at`. Turning the app off beside a passkey (authenticator-settings.ts) reads
 *   whether they have a passkey under the person's row and keeps their backup codes. None of them touches a device, and
 *   only asking again touches a session;
 * - an Admin's reset of a person's sign-in (resetSignin(), signin-reset.ts, since the sign-in release's slice SI-9a,
 *   `parent.signin.reset`) takes the parents' settings lock shared (the door is read), then the person's row FOR UPDATE,
 *   reads their sign-in account, rows that count, app, backup codes and passkeys under it, then deletes their unused
 *   email change requests, then their unused codes and those spent within a code's life (as a password reset does),
 *   then their unspent links, a held one included, then makes a new set-up link (mintSigninLink(), the row again FOR
 *   UPDATE, a lock it holds already), then deletes their password, then their app (an unfinished set-up included) and
 *   every backup code, then their passkeys, then forgets their devices, then ends their sessions. It is the one writer
 *   that removes everything a person signs in with; its mail goes after the commit;
 * - Strict's enrolment (enrolment.ts, since the sign-in release's slice SI-10a): the one finish writes a new session's
 *   `enrol_until` just after making it, before its last check takes the person's row (the session is the finish's
 *   alone then, with no cookie yet); the gate ends one session that is no longer enrolling, or under Strict one of a
 *   person with no factor, by its row alone, taking no person's row; and the transaction that puts the person's first
 *   factor in force (a passkey's add, passkey-settings.ts, or the app's confirm, authenticator-settings.ts), which holds
 *   the person's row FOR UPDATE, then clears `enrol_until` and sets `strong_at` on that one session's row
 *   (completeEnrolment()): the person's row, then the session's;
 * - "Not now" on the passkey offer on Home (declinePasskeyOffer(), passkey-offer.ts, since the sign-in release's slice
 *   SI-8), in a transaction of its own, takes the person's row FOR UPDATE and no other lock, reads the session, its
 *   device and the person's count under it, then updates the device the session names (`passkey_offered_at`), then the
 *   person's row (`passkey_offer_declines`). It touches no session, and every writer that deletes devices finds the
 *   person's row held or waits for it.
 */
export async function lockedPerson(tx: Tx, parentId: string): Promise<{ email: string; blocked: boolean } | null> {
  const [p] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, parentId)).for("key share");
  return p ?? null;
}

/**
 * Serializes changes that claim an email address, so two changes to the same address can't give it to two people. A
 * change that takes more than one takes them in the order of the addresses, before the person's row.
 */
export const lockEmail = (tx: Tx, email: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.parent_email:${email}`}))`);

/** Ends every session the person has, at once (spec §1 The session). Sessions are read from the database on each request. */
export async function endParentSessions(parentId: string, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

/**
 * Ends the person's sessions that chose one family (spec §2 Closing a link), by the app's own family record the session
 * stores (`parent_auth_session.family_id`). Sessions in their other families, and one still choosing, carry on.
 */
export async function endFamilySessions(parentId: string, familyId: AppFamilyId, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE family_id = ${String(familyId)} AND user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

/** An open guardian row whose family the person may enter: it names an app family record, and that record is active. */
export type EnterableRow = GuardianRow & { familyId: AppFamilyId };

/**
 * Whether the family record `familyId` (a column or value of the outer query) has an active student record, the
 * condition the Admin's "Families with no active student" setting adds (`requireActiveStudents`; open question 15 of
 * the app-owned families spec: read from the app's own students, never from QuickBooks). A condition for a `where`:
 * there drizzle names every column with its table, so the outer family is never read as the student's own id.
 */
export const hasActiveStudent = (familyId: typeof family.id): SQL =>
  exists(db.select({ id: student.id }).from(student).where(and(eq(student.familyId, familyId), eq(student.active, true))));

/**
 * Whether "Families with no active student" is in force: stored on, and the stored membership shape names a student
 * type (shapeNamesStudents()). With no student type the app holds no active student, so the rule would keep every
 * parent out: it is in force only while the shape names students, as it was before stage 3's slice 7a, and a value
 * stored on beside a shape without students is not used until a shape with students is saved. This is the one place
 * that decides it: the gate, the code request and check, the chooser, the welcome, the switches' counts, the staff
 * words and the reminders all go through it, through studentsRuleInForce(), which reads both as stored.
 */
export const studentsRuleApplies = (requireActiveStudents: boolean, shape: MembershipShape | null): boolean =>
  requireActiveStudents && shapeNamesStudents(shape);

/** studentsRuleApplies() for the stored setting and shape, read in `tx` when given. */
export async function studentsRuleInForce(tx?: Tx): Promise<boolean> {
  const [{ requireActiveStudents }, shape] = await Promise.all([getParentSettings(tx), getShape(tx)]);
  return studentsRuleApplies(requireActiveStudents, shape);
}

/**
 * The one definition of a guardian row that counts (app-owned families spec §6: a guardian signs in while they are an
 * active guardian of an active family in the app): an open row (`status` not `disabled`) whose `family_id` names a
 * family record that is active, and, while the students rule is in force (studentsRuleInForce()), a family with at
 * least one active `student` record. Nothing here reads QuickBooks, and nothing closes a row for any of it: a row of a
 * family that stops counting stays open and counts again when the family does. A row that doesn't count is not a
 * family the person can enter: the chooser doesn't offer it (chooseFamily() refuses it), a session that chose it is
 * sent back to choose, and a person with no row that counts is refused as one with no open row
 * (src/lib/auth/resolve.ts): sent no code and refused at the code check (signin-codes.ts, `no_enabled_guardian`) and
 * at the sign-in's end (completeParentSignin()), and sent no welcome (welcome.ts, through hasRowThatCounts(), the same
 * rule as SQL). A session already open when the rule comes into force, or when a family loses its last active student
 * or goes inactive, is caught on its next request. In the chooser's order, by `family_qbo_id`, then the rows that name
 * no customer (made while their family had no link, stage 3's slice 9d), then by row id, so no linked family's place in
 * the chooser (and its "(1)", "(2)" in myFamilyNames()) moves. Closing a membership
 * ends the sessions that chose the row's family record (endFamilySessions()), and every session once no open row is
 * left (membership.ts).
 */
export async function enterableGuardianRows(parentId: string, tx?: Tx): Promise<EnterableRow[]> {
  const studentsRule = await studentsRuleInForce(tx);
  const rows = await (tx ?? db).select({ g: guardian, familyId: family.id }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"), eq(family.active, true),
      studentsRule ? hasActiveStudent(family.id) : undefined)).orderBy(sql`${guardian.familyQboId} asc nulls last`, guardian.id);
  return rows.map((r) => ({ ...r.g, familyId: r.familyId }));
}

/**
 * enterableGuardianRows()'s rule as a condition on a query of `parent`: the person has at least one row that counts.
 * The welcome's batch and claim and the switches' marking read it, so a person is welcomed exactly when they could
 * sign in. The caller passes studentsRuleInForce(), read in the transaction it reads the rows in.
 */
export function hasRowThatCounts(studentsRule: boolean): SQL {
  return exists(db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, parent.id), guardianRowCounts(studentsRule))));
}

/**
 * enterableGuardianRows()'s rule as a condition on a query of `guardian`: this row counts. Mail sent to a family's
 * guardians that asks them to sign in (the due-date, form and volunteer reminders) goes only to rows that count, so
 * nobody is asked to sign in where the gate would refuse them. The caller passes studentsRuleInForce().
 */
export function guardianRowCounts(studentsRule: boolean): SQL {
  return and(ne(guardian.status, "disabled"), exists(db.select({ id: family.id }).from(family)
    .where(and(eq(family.id, guardian.familyId), eq(family.active, true), studentsRule ? hasActiveStudent(family.id) : undefined))))!;
}

/**
 * The person's sign-in codes not yet used, and how many there were. With `spentSince`, the codes spent since then go
 * too: a password reset passes the start of a code's life back from now, so a sign-in whose code was spent just before
 * the reset, and whose session is made just after it, is refused by the code door's last check (signinStands(), which
 * reads the code it spent again).
 */
export async function deleteUnusedSigninCodes(parentId: string, tx: Tx, o: { spentSince?: Date } = {}): Promise<number> {
  const which = o.spentSince ? or(isNull(signinCode.usedAt), gt(signinCode.usedAt, o.spentSince)) : isNull(signinCode.usedAt);
  const rows = await tx.delete(signinCode).where(and(eq(signinCode.parentId, parentId), which)).returning({ id: signinCode.id });
  return rows.length;
}

/**
 * The person's set-up and reset links not yet spent (unused, or held while their mail goes: unspentLink, ./link-state.ts), and
 * how many there were. A used one stays until the daily clean-up.
 */
export async function deleteUnusedSigninLinks(parentId: string, tx: Tx): Promise<number> {
  const rows = await tx.delete(parentSigninToken).where(and(eq(parentSigninToken.parentId, parentId), unspentLink))
    .returning({ id: parentSigninToken.id });
  return rows.length;
}

/** Every device remembered for the person (`parent_device`), and how many there were: each asks for the second step again. */
export async function forgetDevices(parentId: string, tx: Tx): Promise<number> {
  const rows = await tx.delete(parentDevice).where(eq(parentDevice.parentId, parentId)).returning({ id: parentDevice.id });
  return rows.length;
}
