// Choosing a password from a set-up or reset link (the sign-in release, slice SI-2; section 6 of the app-owned families
// spec, "Signing in"; open questions 23, 27 and 34). The visitor has no session: the link is the guard. Server only.
//
// The portal owns the password: Better Auth's email-and-password routes stay off on the parent door
// (src/lib/auth/parent-auth.ts), and the password is hashed with Better Auth's own scrypt (`better-auth/crypto`) and
// kept as the person's `credential` row of `parent_auth_account`, the row Better Auth's sign-up would write, so that the
// write shares the portal's transaction with its audit row. Nobody is signed in here: a set-up at the club's Standard
// level hands back the proof of what it spent (since slice SI-3a), and the action finishes the sign-in with it through
// the one finish every sign-in goes through (src/lib/auth/parent-link-signin.ts, then parent-signin-finish.ts).
import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { parent, parentAuthAccount, parentSigninToken } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { checkBreach, type BreachCheck } from "./breach-check";
import { markBreachCheck } from "./breach-mark";
import { PASSWORD_COPY } from "./password-copy";
import { checkPasswordRule } from "./password-rule";
import { takeRateLimit, type RateLimitTake } from "./rate-limit";
import { CODE_TTL_MS, type LinkSigninProof } from "./signin-codes";
import { getParentSettings } from "./settings";
import { deleteUnusedSigninCodes, endParentSessions, forgetDevices, parentActor } from "./sessions";
import { hashLinkToken, isLinkPurpose, isLinkToken, linkVerdict, type LinkPurpose, type LinkRefusal } from "./signin-links";

/**
 * What the form is answered: the password is set (with `next`, where to go, when the action signed the parent in), or
 * what went wrong in words. Nothing else of the sign-in reaches the browser.
 */
export type PasswordSetResult = { ok: true; message: string; next?: string } | { ok: false; errors: string[] };

/**
 * A set-up link's sign-in, to be finished: the person, the address the set read under their lock, and the proof of what
 * the set spent (signinStands(), signin-codes.ts, reads it again). Server only: the action passes it to
 * signInFromLink() and never to the browser.
 */
export type LinkSignin = { parentId: string; email: string; proof: LinkSigninProof };

/** What choosePasswordFromLink() gives its action: the answer, and for a set-up at Standard the sign-in to finish. */
export type PasswordSetOutcome = { ok: true; message: string; signIn: LinkSignin | null } | { ok: false; errors: string[] };

/**
 * The most a password field may hold as sent, in UTF-16 units: anything longer is not something a person typed, and is
 * refused as a bad request before anything is counted or read. Longer than the rule's most (checkPasswordRule()), so a
 * password a little over it is told so in words.
 */
export const MOST_SENT = 1024;

/** The one answer for every refusal of the link, its limits and its re-check: nothing tells them apart. */
const REFUSED: PasswordSetOutcome = { ok: false, errors: [PASSWORD_COPY.linkNoGood] };

type Refusal = LinkRefusal | "rate_limited" | "mismatch" | "too_short" | "too_long" | "breached";
type Who = { id: string; email: string } | null;

const anon: Actor = { door: "parent", id: null, label: null };

/** Audited `parent.password.refused` with its short reason, against the person the link named when it named one. */
async function refuse(purpose: LinkPurpose, reason: Refusal, who: Who, ip: string | null, extra: Record<string, unknown> = {}) {
  await writeAudit({ actor: who ? parentActor(who) : anon, action: "parent.password.refused", targetType: who ? "parent" : undefined,
    targetId: who?.id, after: { purpose, reason, ...extra }, ip });
}

/** A full window is audited once (rate-limit.ts): later refusals in the same window are refused the same way, unrecorded. */
async function refuseOverLimit(take: Exclude<RateLimitTake, "taken">, purpose: LinkPurpose, ip: string | null, limit: "ip" | "token") {
  if (take === "first_refusal") await refuse(purpose, "rate_limited", null, ip, { limit });
}

const sent = (v: unknown): v is string => typeof v === "string" && v.length <= MOST_SENT;

