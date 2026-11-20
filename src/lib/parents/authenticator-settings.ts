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
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { env } from "@/env";
import { currentBrand } from "@/lib/mail/send";
import { currentPassword, sessionProvedRecently, sessionStrongAt } from "./asking-again";
import { AUTHENTICATOR_SETUP_LIFE_MS, authenticatorRowOf, beginAuthenticatorSetup, confirmAuthenticator, hasAuthenticator, makeBackupCodes, removeAuthenticator } from "./authenticator";
import { authenticatorKeyUri, qrSquares, type QrSquares } from "./authenticator-qr";
import { readSecondStepCode } from "./backup-codes";
import { giveBackRateLimit, takeRateLimit, takeRateLimitPlace } from "./rate-limit";
import { provedRecently } from "./reask-rule";
import { deleteUnusedSigninCodes, parentActor } from "./sessions";
import { getParentSettings } from "./settings";
import { SIGNIN_SETTINGS_COPY as COPY } from "./signin-settings-copy";

type Me = Pick<ParentCtx, "parentId" | "sessionId" | "email" | "ip">;

/**
 * The set-up's first answer: the key to type, grouped in fours for reading, and the QR code's squares, once, with the
 * set-up's stamp (setupStamp()), which the confirm sends back.
 */
export type SetupAnswer = { ok: true; message: string; key: string; qr: QrSquares; stamp: string } | { ok: false; errors: string[] };
/**
 * An answer that shows the backup codes, once, as they are made. A confirm's refusal that leaves nothing to finish (the
 * set-up ran out, was replaced by a newer one or was finished in another window, or the window since the proof ran
 * out) says so with `setupOver`, so the page drops the dead QR code and key and draws the set-up press, or the app, again.
 */
export type CodesAnswer = { ok: true; message: string; codes: string[] } | { ok: false; errors: string[]; setupOver?: true };
export type TurnOffAnswer = { ok: true; message: string } | { ok: false; errors: string[] };

const PROVE_AGAIN = { ok: false as const, errors: [COPY.proveAgain] };
const TOO_MANY_PRESSES = { ok: false as const, errors: [COPY.tooManyPresses] };
const TOO_MANY_TRIES = { ok: false as const, errors: [COPY.tooManyTries] };
const WRONG = { ok: false as const, errors: [COPY.appSetupWrong] };
/** The confirm's refusals that leave nothing to finish: the page goes back to the set-up press (or the app, drawn again). */
const SETUP_TIMED_OUT = { ok: false as const, errors: [COPY.appSetupTimedOut], setupOver: true as const };
/** A set-up that is no longer the one the stamp names, each in its own words (SetupStanding). */
const SETUP_OVER = {
  replaced: { ok: false as const, errors: [COPY.appSetupReplaced], setupOver: true as const },
  finished_elsewhere: { ok: false as const, errors: [COPY.appSetupDoneElsewhere], setupOver: true as const },
  ran_out: { ok: false as const, errors: [COPY.appSetupGone], setupOver: true as const },
};
/** A stamp no set-up answer gave this session: a bad request, uncounted, changing nothing. */
const NOT_FROM_PAGE = { ok: false as const, errors: [COPY.failed] };
/** The most a code field may hold as sent, as at the door's app step. */
const MOST_SENT_CODE = 20;

/*
 * The set-up's stamp (decision 2 of SI-6b's second read): which set-up a page's key and QR code belong to, so a confirm
 * can tell its own set-up from one that replaced it or was finished in another window. Two HMAC-SHA256s, keyed with the
 * server secret, each over a string that names its purpose, this session and the person: the first over nothing more
 * (so a stamp this session was given is told from a forged one), the second over the set-up's row id. Neither the id nor
 * anything of the key is in the stamp: the reader works the second out again from the person's row as it stands now and
 * compares the two in constant time.
 */
const SETUP_STAMP_SHAPE = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
/** The most a stamp may be as sent: anything longer is not one, and is refused before it is looked at. */
export const MOST_SENT_SETUP_STAMP = 128;
const setupMac = (ctx: Pick<Me, "sessionId" | "parentId">, part: "issued" | "row", rowId = ""): Buffer =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`authenticator-setup:${part}:${ctx.sessionId}:${ctx.parentId}:${rowId}`).digest();
const sameMac = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** The stamp of the set-up `rowId`, for this session and person. */
export const setupStamp = (ctx: Pick<Me, "sessionId" | "parentId">, rowId: string): string =>
  `${setupMac(ctx, "issued").toString("base64url")}.${setupMac(ctx, "row", rowId).toString("base64url")}`;

