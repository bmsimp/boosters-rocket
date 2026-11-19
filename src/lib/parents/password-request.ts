// The page "Set up or reset my password" (/sign-in/password; the sign-in release, slice SI-3a; section 6 of the
// app-owned families spec, "Signing in", and its Appendix A). A visitor with no session types an email address and is
// always answered the same; a person the portal may mail is sent a set-up link (no password yet) or a reset link (a
// password already), and nobody else is sent anything. Server only.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent, parentAuthAccount, parentAuthUser, parentSigninToken } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { mailWorking } from "@/lib/mail/settings";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { passwordResetMessage, passwordSetupMessage } from "@/lib/mail/messages";
import { env } from "@/env";
import { takeRateLimit, type RateLimitTake } from "./rate-limit";
import { enterableGuardianRows, parentActor } from "./sessions";
import { getParentSettings, parentDoorClosed, type ParentSettings } from "./settings";
import { RESEND_AFTER_MS } from "./signin-codes";
import { dropHeldLink, hashLinkToken, holdSigninLink, linkSentWithin, LINK_LIFE_MS, LINK_TOKEN_BYTES, putHeldLinkInPlace, type LinkPurpose } from "./signin-links";
import { whichLinkToMail } from "./password-request-rule";

/** The most an address field may hold as sent: anything longer, or anything not a string, gets the answer and nothing else. */
export const MOST_ASKED = 320;

/**
 * The key a per-address count is kept under: an HMAC-SHA256 keyed with the server secret over a string that names its
 * purpose, as a link's token is hashed (hashLinkToken(), signin-links.ts), so no `rate_limit_event` row holds an
 * address, an outsider's least of all.
 */
export const hashAskedAddress = (address: string): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`password-ask:${address}`).digest("hex");

/**
 * Why nothing was mailed, for the `parent.password.reset_asked` row only: over a limit, not an address, nobody's sign-in
 * address, no sign-in account, blocked, no guardian row that counts, sign-ins off, mail not working, the Strict rules
 * (./password-request-rule.ts), or a link of that purpose sent less than the resend wait ago (resend_wait).
 */
type NotMailed = "rate_limited" | "not_an_address" | "unknown_email" | "no_sign_in_account" | "blocked" | "no_enabled_guardian"
  | "signins_off" | "mail_not_working" | "strict_no_setup" | "strict_no_factor" | "resend_wait";
/**
 * Why a link held on its way was never put in place, for the `parent.password.link_not_sent` row only: a check under
 * the person's lock that now says no (a reason of decide()); the link to send is now of the other purpose, or an end of
 * the person's sign-in or a password reset removed it (changed_while_mailing); a link made since replaced it
 * (superseded); the mail was not handed over (mail_failed); or it was, and putting the link in place then failed, so
 * the person holds a mail whose link never works (not_put_in_place).
 */
type NotSent = NotMailed | "changed_while_mailing" | "superseded" | "mail_failed" | "not_put_in_place";

/** No person has this id: the rows of an address nobody holds are read for it, so every ask makes the same reads. */
const NOBODY = "00000000-0000-0000-0000-000000000000";
/** Who asked, when the address is nobody's: no id, no label, and never the address typed. */
const ANON: Actor = { door: "parent", id: null, label: null };
const DONE: { delivery: Promise<void> } = { delivery: Promise.resolve() };

type Who = { id: string; email: string };
type Person = { id: string; email: string; blocked: boolean; authUserId: string | null; hasPassword: boolean };

/** The person who holds the address, with their sign-in account and whether they have a password; in `tx` when given. */
async function personBy(where: { email: string } | { id: string }, tx?: Tx): Promise<Person | null> {
  const [row] = await (tx ?? db).select({
    id: parent.id, email: parent.email, blocked: parent.blocked, authUserId: parentAuthUser.id,
    hasPassword: sql<boolean>`exists (select 1 from ${parentAuthAccount} where ${parentAuthAccount.userId} = ${parentAuthUser.id} and ${parentAuthAccount.providerId} = 'credential')`,
  }).from(parent).leftJoin(parentAuthUser, eq(parentAuthUser.parentId, parent.id))
    .where("email" in where ? eq(parent.email, where.email) : eq(parent.id, where.id));
  return row ? { ...row, hasPassword: row.hasPassword === true } : null;
}

