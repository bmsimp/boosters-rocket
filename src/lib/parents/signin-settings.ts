// A parent's sign-in settings (/family/sign-in; the sign-in release, slice SI-5a; section 6 of the app-owned families
// spec, "Signing in", and open questions 26, 28, 34 and 36): what the page shows, changing the password, signing out
// everywhere, and the set-up link offered to a person with no password. Everything is read and changed through the
// session's own person (`ctx.parentId`, `ctx.sessionId`, `ctx.email`), never by an id from the address or a form, but
// one: since slice SI-5b the page lists the person's remembered devices, and forgetting one takes that device's row id
// from the page, checked against the person in the delete itself. Server only; parent code.
import "server-only";
import { and, desc, eq, gt, isNull, ne } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db, type Tx } from "@/lib/db/client";
import { parent, parentAuthAccount, parentDevice, parentEmailChange } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { passwordChangedMessage } from "@/lib/mail/messages";
import { checkBreach } from "./breach-check";
import { markBreachCheck } from "./breach-mark";
import { canChangeMyEmail } from "./email-change";
import { PASSWORD_COPY, askWords } from "./password-copy";
import { checkPasswordRule } from "./password-rule";
import { askForPasswordLink } from "./password-request";
import { MOST_SENT } from "./password-set";
import { takeRateLimit } from "./rate-limit";
import { deleteUnusedSigninCodes, deleteUnusedSigninLinks, endParentSessions, forgetDevices, parentActor } from "./sessions";
import { getParentSettings } from "./settings";
import { getClubSettings } from "@/lib/settings/club";
import { CODE_TTL_MS } from "./signin-codes";
import { currentPassword, sessionDeviceId, sessionProvedRecently, sessionStrongAt } from "./asking-again";
import { isDeviceId } from "./devices";
import { provedRecently } from "./reask-rule";
import { portalAddress } from "./link-delivery";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

type Me = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;
export type SettingsResult = { ok: true; message: string } | { ok: false; errors: string[] };

/**
 * One remembered device as the page lists it (slice SI-5b), and all it is given: the row's id (the value of its forget
 * button, the only id an action of the page takes), whether it is the one this session names (`device_id`), and when
 * it was first remembered and last used, as ISO strings for LocalTime. Never its token's hash, a session, a person or an
 * address: the portal keeps no name, browser or place for a device.
 */
export type MyDevice = { id: string; thisOne: boolean; createdAt: string; lastUsedAt: string };

/**
 * What the page shows, and nothing else: the address the parent signs in with, whether the change of it is offered
 * (canChangeMyEmail()), whether they have a password, whether this session proved itself within the window
 * (provedRecently(), the page's choice between asking again and the change), whether the club is at Strict, where
 * nothing can be changed here yet (the door's password step refuses every password without a second factor, so nobody
 * can be asked again until SI-6 and SI-7), and (since SI-5b) the person's remembered devices that are still unexpired,
 * newest use first, the one this session names marked. A session from before SI-5b names none, and none is marked.
 */
export type MySignin = { email: string; canChangeEmail: boolean; hasPassword: boolean; provedRecently: boolean; strict: boolean; devices: MyDevice[] };

export async function loadMySignin(ctx: ParentCtx, now = new Date()): Promise<MySignin> {
  const [canChangeEmail, password, strongAt, settings, thisDevice, devices] = await Promise.all([
    canChangeMyEmail(ctx), currentPassword(db, ctx.parentId), sessionStrongAt(db, ctx), getParentSettings(), sessionDeviceId(db, ctx),
    db.select({ id: parentDevice.id, createdAt: parentDevice.createdAt, lastUsedAt: parentDevice.lastUsedAt }).from(parentDevice)
      .where(and(eq(parentDevice.parentId, ctx.parentId), gt(parentDevice.expiresAt, now))).orderBy(desc(parentDevice.lastUsedAt), parentDevice.id),
  ]);
  return { email: ctx.email, canChangeEmail, hasPassword: password !== null, provedRecently: provedRecently(strongAt, now), strict: settings.level === "strict",
    devices: devices.map((d) => ({ id: d.id, thisOne: d.id === thisDevice, createdAt: d.createdAt.toISOString(), lastUsedAt: d.lastUsedAt.toISOString() })) };
}

const sent = (v: unknown): v is string => typeof v === "string" && v.length <= MOST_SENT;
const PROVE_AGAIN: SettingsResult = { ok: false, errors: [COPY.proveAgain] };

/** Deletes the person's unused email change requests, as a block does, in the caller's transaction: how many went. */
async function deleteUnusedEmailChanges(parentId: string, tx: Tx): Promise<number> {
  return (await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, parentId), isNull(parentEmailChange.usedAt)))
    .returning({ id: parentEmailChange.id })).length;
}

