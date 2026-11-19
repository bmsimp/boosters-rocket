import { and, asc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent, parentSigninToken } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { getStoredMailConfig, mailWorking } from "@/lib/mail/settings";
import { choosePasswordMessage, welcomeMessage, type EarlierLinkWords, type SetupLinkWords } from "@/lib/mail/messages";
import type { MailMessage } from "@/lib/mail/types";
import { failedLast, markJob, readMark, WELCOME_MARK } from "@/lib/jobs/marks";
import type { StaffOp } from "./people";
import { getParentSettings, parentDoorClosed } from "./settings";
import { enterableGuardianRows, hasRowThatCounts, studentsRuleInForce } from "./sessions";
import { RESEND_AFTER_MS } from "./signin-codes";
import { heldLink } from "./link-state";
import { holdSigninLink, linkSentWithin, LINK_LIFE_MS } from "./signin-links";
import { deliverHeldLink, lifeWords, passwordLink, personBy, portalAddress, type HeldLink, type LinkPerson } from "./link-delivery";

export const WELCOME_BATCH = 5;
export const WELCOME_RETRY_MS = 15 * 60_000;
const WELCOME_ACTOR: Actor = { door: "system", id: null, label: "welcome" };

/** The club's own sending address, which a reply reaches (spec §3). Both settings hold a bare address. */
async function contactAddress(): Promise<string | null> {
  const stored = await getStoredMailConfig();
  return stored ? (stored.method === "graph" ? stored.mailbox : stored.from) : null;
}

/**
 * Which mail a person is sent: the welcome, or, for a person the club welcomed before who is owed a mail again (the
 * Admin's press on the parents' settings page, oweSetupMails(), ./switches.ts, is the one thing that owes a mail to
 * someone welcomed already), the mail with a link to choose their password (choosePasswordMessage()). Each is also its
 * MailPurpose, and the `mail` of its audit rows.
 */
type Mail = "welcome" | "choose_password";

/**
 * The mail as the worker and a resend write it, and as the settings show it as a sample: one function, so a sample is
 * the mail that goes. `link`: a new set-up link, the one emailed earlier (EarlierLinkWords, the welcome only), or none.
 */
async function writeMail(mail: Mail, to: string, link: SetupLinkWords | EarlierLinkWords | null): Promise<MailMessage> {
  const appUrl = portalAddress();
  const [brand, contact] = await Promise.all([currentBrand(), contactAddress()]);
  return mail === "choose_password" && link && "url" in link ? choosePasswordMessage(brand, to, { appUrl, contact, link }) : welcomeMessage(brand, to, { appUrl, contact, link });
}

/** A sample's link: plainly a sample, never a token's shape. Nothing is made, held or read for it. */
async function sampleLink(): Promise<SetupLinkWords> {
  const settings = await getParentSettings();
  return { url: `${portalAddress()}/sign-in/set-up/(a link made for each person)`, life: lifeWords(LINK_LIFE_MS.setup), strict: settings.level === "strict" };
}

/** The welcome email as it would go to `to`, with no password yet: step 2 of the settings shows it as a sample. */
export async function sampleWelcome(to: string): Promise<MailMessage> {
  return writeMail("welcome", to, await sampleLink());
}

/** The mail the Admin's press sends someone welcomed before, as it would go to `to`: the parents' settings show it beside the press. */
export async function sampleChoosePassword(to: string): Promise<MailMessage> {
  return writeMail("choose_password", to, await sampleLink());
}

/**
 * Takes one person for sending, in a single statement: it succeeds for one run only, and only while the person is still
 * owed, not blocked, not tried in the last 15 minutes, and has a guardian row that counts (`counts`, hasRowThatCounts():
 * the rule the gate lets them in by). The claim time is the back-off after a failure.
 */
async function claim(id: string, now: Date, counts: SQL): Promise<boolean> {
  const rows = await db.update(parent).set({ welcomeTriedAt: now })
    .where(and(eq(parent.id, id), eq(parent.welcomeOwed, true), eq(parent.blocked, false), counts,
      or(isNull(parent.welcomeTriedAt), lt(parent.welcomeTriedAt, new Date(now.getTime() - WELCOME_RETRY_MS)))))
    .returning({ id: parent.id });
  return rows.length > 0;
}
const welcomesOn = async () => { const s = await getParentSettings(); return s.welcome && s.signin; };

/** Who sends and is recorded: the worker (no permission), or the staff member who pressed Resend. */
type Sender = { actor: Actor; permission?: string; ip: string | null };
/** The worker's welcome (it reads the switches and the owed mark again) or a staff resend (it reads only the door, as before). */
type Kind = { worker: true } | { worker: false };

