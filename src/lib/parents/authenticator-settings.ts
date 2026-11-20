// A parent's authenticator app in their sign-in settings (/family/sign-in; the sign-in release, slice SI-6b; section 6
// of the app-owned families spec, "An authenticator app is in sign-in settings for anyone who wants one", and open
// questions 25, 26, 28 and 33): setting it up in two presses, its ten backup codes shown once, new ones made, and the
// app turned off. Each press is asked again first (open question 28; the lead's decision for SI-6b asks for the set-up
// too, since it shows backup codes): it acts only for a session that proved itself within the window
// (sessionProvedRecently(), asking-again.ts, where a proof made before the person's app came into force doesn't count),
// read before and again under the person's row. Everything is for the session's own person (`ctx.parentId`,
// `ctx.email`): no press takes an id, and an unfinished set-up is found by the person alone, the confirm's stamp only
// telling whether it is still the one its page shows (setupStamp()). The rows themselves are read and written only by authenticator.ts. The secret is answered once, at the
// first press, as the key to type and the QR code's squares (drawn here, on the server: authenticator-qr.ts), and never
// again; the backup codes once, as they are made. No audit row holds a secret, a code, a hash, the key URI or the
// QR code. Nothing here makes or ends a session, forgets a device or touches `strong_at`. Server only; parent code.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { hasPasskey } from "./passkeys";
import { deleteUnusedSigninCodes, parentActor } from "./sessions";
import { PARENTS_KEY, getParentSettings } from "./settings";
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
 * set-up within its life (`current`, with its id); `replaced` by a newer, unfinished one still within its life (there is
 * something to finish in the other window); `finished_elsewhere` (an app is in force, from this set-up or from a newer
 * one); or `ran_out` (no row at all, or the unfinished one past its life, whether it is this set-up or a newer one, since
 * then nothing is left to finish anywhere).
 */
type SetupStanding = { standing: "current"; id: string } | { standing: keyof typeof SETUP_OVER };
async function setupStanding(q: Parameters<typeof authenticatorRowOf>[1], ctx: Me, rowMac: Buffer, at: Date): Promise<SetupStanding> {
  const row = await authenticatorRowOf(ctx.parentId, q);
  if (!row) return { standing: "ran_out" };
  if (row.inForce) return { standing: "finished_elsewhere" };
  if (row.createdAt.getTime() <= at.getTime() - AUTHENTICATOR_SETUP_LIFE_MS) return { standing: "ran_out" };
  if (!sameMac(rowMac, setupMac(ctx, "row", row.id))) return { standing: "replaced" };
  return { standing: "current", id: row.id };
}

/** The key as the page shows it to be typed: the base32 secret in groups of four. */
export const groupKey = (secret: string): string => secret.replace(/(.{4})(?=.)/g, "$1 ");

/**
 * The parents' settings lock, shared, for a press that reads the club's level (setting up, turning off): taken first,
 * before the person's row, in the order above lockedPerson() (sessions.ts), so a change of level (switches.ts, which
 * holds it exclusively) is wholly before the press's read or wholly after its commit, never between them.
 */
