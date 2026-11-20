// A parent's authenticator app in their sign-in settings (/family/sign-in; the sign-in release, slice SI-6b; section 6
// of the app-owned families spec, "An authenticator app is in sign-in settings for anyone who wants one", and open
// questions 25, 26, 28 and 33): setting it up in two presses, its ten backup codes shown once, new ones made, and the
// app turned off. Each press is asked again first (open question 28; the lead's decision for SI-6b asks for the set-up
// too, since it shows backup codes): it acts only for a session that proved itself within the window
// (sessionProvedRecently(), asking-again.ts), read before and again under the person's row. Everything is for the
// session's own person (`ctx.parentId`, `ctx.email`): no press takes an id, and an unfinished set-up is found by the
// person alone. The rows themselves are read and written only by authenticator.ts. The secret is answered once, at the
// first press, as the key to type and the QR code's squares (drawn here, on the server: authenticator-qr.ts), and never
// again; the backup codes once, as they are made. No audit row holds a secret, a code, a hash, the key URI or the
// QR code. Nothing here makes or ends a session, forgets a device or touches `strong_at`. Server only; parent code.
import "server-only";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { currentBrand } from "@/lib/mail/send";
import { currentPassword, sessionProvedRecently, sessionStrongAt } from "./asking-again";
import { beginAuthenticatorSetup, confirmAuthenticator, hasAuthenticator, makeBackupCodes, removeAuthenticator } from "./authenticator";
import { authenticatorKeyUri, qrSquares, type QrSquares } from "./authenticator-qr";
import { readSecondStepCode } from "./backup-codes";
import { giveBackRateLimit, takeRateLimit, takeRateLimitPlace } from "./rate-limit";
import { provedRecently } from "./reask-rule";
import { deleteUnusedSigninCodes, parentActor } from "./sessions";
import { getParentSettings } from "./settings";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

type Me = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;

/** The set-up's first answer: the key to type, grouped in fours for reading, and the QR code's squares, once. */
export type SetupAnswer = { ok: true; message: string; key: string; qr: QrSquares } | { ok: false; errors: string[] };
/**
 * An answer that shows the backup codes, once, as they are made. A confirm's refusal that leaves nothing to finish (the
 * set-up ran out, was replaced or was finished in another window, or the window since the proof ran out) says so with
 * `setupOver`, so the page drops the dead QR code and key and draws the set-up press, or the app, again.
 */
export type CodesAnswer = { ok: true; message: string; codes: string[] } | { ok: false; errors: string[]; setupOver?: true };
export type TurnOffAnswer = { ok: true; message: string } | { ok: false; errors: string[] };

const PROVE_AGAIN = { ok: false as const, errors: [COPY.proveAgain] };
const TOO_MANY_PRESSES = { ok: false as const, errors: [COPY.tooManyPresses] };
const TOO_MANY_TRIES = { ok: false as const, errors: [COPY.tooManyTries] };
const WRONG = { ok: false as const, errors: [COPY.appSetupWrong] };
/** The confirm's refusals that leave nothing to finish: the page goes back to the set-up press (or the app, drawn again). */
const SETUP_TIMED_OUT = { ok: false as const, errors: [COPY.appSetupTimedOut], setupOver: true as const };
const SETUP_GONE = { ok: false as const, errors: [COPY.appSetupGone], setupOver: true as const };
const SETUP_DONE_ELSEWHERE = { ok: false as const, errors: [COPY.appSetupDoneElsewhere], setupOver: true as const };
/** The most a code field may hold as sent, as at the door's app step. */
const MOST_SENT_CODE = 20;

/** The key as the page shows it to be typed: the base32 secret in groups of four. */
export const groupKey = (secret: string): string => secret.replace(/(.{4})(?=.)/g, "$1 ");

