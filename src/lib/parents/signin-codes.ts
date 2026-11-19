// The emailed code: since the sign-in release's slice SI-3b, a sign-in's second step on a device the portal doesn't
// remember, and never a way in by itself. A code is sent only after the right password (/portal-password/check), or
// again for a pending step (/portal-code/resend), and checked only for the person a pending step names
// (/portal-code/check): src/lib/auth/parent-code-plugin.ts and parent-signin-step.ts. Its own rules stay as spec §1 made
// them: 6 digits, 10 minutes, 5 tries, one code a minute, and the limits per address and per IP address.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentAuthAccount, parentAuthUser, parentDevice, parentSigninToken, signinCode } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { mailWorking } from "@/lib/mail/settings";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { signinCodeMessage } from "@/lib/mail/messages";
import { takeRateLimit, type RateLimitTake } from "./rate-limit";
import { enterableGuardianRows, lockedPerson, parentActor } from "./sessions";
import { getParentSettings, parentDoorClosed, type ParentSettings } from "./settings";
import { secondStepFor } from "./second-step-rule";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_TRIES = 5;
export const RESEND_AFTER_MS = 60 * 1000;
/**
 * The least of its pending step's life a code is sent for. A code never outlives its pending step (sendSecondStepCode()),
 * so one asked for in the step's last minute would be dead before its mail could be read: none is sent.
 */
export const LEAST_CODE_LIFE_MS = 60 * 1000;

export const generateSigninCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
/** Keyed with the server secret, so a copy of the database alone can't be searched for the 1,000,000 possible codes. */
export const hashSigninCode = (parentId: string, code: string) =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`signin-code:${parentId}:${code}`).digest("hex");

/**
 * The password a sign-in was proved with: the person's `credential` row of `parent_auth_account` that the password was
 * checked against, by its id and its `updated_at`. The last check reads it again (signinStands()): a password set or
 * reset since refuses the sign-in (`password_changed`). It never reaches the browser but inside the signed pending step.
 */
export type PasswordProof = { credentialId: string; credentialUpdatedAt: Date };

/**
 * What a set-up link's sign-in spent, as the transaction that set its password read and wrote it under the person's
 * lock (choosePasswordFromLink(), password-set.ts): the link's own row, now spent, and the `credential` row the set
 * wrote, by its id and the `updated_at` it was given. It never reaches the browser.
 */
export type LinkSigninProof = { linkId: string; credentialId: string; credentialUpdatedAt: Date };

/**
 * What a sign-in proved, and the only three ways in (the sign-in release, slice SI-3b): a password and an emailed code
 * (the code's row id, verifySigninCode()), a password and a device the portal remembers for the person (the device's
 * row id), or a set-up link (choosePasswordFromLink()). There is no proof of a code alone: a code signs nobody in.
 */
export type SigninProof = { password: PasswordProof; codeId: string } | { password: PasswordProof; deviceId: string } | { link: LinkSigninProof };

/**
 * Who a pending step names (src/lib/auth/parent-signin-step.ts): the person, the address the password was proved with,
 * that password, and when the step ends (`endsAt`: CODE_TTL_MS after the right password, never extended). A code sent
 * for the step never outlives it; with no `endsAt`, the step is the one about to be set, which ends CODE_TTL_MS from now.
 */
export type StepPerson = { parentId: string; email: string; password: PasswordProof; endsAt?: Date };

type Refusal = "blocked" | "no_enabled_guardian" | "rate_limited" | "mail_failed" | "signins_off" | "address_changed" | "password_changed"
  | "strict_no_factor" | "step_ending";
const ANON: Actor = { door: "parent", id: null, label: null };
/**
 * The per-IP limit, or "taken" when the visitor's address is unknown. With no address (CLIENT_IP_HEADER is none, or the
 * proxy doesn't send the header) every visitor would share one count, and one visitor could use up the whole club's
 * sign-ins. The limits per email address and per code still hold.
 */
export const takeIpLimit = (kind: "code_send_ip" | "code_check_ip" | "password_try_ip", ip: string | null, now: Date): Promise<RateLimitTake> =>
  ip === null ? Promise.resolve("taken") : takeRateLimit(kind, ip, now);
