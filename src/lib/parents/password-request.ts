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
import { hashLinkToken, LINK_LIFE_MS, LINK_TOKEN_BYTES, mintSigninLink, type LinkPurpose } from "./signin-links";
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
 * (./password-request-rule.ts), or the send failed.
 */
type NotMailed = "rate_limited" | "not_an_address" | "unknown_email" | "no_sign_in_account" | "blocked" | "no_enabled_guardian"
  | "signins_off" | "mail_not_working" | "strict_no_setup" | "strict_no_factor" | "mail_failed";

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
 *     purpose is what is true at that moment), makes the link (mintSigninLink(), which replaces their unused one of
 *     that purpose) and writes `parent.password.reset_asked`; for any other ask it writes that row alone, after one
 *     keyed hash of a random token of a link's length, as the mint makes, so both paths do the same kind of work. The
 *     mailed path's transaction still does more (the lock, which may wait on a roster write, the checks again and the
 *     mint), so its time can tell an address it mails from others: bounded by the per-address limit, as the code
 *     request's is (requestSigninCode()). Over a limit, only the first refusal of a full window is recorded
 *     (rate-limit.ts), naming no person.
 * Then the mail, to the address read under the lock and no other; a send that fails deletes the link it made, with a
 * row saying so (`mail_failed`): nobody got it. The token is in the mail's body alone: never in an audit row, a log
 * line or the answer.
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

  const stored = await db.transaction(async (tx) => {
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
    const actor = parentActor(live);
    const token = await mintSigninLink(tx, { parentId: live.id, purpose: again.mail, actor, ip, now });
    await audit(live, { outcome: again.mail }, ip, tx);
    return { purpose: again.mail, token, to: live.email, who: { id: live.id, email: live.email } };
  });
  if (!stored) return DONE;

  const delivery = (async () => {
    const brand = await currentBrand();
    const words = { link: passwordLink(stored.purpose, stored.token), life: lifeWords(LINK_LIFE_MS[stored.purpose]) };
    const message = stored.purpose === "setup" ? passwordSetupMessage(brand, stored.to, words) : passwordResetMessage(brand, stored.to, words);
    const sent = await sendMail(message, { purpose: stored.purpose === "setup" ? "password_setup" : "password_reset", actor: parentActor(stored.who), ip });
    if (!sent.ok) await forgetUnsentLink(stored.who, stored.purpose, stored.token, ip);
  })().catch(() => undefined); // every failure above is audited (mail.failed, and the row below); nothing here may surface to the caller
  return { delivery };
}

/**
 * A link whose mail failed: nobody got it, so nobody may use it. Deleted (while still unused) in one transaction with a
 * `parent.password.reset_asked` row saying so, after the person's row, in the order above lockedPerson().
 */
async function forgetUnsentLink(who: Who, purpose: LinkPurpose, token: string, ip: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, who.id)).for("update");
    const gone = await tx.delete(parentSigninToken)
      .where(and(eq(parentSigninToken.tokenHash, hashLinkToken(purpose, token)), eq(parentSigninToken.purpose, purpose), isNull(parentSigninToken.usedAt)))
      .returning({ id: parentSigninToken.id });
    await audit(who, { outcome: "none", reason: "mail_failed", purpose, linksDeleted: gone.length }, ip, tx);
  });
}