/** Why a change found under the person's lock can't go on: the window run out, blocked, no password, or another one. */
type NotChanged = "not_proved" | "strict" | "blocked" | "no_password" | "password_changed" | "gone";

/**
 * Changing the password, signed in and proved within the window (open questions 26 and 28). In this order:
 * (a) the arguments: two strings of at most MOST_SENT; anything else is a bad request, refused uncounted;
 * (b) the window, read for this session (sessionProvedRecently()); the current password is not asked again;
 * (c) the limit per person (`password_change_parent`): each try past it may ask the breach service and make a hash. It
 *     is taken after the window, so a session that can't change the password can't use up the parent's changes;
 * (d) the two passwords match and meet the rule (checkPasswordRule(), PASSWORD_COPY's words);
 * (e) the breach check (checkBreach(), with markBreachCheck()): found is refused in words, not checked is taken, its
 *     code in the audit row;
 * (f) hashPassword(), outside any transaction;
 * (g) one transaction in the order above lockedPerson() (sessions.ts): the person's row FOR UPDATE, then, read under it,
 *     the window again on this session, the club not at Strict (refused in the Strict words), the person not blocked, and their `credential` row still there and not
 *     replaced since this session proved itself (its `updated_at` no later than `strong_at`: every writer of a password
 *     holds the person's row); then their unused email change requests (as a block does, so a change of sign-in email
 *     asked in a session this ends can't outlive it), and, as a reset does (writePassword(), password-set.ts), their
 *     unused sign-in codes and those spent within a code's life, their unspent links (a held one included), the
 *     `credential` row replaced, every device forgotten and every session of theirs ended, this one included (open
 *     question 26), with one `parent.password.changed` row: the counts and the breach outcome, never the password or a hash.
 * Then, after the commit and not awaited, a short notice to the address read under the lock (passwordChangedMessage()).
 * A refusal at (b) or (g) says to reload and show it's them again; one at (d) or (e) says why.
 */
export async function changeMyPassword(ctx: Me, raw: { password: unknown; again: unknown }): Promise<SettingsResult> {
  const { password, again } = raw;
  if (!sent(password) || !sent(again)) return { ok: false, errors: [COPY.failed] };
  if (!(await sessionProvedRecently(db, ctx))) return PROVE_AGAIN;
  if ((await takeRateLimit("password_change_parent", ctx.parentId)) !== "taken") return { ok: false, errors: [COPY.tooManyChanges] };
  if (password !== again) return { ok: false, errors: [PASSWORD_COPY.mismatch] };
  const rule = checkPasswordRule(password);
  if (!rule.ok) return { ok: false, errors: [rule.problem === "too_long" ? PASSWORD_COPY.tooLong : PASSWORD_COPY.tooShort] };

  const breach = await checkBreach(password);
  await markBreachCheck(breach);
  if (breach.outcome === "found") return { ok: false, errors: [PASSWORD_COPY.breached] };
  const hash = await hashPassword(password);

  let changed: { to: string } | NotChanged;
  try {
    changed = await db.transaction(async (tx) => {
      const [me] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
      if (!me) return "gone" as const;
      const now = new Date(); // read once the person's row is held
      const strongAt = await sessionStrongAt(tx, ctx);
      if (!provedRecently(strongAt, now)) return "not_proved" as const;
      // Under Strict nothing is changed here yet (the page says so): a proof made at Standard before the club moved on
      // is no way past it.
      if ((await getParentSettings(tx)).level === "strict") return "strict" as const;
      if (me.blocked) return "blocked" as const;
      const had = await currentPassword(tx, ctx.parentId);
      if (!had) return "no_password" as const;
      if (had.credentialUpdatedAt.getTime() > strongAt!.getTime()) return "password_changed" as const;

      const emailChangesDeleted = await deleteUnusedEmailChanges(ctx.parentId, tx);
      const codesDeleted = await deleteUnusedSigninCodes(ctx.parentId, tx, { spentSince: new Date(now.getTime() - CODE_TTL_MS) });
      const linksDeleted = await deleteUnusedSigninLinks(ctx.parentId, tx);
      await tx.update(parentAuthAccount).set({ password: hash, updatedAt: now })
        .where(and(eq(parentAuthAccount.id, had.credentialId), eq(parentAuthAccount.providerId, "credential")));
      const devicesForgotten = await forgetDevices(ctx.parentId, tx);
      const sessionsEnded = await endParentSessions(ctx.parentId, tx);
      await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.password.changed", targetType: "parent", targetId: ctx.parentId,
        after: { breachChecked: breach.outcome === "not_found", ...(breach.outcome === "not_checked" ? { breachNotChecked: breach.why } : {}),
          emailChangesDeleted, codesDeleted, linksDeleted, devicesForgotten, sessionsEnded }, ip: ctx.ip }, tx);
      return { to: me.email };
    });
  } catch {
    // The hash is a parameter of the write, and a failed query's error carries its parameters: never let it reach a log.
    throw new Error("password_change_failed");
  }
  if (changed === "strict") return { ok: false, errors: [COPY.strict] };
  if (typeof changed === "string") return PROVE_AGAIN;

  const to = changed.to;
  void (async () => {
    const [brand, club] = await Promise.all([currentBrand(), getClubSettings()]);
    const message = passwordChangedMessage(brand, to, { passwordPage: `${portalAddress()}/sign-in/password`, contact: club.treasurerEmail });
    await sendMail(message, { purpose: "password_changed", actor: parentActor({ id: ctx.parentId, email: to }), ip: ctx.ip });
  })().catch(() => undefined); // a send that fails is audited by sendMail() (mail.failed); nothing here may surface
  return { ok: true, message: COPY.changed };
}