/**
 * Why the door can't go on for anyone now, or null: sign-ins off, or a level whose second step is not the emailed code
 * (under Strict an emailed code is never a second step, secondStepFor(), so a pending step made at Standard goes no
 * further once an Admin stores Strict). `hasSecondFactor: false`, as the password step passes it, until SI-6 and SI-7.
 */
const doorStops = (settings: ParentSettings): "signins_off" | "strict_no_factor" | null =>
  parentDoorClosed(settings) ? "signins_off"
    : secondStepFor({ level: settings.level, hasSecondFactor: false }).step !== "emailed_code" ? "strict_no_factor" : null;
const DONE = { delivery: Promise.resolve(), ended: false };
const ENDED = { delivery: Promise.resolve(), ended: true };

/** One `signin.code_refused` row: against the person, or, over a limit per IP address, naming nobody. */
async function refuse(reason: Refusal, who: { id: string; email: string } | null, ip: string | null, extra: Record<string, unknown> = {}) {
  await writeAudit({ actor: who ? parentActor(who) : ANON, action: "signin.code_refused", targetType: who ? "parent" : undefined,
    targetId: who?.id, after: { reason, ...extra }, ip });
}

/** The `credential` row of the person by its id, as it stands: its `updated_at`, or null when it is gone. */
async function credentialNow(q: Pick<typeof db, "select">, parentId: string, credentialId: string): Promise<Date | null> {
  // The column is read through sql<Date>: the Better Auth tables are built by one generic function (schema.ts), and
  // drizzle's inferred type of this column comes out as never.
  const rows = await q.select({ updatedAt: sql<Date>`${parentAuthAccount.updatedAt}`.mapWith(parentAuthAccount.updatedAt) }).from(parentAuthAccount)
    .where(and(eq(parentAuthAccount.id, credentialId), eq(parentAuthAccount.providerId, "credential"),
      inArray(parentAuthAccount.userId, q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))));
  return rows[0]?.updatedAt ?? null;
}
const samePassword = (stored: Date | null, proof: PasswordProof) => stored !== null && stored.getTime() === proof.credentialUpdatedAt.getTime();

/**
 * The second step's code, for the person a right password or a pending step names (never a typed address): decided,
 * stored, and mailed in `delivery`, which the caller must not await; its answer to the browser never says what happened
 * here. In order: the limit per IP address (skipped with no address), the limit per address (`code_send_email`,
 * counted under the person's own address), mail working, the door open, the person not blocked and with a row that
 * counts; then, under the person's lock (lockedPerson()), their address still the one the password was proved with and
 * their password still the one it was checked against, and the resend wait (one code a minute); then the code, which
 * replaces their unused one. The code never outlives the pending step it is sent for (`person.endsAt`): it expires at
 * the step's end or CODE_TTL_MS from now, whichever is sooner, and its mail says how many whole minutes that is; with
 * less than LEAST_CODE_LIFE_MS of the step left none is sent (`step_ending`), since it would be dead before it was read.
 * `ended` says the step can't go on (blocked, the address or the password changed, no row that counts, sign-ins off,
 * Strict), and the caller clears the pending step. Each refusal is `signin.code_refused` with its reason (over a limit,
 * once per full window); a code mailed is `signin.code_sent`.
 */