/** What the reads say: the link to mail, or why none. The order only decides which reason the audit row gives. */
function decide(o: { email: string | null; person: Person | null; counts: boolean; settings: ParentSettings; mail: boolean }): { mail: LinkPurpose } | { reason: NotMailed } {
  if (!o.email) return { reason: "not_an_address" };
  if (parentDoorClosed(o.settings)) return { reason: "signins_off" };
  if (!o.mail) return { reason: "mail_not_working" };
  if (!o.person) return { reason: "unknown_email" };
  if (o.person.authUserId === null) return { reason: "no_sign_in_account" };
  if (o.person.blocked) return { reason: "blocked" };
  if (!o.counts) return { reason: "no_enabled_guardian" };
  // SI-6 (the authenticator app) and SI-7 (passkeys) give hasSecondFactor its value; until then nobody has one.
  const rule = whichLinkToMail({ level: o.settings.level, hasPassword: o.person.hasPassword, hasSecondFactor: false });
  return rule.mail !== null ? { mail: rule.mail } : { reason: rule.reason };
}

/** One `parent.password.reset_asked` row: against the person when the address is theirs, otherwise naming nobody. */
async function audit(who: Who | null, after: Record<string, unknown>, ip: string | null, tx?: Tx) {
  await writeAudit({ actor: who ? parentActor(who) : ANON, action: "parent.password.reset_asked", targetType: who ? "parent" : undefined,
    targetId: who?.id, after, ip }, tx);
}

/**
 * What became of a link held on its way, when it was not put in place: one `parent.password.link_not_sent` row, in the
 * transaction that makes that true. (Put in place, its row is `parent.password.link_made`, putHeldLinkInPlace().)
 */
async function notSent(who: Who, purpose: LinkPurpose, reason: NotSent, ip: string | null, tx: Tx) {
  await writeAudit({ actor: parentActor(who), action: "parent.password.link_not_sent", targetType: "parent", targetId: who.id,
    after: { purpose, reason }, ip }, tx);
}

/** Postgres ended the transaction to break a deadlock (40P01), or for a serialization failure (40001): worth one more try. */
function worthAnotherTry(e: unknown): boolean {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  const c = code(e) ?? code((e as { cause?: unknown } | null)?.cause);
  return c === "40P01" || c === "40001";
}

/** A link's life in words, for its mail: "1 hour", "7 days". */
export function lifeWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** The address a link opens: the portal's own address and the link's page, built as the email change builds its link. */
export const passwordLink = (purpose: LinkPurpose, token: string) =>
  `${env.APP_URL.replace(/\/+$/, "")}/sign-in/${purpose === "setup" ? "set-up" : "reset"}/${token}`;

/**
 * An ask, decided and stored; the mail goes out in `delivery`. The caller answers with the one sentence whatever
 * happened here, and must not await `delivery`. In this order (each argument comes from the browser):
 * (a) the argument: a string of at most MOST_ASKED characters; anything else is answered and nothing else, uncounted and
 *     unrecorded;
 * (b) the limit per IP address (skipped when the address is unknown: every visitor would share one count);
 * (c) the address, read with normalizeEmail(), and the limit per address, counted under hashAskedAddress(), never the
 *     address (what was typed, lower-cased, when it is no address), and not counted while the IP address is over its
 *     limit;
 * (d) the reads, the same whoever the address names: the parents' settings (the door and the level), whether mail is
 *     working, the person by address with their sign-in account and whether they have a password, and their rows that
 *     count (read for a fixed nobody when the address is nobody's);
 * (e) the rule (decide(), whichLinkToMail());
 * (f) one transaction, whatever the address: for a person to be mailed it takes the person's row first (the order
 *     above lockedPerson(), ./sessions.ts), checks everything again under that lock (the address still theirs, not
 *     blocked, a sign-in account, a row that counts, the door open, and whether they have a password, so the link's
 *     purpose is what is true at that moment), then the resend wait: while a link of that purpose sent less than
 *     RESEND_AFTER_MS ago (the code's own wait) may be in the mailbox unused, or is on its way, nothing is made or
 *     mailed and the row says `resend_wait`. Otherwise it holds a new link (holdSigninLink(): stored, but working for
 *     nobody yet, beside the person's earlier unused one, which it doesn't touch) and writes the ask's row with the
 *     link's purpose, on its way (`{ outcome, link: "on_its_way" }`); for any other ask it writes `parent.password.reset_asked` alone, after one keyed hash of a random token of a link's
 *     length, as the hold makes, so both paths do the same kind of work. The mailed path's transaction still does
 *     more (the lock, which may wait on a roster write, the checks again and the hold), so its time can tell an
 *     address it mails from others: bounded by the per-address limit, as the code request's is (requestSigninCode()).
 *     Over a limit, only the first refusal of a full window is recorded (rate-limit.ts), naming no person.
 * So every ask past (a) has exactly one `parent.password.reset_asked` row, written in the transaction that decided it.
 * Then the mail, to the address read under the lock and no other. What becomes of the held link is a second fact with
 * its own row, written in the transaction that makes it true: once the mail has been handed over the link is put in
 * place, replacing the earlier one (`parent.password.link_made`, putLinkInPlace()); otherwise it is removed and the
 * earlier one left working (`parent.password.link_not_sent`, with its reason). An ask whose process stopped mid-way
 * keeps its `reset_asked` row with no row after it: that is its trace, and the held link is a spent one to the
 * clean-up. So an ask that never reached the person never takes a link from them. The token is in the mail's body
 * alone: never in an audit row, a log line or the answer.
 */
