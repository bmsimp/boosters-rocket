import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, emailTemplateVersion, staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { shownContactEmail } from "@/lib/staff/contact-email";
import { mailWorking } from "./settings";
import { sendMail, currentBrand } from "./send";
import { clubTemplates } from "./template-read";
import { checkTemplate, type TemplateDoc } from "@/lib/email-templates/body";
import { defaultTemplate, emailByKey, rulesOf, sampleEmail, wordsFor, type EmailDef } from "@/lib/email-templates/catalog";

/*
 * The club's words for the emails (docs/superpowers/specs/2026-11-28-email-templates-design.md, section 5): read for
 * every send by currentBrand(), and saved, set back to the default and tested from Settings, Emails, by staff with
 * Settings.Emails.ReadWrite. Nothing here reads a family's data.
 */

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
type Who = { actor: Actor; staffUserId: string; ip: string | null };
const PERMISSION = "Settings.Emails.ReadWrite";
const NOT_FROM_PAGE = "That didn't go through. Reload the page and try again.";
/** How many tests one person may send in an hour (spec section 3). */
export const TESTS_PER_HOUR = 10;

/** Where each email stands, for the list: the club's words, the default, or the club's words set aside because a release changed the email. */
export type EmailStanding = "club" | "default" | "needs_look";
export async function emailStandings(): Promise<Record<string, EmailStanding>> {
  const saved = await clubTemplates();
  const out: Record<string, EmailStanding> = {};
  for (const [key, words] of Object.entries(saved)) {
    const e = emailByKey(key);
    if (!e || !words) continue;
    const w = wordsFor(e, words);
    out[key] = !w.usable ? "needs_look" : isDefault(e, w) ? "default" : "club";
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isDefault = (e: EmailDef<unknown>, w: { subject: string | null; body: TemplateDoc }) => {
  const d = defaultTemplate(e);
  return d.subject === w.subject && same(d.body, w.body);
};

export type VersionRow = { n: number; savedAt: Date; savedBy: string; reset: boolean };
/** Every saved version of one email, newest first, with who saved it. */
export async function emailVersions(key: string): Promise<VersionRow[]> {
  return db.select({ n: emailTemplateVersion.n, savedAt: emailTemplateVersion.savedAt, savedBy: staffUser.name, reset: emailTemplateVersion.reset })
    .from(emailTemplateVersion).innerJoin(staffUser, eq(staffUser.id, emailTemplateVersion.savedBy))
    .where(eq(emailTemplateVersion.emailKey, key)).orderBy(desc(emailTemplateVersion.n));
}

/** One saved version's words, or null for a number that isn't one of this email's. */
export async function emailVersion(key: string, n: number): Promise<{ subject: string | null; body: unknown } | null> {
  if (!Number.isSafeInteger(n) || n < 1) return null;
  const [row] = await db.select({ subject: emailTemplateVersion.subject, body: emailTemplateVersion.body }).from(emailTemplateVersion)
    .where(and(eq(emailTemplateVersion.emailKey, key), eq(emailTemplateVersion.n, n)));
  return row ?? null;
}

/**
 * Saves new words for one email as its next version, after checkTemplate(): the club's words go live for the next send.
 * Words the same as the current ones are refused. `reset` marks the default saved again. Audited `email_template.save`
 * in the same transaction, with the email and the version, never the words (they are in the version itself).
 */
export async function saveEmailTemplate(key: unknown, input: { subject: unknown; body: unknown }, who: Who, o: { reset?: boolean } = {}): Promise<Result> {
  const e = emailByKey(key);
  if (!e) return { ok: false, errors: [NOT_FROM_PAGE] };
  const checked = checkTemplate(rulesOf(e), input);
  if (!checked.ok) return checked;
  return db.transaction(async (tx) => {
    // One save of an email at a time: two at once would both read the same newest version.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.email_template.${e.key}`}))`);
    const [latest] = await tx.select({ n: emailTemplateVersion.n, subject: emailTemplateVersion.subject, body: emailTemplateVersion.body })
      .from(emailTemplateVersion).where(eq(emailTemplateVersion.emailKey, e.key)).orderBy(desc(emailTemplateVersion.n)).limit(1);
    const current = wordsFor(e, latest);
    if (current.subject === checked.subject && same(current.body, checked.body) && (!latest || current.usable)) {
      return { ok: false as const, errors: [o.reset ? "This email already has its default words." : "Nothing has changed since the last save."] };
    }
    const n = (latest?.n ?? 0) + 1;
    await tx.insert(emailTemplateVersion).values({ emailKey: e.key, n, subject: checked.subject, body: checked.body, reset: o.reset ?? false, savedBy: who.staffUserId });
    await writeAudit({ actor: who.actor, action: "email_template.save", permission: PERMISSION, targetType: "email_template", targetId: e.key,
      before: { version: latest?.n ?? null }, after: { version: n, reset: o.reset ?? false }, ip: who.ip }, tx);
    return { ok: true as const, message: o.reset ? `Saved. "${e.title}" has its default words again.` : `Saved. The next "${e.title}" email goes with these words.` };
  });
}

/** "Use the default words": the default saved as the next version, so it can be undone from Earlier versions. */
export const restoreDefaultWords = (key: unknown, who: Who): Promise<Result> => {
  const e = emailByKey(key);
  return e ? saveEmailTemplate(e.key, defaultTemplate(e), who, { reset: true }) : Promise.resolve({ ok: false, errors: [NOT_FROM_PAGE] });
};

/** "Use these words again": an earlier version saved as the next. */
export async function saveVersionAgain(key: unknown, n: unknown, who: Who): Promise<Result> {
  const e = emailByKey(key);
  if (!e || typeof n !== "number") return { ok: false, errors: [NOT_FROM_PAGE] };
  const v = await emailVersion(e.key, n);
  if (!v) return { ok: false, errors: [NOT_FROM_PAGE] };
  return saveEmailTemplate(e.key, v, who);
}

/** The address a staff member's tests go to: their contact email, else their sign-in address. */
export async function testAddress(staffUserId: string): Promise<string | null> {
  const [me] = await db.select({ email: staffUser.email, contactEmail: staffUser.contactEmail }).from(staffUser).where(eq(staffUser.id, staffUserId));
  return me ? shownContactEmail(me) : null;
}

/**
 * "Send me a test": the words on the page, saved or not, filled with the samples, to the staff member's own address,
 * the subject starting "Test: ". At most TESTS_PER_HOUR an hour each, counted from their own audit rows; refused while
 * outgoing mail isn't working. Audited `email_template.test` with the email and whether it went, never the address,
 * in the transaction that holds the person's lock while it counts and sends.
 */
export async function sendTemplateTest(key: unknown, input: { subject: unknown; body: unknown }, who: Who): Promise<Result> {
  const e = emailByKey(key);
  if (!e) return { ok: false, errors: [NOT_FROM_PAGE] };
  const checked = checkTemplate(rulesOf(e), input);
  if (!checked.ok) return checked;
  if (!(await mailWorking())) return { ok: false, errors: ["Outgoing mail isn't working, so no test can be sent. Check it under Settings, Integrations, Outgoing mail."] };
  const to = await testAddress(who.staffUserId);
  if (!to) return { ok: false, errors: [NOT_FROM_PAGE] };
  const m = sampleEmail(e, await currentBrand(), to, { subject: checked.subject, body: checked.body });
  // One test of a person's at a time: the count, the send and its audit row under their own lock, so presses together
  // can't pass the limit, and every try that went to the mail server counts, sent or not.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.email_template.test.${who.staffUserId}`}))`);
    const [tried] = await tx.select({ count: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.action, "email_template.test"),
      eq(auditLog.actorId, who.staffUserId), gte(auditLog.at, new Date(Date.now() - 3_600_000))));
    if ((tried?.count ?? 0) >= TESTS_PER_HOUR) return { ok: false as const, errors: [`You've sent ${TESTS_PER_HOUR} tests in the last hour. Try again a little later.`] };
    const sent = await sendMail({ ...m, subject: `Test: ${m.subject}` }, { purpose: "template_test", actor: who.actor, ip: who.ip })
      .catch((): { ok: false } => ({ ok: false }));
    await writeAudit({ actor: who.actor, action: "email_template.test", permission: PERMISSION, targetType: "email_template", targetId: e.key,
      after: { ok: sent.ok }, ip: who.ip }, tx);
    return sent.ok ? { ok: true as const, message: `Sent to ${to}. It has sample values, and its links open nothing.` }
      : { ok: false as const, errors: ["The test couldn't be sent. Check Outgoing mail under Settings, Integrations."] };
  });
}
