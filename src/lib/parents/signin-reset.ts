// Staff only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): an Admin's reset of one parent's sign-in
// (the sign-in release, slice SI-9a; open questions 22, 24, 26 and 33 of the app-owned families spec), what a person's
// page shows of what they sign in with, and the staff home's line for every other Admin. It reads and removes any
// person's sign-in, and reads every recent reset. Staff never see or set a password: nothing here shows, takes or
// stores one, and the reason, which is for staff only, is kept in its audit row alone.
import "server-only";
import { and, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice, parentEmailChange } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { signinResetMessage } from "@/lib/mail/messages";
import { getClubSettings } from "@/lib/settings/club";
import { hasAuthenticator, removeAuthenticator, unspentBackupCodes } from "./authenticator";
import { lifeWords, passwordLink } from "./link-delivery";
import { passkeyCount, removeAllPasskeys } from "./passkeys";
import type { StaffOp } from "./people";
import { takeRateLimit } from "./rate-limit";
import { deleteUnusedSigninCodes, deleteUnusedSigninLinks, endParentSessions, enterableGuardianRows, forgetDevices } from "./sessions";
import { PARENTS_KEY, getParentSettings, parentDoorClosed } from "./settings";
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

type Done = { to: string; token: string };

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
 *     lock. One that couldn't be handed over leaves the reset standing (what was asked is done: every session ended and
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
    if (parentDoorClosed(await getParentSettings(tx))) { await refused("signins_off", p.id, tx); return "signins_off"; }
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
    return { to: p.email, token };
  });
  if (typeof done === "string") return { ok: false, reason: done };

  // The mail, after the commit: at once, never queued (Appendix A: "without waiting").
  const sent = await (async () => {
    const [brand, club] = await Promise.all([currentBrand(), getClubSettings()]);
    const message = signinResetMessage(brand, done.to, { link: passwordLink("setup", done.token), life: lifeWords(LINK_LIFE_MS.setup), contact: club.treasurerEmail });
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