const holdParentSettings = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${PARENTS_KEY}))`);

/**
 * The person's row, FOR UPDATE, and, read under it, this session's window at `now` (or the clock once the row is held):
 * the first part of every press here, in the order above lockedPerson() (sessions.ts: the person's row, then their
 * emailed codes, then their app and backup codes, before devices and sessions). Null when the person is gone or blocked
 * or the window has run out since the page.
 */
async function provedUnderLock(tx: Tx, ctx: Me, now?: Date): Promise<{ email: string; at: Date } | null> {
  const me = await heldPerson(tx, ctx, now);
  return me && (await windowStands(tx, ctx, me.at)) ? me : null;
}

/** The person's row, FOR UPDATE, and the clock read once it is held (or `now`); null when the person is gone or blocked. */
async function heldPerson(tx: Tx, ctx: Me, now?: Date): Promise<{ email: string; at: Date } | null> {
  const [me] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, ctx.parentId)).for("update");
  if (!me || me.blocked) return null;
  return { email: me.email, at: now ?? new Date() };
}

/** This session's window at `at`, read under the person's row (a proof from before an app in force doesn't count: sessionStrongAt()). */
const windowStands = async (tx: Tx, ctx: Me, at: Date) => provedRecently(await sessionStrongAt(tx, ctx), at);

/**
 * "Set up an authenticator app", the first press (decision 2 of SI-6b). It takes no argument. In this order:
 * (a) the window, read for this session: refused in the words that say to show it's them again;
 * (b) the limit per person (`signin_settings_parent`, these settings' presses), taken after the window;
 * (c) one transaction: the parents' settings lock shared (holdParentSettings()), the person's row FOR UPDATE, the
 *     window again under it (and the person not blocked), the club not at Strict (where the club's own enrolment sets the app up, SI-10: refused in words), a password chosen, and no app
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
    await holdParentSettings(tx);
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
 *     `parent.authenticator.confirm_refused` (`reason` `replaced`, `finished_elsewhere` or `ran_out`) only when one of
 *     the settings' presses (`signin_settings_parent`) is taken for it, so a stale stamp replayed writes at most ten rows
 *     an hour (past that it is told the same words, unaudited). This comes before the window, so a set-up finished in
 *     another window is told as such and never as the window run out;
 * (b) the window, read for this session; when it has run out, the set-up's standing is read again (nothing holds the
 *     row between the two reads, and a set-up finished meanwhile leaves this session's proof older than the app), and
 *     only a set-up still current is answered `appSetupTimedOut`, any other as at (a);
 * (c) the try's place under the person (`second_step_parent`, SI-6a's count, so set-up tries and sign-in tries share its
 *     5 wrong in 15 minutes), taken before the code is checked; its first refusal audited
 *     `parent.authenticator.confirm_refused` (`rate_limited`);
 * (d) one transaction: the person's row FOR UPDATE (and the person not blocked), where the stamped set-up stands again
 *     (anything but `current` is (a)'s answer, its place given back), then the window again under it (in that order,
 *     since an app finished meanwhile leaves this session's proof older than the app); the code by its shape
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
  // A set-up found over outside the lock is told in its words every time, but audited only while one of the settings'
  // presses (`signin_settings_parent`) is free and taken for it: a stale stamp sent again and again writes at most that
  // limit's rows, and still keeps no place at the door's (`second_step_parent`).
  const overOutside = async (standing: keyof typeof SETUP_OVER) => {
    if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) === "taken") await over(standing);
    return SETUP_OVER[standing];
  };
  const before = await setupStanding(db, ctx, rowMac, now ?? new Date());
  if (before.standing !== "current") return overOutside(before.standing);
  if (!(await sessionProvedRecently(db, ctx, now))) {
    // Nothing holds the row between the two reads: a confirm that finished this set-up meanwhile leaves this session's
    // proof older than the app, so the set-up is read again, and only one still current is told the window ran out.
    const after = await setupStanding(db, ctx, rowMac, now ?? new Date());
    return after.standing === "current" ? SETUP_TIMED_OUT : overOutside(after.standing);
  }
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
    // The set-up's standing before the window, as at (a): an app finished by the other of two confirms at once leaves
    // this session's proof older than the app, so the window would say it ran out when the set-up is the thing that's over.
    const me = await heldPerson(tx, ctx, now);
    if (!me) return "not_proved" as const;
    const setup = await setupStanding(tx, ctx, rowMac, me.at);
    if (setup.standing !== "current") return over(setup.standing, tx);
    if (!(await windowStands(tx, ctx, me.at))) return "not_proved" as const;
    const who = parentActor({ id: ctx.parentId, email: me.email });
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
 * "Make new backup codes" (decision 3 of SI-6b; open question 28's "seeing backup codes"), only beside an app in force
 * or, since slice SI-7b, a passkey, at either level: the window, `signin_settings_parent`, then one transaction: the
 * person's row FOR UPDATE, the window again under it (and the person not blocked), an app in force or a passkey (refused
 * in words otherwise), every backup code of the
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
    if (!(await hasAuthenticator(ctx.parentId, tx)) && !(await hasPasskey(ctx.parentId, tx))) return "off" as const;
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
 * `signin_settings_parent`, then one transaction: the parents' settings lock shared (holdParentSettings()), the person's
 * row FOR UPDATE, the window again under it (and the person not blocked); under Strict refused in words when the app
 * is their only second step (Strict asks for one: ask the club, or add a passkey first; since slice SI-7b it is allowed
 * while a passkey remains), changing nothing; an app in force (refused in words otherwise); then the app's row deleted
 * and every backup code of the person with it, but for a person with a passkey (since SI-7b), beside which the backup
 * codes still stand (removeAuthenticator(), `keepBackupCodes`), with one `parent.authenticator.off` row (counts only).
 * Remembered devices stay, and no session is made or ended. A sign-in whose app's code or backup code was taken just
 * before and whose session is made after is refused at its last check (signinStands(): `second_factor_gone`,
 * `backup_code_gone`), and a step that asked for the app and is still open ends at its next try (verifySecondFactor(),
 * `no_app`). The next sign-in on a new device asks for the emailed code again.
 */
export async function turnOffMyAuthenticator(ctx: Me, now?: Date): Promise<TurnOffAnswer> {
  if (!(await sessionProvedRecently(db, ctx, now))) return PROVE_AGAIN;
  if ((await takeRateLimit("signin_settings_parent", ctx.parentId, now)) !== "taken") return TOO_MANY_PRESSES;
  const done = await db.transaction(async (tx) => {
    await holdParentSettings(tx);
    const me = await provedUnderLock(tx, ctx, now);
    if (!me) return "not_proved" as const;
    const passkey = await hasPasskey(ctx.parentId, tx);
    if (!passkey && (await getParentSettings(tx)).level === "strict") return "strict" as const;
    if (!(await hasAuthenticator(ctx.parentId, tx))) return "off" as const;
    const gone = await removeAuthenticator(tx, ctx.parentId, { keepBackupCodes: passkey });
    await writeAudit({ actor: parentActor({ id: ctx.parentId, email: me.email }), action: "parent.authenticator.off", targetType: "parent", targetId: ctx.parentId,
      after: { backupCodesDeleted: gone.backupCodes, passkeyStays: passkey }, ip: ctx.ip }, tx);
    return passkey ? "off_beside_passkey" as const : "off_now" as const;
  });
  if (done === "not_proved") return PROVE_AGAIN;
  if (done === "strict") return { ok: false, errors: [COPY.turnOffStrict] };
  if (done === "off") return { ok: false, errors: [COPY.appNotOn] };
  return { ok: true, message: done === "off_beside_passkey" ? COPY.turnedOffBesidePasskey : COPY.turnedOff };
}
