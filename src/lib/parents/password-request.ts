// The page "Set up or reset my password" (/sign-in/password; the sign-in release, slice SI-3a; section 6 of the
// app-owned families spec, "Signing in", and its Appendix A). A visitor with no session types an email address and is
// always answered the same; a person the portal may mail is sent a set-up link (no password yet) or a reset link (a
// password already), and nobody else is sent anything. Server only.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { mailWorking } from "@/lib/mail/settings";
import { currentBrand } from "@/lib/mail/send";
import { passwordResetMessage, passwordSetupMessage } from "@/lib/mail/messages";
import { env } from "@/env";
import { takeRateLimit, type RateLimitTake } from "./rate-limit";
import { enterableGuardianRows, parentActor } from "./sessions";
import { getParentSettings, parentDoorClosed, type ParentSettings } from "./settings";
import { RESEND_AFTER_MS } from "./signin-codes";
import { hashLinkToken, holdSigninLink, linkSentWithin, LINK_LIFE_MS, LINK_TOKEN_BYTES, type LinkPurpose } from "./signin-links";
import { whichLinkToMail } from "./password-request-rule";
import { hasSecondFactor } from "./passkeys";
import { deliverHeldLink, lifeWords, passwordLink, personBy, type HeldLink, type LinkPerson } from "./link-delivery";

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
type Person = LinkPerson;

/** What the reads say: the link to mail, or why none. The order only decides which reason the audit row gives. */
function decide(o: { email: string | null; person: Person | null; counts: boolean; hasFactor: boolean; settings: ParentSettings; mail: boolean }): { mail: LinkPurpose } | { reason: NotMailed } {
  if (!o.email) return { reason: "not_an_address" };
  if (parentDoorClosed(o.settings)) return { reason: "signins_off" };
  if (!o.mail) return { reason: "mail_not_working" };
  if (!o.person) return { reason: "unknown_email" };
  if (o.person.authUserId === null) return { reason: "no_sign_in_account" };
  if (o.person.blocked) return { reason: "blocked" };
  if (!o.counts) return { reason: "no_enabled_guardian" };
  // The person's own second factor: since slice SI-6a their authenticator app in force, and since SI-7a a passkey
  // (hasSecondFactor(), passkeys.ts). Under Strict only a person with one is mailed a reset.
  const rule = whichLinkToMail({ level: o.settings.level, hasPassword: o.person.hasPassword, hasSecondFactor: o.hasFactor });
  return rule.mail !== null ? { mail: rule.mail } : { reason: rule.reason };
}

/** One `parent.password.reset_asked` row: against the person when the address is theirs, otherwise naming nobody. */
async function audit(who: Who | null, after: Record<string, unknown>, ip: string | null, tx?: Tx) {
  await writeAudit({ actor: who ? parentActor(who) : ANON, action: "parent.password.reset_asked", targetType: who ? "parent" : undefined,
    targetId: who?.id, after, ip }, tx);
}

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
 *     working, the person by address with their sign-in account and whether they have a password, their rows that
 *     count, and (since slice SI-6a) whether they have an authenticator app in force (each read for a fixed nobody when
 *     the address is nobody's);
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
 * place, replacing the earlier one (`parent.password.link_made`, deliverHeldLink(), ./link-delivery.ts); otherwise it is removed and the
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
  const [rows, hasFactor] = await Promise.all([enterableGuardianRows(person?.id ?? NOBODY), hasSecondFactor(person?.id ?? NOBODY)]);
  const counts = rows.length > 0;

  const over = byIp !== "taken" ? { take: byIp, limit: "ip" } : byAddress !== "taken" ? { take: byAddress, limit: "email" } : null;
  if (over) {
    hashLinkToken("setup", randomBytes(LINK_TOKEN_BYTES).toString("base64url"));
    if (over.take === "first_refusal") await db.transaction((tx) => audit(null, { outcome: "none", reason: "rate_limited", limit: over.limit }, ip, tx));
    return DONE;
  }
  const decided = decide({ email, person, counts, hasFactor, settings, mail });
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
      ? decide({ email, person: live, counts: liveCounts, hasFactor: await hasSecondFactor(live.id, tx), settings: await getParentSettings(tx), mail: true })
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
    return { linkId, purpose: again.mail, token, to: live.email, who: { id: live.id, email: live.email } };
  });
  if (!held) return DONE;

  // The person's earlier link keeps working until the new one is put in place, and that happens only once its mail has
  // been handed over: a send that fails, or a putting in place that fails (tried once more after a deadlock or a
  // serialization failure), removes the held link instead, each with its own reason (deliverHeldLink(), link-delivery.ts).
  const delivery = deliverHeldLink(held, { message: () => linkMessage(held), purpose: held.purpose === "setup" ? "password_setup" : "password_reset",
    actor: parentActor(held.who), ip, check: (tx, live) => stillToMail(tx, live, held) }).then(() => undefined, () => undefined); // every outcome is audited; nothing here may surface to the caller
  return { delivery };
}

/** The link's mail, to the address read under the lock and no other. */
async function linkMessage(l: HeldLink) {
  const brand = await currentBrand();
  const words = { link: passwordLink(l.purpose, l.token), life: lifeWords(LINK_LIFE_MS[l.purpose]) };
  return l.purpose === "setup" ? passwordSetupMessage(brand, l.to, words) : passwordResetMessage(brand, l.to, words);
}

/**
 * The check again under the person's lock, once the link's mail has been handed over, before it is put in place: as
 * before the mail, the address still the one mailed, and everything else that let it be sent (decide()). When it says
 * no, the reason is that check's; `changed_while_mailing` when the link to mail is now of the other purpose.
 */
async function stillToMail(tx: Tx, live: Person | null, l: HeldLink): Promise<NotSent | null> {
  const counts = live ? (await enterableGuardianRows(live.id, tx)).length > 0 : false;
  const again = live && live.email === l.to
    ? decide({ email: l.to, person: live, counts, hasFactor: await hasSecondFactor(live.id, tx), settings: await getParentSettings(tx), mail: true })
    : { reason: "unknown_email" as const };
  return !("mail" in again) ? again.reason : again.mail !== l.purpose ? "changed_while_mailing" : null;
}