export async function sendSecondStepCode(person: StepPerson, ip: string | null, now = new Date()): Promise<{ delivery: Promise<void>; ended: boolean }> {
  const email = person.email;
  const who = { id: person.parentId, email };
  // The IP limit comes first, so no refusal below it (mail not working included) can be repeated without limit.
  const byIp = await takeIpLimit("code_send_ip", ip, now);
  if (byIp !== "taken") { if (byIp === "first_refusal") await refuse("rate_limited", null, ip, { limit: "ip" }); return DONE; }
  const byEmail = await takeRateLimit("code_send_email", email, now);
  if (byEmail !== "taken") { if (byEmail === "first_refusal") await refuse("rate_limited", who, ip, { limit: "email" }); return DONE; }
  const expiresAt = new Date(Math.min(now.getTime() + CODE_TTL_MS, person.endsAt?.getTime() ?? Infinity));
  if (expiresAt.getTime() - now.getTime() < LEAST_CODE_LIFE_MS) { await refuse("step_ending", who, ip); return DONE; }
  if (!(await mailWorking())) { await refuse("mail_failed", who, ip, { detail: "mail_not_working" }); return DONE; }
  const stops = doorStops(await getParentSettings());
  if (stops) { await refuse(stops, who, ip); return ENDED; }
  const [p] = await db.select().from(parent).where(eq(parent.id, person.parentId));
  if (!p || p.email !== email) { await refuse("address_changed", who, ip); return ENDED; }
  if (p.blocked) { await refuse("blocked", who, ip); return ENDED; }
  if ((await enterableGuardianRows(p.id)).length === 0) { await refuse("no_enabled_guardian", who, ip); return ENDED; }

  const code = generateSigninCode();
  const stored = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.signin_code:${p.id}`}))`);
    // `p` was read before this transaction, and staff or the parent may be changing the person's address right now.
    // The address is read again under a lock (lockedPerson): a change under way finishes first and is seen here, and one
    // that starts later waits for this code to be stored and then deletes it. The code is mailed to the address read
    // here and to no other, so it can never go to an address the person no longer has.
    const live = await lockedPerson(tx, p.id);
    if (!live || live.email !== email) return "moved" as const;
    if (live.blocked) return "blocked" as const;
    if (!samePassword(await credentialNow(tx, p.id, person.password.credentialId), person.password)) return "password" as const;
    const [last] = await tx.select({ createdAt: signinCode.createdAt }).from(signinCode).where(eq(signinCode.parentId, p.id))
      .orderBy(desc(signinCode.createdAt)).limit(1);
    if (last && now.getTime() - last.createdAt.getTime() < RESEND_AFTER_MS) return "resend" as const;
    await tx.delete(signinCode).where(and(eq(signinCode.parentId, p.id), isNull(signinCode.usedAt)));
    const [row] = await tx.insert(signinCode).values({ parentId: p.id, codeHash: hashSigninCode(p.id, code), expiresAt, createdAt: now })
      .returning({ id: signinCode.id });
    return { id: row!.id, to: live.email };
  });
  if (stored === "moved") { await refuse("address_changed", who, ip); return ENDED; }
  if (stored === "blocked") { await refuse("blocked", who, ip); return ENDED; }
  if (stored === "password") { await refuse("password_changed", who, ip); return ENDED; }
  if (stored === "resend") { await refuse("rate_limited", who, ip, { limit: "resend" }); return DONE; }

  const passwordPage = `${env.APP_URL.replace(/\/+$/, "")}/sign-in/password`;
  // Whole minutes, rounded down, so the mail never promises more than the code has.
  const minutes = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 60_000));
  const delivery = (async () => {
    const r = await sendMail(signinCodeMessage(await currentBrand(), stored.to, code, { passwordPage, minutes }), { purpose: "signin_code", actor: parentActor(p), ip });
    if (r.ok) {
      await writeAudit({ actor: parentActor(p), action: "signin.code_sent", targetType: "parent", targetId: p.id,
        after: { expiresAt: expiresAt.toISOString() }, ip });
    } else {
      await db.delete(signinCode).where(eq(signinCode.id, stored.id)); // nobody got it, so nobody may use it
      await refuse("mail_failed", who, ip);
    }
  })().catch(() => undefined); // every failure above is already audited; nothing here may surface to the caller
  return { delivery, ended: false };
}

/**
 * A right code, spent: the code's own row, which the last check of the sign-in reads again (signinStands()). A refusal
 * says whether the pending step has ended (`ended`: its code's tries used up, the person blocked or gone from their
 * address, their password changed, sign-ins off, Strict), so the caller clears it.
 */
export type VerifyResult = { ok: true; codeId: string } | { ok: false; reason: "rejected" | "rate_limited"; ended: boolean };
const REJECTED: VerifyResult = { ok: false, reason: "rejected", ended: false };
const REJECTED_ENDED: VerifyResult = { ok: false, reason: "rejected", ended: true };