/**
 * The person's row, FOR UPDATE, and, read under it, this session's window at `now` (or the clock once the row is held):
 * the first part of every press here, in the order above lockedPerson() (sessions.ts: the person's row, then their
 * emailed codes, then their app and backup codes, before devices and sessions). Null when the person is gone or blocked
 * or the window has run out since the page.
 */
async function provedUnderLock(tx: Tx, ctx: Me, now?: Date): Promise<{ email: string; at: Date } | null> {
  const [me] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
  if (!me || me.blocked) return null;
  const at = now ?? new Date(); // read once the person's row is held
  return provedRecently(await sessionStrongAt(tx, ctx), at) ? { email: me.email, at } : null;
}

/**
 * "Set up an authenticator app", the first press (decision 2 of SI-6b). It takes no argument. In this order:
 * (a) the window, read for this session: refused in the words that say to show it's them again;
 * (b) the limit per person (`signin_settings_parent`, these settings' presses), taken after the window;
 * (c) one transaction: the person's row FOR UPDATE, the window again under it (and the person not blocked), the club not
 *     at Strict (where the club's own enrolment sets the app up, SI-10: refused in words), a password chosen, and no app
 *     in force (refused in words); then any unfinished set-up of theirs replaced by a new one, its secret sealed
 *     (beginAuthenticatorSetup(), authenticator.ts), with one `parent.authenticator.setup_started` row (how many it
 *     replaced, nothing of the secret).
 * The answer carries the key to type (grouped in fours) and the QR code's squares of the key URI, labelled with the
 * club's name and the address read under the lock: once, in this answer alone, never in the page's HTML or a later
 * answer. A reload or leaving the page loses them; pressing again starts a new set-up with a new secret. Nothing is in
 * force until a code from the app is checked (confirmMyAuthenticator()).
 */
export async function startMyAuthenticator(ctx: Me, now?: Date): Promise<SetupAnswer> {
  if (!(await sessionProvedRecently(db, ctx, now))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return TOO_MANY_PRESSES;
  const brand = await currentBrand();
  const begun = await db.transaction(async (tx) => {
    const me = await provedUnderLock(tx, ctx, now);
    if (!me) return "not_proved" as const;
    if ((await getParentSettings(tx)).level === "strict") return "strict" as const;
    if (!(await currentPassword(tx, ctx.parentId))) return "no_password" as const;
    const made = await beginAuthenticatorSetup(tx, ctx.parentId, me.at);
    if (!made) return "on" as const;
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.authenticator.setup_started", targetType: "parent", targetId: ctx.parentId,
      after: { replaced: made.replaced }, ip: ctx.ip }, tx);
    return { secret: made.secret, email: me.email };
  });
  if (begun === "strict") return { ok: false, errors: [COPY.appStrictOff] };
  if (begun === "no_password") return { ok: false, errors: [COPY.appNeedsPassword] };
  if (begun === "on") return { ok: false, errors: [COPY.appAlreadyOn] };
  if (typeof begun === "string") return PROVE_AGAIN;
  return { ok: true, message: COPY.appScan, key: groupKey(begun.secret), qr: qrSquares(authenticatorKeyUri(brand.clubName, begun.email, begun.secret)) };
}