/**
 * What the read under the person's lock found. `go`: the mail to send, to the address read under the lock, with a set-up
 * link held for it (holdSigninLink()) when the person has no password, or none; `earlier` for the worker's welcome to a
 * person who holds a set-up link that still works, which goes with no new link and says that one still works. Otherwise
 * why not: for a resend, the refusals as before; for the worker, nothing to send now (`quiet`: switched off, no longer
 * owed, blocked, no row that counts or no sign-in account since the claim; it stays as it is), a press mail skipped for
 * a password chosen since or a set-up link that still works (`skipped`, its row written), or a mail to someone whose
 * set-up link from another sender is on its way, or a press mail to someone sent a set-up link a moment ago (`wait`,
 * still owed). A resend is refused (`on_its_way`) while another set-up link is on its way to the person (the worker's
 * welcome, an ask on "Set up or reset my password"), and for RESEND_AFTER_MS after the portal last mailed them one
 * (setupMailedJustNow()): its link would replace the one in that mail, which may not even have been opened yet.
 */
type Prepared =
  | { go: true; to: string; mail: Mail; held: HeldLink | null; earlier: boolean; strict: boolean }
  | { go: false; why: "not_found" | "blocked" | "no_access" | "on_its_way" | "quiet" | "skipped" | "wait" };

/**
 * The person's set-up links as a welcome reads them under the person's lock: one held on its way, made less than
 * RESEND_AFTER_MS ago (another sender's mail is going; a link held longer ago belongs to a send the portal never came
 * back to), and one that still works (unused and not expired, however old).
 */
async function setupLinks(tx: Tx, parentId: string, now: Date): Promise<{ onItsWay: boolean; works: boolean }> {
  const rows = await tx.select({ usedAt: parentSigninToken.usedAt }).from(parentSigninToken)
    .where(and(eq(parentSigninToken.parentId, parentId), eq(parentSigninToken.purpose, "setup"),
      or(and(isNull(parentSigninToken.usedAt), gt(parentSigninToken.expiresAt, now)),
        and(heldLink, gt(parentSigninToken.createdAt, new Date(now.getTime() - RESEND_AFTER_MS))))));
  return { onItsWay: rows.some((r) => r.usedAt !== null), works: rows.some((r) => r.usedAt === null) };
}

/**
 * For a resend: whether the portal mailed this person a set-up link less than RESEND_AFTER_MS ago that may be in their
 * mailbox unopened, which a new link would stop working (a double press, or two staff members pressing at once): one
 * made in that time and live or on its way (linkSentWithin(), the request page's resend wait), or a link that still
 * works while their last welcome or press mail went in that time (`welcomed_at` is written once its link was put in
 * place, so this counts from then, not from when the link was made).
 */
async function setupMailedJustNow(tx: Tx, parentId: string, o: { welcomedAt: Date | null; linkWorks: boolean; now: Date }): Promise<boolean> {
  if (o.linkWorks && o.welcomedAt !== null && o.welcomedAt.getTime() > o.now.getTime() - RESEND_AFTER_MS) return true;
  return linkSentWithin(tx, { parentId, purpose: "setup", now: o.now, withinMs: RESEND_AFTER_MS });
}

