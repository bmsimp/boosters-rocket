// Staff only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): an Admin's reset of one parent's sign-in
// (the sign-in release, slice SI-9a; open questions 22, 24, 26 and 33 of the app-owned families spec), what a person's
// page shows of what they sign in with, the staff home's line for every other Admin, and, since slice SI-9b, an
// Admin's removal in one press of every parent's passkeys made at an earlier address of the portal, with its count. It
// reads and removes any person's sign-in, reads every recent reset, and reads every passkey of the club. Staff never
// see or set a password: nothing here shows, takes or stores one, and the reason, which is for staff only, is kept in
// its audit row alone.
import "server-only";
import { and, count, desc, eq, exists, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthenticator, parentAuthPasskey, parentAuthSession, parentAuthUser, parentDevice, parentEmailChange } from "@/lib/db/schema";
import { passkeyOrigin } from "@/lib/auth/passkey-origin";
import { writeAudit } from "@/lib/audit/log";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { signinResetMessage } from "@/lib/mail/messages";
import { getClubSettings } from "@/lib/settings/club";
import { hasAuthenticator, removeAuthenticator, removeBackupCodes, unspentBackupCodes } from "./authenticator";
import { lifeWords, passwordLink } from "./link-delivery";
import { madeElsewhere, passkeyCount, removeAllPasskeys, removeOldAddressPasskeysOf } from "./passkeys";
import type { StaffOp } from "./people";
import { takeRateLimit } from "./rate-limit";
import { deleteUnusedSigninCodes, deleteUnusedSigninLinks, endParentSessions, enterableGuardianRows, forgetDevices } from "./sessions";
import { PARENTS_KEY, getParentSettings, parentDoorClosed, readStoredSettings } from "./settings";
import { CODE_TTL_MS } from "./signin-codes";
import { LINK_LIFE_MS, mintSigninLink } from "./signin-links";

/** The permission a reset needs, Admin-only (src/lib/permissions/registry.ts). */
export const RESET_PERMISSION = "Parents.SignInReset.ReadWrite" as const;
/** The most a reset's reason may hold, as blockPerson()'s (people.ts). */
export const MOST_RESET_REASON = 500;

/**
 * Why a reset was refused: what was sent isn't a reset (`invalid`: no reason, one over MOST_RESET_REASON, or the
 * call-back box not ticked), the person's sign-in was reset too often today (`rate_limited`), they aren't there
 * (`not_found`), they are blocked (`blocked`: blocking already ended every session, and their link would be refused;
 * unblock first), they can't sign in (`no_access`: no sign-in account, or no guardian row that counts), or parent
 * sign-ins are switched off (`signins_off`). Each changes nothing and mails nothing.
 */
export type ResetRefusal = "invalid" | "rate_limited" | "not_found" | "blocked" | "no_access" | "signins_off";
/**
 * A reset done: the address its mail went to (the one read under the person's lock), and whether the mail was handed
 * over. A mail that wasn't leaves the reset standing.
 */
export type ResetResult = { ok: true; to: string; mailed: boolean } | { ok: false; reason: ResetRefusal };