export async function askForPasswordLink(raw: unknown, ip: string | null, now = new Date()): Promise<{ delivery: Promise<void> }> {
  if (typeof raw !== "string" || raw.length > MOST_ASKED) return DONE;
  const byIp: RateLimitTake = ip === null ? "taken" : await takeRateLimit("password_ask_ip", ip, now);
  const email = normalizeEmail(raw);
  const byAddress: RateLimitTake = byIp === "taken" ? await takeRateLimit("password_ask_email", hashAskedAddress(email ?? raw.trim().toLowerCase()), now) : "refused";
  const [settings, mail, person] = await Promise.all([getParentSettings(), mailWorking(), email ? personBy({ email }) : Promise.resolve(null)]);
  const counts = (await enterableGuardianRows(person?.id ?? NOBODY)).length > 0;

  const over = byIp !== "taken" ? { take: byIp, limit: "ip" } : byAddress !== "taken" ? { take: byAddress, limit: "email" } : null;
  if (over) {
    hashLinkToken("setup", randomBytes(LINK_TOKEN_BYTES).toString("base64url"));
    if (over.take === "first_refusal") await db.transaction((tx) => audit(null, { outcome: "none", reason: "rate_limited", limit: over.limit }, ip, tx));
    return DONE;
  }
  const decided = decide({ email, person, counts, settings, mail });
  const who = person ? { id: person.id, email: person.email } : null;
  if (!("mail" in decided) || !person) {
    hashLinkToken("setup", randomBytes(LINK_TOKEN_BYTES).toString("base64url"));
    await db.transaction((tx) => audit(who, { outcome: "none", reason: "mail" in decided ? "unknown_email" : decided.reason }, ip, tx));
    return DONE;
  }

  const held = await db.transaction(async (tx) => {
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, person.id)).for("update");
    const live = await personBy({ id: person.id }, tx);
    const liveCounts = live ? (await enterableGuardianRows(live.id, tx)).length > 0 : false;
    // The address was read before this transaction: a change since that took it from this person makes it nobody's
    // here, refused as an address never on file.
    const again = live && live.email === email
      ? decide({ email, person: live, counts: liveCounts, settings: await getParentSettings(tx), mail: true })
      : { reason: "unknown_email" as const };
    if (!("mail" in again) || !live) {
      await audit(who, { outcome: "none", reason: "mail" in again ? "unknown_email" : again.reason }, ip, tx);
      return null;
    }
    // The resend wait: a link of this purpose sent a moment ago, or on its way, may be in the mailbox unused; another
    // would replace it, so nothing is mailed or made (the limits counted this ask already).
    if (await linkSentWithin(tx, { parentId: live.id, purpose: again.mail, now, withinMs: RESEND_AFTER_MS })) {
      await audit(live, { outcome: "none", reason: "resend_wait", purpose: again.mail }, ip, tx);
      return null;
    }
    const { linkId, token } = await holdSigninLink(tx, { parentId: live.id, purpose: again.mail, now });
    await audit(live, { outcome: again.mail, link: "on_its_way" }, ip, tx);
    return { linkId, madeAt: now, purpose: again.mail, token, to: live.email, who: { id: live.id, email: live.email } };
  });
  if (!held) return DONE;

  // The person's earlier link keeps working until the new one is put in place, and that happens only once its mail has
  // been handed over: a send that fails, or a putting in place that fails (tried once more after a deadlock or a
  // serialization failure), removes the held link instead, each with its own reason.
  const delivery = (async () => {
    const sent = await mailLink(held, ip).catch(() => false);
    if (!sent) { await forgetUnsentLink(held, ip, "mail_failed"); return; }
    try {
      await putLinkInPlace(held, ip).catch((e: unknown) => { if (worthAnotherTry(e)) return putLinkInPlace(held, ip); throw e; });
    } catch {
      await forgetUnsentLink(held, ip, "not_put_in_place");
    }
  })().catch(() => undefined); // every outcome above is audited (mail.failed, and the rows below); nothing here may surface to the caller
  return { delivery };
}