/**
 * "Finish setting up", the second press (decision 2 of SI-6b): the code the app shows, a string of at most 20 (anything
 * else is the one refusal, uncounted). In this order:
 * (a) the window, read for this session;
 * (b) the try's place under the person (`second_step_parent`, SI-6a's count, so set-up tries and sign-in tries share its
 *     5 wrong in 15 minutes), taken before the set-up is read; its first refusal audited
 *     `parent.authenticator.confirm_refused` (`rate_limited`);
 * (c) one transaction: the person's row FOR UPDATE, the window again under it (and the person not blocked); the code by
 *     its shape (readSecondStepCode(): spaces and dashes dropped, so "123 456" and "123-456", as apps show it, are taken;
 *     anything but six digits is a wrong try); the person's unfinished set-up, younger than its life, confirmed by one
 *     conditional update when the code matches the step now or one either way (confirmAuthenticator(), authenticator.ts:
 *     two confirms at once make one app); a wrong code, or no set-up to confirm, is `parent.authenticator.confirm_wrong`
 *     (`factor`, `try`, `reason` `wrong`, `no_setup`, or `already_on` when an app is in force, finished in another
 *     window or by the other of two confirms at once), and a secret that won't open is
 *     `parent.authenticator.confirm_refused` (`setup_unreadable`), never a throw. Taken: the person's unused emailed
 *     codes deleted (an emailed code's proof is refused beside an app in force anyway, signinStands()), ten backup codes
 *     made, any older ones deleted (makeBackupCodes()), with `parent.authenticator.on` and `parent.backup_codes.make`
 *     (counts only);
 * (d) a right code gives its place back, and so does a secret that won't open (no guess was possible), as at the door.
 * The answer carries the ten codes, once. Devices stay remembered, no session is made or ended, `strong_at` stays. A
 * refusal that leaves nothing to finish (the window run out, no set-up, an app in force already) carries `setupOver`,
 * each in its own words, saying to delete the dead entry the app saved.
 */
export async function confirmMyAuthenticator(ctx: Me, code: unknown, now?: Date): Promise<CodesAnswer> {
  if (typeof code !== "string" || code.length > MOST_SENT_CODE) return WRONG;
  if (!(await sessionProvedRecently(db, ctx, now))) return SETUP_TIMED_OUT;
  const actor = parentActor({ id: ctx.parentId, email: ctx.email });
  const place = await takeRateLimitPlace("second_step_parent", ctx.parentId, now);
  if (place.take !== "taken") {
    if (place.take === "first_refusal") {
      await writeAudit({ actor, action: "parent.authenticator.confirm_refused", targetType: "parent", targetId: ctx.parentId,
        after: { reason: "rate_limited", limit: "second_step" }, ip: ctx.ip });
    }
    return TOO_MANY_TRIES;
  }
  const typed = readSecondStepCode(code);
  const done = await db.transaction(async (tx) => {
    const me = await provedUnderLock(tx, ctx, now);
    if (!me) return "not_proved" as const;
    const who = parentActor({ id: ctx.parentId, email: me.email });
    const took = typed.kind === "app" ? await confirmAuthenticator(tx, ctx.parentId, typed.code, me.at) : { miss: "wrong" as const };
    if ("miss" in took) {
      if (took.miss === "unreadable") {
        await writeAudit({ actor: who, action: "parent.authenticator.confirm_refused", targetType: "parent", targetId: ctx.parentId,
          after: { reason: "setup_unreadable" }, ip: ctx.ip }, tx);
        return "unreadable" as const;
      }
      // No set-up to confirm beside an app in force: finished in another window, or by the other of two confirms at once.
      const reason = took.miss === "no_setup" && (await hasAuthenticator(ctx.parentId, tx)) ? "already_on" as const : took.miss;
      await writeAudit({ actor: who, action: "parent.authenticator.confirm_wrong", targetType: "parent", targetId: ctx.parentId,
        after: { factor: "authenticator", try: place.number ?? 0, reason }, ip: ctx.ip }, tx);
      return reason;
    }
    const codesDeleted = await deleteUnusedSigninCodes(ctx.parentId, tx);
    const made = await makeBackupCodes(tx, ctx.parentId, me.at);
    await writeAudit({ actor: who, action: "parent.authenticator.on", targetType: "parent", targetId: ctx.parentId,
      after: { codesDeleted }, ip: ctx.ip }, tx);
    await writeAudit({ actor: who, action: "parent.backup_codes.make", targetType: "parent", targetId: ctx.parentId,
      after: { made: made.codes.length, replaced: made.replaced }, ip: ctx.ip }, tx);
    return { codes: made.codes };
  });
  if (typeof done !== "string" || done === "unreadable") await giveBackRateLimit(place.placeId);
  if (done === "not_proved") return SETUP_TIMED_OUT;
  if (done === "no_setup") return SETUP_GONE;
  if (done === "already_on") return SETUP_DONE_ELSEWHERE;
  if (typeof done === "string") return WRONG;
  return { ok: true, message: COPY.appOn, codes: done.codes };
}