async function prepare(parentId: string, kind: Kind, by: Sender): Promise<Prepared> {
  return db.transaction(async (tx): Promise<Prepared> => {
    // The person's row first, in the order above lockedPerson() (./sessions.ts); then everything is read again under it.
    const [row] = await tx.select({ welcomedAt: parent.welcomedAt, welcomeOwed: parent.welcomeOwed }).from(parent).where(eq(parent.id, parentId)).for("update");
    // The moment's time, read once the lock is held, never the wake's: a batch's earlier sends can take a minute or
    // more, and every read below of whether a link is on its way or still works, and the life of a link held here, go
    // by when this person's turn came. Other senders judge "on its way" by their own clock, so a link held with the
    // wake's start time would already look too old to them.
    const now = new Date();
    const live = row ? await personBy({ id: parentId }, tx) : null;
    if (!row || !live) return { go: false, why: kind.worker ? "quiet" : "not_found" };
    const settings = await getParentSettings(tx);
    const counts = (await enterableGuardianRows(live.id, tx)).length > 0;
    if (kind.worker) {
      if (!settings.signin || !settings.welcome || parentDoorClosed(settings) || !row.welcomeOwed || live.blocked || !counts || live.authUserId === null) return { go: false, why: "quiet" };
    } else {
      if (live.blocked) return { go: false, why: "blocked" };
      // Only to someone the gate would let in: the door open, a row that counts, and a sign-in account (nothing signs in without one).
      if (parentDoorClosed(settings) || !counts || live.authUserId === null) return { go: false, why: "no_access" };
    }
    const mail: Mail = kind.worker && row.welcomedAt !== null ? "choose_password" : "welcome";
    if (mail === "choose_password" && live.hasPassword) {
      // A press mail for someone who has chosen a password since the press: nothing to choose, so it isn't sent.
      await tx.update(parent).set({ welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, live.id));
      await writeAudit({ actor: by.actor, action: "parent.welcome.skipped", targetType: "parent", targetId: live.id, after: { to: live.email, mail, reason: "has_password" }, ip: by.ip }, tx);
      return { go: false, why: "skipped" };
    }
    const strict = settings.level === "strict";
    if (live.hasPassword) return { go: true, to: live.email, mail, held: null, earlier: false, strict };
    // Another sender's set-up link on its way (a resend and the worker at once, or an ask on the request page): this
    // mail's link would replace it once both were handed over, so the first mail's link wouldn't work. The worker
    // waits, owed, for a later wake; a resend is refused in words.
    const links = await setupLinks(tx, live.id, now);
    if (links.onItsWay) return { go: false, why: kind.worker ? "wait" : "on_its_way" };
    // No mail the portal sends by itself destroys a link that still works: only a deliberate act does (a parent's own
    // ask on the request page, or a staff member's Resend, whose purpose is a fresh link).
    if (mail === "choose_password") {
      // The resend wait of the request page: a set-up link sent a moment ago may be in the mailbox unused, and the
      // press's mail would replace it. It waits, owed, for a later wake.
      if (await linkSentWithin(tx, { parentId: live.id, purpose: "setup", now, withinMs: RESEND_AFTER_MS })) return { go: false, why: "wait" };
      // A set-up link that still works, made longer ago (asked for since the press): they have one to choose a password
      // with, and the press's mail would only replace it. It isn't sent.
      if (links.works) {
        await tx.update(parent).set({ welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, live.id));
        await writeAudit({ actor: by.actor, action: "parent.welcome.skipped", targetType: "parent", targetId: live.id, after: { to: live.email, mail, reason: "has_live_link" }, ip: by.ip }, tx);
        return { go: false, why: "skipped" };
      }
    } else if (kind.worker && links.works) {
      // The worker's welcome (a first one, or one tried again) to a person who holds a set-up link that still works,
      // whoever sent it (they asked on the request page, or an earlier try's mail went and its link was put in place):
      // it goes now, once, with no new link, saying the one emailed earlier still works.
      return { go: true, to: live.email, mail, held: null, earlier: true, strict };
    } else if (!kind.worker && (await setupMailedJustNow(tx, live.id, { welcomedAt: row.welcomedAt, linkWorks: links.works, now }))) {
      // A resend within a minute of the last set-up link the portal mailed them would stop that link working.
      return { go: false, why: "on_its_way" };
    }
    const { linkId, token } = await holdSigninLink(tx, { parentId: live.id, purpose: "setup", now });
    return { go: true, to: live.email, mail, strict, earlier: false, held: { linkId, purpose: "setup", token, to: live.email, who: { id: live.id, email: live.email } } };
  });
}

/**
 * The check again under the person's lock before a welcome's link is put in place: the address still the one mailed,
 * the door open, a sign-in account, not blocked, a row that counts, and still no password. The Strict rule of the
 * request page (whichLinkToMail()) is not asked: under Strict the club resends the welcome (open question 34).
 */
async function stillToWelcome(tx: Tx, live: LinkPerson | null, to: string): Promise<string | null> {
  if (!live || live.email !== to) return "unknown_email";
  if (parentDoorClosed(await getParentSettings(tx))) return "signins_off";
  if (live.authUserId === null) return "no_sign_in_account";
  if (live.blocked) return "blocked";
  if ((await enterableGuardianRows(live.id, tx)).length === 0) return "no_enabled_guardian";
  return live.hasPassword ? "has_password" : null;
}

const message = (p: Extract<Prepared, { go: true }>): Promise<MailMessage> => writeMail(p.mail, p.to,
  p.held ? { url: passwordLink("setup", p.held.token), life: lifeWords(LINK_LIFE_MS.setup), strict: p.strict } : p.earlier ? { earlier: true, strict: p.strict } : null);