/**
 * The second half of a stamp this session was given, or null: not a string of at most MOST_SENT_SETUP_STAMP, not a
 * stamp's shape, or not issued to this session and person.
 */
function readSetupStamp(raw: unknown, ctx: Me): Buffer | null {
  if (typeof raw !== "string" || raw.length > MOST_SENT_SETUP_STAMP) return null;
  const m = SETUP_STAMP_SHAPE.exec(raw);
  if (!m || !sameMac(Buffer.from(m[1]!, "base64url"), setupMac(ctx, "issued"))) return null;
  return Buffer.from(m[2]!, "base64url");
}

/**
 * Where the stamped set-up stands, read from the person's one row (authenticatorRowOf()): still the person's unfinished
 * set-up within its life (`current`, with its id); `replaced` by a newer, unfinished one; `finished_elsewhere` (an app
 * is in force, from this set-up or from a newer one); or `ran_out` (no row at all, or this one past its life).
 */
type SetupStanding = { standing: "current"; id: string } | { standing: keyof typeof SETUP_OVER };
async function setupStanding(q: Parameters<typeof authenticatorRowOf>[1], ctx: Me, rowMac: Buffer, at: Date): Promise<SetupStanding> {
  const row = await authenticatorRowOf(ctx.parentId, q);
  if (!row) return { standing: "ran_out" };
  if (row.inForce) return { standing: "finished_elsewhere" };
  if (!sameMac(rowMac, setupMac(ctx, "row", row.id))) return { standing: "replaced" };
  if (row.createdAt.getTime() <= at.getTime() - AUTHENTICATOR_SETUP_LIFE_MS) return { standing: "ran_out" };
  return { standing: "current", id: row.id };
}

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
 * answer; and the set-up's stamp (setupStamp(): nothing of the key, and not the row's id), which the confirm sends back. A reload or leaving the page loses them; pressing again starts a new set-up with a new secret. Nothing is in
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
    return { secret: made.secret, id: made.id, email: me.email };
  });
  if (begun === "strict") return { ok: false, errors: [COPY.appStrictOff] };
  if (begun === "no_password") return { ok: false, errors: [COPY.appNeedsPassword] };
  if (begun === "on") return { ok: false, errors: [COPY.appAlreadyOn] };
  if (typeof begun === "string") return PROVE_AGAIN;
  return { ok: true, message: COPY.appScan, key: groupKey(begun.secret), qr: qrSquares(authenticatorKeyUri(brand.clubName, begun.email, begun.secret)),
    stamp: setupStamp(ctx, begun.id) };
}

/**
 * "Finish setting up", the second press (decision 2 of SI-6b): the code the app shows, a string of at most 20 (anything
 * else is the one refusal, uncounted), and the stamp the set-up's answer gave (setupStamp(); since the second read's
 * decision 2), a string of at most MOST_SENT_SETUP_STAMP issued to this session and person (anything else, missing or
 * forged, is a bad request, NOT_FROM_PAGE, uncounted, changing nothing). In this order:
 * (a) where the stamped set-up stands (setupStanding()): one that is no longer the person's unfinished set-up within
 *     its life is answered at once, uncounted, keeping no place in the limit, in its own words with `setupOver` (a newer
 *     set-up started in another window, `appSetupReplaced`; an app in force, finished in another window or by the other
 *     of two confirms at once, `appSetupDoneElsewhere`; none, or this one past its life, `appSetupGone`), audited
 *     `parent.authenticator.confirm_refused` (`reason` `replaced`, `finished_elsewhere` or `ran_out`). This comes before
 *     the window, so a set-up finished in another window is told as such and never as the window run out;
 * (b) the window, read for this session;
 * (c) the try's place under the person (`second_step_parent`, SI-6a's count, so set-up tries and sign-in tries share its
 *     5 wrong in 15 minutes), taken before the code is checked; its first refusal audited
 *     `parent.authenticator.confirm_refused` (`rate_limited`);
 * (d) one transaction: the person's row FOR UPDATE, the window again under it (and the person not blocked), where the
 *     stamped set-up stands again (anything but `current` is (a)'s answer, its place given back); the code by its shape
 *     (readSecondStepCode(): spaces and dashes dropped, so "123 456" and "123-456", as apps show it, are taken; anything
 *     but six digits is a wrong try); that set-up, and no other, confirmed by one conditional update when the code
 *     matches the step now or one either way (confirmAuthenticator(), authenticator.ts: two confirms at once make one
 *     app); a wrong code is `parent.authenticator.confirm_wrong` (`factor`, `try`, `reason` `wrong`), and a secret that
 *     won't open is `parent.authenticator.confirm_refused` (`setup_unreadable`), never a throw. Taken: the person's unused
 *     emailed codes deleted (an emailed code's proof is refused beside an app in force anyway, signinStands()), ten
 *     backup codes made, any older ones deleted (makeBackupCodes()), with `parent.authenticator.on` and
 *     `parent.backup_codes.make` (counts only);
 * (e) a right code gives its place back, and so does a secret that won't open (no guess was possible), as at the door.
 * The answer carries the ten codes, once. Devices stay remembered, no session is made or ended, `strong_at` stays. The
 * window run out is answered with `setupOver` too, in its own words (`appSetupTimedOut`).
 */