/**
 * Spec §1, for the person a pending step names (never a typed address). Single use, 10 minutes, 5 wrong tries, 180
 * checks per IP address per 15 minutes. Before the code is looked at, the step must still be able to go on: the person
 * still at the address and not blocked, and, when the step's password is given (the door always gives it), their
 * `credential` row still the one it proved. A block and a reset delete the person's codes too, so without this their
 * step would be refused only as a missing code and linger to its end. Each refusal is audited (`signin.code_expired`,
 * `signin.code_wrong`, `signin.refused`), and the caller answers it as one refusal.
 */
export async function verifySigninCode(step: { parentId: string; email: string; password?: PasswordProof }, rawCode: string, ip: string | null, now = new Date()): Promise<VerifyResult> {
  const byIp = await takeIpLimit("code_check_ip", ip, now);
  if (byIp !== "taken") {
    if (byIp === "first_refusal") await refuse("rate_limited", null, ip, { limit: "check_ip" });
    return { ok: false, reason: "rate_limited", ended: false };
  }
  const who = { id: step.parentId, email: step.email };
  const [p] = await db.select().from(parent).where(eq(parent.id, step.parentId));
  if (!p || p.email !== normalizeEmail(step.email)) {
    await writeAudit({ actor: parentActor(who), action: "signin.refused", targetType: "parent", targetId: step.parentId, after: { reason: "address_changed" }, ip });
    return REJECTED_ENDED;
  }
  if (p.blocked) {
    await writeAudit({ actor: parentActor(p), action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "blocked" }, ip });
    return REJECTED_ENDED;
  }
  const code = rawCode.replace(/[\s-]/g, "");

  const outcome = await db.transaction(async (tx) => {
    if (step.password && !samePassword(await credentialNow(tx, p.id, step.password.credentialId), step.password)) return "password_changed" as const;
    const [row] = await tx.select().from(signinCode).where(and(eq(signinCode.parentId, p.id), isNull(signinCode.usedAt))).for("update");
    if (!row) return "no_code" as const;
    if (row.expiresAt.getTime() <= now.getTime()) return "expired" as const;
    if (row.tries >= CODE_MAX_TRIES) return "too_many_tries" as const;
    const want = Buffer.from(row.codeHash, "hex");
    const got = Buffer.from(hashSigninCode(p.id, /^\d{6}$/.test(code) ? code : "invalid"), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      await tx.update(signinCode).set({ tries: row.tries + 1 }).where(eq(signinCode.id, row.id));
      return { wrong: row.tries + 1 } as const;
    }
    await tx.update(signinCode).set({ usedAt: now }).where(eq(signinCode.id, row.id));
    return { spent: row.id } as const;
  });
  if (outcome === "password_changed") {
    await writeAudit({ actor: parentActor(p), action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: outcome }, ip });
    return REJECTED_ENDED;
  }
  if (outcome === "no_code" || outcome === "expired" || outcome === "too_many_tries") {
    await writeAudit({ actor: parentActor(p), action: "signin.code_expired", targetType: "parent", targetId: p.id, after: { reason: outcome }, ip });
    return outcome === "too_many_tries" ? REJECTED_ENDED : REJECTED;
  }
  if ("wrong" in outcome) {
    await writeAudit({ actor: parentActor(p), action: "signin.code_wrong", targetType: "parent", targetId: p.id, after: { try: outcome.wrong }, ip });
    return (outcome.wrong ?? 0) >= CODE_MAX_TRIES ? REJECTED_ENDED : REJECTED;
  }
  // The code was right; the person must still be allowed in now (they may have been blocked or removed since it was
  // sent). Whether the address and the password are still theirs is settled last of all, once the session exists
  // (signinStands).
  const [fresh] = await db.select().from(parent).where(eq(parent.id, p.id));
  const reason = doorStops(await getParentSettings())
    ?? (!fresh || fresh.blocked ? "blocked" : (await enterableGuardianRows(p.id)).length === 0 ? "no_enabled_guardian" : null);
  if (reason) {
    await writeAudit({ actor: parentActor(p), action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason }, ip });
    return REJECTED_ENDED;
  }
  return { ok: true, codeId: outcome.spent };
}