/**
 * "Sign out everywhere" (open question 26): every session of the person ended, this one included, and every device the
 * portal remembers for them forgotten, in one transaction in the order above lockedPerson() (the person's row FOR
 * UPDATE, their email change requests, their codes, their devices, their sessions), with one `parent.sessions.end_all`
 * row and its counts. Their unused email change requests go too, as a block's do, so a change of sign-in email asked in
 * a session this ends can't outlive it; and their unused codes and those spent within a code's life, as a reset's do,
 * so a sign-in finishing at this moment, whose code was spent before the press and whose session is made after it, is
 * refused by its last check (signinStands(), `code_gone`). The password and the links stay. Not asked again (the lead's
 * choice 9 of the sign-in release: it leaves nobody signed in, the one who pressed it included), and open to a person
 * with no password too. Limited per person (`signin_settings_parent`).
 */
export async function signOutEverywhere(ctx: Me): Promise<SettingsResult> {
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId)) !== "taken") return { ok: false, errors: [COPY.tooManyPresses] };
  await db.transaction(async (tx) => {
    const [me] = await tx.select({ email: parent.email }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
    const now = new Date(); // read once the person's row is held
    const emailChangesDeleted = await deleteUnusedEmailChanges(ctx.parentId, tx);
    const codesDeleted = await deleteUnusedSigninCodes(ctx.parentId, tx, { spentSince: new Date(now.getTime() - CODE_TTL_MS) });
    const devicesForgotten = await forgetDevices(ctx.parentId, tx);
    const sessionsEnded = await endParentSessions(ctx.parentId, tx);
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me?.email ?? ctx.email }), action: "parent.sessions.end_all", targetType: "parent", targetId: ctx.parentId,
      after: { emailChangesDeleted, codesDeleted, devicesForgotten, sessionsEnded }, ip: ctx.ip }, tx);
  });
  return { ok: true, message: COPY.everywhereDone };
}

/** The one answer to a device that isn't the person's to forget: another's, gone, expired, or not a device's id at all. */
const NOT_FROM_PAGE: SettingsResult = { ok: false, errors: [COPY.deviceNotFound] };

/**
 * The person's row, FOR UPDATE, and, read under it, this session's window: the first part of both forgets, in the
 * order above lockedPerson() (sessions.ts: the person's row, then their devices). Null when the person is gone or
 * blocked or the window has run out since the page.
 */
async function provedUnderLock(tx: Tx, ctx: Me): Promise<{ email: string; now: Date } | null> {
  const [me] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
  if (!me || me.blocked) return null;
  const now = new Date(); // read once the person's row is held
  return provedRecently(await sessionStrongAt(tx, ctx), now) ? { email: me.email, now } : null;
}

/**
 * "Forget this device" (slice SI-5b; open question 26), for one of the person's remembered devices, asked again first
 * as a change of how they sign in is (open question 28; the lead's decision). In this order:
 * (a) the argument: a device row's id, a uuid string of at most 36 characters (isDeviceId()); anything else is the one
 *     refusal, NOT_FROM_PAGE, uncounted;
 * (b) the window, read for this session (sessionProvedRecently()): refused in the words that say to show it's them;
 * (c) the limit per person (`signin_settings_parent`, the kind of these settings' presses), taken after the window;
 * (d) one transaction in the order above lockedPerson(): the person's row FOR UPDATE, the window again under it (and the
 *     person not blocked), then the device deleted with its person in the delete's own WHERE (`parent_device.parent_id`
 *     = the session's person, and unexpired): never a read and then a delete. A device of anyone else, gone or expired
 *     deletes nothing and is the same one refusal, changing nothing. The device this session names may be forgotten: the
 *     session goes on, its `device_id` set null by the foreign key, and the next sign-in on it takes the emailed code.
 *     One `parent.device.forgotten` row, with the device's id and whether it was this session's, never its token.
 */