/**
 * The form's whole work, in this order (each argument comes from the browser, whatever its type says):
 * (a) the arguments: a purpose, a token of a token's shape (looked up under that purpose only, so a token sent with the
 *     other page's purpose names no link), and two strings of at most MOST_SENT; anything else is a bad request,
 *     answered as a refused link, uncounted and unrecorded;
 * (b) the limits, per IP address first (skipped when the address is unknown: every visitor would share one count) and
 *     then per link, counted under the token's hash, never the token;
 * (c) the link may be used (linkVerdict()), read without a lock, and read over a limit too, its answer unused, so an
 *     over-limit refusal makes the reads a refused link makes;
 * (d) the two passwords match, and meet the rule;
 * (e) the breach check: found is refused in words, not checked is taken and said so in the audit row;
 * (f) the hash;
 * (g) one transaction that checks the link again under the person's lock and sets the password (storePassword()), and,
 *     for a set-up while the club's level is Standard, hands back the sign-in to finish (`signIn`), which the action
 *     finishes after this transaction has committed; null for a reset and under Strict.
 * Every refusal of (b), (c) and (g) is the same one sentence, and runs no rule, breach check or hash. A refusal of (d)
 * or (e) says why and what to do, and leaves the link unspent; the limit per link counts each try. The breach check and
 * the hash run outside any transaction, so nothing is held while the service is asked. Every refusal from (b) on is
 * audited `parent.password.refused`.
 */
export async function choosePasswordFromLink(raw: { purpose: unknown; token: unknown; password: unknown; again: unknown },
  o: { ip: string | null; now?: Date }): Promise<PasswordSetOutcome> {
  const { purpose, token, password, again } = raw;
  if (!isLinkPurpose(purpose) || !isLinkToken(token) || !sent(password) || !sent(again)) return REFUSED;
  const now = o.now ?? new Date();
  const ip = o.ip;

  // Over a limit, the link is still read and its answer thrown away (c). What differs: the audit row (one per full
  // window, rate-limit.ts, naming no person), and, with the address over its limit, nothing is counted for the link.
  const byIp: RateLimitTake = ip === null ? "taken" : await takeRateLimit("password_link_ip", ip, now);
  const byLink: RateLimitTake = byIp === "taken" ? await takeRateLimit("password_link_token", hashLinkToken(purpose, token), now) : "refused";
  const verdict = await linkVerdict(purpose, token, { now });
  if (byIp !== "taken") { await refuseOverLimit(byIp, purpose, ip, "ip"); return REFUSED; }
  if (byLink !== "taken") { await refuseOverLimit(byLink, purpose, ip, "token"); return REFUSED; }
  if (!verdict.ok) { await refuse(purpose, verdict.reason, verdict.who, ip); return REFUSED; }
  const who = { id: verdict.link.parentId, email: verdict.link.email };

  if (password !== again) { await refuse(purpose, "mismatch", who, ip); return { ok: false, errors: [PASSWORD_COPY.mismatch] }; }
  const rule = checkPasswordRule(password);
  if (!rule.ok) {
    const reason = rule.problem === "too_long" ? "too_long" : "too_short";
    await refuse(purpose, reason, who, ip);
    return { ok: false, errors: [reason === "too_long" ? PASSWORD_COPY.tooLong : PASSWORD_COPY.tooShort] };
  }

  const breach = await checkBreach(password);
  await markBreachCheck(breach);
  if (breach.outcome === "found") { await refuse(purpose, "breached", who, ip); return { ok: false, errors: [PASSWORD_COPY.breached] }; }

  const hash = await hashPassword(password);
  const stored = await storePassword({ purpose, token, hash, breach, ip, now: o.now });
  if (!stored.ok) { await refuse(purpose, stored.reason, stored.who, ip); return REFUSED; }
  return { ok: true, message: PASSWORD_COPY.set, signIn: stored.signIn };
}

/**
 * The write, in one transaction with its audit row. The person's row is taken FOR UPDATE first, so two submits for one
 * person (the same link twice, or a set-up beside a reset) take turns. Under that lock the link is checked again (its
 * row FOR UPDATE, still unused and unexpired, still no password for a set-up, not blocked, a row that counts, the door
 * open), at the time the lock was had (a slow breach check or a wait for the person's row must not stretch a link's
 * life), and a refusal changes nothing. The link's row is so taken right after the person's, ahead of the codes: the one
 * step out of the order above lockedPerson() (./sessions.ts), which says why it is safe; the rest follows that order.
 * Then: for a reset, the person's unused sign-in codes go (until the code stops being a way in by itself, a reset that
 * left one would leave a way in), and so do those spent within a code's life (CODE_TTL_MS), so a code sign-in that
 * spent its code before the reset and makes its session after it is refused at its last check (signinStands(),
 * signin-codes.ts, which reads the code it spent again under the person's lock); the link is spent; the person's
 * `credential` row is replaced, or made when there is none, so a person never has two; and for a reset every remembered device is forgotten and every session ended (open
 * question 23). A set-up ends nothing. Audited `parent.password.set`, never with the password, its hash, the token or
 * its hash.
 *
 * The hash is a parameter of the write, and a failed query's error carries its parameters (drizzle's message names
 * them), so a failure is thrown again as a short code with nothing of the query: a password's hash never reaches the
 * server's log. `now` is for tests only; otherwise the time is read once the person's row is held.
 */
