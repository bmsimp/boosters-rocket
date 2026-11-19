import { and, asc, eq, isNull, lt, or, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { getStoredMailConfig, mailWorking } from "@/lib/mail/settings";
import { signinChangedMessage, welcomeMessage, type SetupLinkWords } from "@/lib/mail/messages";
import type { MailMessage } from "@/lib/mail/types";
import type { StaffOp } from "./people";
import { getParentSettings, parentDoorClosed } from "./settings";
import { enterableGuardianRows, hasRowThatCounts, studentsRuleInForce } from "./sessions";
import { RESEND_AFTER_MS } from "./signin-codes";
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
 * The welcome email as it would go to `to`, with no password yet: step 2 of the settings shows it as a sample. Its link
 * is plainly a sample, never a token's shape: this makes, holds and reads no link.
 */
export async function sampleWelcome(to: string): Promise<MailMessage> {
  const appUrl = portalAddress();
  const settings = await getParentSettings();
  return welcomeMessage(await currentBrand(), to, { appUrl, contact: await contactAddress(),
    link: { url: `${appUrl}/sign-in/set-up/(a link made for each person)`, life: lifeWords(LINK_LIFE_MS.setup), strict: settings.level === "strict" } });
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

/**
 * Which mail a person is sent: the welcome, or, for a person the club welcomed before who is owed a mail again (the
 * Admin's press on the parents' settings page, oweSetupMails(), ./switches.ts, is the one thing that owes a mail to
 * someone welcomed already), the mail that says the portal now signs parents in with a password.
 */
type Mail = "welcome" | "signin_changed";
/** Who sends and is recorded: the worker (no permission), or the staff member who pressed Resend. */
type Sender = { actor: Actor; permission?: string; ip: string | null };
/** The worker's welcome (it reads the switches and the owed mark again) or a staff resend (it reads only the door, as before). */
type Kind = { worker: true } | { worker: false };

/**
 * What the read under the person's lock found. `go`: the mail to send, to the address read under the lock, with a set-up
 * link held for it (holdSigninLink()) when the person has no password, or none. Otherwise why not: for a resend, the
 * refusals as before; for the worker, nothing to send now (`quiet`: switched off, no longer owed, blocked, no row that
 * counts or no sign-in account since the claim; it stays as it is), a press mail skipped for a password chosen since
 * (`skipped`, its row written), or a press mail to someone sent a set-up link a moment ago (`wait`, still owed).
 */
type Prepared =
  | { go: true; to: string; mail: Mail; held: HeldLink | null; strict: boolean }
  | { go: false; why: "not_found" | "blocked" | "no_access" | "quiet" | "skipped" | "wait" };

async function prepare(parentId: string, kind: Kind, by: Sender, now: Date): Promise<Prepared> {
  return db.transaction(async (tx): Promise<Prepared> => {
    // The person's row first, in the order above lockedPerson() (./sessions.ts); then everything is read again under it.
    const [row] = await tx.select({ welcomedAt: parent.welcomedAt, welcomeOwed: parent.welcomeOwed }).from(parent).where(eq(parent.id, parentId)).for("update");
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
    const mail: Mail = kind.worker && row.welcomedAt !== null ? "signin_changed" : "welcome";
    if (mail === "signin_changed" && live.hasPassword) {
      // A press mail for someone who has chosen a password since the press: nothing to choose, so it isn't sent.
      await tx.update(parent).set({ welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, live.id));
      await writeAudit({ actor: by.actor, action: "parent.welcome.skipped", targetType: "parent", targetId: live.id, after: { to: live.email, mail, reason: "has_password" }, ip: by.ip }, tx);
      return { go: false, why: "skipped" };
    }
    const strict = settings.level === "strict";
    if (live.hasPassword) return { go: true, to: live.email, mail, held: null, strict };
    // The resend wait of the request page: a set-up link sent a moment ago, or on its way, may be in the mailbox unused,
    // and the press's mail would replace it. It waits, owed, for a later wake.
    if (mail === "signin_changed" && await linkSentWithin(tx, { parentId: live.id, purpose: "setup", now, withinMs: RESEND_AFTER_MS })) return { go: false, why: "wait" };
    const { linkId, token } = await holdSigninLink(tx, { parentId: live.id, purpose: "setup", now });
    return { go: true, to: live.email, mail, strict, held: { linkId, purpose: "setup", token, to: live.email, who: { id: live.id, email: live.email } } };
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

async function message(p: Extract<Prepared, { go: true }>): Promise<MailMessage> {
  const appUrl = portalAddress();
  const [brand, contact] = await Promise.all([currentBrand(), contactAddress()]);
  const link: SetupLinkWords | null = p.held ? { url: passwordLink("setup", p.held.token), life: lifeWords(LINK_LIFE_MS.setup), strict: p.strict } : null;
  return p.mail === "signin_changed" && link ? signinChangedMessage(brand, p.to, { appUrl, contact, link }) : welcomeMessage(brand, p.to, { appUrl, contact, link });
}

/**
 * What a sent welcome carried, for its row and the resend's answer: a set-up link put in place (`setup`), no link (a
 * person with a password), or a link that was not put in place because a password was chosen while it was on its way
 * (`not_in_place`), which leaves nothing to choose.
 */
export type WelcomeLink = "setup" | "none" | "not_in_place";
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
  const purpose = p.mail === "welcome" ? "welcome" as const : "signin_changed" as const;
  let outcome: { handedOver: false; error: string } | { handedOver: true; link: WelcomeLink } | { handedOver: true; notInPlace: string };
  if (p.held) {
    const d = await deliverHeldLink(p.held, { message: () => message(p), purpose, actor: by.actor, permission: by.permission, ip: by.ip,
      check: (tx, live) => stillToWelcome(tx, live, p.to) });
    outcome = !d.handedOver ? d : d.inPlace ? { handedOver: true, link: "setup" } : d.reason === "has_password" ? { handedOver: true, link: "not_in_place" } : { handedOver: true, notInPlace: d.reason };
  } else {
    const r = await (async () => sendMail(await message(p), { purpose, actor: by.actor, ip: by.ip }))().catch(() => ({ ok: false as const, error: "The email couldn't be written." }));
    outcome = r.ok ? { handedOver: true, link: "none" } : { handedOver: false, error: r.error };
  }
  return db.transaction(async (tx): Promise<Sent> => {
    const row = { actor: by.actor, permission: by.permission, targetType: "parent", targetId: parentId, ip: by.ip } as const;
    if (!outcome.handedOver) {
      // welcomeTriedAt stays as claimed: that is the 15-minute back-off.
      await writeAudit({ ...row, action: "parent.welcome.failed", after: { ...base, link: p.held ? "setup" : "none", error: outcome.error } }, tx);
      return { ok: false, why: "mail_failed" };
    }
    if ("notInPlace" in outcome) {
      await writeAudit({ ...row, action: "parent.welcome.failed", after: { ...base, link: "setup", error: "link_not_put_in_place", reason: outcome.notInPlace } }, tx);
      return { ok: false, why: "link_not_in_place" };
    }
    await tx.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false, welcomeTriedAt: null, updatedAt: new Date() }).where(eq(parent.id, parentId));
    await writeAudit({ ...row, action: "parent.welcome.sent", after: { ...base, link: outcome.link } }, tx);
    return { ok: true, link: outcome.link };
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
 * (prepare()), holding a set-up link for a person with no password; then the mail goes (send()).
 */
export async function sendOwedWelcomes(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  if (!(await welcomesOn()) || !(await mailWorking())) return { sent: 0, failed: 0 };
  const counts = hasRowThatCounts(await studentsRuleInForce());
  const due = await db.select().from(parent)
    .where(and(eq(parent.welcomeOwed, true), eq(parent.blocked, false), counts,
      or(isNull(parent.welcomeTriedAt), lt(parent.welcomeTriedAt, new Date(now.getTime() - WELCOME_RETRY_MS)))))
    .orderBy(asc(parent.createdAt), asc(parent.id)).limit(WELCOME_BATCH);
  let sent = 0, failed = 0;
  for (const p of due) {
    if (!(await welcomesOn())) break; // switched off while this run was going
    if (!(await claim(p.id, now, counts))) continue;
    const by = { actor: WELCOME_ACTOR, ip: null };
    const ready = await prepare(p.id, { worker: true }, by, now);
    if (!ready.go) continue;
    if ((await send(p.id, ready, by, false)).ok) sent++; else failed++;
  }
  return { sent, failed };
}

export type ResendRefusal = "not_found" | "no_access" | "blocked" | "mail_failed" | "link_not_in_place";
/**
 * **Resend welcome email** on a person's page. It goes at once and does not depend on the welcome switch. It is the
 * welcome of the worker, sent now: with a set-up link for a person with no password, which takes the place of their
 * unused one only once its mail has gone, and with none for a person with a password. The staff member is the actor of
 * every row. Refused for a person not there, blocked, or who can't sign in (`no_access`: the door closed, no row that
 * counts, no sign-in account); `mail_failed` when the mail wasn't handed over (an earlier link keeps working), and
 * `link_not_in_place` when it was but something changed for the person while it went, so its link won't work.
 */
export async function resendWelcome(parentId: string, o: StaffOp, now: Date = new Date()): Promise<{ ok: true; link: WelcomeLink } | { ok: false; reason: ResendRefusal }> {
  const by = { actor: o.actor, permission: o.permission, ip: o.ip };
  const ready = await prepare(parentId, { worker: false }, by, now);
  if (!ready.go) return { ok: false, reason: ready.why === "blocked" || ready.why === "not_found" ? ready.why : "no_access" };
  const r = await send(parentId, ready, by, true);
  return r.ok ? r : { ok: false, reason: r.why };
}