/** The parents' settings lock, shared: the club's level and the door are read under it (as guardians.ts and SI-6b's and SI-7b's presses take it). */
const holdParentSettings = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${PARENTS_KEY}))`);

/** Why a mail couldn't be handed over when the message itself couldn't be written (the club's name not read, say): a fixed sentence, as a send failure's is. */
const NOT_WRITTEN = "The email couldn't be written.";

type Done = { to: string; token: string; strict: boolean };

/**
 * An Admin's reset of one person's sign-in (open question 22). In this order:
 * (a) the arguments: the reason trimmed, 1 to MOST_RESET_REASON characters, and `calledBack` exactly true (the Admin
 *     called the person back on a number the club already holds, and they asked for it); anything else is `invalid`,
 *     with nothing counted or written;
 * (b) the limit per person reset (`signin_reset_person`, keyed by their id), taken before any row is read: a full
 *     window's first refusal is audited once (`parent.signin.reset_refused`, `rate_limited`), a later one writes nothing;
 * (c) one transaction in the order above lockedPerson() (sessions.ts): the parents' settings lock shared, then the
 *     person's row FOR UPDATE; then, read under it, a refusal that changes nothing (`not_found`, naming nobody;
 *     `blocked`; `no_access` for no sign-in account or no guardian row that counts, enterableGuardianRows(); and
 *     `signins_off` while the parent door is closed, parentDoorClosed()), each audited `parent.signin.reset_refused`;
 *     otherwise, each in its place and counted: their unused email change requests (as a block deletes them); their
 *     sign-in codes, unused and those spent within a code's life, so a sign-in whose code was spent before the reset
 *     and whose session is made after it is refused at its last check (signinStands(), `code_gone`, behind
 *     `password_changed`); their unspent set-up and reset links, a held one on its way included; then a new set-up link
 *     (mintSigninLink(), which audits `parent.password.link_made` itself; its token is kept in memory for the mail
 *     alone); their password (the `credential` row of their sign-in account); their authenticator app, an unfinished
 *     set-up included, and every backup code (removeAuthenticator(), which takes the codes whatever stood beside them,
 *     a passkey alone included); their passkeys (removeAllPasskeys()); their remembered devices; their sessions; and one
 *     `parent.signin.reset` row with what they had and what went, counts only, and the reason;
 * (d) after the commit, never inside it, the mail with the link (signinResetMessage()) to the address read under the
 *     lock, in the words of the level read under it (at Strict, that the password leads first to adding a passkey or
 *     an authenticator app: slice SI-10b). One that couldn't be handed over leaves the reset standing (what was asked is done: every session ended and
 *     every credential gone) and the link as it is (its token is in no mail, and gone with this call: it expires and
 *     the next link replaces it), and writes `parent.signin.reset_unmailed` with the send's fixed sentence.
 * Everything else of the person stays: their name, their guardian rows and every family's records, their forms, their
 * welcome marks, their phone and mailing address, their block state. A sign-in that proved itself before the reset and
 * makes its session after it is refused at its last check by what the reset removed (signinStands(): `password_changed`
 * for every proof that carries the password, which the reset deleted; `passkey_gone` for a passkey alone).
 */
export async function resetSignin(sentId: string, raw: { reason: string; calledBack: boolean }, o: StaffOp): Promise<ResetResult> {
  // One spelling of the id for the limit and every audit row: Postgres reads a uuid in any letter case as the same one,
  // so a count keyed by the id as sent would give each spelling a window of its own.
  const parentId = sentId.toLowerCase();
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason || reason.length > MOST_RESET_REASON || raw.calledBack !== true) return { ok: false, reason: "invalid" };
  const permission = o.permission ?? RESET_PERMISSION;
  const refused = (why: Exclude<ResetRefusal, "invalid">, targetId: string | null, tx?: Tx) =>
    writeAudit({ actor: o.actor, action: "parent.signin.reset_refused", permission, ...(targetId ? { targetType: "parent", targetId } : {}), after: { reason: why }, ip: o.ip }, tx);

  const take = await takeRateLimit("signin_reset_person", parentId);
  if (take !== "taken") {
    if (take === "first_refusal") await refused("rate_limited", parentId);
    return { ok: false, reason: "rate_limited" };
  }

  const done = await db.transaction(async (tx): Promise<Done | Exclude<ResetRefusal, "invalid" | "rate_limited">> => {
    await holdParentSettings(tx);
    const [p] = await tx.select({ id: parent.id, email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) { await refused("not_found", null, tx); return "not_found"; }
    if (p.blocked) { await refused("blocked", p.id, tx); return "blocked"; }
    const [user] = await tx.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, p.id));
    if (!user || (await enterableGuardianRows(p.id, tx)).length === 0) { await refused("no_access", p.id, tx); return "no_access"; }
    const settings = await getParentSettings(tx);
    if (parentDoorClosed(settings)) { await refused("signins_off", p.id, tx); return "signins_off"; }
    const now = new Date(); // read once the person's row is held

    // What they had, read under the person's row (every writer of these holds it), before anything goes.
    const app = await hasAuthenticator(p.id, tx);
    const backupCodes = await unspentBackupCodes(p.id, tx);
    const passkeys = await passkeyCount(p.id, tx);
    // Devices and sessions as the section counts them (signinHeld()): those still live, not the expired ones the daily
    // clean-up has yet to delete, which go below all the same.
    const [devices] = await tx.select({ n: count() }).from(parentDevice).where(and(eq(parentDevice.parentId, p.id), gt(parentDevice.expiresAt, now)));
    const [sessions] = await tx.select({ n: count() }).from(parentAuthSession).where(and(eq(parentAuthSession.userId, user.id), gt(parentAuthSession.expiresAt, now)));

    // What hangs on the person, in the order above lockedPerson() (sessions.ts): requests, codes, links, the password,
    // the app and backup codes and passkeys, devices, sessions.
    const requestsDeleted = (await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)))
      .returning({ id: parentEmailChange.id })).length;
    const codesDeleted = await deleteUnusedSigninCodes(p.id, tx, { spentSince: new Date(now.getTime() - CODE_TTL_MS) });
    const linksDeleted = await deleteUnusedSigninLinks(p.id, tx);
    const token = await mintSigninLink(tx, { parentId: p.id, purpose: "setup", actor: o.actor, ip: o.ip, now });
    const passwordRemoved = (await tx.delete(parentAuthAccount).where(and(eq(parentAuthAccount.userId, user.id), eq(parentAuthAccount.providerId, "credential")))
      .returning({ id: parentAuthAccount.id })).length > 0;
    const removed = await removeAuthenticator(tx, p.id);
    const passkeysRemoved = await removeAllPasskeys(tx, p.id);
    const devicesForgotten = await forgetDevices(p.id, tx);
    const sessionsEnded = await endParentSessions(p.id, tx);

    await writeAudit({ actor: o.actor, action: "parent.signin.reset", permission, targetType: "parent", targetId: p.id,
      before: { password: passwordRemoved, passkeys, app, backupCodes, devices: Number(devices?.n ?? 0), sessions: Number(sessions?.n ?? 0) },
      after: { reason, calledBack: true, passwordRemoved, passkeysRemoved, appsRemoved: removed.apps, backupCodesRemoved: removed.backupCodes,
        devicesForgotten, sessionsEnded, codesDeleted, linksDeleted, requestsDeleted }, ip: o.ip }, tx);
    return { to: p.email, token, strict: settings.level === "strict" };
  });
  if (typeof done === "string") return { ok: false, reason: done };

  // The mail, after the commit: at once, never queued (Appendix A: "without waiting").
  const sent = await (async () => {
    const [brand, club] = await Promise.all([currentBrand(), getClubSettings()]);
    const message = signinResetMessage(brand, done.to, { link: passwordLink("setup", done.token), life: lifeWords(LINK_LIFE_MS.setup), contact: club.treasurerEmail, strict: done.strict });
    return sendMail(message, { purpose: "signin_reset", actor: o.actor, ip: o.ip });
  })().catch(() => ({ ok: false as const, error: NOT_WRITTEN }));
  if (!sent.ok) {
    await db.transaction((tx) => writeAudit({ actor: o.actor, action: "parent.signin.reset_unmailed", permission, targetType: "parent", targetId: parentId,
      after: { error: sent.error }, ip: o.ip }, tx)).catch(() => undefined);
  }
  return { ok: true, to: done.to, mailed: sent.ok };
}

/**
 * What a person signs in with now, counts only, for the reset section of their page: whether they have chosen a
 * password, how many passkeys, whether an authenticator app is in force, how many unspent backup codes, how many
 * remembered devices and live sessions. Never a passkey's name (the parent's own words), a device or an address.
 */
export type SigninHeld = { password: boolean; passkeys: number; app: boolean; backupCodes: number; devices: number; sessions: number };
export async function signinHeld(parentId: string, now = new Date()): Promise<SigninHeld> {
  const users = db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId));
  const [password, passkeys, app, backupCodes, devices, sessions] = await Promise.all([
    db.select({ id: parentAuthAccount.id }).from(parentAuthAccount).where(and(inArray(parentAuthAccount.userId, users), eq(parentAuthAccount.providerId, "credential"))).limit(1),
    passkeyCount(parentId),
    hasAuthenticator(parentId),
    unspentBackupCodes(parentId),
    db.select({ n: count() }).from(parentDevice).where(and(eq(parentDevice.parentId, parentId), gt(parentDevice.expiresAt, now))),
    db.select({ n: count() }).from(parentAuthSession).where(and(inArray(parentAuthSession.userId, users), gt(parentAuthSession.expiresAt, now))),
  ]);
  return { password: password.length > 0, passkeys, app, backupCodes, devices: Number(devices[0]?.n ?? 0), sessions: Number(sessions[0]?.n ?? 0) };
}

/** How long the staff home shows a reset to every other Admin (open question 22: "for 7 days"). */
export const RESET_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A reset as the staff home's line names it: who reset (the audit row's actor label, as it was at the time), whose
 * sign-in (the person's id, and their name now, or null when they are no longer in the portal), and when. Never the
 * reason: it stays in the audit log, which the line links to.
 */
export type RecentReset = { auditId: number; by: string | null; parentId: string; name: string | null; at: Date };
/** The most resets the staff home's line names; `more` says there were others this week, which the audit log holds. */
export const RESETS_SHOWN = 50;

/**
 * The `parent.signin.reset` rows of the last RESET_SHOWN_MS, newest first, but those the viewer wrote (open question
 * 22: "for every other Admin"), read from the audit log, so nothing new is stored for them. At most RESETS_SHOWN, and
 * `more` when there were others (after a change of the portal's address, Admins may reset many parents one by one):
 * the line says so and links to the audit log, so it never reads as the whole week when it isn't.
 */
export async function recentSigninResets(viewerStaffId: string, now = new Date()): Promise<{ resets: RecentReset[]; more: boolean }> {
  const rows = await db.select({ auditId: auditLog.id, by: auditLog.actorLabel, parentId: auditLog.targetId, name: parent.name, at: auditLog.at })
    .from(auditLog).leftJoin(parent, sql`${parent.id}::text = ${auditLog.targetId}`)
    .where(and(eq(auditLog.action, "parent.signin.reset"), gt(auditLog.at, new Date(now.getTime() - RESET_SHOWN_MS)),
      or(isNull(auditLog.actorId), ne(auditLog.actorId, viewerStaffId))))
    .orderBy(desc(auditLog.at), desc(auditLog.id)).limit(RESETS_SHOWN + 1);
  const resets = rows.slice(0, RESETS_SHOWN).flatMap((r) => (r.parentId ? [{ auditId: r.auditId, by: r.by, parentId: r.parentId, name: r.name, at: r.at }] : []));
  return { resets, more: rows.length > RESETS_SHOWN };
}

/*
 * Passkeys from an earlier address (the sign-in release, slice SI-9b; section 6 of the app-owned families spec,
 * "Passkeys anywhere": "A passkey belongs to the portal's address: if a club changes it, parents fall back to password
 * and second step and add their passkeys again"). A passkey works only at the origin it was made for (the relying
 * party, parentPasskeys(), src/lib/auth/parent-auth.ts), yet the portal counts every row as a second factor. After a
 * change of APP_URL an Admin removes, in one press, every passkey whose recorded origin is not the portal's now
 * (madeElsewhere(), passkeys.ts: a null origin, a row the portal never recorded, counts as one). Until they press,
 * nothing at the door, the gate, asking again or the offer reads the origin.
 */

type Reader = Pick<typeof db, "select">;

/** A count of passkeys from an earlier address, by the origin they were made at (null: one the portal didn't record). */
export type OldOrigin = { origin: string | null; passkeys: number };
/**
 * The passkeys from an earlier address now, counts only: the portal's origin now; how many passkeys were made
 * elsewhere and how many people they belong to; those counts by the origin they were made at (each the portal's own
 * address once, which the Health page shows staff already; never a credential id or a passkey's name); and, of those
 * people, how many the press would leave with no passkey and no authenticator app in force (hasAuthenticator()'s
 * rule), not counting a blocked person, whose backup codes it keeps.
 */
export type OldAddressPasskeys = { origin: string; passkeys: number; people: number; leftWithNoFactor: number; byOrigin: OldOrigin[] };

/** Origins in a fixed order: by their text, code unit by code unit, and the unrecorded last. */
const byOriginText = (a: OldOrigin, b: OldOrigin) => (a.origin === b.origin ? 0 : a.origin === null ? 1 : b.origin === null ? -1 : a.origin < b.origin ? -1 : 1);

/** The people who hold a passkey from an earlier address, as a query of their ids. */
const holdersElsewhere = (q: Reader, origin: string) => q.select({ id: parentAuthUser.parentId }).from(parentAuthPasskey)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthPasskey.userId)).where(madeElsewhere(origin));
/** On a query of `parent`: the person holds no passkey made at `origin` and no authenticator app in force. */
const leftWithNothing = (origin: string) => sql`not ${exists(db.select({ id: parentAuthPasskey.id }).from(parentAuthPasskey)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthPasskey.userId))
  .where(and(eq(parentAuthUser.parentId, parent.id), eq(parentAuthPasskey.origin, origin))))}
  and not ${exists(db.select({ id: parentAuthenticator.id }).from(parentAuthenticator)
    .where(and(eq(parentAuthenticator.parentId, parent.id), isNotNull(parentAuthenticator.confirmedAt))))}`;

/**
 * OldAddressPasskeys now, read in `q` when given (the press reads it under its locks): one read of the passkeys by
 * origin and, when there are any, one of the people who hold them, and nothing else of the club's.
 */
export async function oldAddressPasskeys(q: Reader = db): Promise<OldAddressPasskeys> {
  const origin = passkeyOrigin();
  const groups = await q.select({ origin: parentAuthPasskey.origin, passkeys: count() }).from(parentAuthPasskey)
    .where(madeElsewhere(origin)).groupBy(parentAuthPasskey.origin);
  const byOrigin = groups.map((g) => ({ origin: g.origin, passkeys: Number(g.passkeys) })).sort(byOriginText);
  const passkeys = byOrigin.reduce((sum, g) => sum + g.passkeys, 0);
  if (passkeys === 0) return { origin, passkeys: 0, people: 0, leftWithNoFactor: 0, byOrigin: [] };
  const [row] = await q.select({ people: count(),
    left: sql<number>`count(*) filter (where ${parent.blocked} = false and ${leftWithNothing(origin)})`.mapWith(Number) })
    .from(parent).where(inArray(parent.id, holdersElsewhere(q, origin)));
  return { origin, passkeys, people: Number(row?.people ?? 0), leftWithNoFactor: row?.left ?? 0, byOrigin };
}

/** Why the press was refused: `shown` isn't a count the page draws, the count changed since, or there are none now. */
export type OldPasskeysRefusal = "invalid" | "count_changed" | "none";
/**
 * The press done: how many passkeys went, from how many people, how many of those were left with no passkey and no
 * app (their backup codes gone too), and, at Strict, how many of those had a session ended.
 */
export type OldPasskeysResult = { ok: true; passkeys: number; people: number; leftWithNoFactor: number; signedOut: number } | { ok: false; reason: OldPasskeysRefusal };

/**
 * An Admin's removal of every passkey made at an earlier address (slice SI-9b), by the reset's permission
 * (RESET_PERMISSION, Admin-only: it takes away what people sign in with). In this order:
 * (a) `shown`, the count of such passkeys the page drew, a safe whole number of 1 or more, else `invalid`, nothing read
 *     or written;
 * (b) one transaction in the order above lockedPerson() (sessions.ts): the parents' settings lock shared (the level is
 *     read under it, and the switches, which take it whole, wait or are waited for); then, in one statement ordered by
 *     id, the row FOR UPDATE of every person who holds such a passkey (the order of lockPeople(), switches.ts, and of
 *     the clean-up, the only other writers that lock more than one person: two presses, a press and a switch, or a
 *     press and any one person's own write never wait on each other in a circle); then, read under them, the count:
 *     none refuses as `none`, writing nothing; one that isn't `shown` refuses as `count_changed`, changing nothing,
 *     audited `parent.passkeys.old_address_refused`;
 * (c) otherwise, person by person in id order: their passkeys from an earlier address deleted
 *     (removeOldAddressPasskeysOf()); if they are not blocked and hold no passkey after it and no app in force, every
 *     backup code, which would stand beside nothing (as removeMyPasskey() takes them with a last passkey beside no app:
 *     open question 25), and at Strict (the level stored, as the page reads it, readStoredSettings()) every session
 *     ended (open question 21, as the switch to Strict does: the gate would end it at their next request,
 *     `strict_no_factor`, so the counts are true at the press); at Standard nobody is signed out. One
 *     `parent.passkey.remove` row each, `reason: "old_address"`. Their devices, password, app, other passkeys, codes
 *     beside an app or a remaining passkey, the offer's count and everything else stay. A blocked person's old passkeys
 *     go too (they work nowhere), with nothing else of theirs. Sign-ins off doesn't stop the press;
 * (d) one `parent.passkeys.old_address_removed` row of counts, with the portal's origin, the level and the origins.
 * No mail goes (the screens each parent reaches next say what to do) and no rate limit applies: the press is an
 * Admin's, and a second finds none. One gap is accepted: the library inserts a new passkey's row before the add records
 * its origin (passkey-settings.ts), so a press in that moment counts it as one from an earlier address and removes it;
 * the add then answers that it couldn't be added, and the parent adds it again.
 */
export async function removeOldAddressPasskeys(shown: unknown, o: StaffOp): Promise<OldPasskeysResult> {
  if (typeof shown !== "number" || !Number.isSafeInteger(shown) || shown < 1) return { ok: false, reason: "invalid" };
  const permission = o.permission ?? RESET_PERMISSION;
  return db.transaction(async (tx): Promise<OldPasskeysResult> => {
    await holdParentSettings(tx);
    const origin = passkeyOrigin();
    const people = await tx.select({ id: parent.id, blocked: parent.blocked }).from(parent)
      .where(inArray(parent.id, holdersElsewhere(tx, origin))).orderBy(parent.id).for("update");
    const found = await oldAddressPasskeys(tx);
    if (found.passkeys === 0) return { ok: false, reason: "none" };
    if (found.passkeys !== shown) {
      await writeAudit({ actor: o.actor, action: "parent.passkeys.old_address_refused", permission, targetType: "setting", targetId: PARENTS_KEY,
        after: { reason: "count_changed", shown, found: found.passkeys }, ip: o.ip }, tx);
      return { ok: false, reason: "count_changed" };
    }
    const level = (await readStoredSettings(tx)).level === "strict" ? "strict" as const : "standard" as const;
    let passkeys = 0, touched = 0, backupCodesDeleted = 0, leftWithNoFactor = 0, sessionsEnded = 0, signedOut = 0;
    for (const p of people) {
      const removed = await removeOldAddressPasskeysOf(tx, p.id, origin);
      if (removed === 0) continue;
      const left = await passkeyCount(p.id, tx);
      const nothing = !p.blocked && left === 0 && !(await hasAuthenticator(p.id, tx));
      const codes = nothing ? await removeBackupCodes(tx, p.id) : 0;
      const ended = nothing && level === "strict" ? await endParentSessions(p.id, tx) : 0;
      passkeys += removed; touched++; backupCodesDeleted += codes; sessionsEnded += ended;
      if (nothing) leftWithNoFactor++;
      if (ended > 0) signedOut++;
      await writeAudit({ actor: o.actor, action: "parent.passkey.remove", permission, targetType: "parent", targetId: p.id,
        after: { reason: "old_address", removed, passkeys: left, backupCodesDeleted: codes, sessionsEnded: ended }, ip: o.ip }, tx);
    }
    await writeAudit({ actor: o.actor, action: "parent.passkeys.old_address_removed", permission, targetType: "setting", targetId: PARENTS_KEY,
      after: { origin, level, passkeys, people: touched, backupCodesDeleted, leftWithNoFactor, sessionsEnded, byOrigin: found.byOrigin }, ip: o.ip }, tx);
    return { ok: true, passkeys, people: touched, leftWithNoFactor, signedOut };
  });
}