/**
 * "Make new backup codes" (decision 3 of SI-6b; open question 28's "seeing backup codes"), only beside an app in force,
 * at either level: the window, `signin_settings_parent`, then one transaction: the person's row FOR UPDATE, the window
 * again under it (and the person not blocked), an app in force (refused in words otherwise), every backup code of the
 * person deleted and ten new ones made (makeBackupCodes()), with one `parent.backup_codes.make` row (how many it made and
 * replaced). The answer shows them once, saying the old ones no longer work. A sign-in that spent an old one just before
 * and finishes after is refused at its last check (signinStands(), `backup_code_gone`).
 */
export async function remakeMyBackupCodes(ctx: Me, now?: Date): Promise<CodesAnswer> {
  if (!(await sessionProvedRecently(db, ctx, now))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return TOO_MANY_PRESSES;
  const done = await db.transaction(async (tx) => {
    const me = await provedUnderLock(tx, ctx, now);
    if (!me) return "not_proved" as const;
    if (!(await hasAuthenticator(ctx.parentId, tx))) return "off" as const;
    const made = await makeBackupCodes(tx, ctx.parentId, me.at);
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.backup_codes.make", targetType: "parent", targetId: ctx.parentId,
      after: { made: made.codes.length, replaced: made.replaced }, ip: ctx.ip }, tx);
    return { codes: made.codes };
  });
  if (done === "not_proved") return PROVE_AGAIN;
  if (done === "off") return { ok: false, errors: [COPY.appNotOn] };
  return { ok: true, message: COPY.newCodesMade, codes: done.codes };
}

/**
 * "Turn off the authenticator app" (decision 4 of SI-6b; open questions 28 and 33): the window,
 * `signin_settings_parent`, then one transaction: the person's row FOR UPDATE, the window again under it (and the person
 * not blocked); under Strict refused in words (the app is their only second step until passkeys, SI-7, and Strict asks
 * for one: ask the club), changing nothing; an app in force (refused in words otherwise); then the app's row and every
 * backup code of the person deleted (removeAuthenticator()), with one `parent.authenticator.off` row (counts only).
 * Remembered devices stay, and no session is made or ended. A sign-in whose app's code or backup code was taken just
 * before and whose session is made after is refused at its last check (signinStands(): `second_factor_gone`,
 * `backup_code_gone`), and a step that asked for the app and is still open ends at its next try (verifySecondFactor(),
 * `no_app`). The next sign-in on a new device asks for the emailed code again.
 */
export async function turnOffMyAuthenticator(ctx: Me, now?: Date): Promise<TurnOffAnswer> {
  if (!(await sessionProvedRecently(db, ctx, now))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return TOO_MANY_PRESSES;
  const done = await db.transaction(async (tx) => {
    const me = await provedUnderLock(tx, ctx, now);
    if (!me) return "not_proved" as const;
    if ((await getParentSettings(tx)).level === "strict") return "strict" as const;
    if (!(await hasAuthenticator(ctx.parentId, tx))) return "off" as const;
    const gone = await removeAuthenticator(tx, ctx.parentId);
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.authenticator.off", targetType: "parent", targetId: ctx.parentId,
      after: { backupCodesDeleted: gone.backupCodes }, ip: ctx.ip }, tx);
    return "off_now" as const;
  });
  if (done === "not_proved") return PROVE_AGAIN;
  if (done === "strict") return { ok: false, errors: [COPY.turnOffStrict] };
  if (done === "off") return { ok: false, errors: [COPY.appNotOn] };
  return { ok: true, message: COPY.turnedOff };
}