export async function forgetMyDevice(ctx: Me, deviceId: unknown): Promise<SettingsResult> {
  if (!isDeviceId(deviceId)) return NOT_FROM_PAGE;
  if (!(await sessionProvedRecently(db, ctx))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId)) !== "taken") return { ok: false, errors: [COPY.tooManyPresses] };
  const done = await db.transaction(async (tx) => {
    const me = await provedUnderLock(tx, ctx);
    if (!me) return "not_proved" as const;
    const thisOne = (await sessionDeviceId(tx, ctx)) === deviceId.toLowerCase();
    const gone = await tx.delete(parentDevice)
      .where(and(eq(parentDevice.id, deviceId), eq(parentDevice.parentId, ctx.parentId), gt(parentDevice.expiresAt, me.now)))
      .returning({ id: parentDevice.id });
    if (gone.length === 0) return "not_theirs" as const;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.device.forgotten", targetType: "parent", targetId: ctx.parentId,
      after: { deviceId: gone[0]!.id, thisDevice: thisOne }, ip: ctx.ip }, tx);
    return "forgotten" as const;
  });
  if (done === "not_proved") return PROVE_AGAIN;
  if (done === "not_theirs") return NOT_FROM_PAGE;
  return { ok: true, message: COPY.deviceForgotten };
}

/**
 * "Forget every other device" (slice SI-5b): every remembered device of the person but the one this session names
 * (all of them when it names none), asked again first as forgetting one is, limited the same way, in one transaction
 * in the order above lockedPerson() (the person's row FOR UPDATE, the window again under it, then the devices), with one
 * `parent.devices.forgotten` row and its count. It takes no id: whose devices, and which is kept, come from the session.
 * When none is kept (the session names no device, or one no longer the person's own unexpired one), the page called it
 * "Forget every device", and the answer says every device is forgotten, this one included (`everyDeviceForgotten`).
 */
export async function forgetMyOtherDevices(ctx: Me): Promise<SettingsResult> {
  if (!(await sessionProvedRecently(db, ctx))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId)) !== "taken") return { ok: false, errors: [COPY.tooManyPresses] };
  const done = await db.transaction(async (tx) => {
    const me = await provedUnderLock(tx, ctx);
    if (!me) return false;
    const kept = await sessionDeviceId(tx, ctx);
    const gone = await tx.delete(parentDevice)
      .where(kept ? and(eq(parentDevice.parentId, ctx.parentId), ne(parentDevice.id, kept)) : eq(parentDevice.parentId, ctx.parentId))
      .returning({ id: parentDevice.id });
    // Kept only when what the session names is still one of the person's own remembered devices: an expired row the
    // clean-up hasn't reached yet, or anyone else's, was never on the page and is no device of theirs kept.
    const [stillTheirs] = kept ? await tx.select({ id: parentDevice.id }).from(parentDevice)
      .where(and(eq(parentDevice.id, kept), eq(parentDevice.parentId, ctx.parentId), gt(parentDevice.expiresAt, me.now))) : [];
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.devices.forgotten", targetType: "parent", targetId: ctx.parentId,
      after: { devicesForgotten: gone.length, thisDeviceKept: stillTheirs !== undefined }, ip: ctx.ip }, tx);
    return stillTheirs !== undefined ? "kept" as const : "none_kept" as const;
  });
  if (!done) return PROVE_AGAIN;
  // With none kept the page couldn't say which device was in use ("Forget every device"): the answer says every one is
  // gone, the one in use included.
  return { ok: true, message: done === "kept" ? COPY.otherDevicesForgotten : COPY.everyDeviceForgotten };
}

/**
 * The set-up link offered to a person with no password (open question 34): "Set up or reset my password"
 * (askForPasswordLink(), password-request.ts) for the session's own address, called as it is, with its own limits
 * (`password_ask_email`, `password_ask_ip`), resend wait, rows and one answer (its mail is not awaited). Nothing in the
 * session alone sets a password: the link does, from the mailbox. At Strict nothing is mailed on request, and the answer
 * says so, as the request page's does (askWords()).
 */
export async function askMySetupLink(ctx: Me): Promise<SettingsResult> {
  const { delivery } = await askForPasswordLink(ctx.email, ctx.ip);
  void delivery;
  const { level } = await getParentSettings();
  return { ok: true, message: askWords(level === "strict").answer ?? PASSWORD_COPY.askAnswer };
}