/**
 * What a sent welcome carried, for its row and the resend's answer: a set-up link put in place (`setup`), no link (a
 * person with a password), no new link because the one emailed earlier still works (`earlier`: the worker's welcome
 * only), or a link that was not put in place because a password was chosen while it was on its way (`not_in_place`),
 * which leaves nothing to choose.
 */
export type WelcomeLink = "setup" | "none" | "earlier" | "not_in_place";
type Sent = { ok: true; link: WelcomeLink } | { ok: false; why: "mail_failed" | "link_not_in_place" };

/**
 * Sends the prepared mail, and records the outcome in its own transaction. With a held link, through the shared delivery
 * (deliverHeldLink(), ./link-delivery.ts): the link is put in place only once the mail has been handed over, and a link
 * the person held before is never taken from them by a mail that didn't reach them. Handed over, and the link in place
 * or none to put: the person is welcomed (`welcomed_at` now, owed no more) and `parent.welcome.sent` says which mail went
 * and whether a link did (never which). Not handed over: `parent.welcome.failed`, and they stay owed with the claim's
 * back-off. Handed over and the link not put in place: they stay owed and `parent.welcome.failed` says so
 * (`link_not_put_in_place`), unless a password was chosen meanwhile, when they are welcomed (`not_in_place`).
 */
async function send(parentId: string, p: Extract<Prepared, { go: true }>, by: Sender, resend: boolean): Promise<Sent> {
  const base = { to: p.to, mail: p.mail, ...(resend ? { resend: true } : {}) };
  const purpose = p.mail; // each mail is its own MailPurpose
  const carries: WelcomeLink = p.held ? "setup" : p.earlier ? "earlier" : "none";
  let outcome: { handedOver: false; error: string } | { handedOver: true; link: WelcomeLink } | { handedOver: true; notInPlace: string };
  if (p.held) {
    const d = await deliverHeldLink(p.held, { message: () => message(p), purpose, actor: by.actor, permission: by.permission, ip: by.ip,
      check: (tx, live) => stillToWelcome(tx, live, p.to) });
    outcome = !d.handedOver ? d : d.inPlace ? { handedOver: true, link: "setup" } : d.reason === "has_password" ? { handedOver: true, link: "not_in_place" } : { handedOver: true, notInPlace: d.reason };
  } else {
    const r = await (async () => sendMail(await message(p), { purpose, actor: by.actor, ip: by.ip }))().catch(() => ({ ok: false as const, error: "The email couldn't be written." }));
    outcome = r.ok ? { handedOver: true, link: carries } : { handedOver: false, error: r.error };
  }
  return db.transaction(async (tx): Promise<Sent> => {
    const row = { actor: by.actor, permission: by.permission, targetType: "parent", targetId: parentId, ip: by.ip } as const;
    if (!outcome.handedOver) {
      // welcomeTriedAt stays as claimed: that is the 15-minute back-off.
      await writeAudit({ ...row, action: "parent.welcome.failed", after: { ...base, link: carries, error: outcome.error } }, tx);
      return { ok: false, why: "mail_failed" };
    }
    if ("notInPlace" in outcome) {
      await writeAudit({ ...row, action: "parent.welcome.failed", after: { ...base, link: "setup", error: "link_not_put_in_place", reason: outcome.notInPlace } }, tx);
      return { ok: false, why: "link_not_in_place" };
    }
    let link = outcome.link;
    if (link === "setup" && p.held) {
      // The link was put in place in the delivery's own transaction. Under the person's row again it must still be there
      // (unused, or spent by their choosing a password with it): an end of their sign-in in between (a block and an
      // unblock, say) deleted it, and recording them as welcomed would leave them a dead link and nothing owed. Then
      // they stay owed with the claim's back-off, unless they have a password by now, which leaves nothing to choose.
      await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, parentId)).for("update");
      const [still] = await tx.select({ id: parentSigninToken.id }).from(parentSigninToken).where(eq(parentSigninToken.id, p.held.linkId));
      if (!still) {
        if (!(await personBy({ id: parentId }, tx))?.hasPassword) {
          await writeAudit({ ...row, action: "parent.welcome.failed", after: { ...base, link: "setup", error: "link_not_put_in_place", reason: "changed_while_mailing" } }, tx);
          return { ok: false, why: "link_not_in_place" };
        }
        link = "not_in_place";
      }
    }
    await tx.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, parentId));
    await writeAudit({ ...row, action: "parent.welcome.sent", after: { ...base, link } }, tx);
    return { ok: true, link };
  });
}