/**
 * A code posted with no pending step this server signed (or one past its end): it signs nobody in, whatever the code.
 * Counted against the check's limit per IP address, as a check is, so it can't be repeated without limit, and audited
 * `signin.refused` (`no_pending_step`), naming nobody, at most once per full window when over the limit.
 */
export async function refuseCodeWithoutStep(ip: string | null, now = new Date()): Promise<"rejected" | "rate_limited"> {
  const byIp = await takeIpLimit("code_check_ip", ip, now);
  if (byIp !== "taken") {
    if (byIp === "first_refusal") await refuse("rate_limited", null, ip, { limit: "check_ip" });
    return "rate_limited";
  }
  await writeAudit({ actor: ANON, action: "signin.refused", after: { reason: "no_pending_step" }, ip });
  return "rejected";
}

/**
 * The last check of a sign-in, made once the session row exists: the address the sign-in was proved with is still the
 * person's, they are not blocked, and what the sign-in proved still stands. Read under the lock an address change, a
 * block or a password reset waits for (lockedPerson), and after the session is stored, so there is no moment in which a
 * session proved with a replaced address, or before a reset, can slip through. A change that committed first is seen
 * here and the caller removes the session; a change that comes later ends the person's sessions itself, and by then
 * this one is stored where it can see it. For every kind of proof, the person's `credential` row is still the one the
 * password was checked against, or the set-up link wrote, by its id and its `updated_at` (`password_changed`
 * otherwise): a reset, or a staff reset, that committed since has replaced the password. Then what else it spent:
 * - a code (from verifySigninCode()): its row is still there (`code_gone` otherwise). A reset that committed first is
 *   caught above as `password_changed`, since it replaces the `credential` row; it also deletes the person's codes
 *   spent within a code's life (choosePasswordFromLink(), password-set.ts), so `code_gone` is a second line behind it.
 *   The daily clean-up keeps a spent code until a code's life has passed since it was spent (cleanUp(), cleanup.ts), so
 *   it never takes one this soon.
 * - a remembered device: its row is still there, the person's and unexpired (`device_gone` otherwise: a block, a reset
 *   or anything else that ends all of a person's sign-in forgets every device).
 * - a set-up link: the link's row is still there and spent (`link_gone` otherwise).
 * Every refusal is audited `signin.refused` with its short reason, and the caller answers it as one refusal.
 */
export async function signinStands(parentId: string, rawEmail: string, ip: string | null, proof: SigninProof, now = new Date()): Promise<boolean> {
  const email = normalizeEmail(rawEmail);
  const seen = await db.transaction(async (tx) => {
    const live = await lockedPerson(tx, parentId);
    const password = "link" in proof ? proof.link : proof.password;
    if (!samePassword(await credentialNow(tx, parentId, password.credentialId), password)) return { live, spent: "password_changed" as const };
    if ("codeId" in proof) {
      const [code] = await tx.select({ id: signinCode.id }).from(signinCode).where(and(eq(signinCode.id, proof.codeId), eq(signinCode.parentId, parentId)));
      return { live, spent: code !== undefined ? null : "code_gone" as const };
    }
    if ("deviceId" in proof) {
      const [device] = await tx.select({ id: parentDevice.id }).from(parentDevice)
        .where(and(eq(parentDevice.id, proof.deviceId), eq(parentDevice.parentId, parentId), gt(parentDevice.expiresAt, now)));
      return { live, spent: device !== undefined ? null : "device_gone" as const };
    }
    const [link] = await tx.select({ usedAt: parentSigninToken.usedAt }).from(parentSigninToken)
      .where(and(eq(parentSigninToken.id, proof.link.linkId), eq(parentSigninToken.parentId, parentId)));
    return { live, spent: !link || link.usedAt === null ? "link_gone" as const : null };
  });
  const { live } = seen;
  if (live && email && live.email === email && !live.blocked && seen.spent === null) return true;
  await writeAudit({ actor: { door: "parent", id: parentId, label: email }, action: "signin.refused", targetType: "parent", targetId: parentId,
    after: { reason: live?.blocked ? "blocked" : !live || !email || live.email !== email ? "address_changed" : seen.spent }, ip });
  return false;
}