export async function confirmMyAuthenticator(ctx: Me, code: unknown, stamp: unknown, now?: Date): Promise<CodesAnswer> {
  if (typeof code !== "string" || code.length > MOST_SENT_CODE) return WRONG;
  const rowMac = readSetupStamp(stamp, ctx);
  if (!rowMac) return NOT_FROM_PAGE;
  const actor = parentActor({ id: ctx.parentId, email: ctx.email });
  const over = async (standing: keyof typeof SETUP_OVER, tx?: Tx) => {
    await writeAudit({ actor, action: "parent.authenticator.confirm_refused", targetType: "parent", targetId: ctx.parentId,
      after: { reason: standing }, ip: ctx.ip }, tx);
    return standing;
  };
  const before = await setupStanding(db, ctx, rowMac, now ?? new Date());
  if (before.standing !== "current") return SETUP_OVER[await over(before.standing)];
  if (!(await sessionProvedRecently(db, ctx, now))) return SETUP_TIMED_OUT;
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
    const setup = await setupStanding(tx, ctx, rowMac, me.at);
    if (setup.standing !== "current") return over(setup.standing, tx);
    const took = typed.kind === "app" ? await confirmAuthenticator(tx, ctx.parentId, setup.id, typed.code, me.at) : { miss: "wrong" as const };
    if ("miss" in took) {
      if (took.miss === "unreadable") {
        await writeAudit({ actor: who, action: "parent.authenticator.confirm_refused", targetType: "parent", targetId: ctx.parentId,
          after: { reason: "setup_unreadable" }, ip: ctx.ip }, tx);
        return "unreadable" as const;
      }
      // The person's row is held and the set-up read under it is current, so a miss here is the code itself.
      await writeAudit({ actor: who, action: "parent.authenticator.confirm_wrong", targetType: "parent", targetId: ctx.parentId,
        after: { factor: "authenticator", try: place.number ?? 0, reason: "wrong" }, ip: ctx.ip }, tx);
      return "wrong" as const;
    }
    const codesDeleted = await deleteUnusedSigninCodes(ctx.parentId, tx);
    const made = await makeBackupCodes(tx, ctx.parentId, me.at);
    await writeAudit({ actor: who, action: "parent.authenticator.on", targetType: "parent", targetId: ctx.parentId,
      after: { codesDeleted }, ip: ctx.ip }, tx);
    await writeAudit({ actor: who, action: "parent.backup_codes.make", targetType: "parent", targetId: ctx.parentId,
      after: { made: made.codes.length, replaced: made.replaced }, ip: ctx.ip }, tx);
    return { codes: made.codes };
  });
  // Only a wrong code keeps its place: a right one, a secret that won't open, and a set-up found over or a window run
  // out under the lock (no code was checked) give it back.
  if (done !== "wrong") await giveBackRateLimit(place.placeId);
  if (done === "not_proved") return SETUP_TIMED_OUT;
  if (done === "replaced" || done === "finished_elsewhere" || done === "ran_out") return SETUP_OVER[done];
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