/** A held link on its way (holdSigninLink(), signin-links.ts): its token, which only its mail carries, and who it is for. */
type Held = { linkId: string; madeAt: Date; purpose: LinkPurpose; token: string; to: string; who: Who };

/** The link's mail, to the address read under the lock and no other. Whether it was handed over. */
async function mailLink(l: Held, ip: string | null): Promise<boolean> {
  const brand = await currentBrand();
  const words = { link: passwordLink(l.purpose, l.token), life: lifeWords(LINK_LIFE_MS[l.purpose]) };
  const message = l.purpose === "setup" ? passwordSetupMessage(brand, l.to, words) : passwordResetMessage(brand, l.to, words);
  return (await sendMail(message, { purpose: l.purpose === "setup" ? "password_setup" : "password_reset", actor: parentActor(l.who), ip })).ok;
}

/**
 * A link whose mail was handed over, put in place (putHeldLinkInPlace()) once the person is checked again under their
 * lock, as before the mail: the address still the one mailed, and everything else that let it be sent. An end of the
 * person's sign-in meanwhile (blocking, a last membership closed, a change of address, sign-ins switched off) deleted
 * the held link with the unused ones (unspentLink, ./link-state.ts), so it stays gone even when the person is let in
 * again before the mail is handed over; a newer link made meanwhile (mintSigninLink()) deleted it too, and wins. Put in
 * place, its row is `parent.password.link_made`. When the check says no, the held link is removed and one
 * `parent.password.link_not_sent` row gives the reason (`changed_while_mailing` when the link to mail is now of the
 * other purpose); when the link is no longer held, nothing is removed and the row says `superseded` (a newer link) or
 * `changed_while_mailing` (an end of the person's sign-in, or a password reset). Throws when the transaction fails.
 */
async function putLinkInPlace(l: Held, ip: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, l.who.id)).for("update");
    const live = await personBy({ id: l.who.id }, tx);
    const counts = live ? (await enterableGuardianRows(live.id, tx)).length > 0 : false;
    const again = live && live.email === l.to
      ? decide({ email: l.to, person: live, counts, settings: await getParentSettings(tx), mail: true })
      : { reason: "unknown_email" as const };
    const reason: NotSent | null = !("mail" in again) ? again.reason : again.mail !== l.purpose ? "changed_while_mailing" : null;
    if (reason === null && live) {
      const put = await putHeldLinkInPlace(tx, { linkId: l.linkId, parentId: live.id, purpose: l.purpose, madeAt: l.madeAt, actor: parentActor(live), ip });
      if (put !== "put") await notSent(l.who, l.purpose, put === "superseded" ? "superseded" : "changed_while_mailing", ip, tx);
      return;
    }
    await dropHeldLink(tx, l.linkId);
    await notSent(l.who, l.purpose, reason ?? "changed_while_mailing", ip, tx);
  });
}

/**
 * A link whose mail was not handed over (`mail_failed`), or was and whose putting in place then failed
 * (`not_put_in_place`): nobody may use it. Under the person's row, in the order above lockedPerson(), it looks first:
 * a link that is live after all (the putting in place committed and only its answer was lost) is left as it is, with no
 * row. Otherwise the held link is removed with one `parent.password.link_not_sent` row giving the reason. The person's
 * earlier link, if any, was never touched and still works.
 */
async function forgetUnsentLink(l: Held, ip: string | null, reason: "mail_failed" | "not_put_in_place"): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, l.who.id)).for("update");
    const [live] = await tx.select({ id: parentSigninToken.id }).from(parentSigninToken)
      .where(and(eq(parentSigninToken.id, l.linkId), isNull(parentSigninToken.usedAt)));
    if (live) return;
    await dropHeldLink(tx, l.linkId);
    await notSent(l.who, l.purpose, reason, ip, tx);
  });
}