async function storePassword(o: { purpose: LinkPurpose; token: string; hash: string; breach: Exclude<BreachCheck, { outcome: "found" }>; ip: string | null; now?: Date }):
  Promise<{ ok: true; signIn: LinkSignin | null } | { ok: false; reason: LinkRefusal; who: Who }> {
  try {
    return await writePassword(o);
  } catch {
    throw new Error("password_store_failed");
  }
}

async function writePassword(o: { purpose: LinkPurpose; token: string; hash: string; breach: Exclude<BreachCheck, { outcome: "found" }>; ip: string | null; now?: Date }):
  Promise<{ ok: true; signIn: LinkSignin | null } | { ok: false; reason: LinkRefusal; who: Who }> {
  return db.transaction(async (tx) => {
    const [named] = await tx.select({ parentId: parentSigninToken.parentId }).from(parentSigninToken)
      .where(and(eq(parentSigninToken.tokenHash, hashLinkToken(o.purpose, o.token)), eq(parentSigninToken.purpose, o.purpose)));
    if (!named) return { ok: false as const, reason: "unknown" as const, who: null };
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, named.parentId)).for("update");
    const now = o.now ?? new Date();
    const verdict = await linkVerdict(o.purpose, o.token, { now, tx, lock: true });
    if (!verdict.ok) return { ok: false as const, reason: verdict.reason, who: verdict.who };
    const link = verdict.link;
    const reset = o.purpose === "reset";
    // The club's level, read under the person's lock with the rest of the link's check: a set-up signs in at Standard
    // only (under Strict a later slice leads to a passkey or an authenticator app first), and a reset never does.
    const { level } = await getParentSettings(tx);

    // A code spent within a code's life goes too: a sign-in that spent it just before this reset, and makes its session
    // just after, finds it gone at its last check (signinStands()) and is refused.
    const codesDeleted = reset ? await deleteUnusedSigninCodes(link.parentId, tx, { spentSince: new Date(now.getTime() - CODE_TTL_MS) }) : 0;
    await tx.update(parentSigninToken).set({ usedAt: now }).where(eq(parentSigninToken.id, link.tokenId));
    const [had] = await tx.select({ id: parentAuthAccount.id }).from(parentAuthAccount)
      .where(and(eq(parentAuthAccount.userId, link.authUserId), eq(parentAuthAccount.providerId, "credential"))).for("update");
    const credentialId = had?.id ?? randomUUID();
    if (had) {
      await tx.update(parentAuthAccount).set({ password: o.hash, updatedAt: now }).where(eq(parentAuthAccount.id, had.id));
    } else {
      // As Better Auth's own sign-up links a credential account: the account id is the user's own id.
      await tx.insert(parentAuthAccount).values({ id: credentialId, accountId: link.authUserId, providerId: "credential", userId: link.authUserId,
        password: o.hash, createdAt: now, updatedAt: now });
    }
    const devicesForgotten = reset ? await forgetDevices(link.parentId, tx) : 0;
    const sessionsEnded = reset ? await endParentSessions(link.parentId, tx) : 0;

    await writeAudit({ actor: parentActor({ id: link.parentId, email: link.email }), action: "parent.password.set", targetType: "parent", targetId: link.parentId,
      after: { purpose: o.purpose, replaced: Boolean(had), breachChecked: o.breach.outcome === "not_found",
        ...(o.breach.outcome === "not_checked" ? { breachNotChecked: o.breach.why } : {}),
        ...(reset ? { codesDeleted, devicesForgotten, sessionsEnded } : {}) }, ip: o.ip }, tx);
    // The proof of what this set spent: its link, now spent, and the password row as written here. The sign-in's last
    // check reads both again under the person's lock, so a reset or a block that commits in between refuses it.
    const signIn: LinkSignin | null = o.purpose === "setup" && level === "standard"
      ? { parentId: link.parentId, email: link.email, proof: { linkId: link.tokenId, credentialId, credentialUpdatedAt: now } } : null;
    return { ok: true as const, signIn };
  });
}