/**
 * Sends welcomes the switches, an unblock, or a staff add or reinstate of a guardian (./guardians.ts, which owes one
 * whether or not the row counts yet) marked as owed (spec §2 Welcome emails), and the mails the Admin's press owed to
 * people welcomed before (oweSetupMails(), ./switches.ts). Called on every wake of the worker: at most five a wake, so
 * a whole roster goes out over some minutes, not in one burst from the club's mailbox. Each person is claimed before
 * their email goes, so two overlapping runs never welcome the same person twice. A person owed a welcome with no
 * guardian row that counts (the gate's rule, enterableGuardianRows()) is skipped and stays owed: the welcome goes once
 * they can sign in. After the claim, one transaction takes the person's row and reads everything again under it
 * (prepare()), holding a set-up link for a person with no password; then the mail goes (send()). `now` decides only who
 * is due and is the claim's time; everything about links is read at each person's turn (prepare()).
 *
 * A mail outage is not hammered: a send that fails for the mail's own reasons (not handed over) ends the wake's batch,
 * and while the last welcome the worker tried to send failed (its counts-only mark, WELCOME_MARK, ../jobs/marks.ts), a
 * wake tries one person, not five; the first that goes brings back the batch of five at the next wake. The Health page's
 * parents line says when welcome emails are waiting for that reason.
 */
export async function sendOwedWelcomes(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  if (!(await welcomesOn()) || !(await mailWorking())) return { sent: 0, failed: 0 };
  const counts = hasRowThatCounts(await studentsRuleInForce());
  const batch = failedLast(await readMark(WELCOME_MARK)) ? 1 : WELCOME_BATCH;
  const due = await db.select().from(parent)
    .where(and(eq(parent.welcomeOwed, true), eq(parent.blocked, false), counts,
      or(isNull(parent.welcomeTriedAt), lt(parent.welcomeTriedAt, new Date(now.getTime() - WELCOME_RETRY_MS)))))
    .orderBy(asc(parent.createdAt), asc(parent.id)).limit(batch);
  let sent = 0, failed = 0, mailFailed = 0;
  for (const p of due) {
    if (!(await welcomesOn())) break; // switched off while this run was going
    if (!(await claim(p.id, now, counts))) continue;
    const by = { actor: WELCOME_ACTOR, ip: null };
    const ready = await prepare(p.id, { worker: true }, by);
    if (!ready.go) continue;
    const r = await send(p.id, ready, by, false);
    if (r.ok) { sent++; continue; }
    failed++;
    if (r.why === "mail_failed") { mailFailed++; break; } // the mail itself is failing: the rest wait for a later wake
  }
  // Only a wake that tried someone is marked: one that tried nobody says nothing about whether mail works.
  if (sent + failed > 0) await markJob(WELCOME_MARK, { counts: { sent, linkNotInPlace: failed - mailFailed }, failed: mailFailed });
  return { sent, failed };
}

export type ResendRefusal = "not_found" | "no_access" | "blocked" | "on_its_way" | "mail_failed" | "link_not_in_place";
/**
 * **Resend welcome email** on a person's page. It goes at once and does not depend on the welcome switch. It is the
 * welcome of the worker, sent now: with a set-up link for a person with no password, which takes the place of their
 * unused one only once its mail has gone, and with none for a person with a password. The staff member is the actor of
 * every row. Refused for a person not there, blocked, or who can't sign in (`no_access`: the door closed, no row that
 * counts, no sign-in account), and while another set-up link is on its way to them or the portal mailed them one less
 * than RESEND_AFTER_MS ago (`on_its_way`: the worker's welcome, a resend just pressed, or an ask on "Set up or reset my
 * password", whose link this one would replace, so a double press can't stop the link in the mail just sent working);
 * `mail_failed` when the mail wasn't handed over (an earlier link keeps working), and `link_not_in_place` when it was
 * but something changed for the person while it went, so its link won't work.
 */
export async function resendWelcome(parentId: string, o: StaffOp): Promise<{ ok: true; link: Exclude<WelcomeLink, "earlier"> } | { ok: false; reason: ResendRefusal }> {
  const by = { actor: o.actor, permission: o.permission, ip: o.ip };
  const ready = await prepare(parentId, { worker: false }, by);
  if (!ready.go) return { ok: false, reason: ready.why === "blocked" || ready.why === "not_found" || ready.why === "on_its_way" ? ready.why : "no_access" };
  const r = await send(parentId, ready, by, true);
  if (!r.ok) return { ok: false, reason: r.why };
  // prepare() answers `earlier` for the worker alone: a resend carries a link of its own, or none to a person with a password.
  return { ok: true, link: r.link === "earlier" ? "none" : r.link };
}
