// Two lines of the Health page (./report.ts) for worker jobs that keep no job_run row of their own: the volunteer
// reminders (src/lib/volunteer/reminders.ts) and the daily check of the buy-out invoices (src/lib/buyouts/daily-check.ts).
// Each says when the job last ran and what it did or that it failed, from what the worker marked (src/lib/jobs/marks.ts).
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, jobRun, setting } from "@/lib/db/schema";
import { BUYOUT_CHECK_MARK, readMark, REMINDERS_MARK, type JobMark } from "@/lib/jobs/marks";
import { MONEY_JOB } from "@/lib/money/run-keys";
import type { HealthLine } from "./report";

/** The buy-out check follows a read of every family in the same wake. This long after one finished without it, it is behind. */
export const BUYOUT_CHECK_LATE_MS = 15 * 60_000;
/** The setting the buy-out check keeps of the run it last followed (CHECKED_KEY in src/lib/buyouts/daily-check.ts). */
const BUYOUTS_CHECKED_KEY = "buyouts.checked";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const failedLast = (m: JobMark | null) => Boolean(m?.failedAt && (!m.okAt || m.failedAt > m.okAt));

/** The volunteer reminders: the day before a shift, and the nudges before a volunteer due date. */
export async function volunteerRemindersLine(o: { signin: boolean; welcome: boolean; mailWorking: boolean }): Promise<HealthLine> {
  const mark = await readMark(REMINDERS_MARK);
  const base = { key: "volunteer_reminders" as const, title: "Volunteer reminders",
    times: [{ label: "Last looked", at: mark?.ranAt ?? null }, { label: "Last sent", at: mark?.didAt ?? null }, { label: "Last failure", at: mark?.failedAt ?? null }] };
  const sent = mark?.did?.sent;
  const lastSent = typeof sent === "number" && sent > 0 ? [`The last ones that went: ${plural(sent, "reminder", "reminders")}.`] : [];
  if (!o.signin) {
    return { ...base, state: "off", word: "Off", notes: [], fix: { href: "/staff/settings/parents", label: "Open parent sign-ins" },
      says: "Not sending: parent sign-ins are off. The reminders the day before a shift go while parent sign-ins are on, and the nudges before a volunteer due date while welcome emails are on too." };
  }
  if (!o.mailWorking) {
    return { ...base, state: "off", word: "Waiting for mail", notes: lastSent, fix: { href: "/staff/settings/mail", label: "Open mail settings" },
      says: "Not sending until outgoing mail is set up and tested (the Outgoing mail line)." };
  }
  if (!mark) {
    return { ...base, state: "off", word: "Not yet run", notes: [], fix: null,
      says: "Hasn't run yet. The worker looks every minute, and from 9:00 on the club's clock sends the reminders that are due, a few at a time." };
  }
  const nudgesOff = o.welcome ? [] : ["The nudges before a volunteer due date wait until welcome emails are switched on; the reminders the day before a shift go."];
  if (failedLast(mark)) {
    const f = mark.failure;
    const says = f?.kind === "some_failed"
      ? `${f.count === 1 ? "1 volunteer reminder" : `${f.count} volunteer reminders`} couldn't be sent at the last try. Each is tried again after 15 minutes while it is still the day for it; the Outgoing mail line says whether mail is working.`
      : "The last try to send volunteer reminders stopped with an error. The worker tries again at its next wake, a minute later.";
    return { ...base, state: "attention", word: "Needs attention", says, notes: [...lastSent, ...nudgesOff], fix: f?.kind === "some_failed" ? { href: "/staff/settings/mail", label: "Open mail settings" } : null };
  }
  return { ...base, state: "ok", word: "Working", notes: [...lastSent, ...nudgesOff], fix: null,
    says: "From 9:00 on the club's clock, sends the reminder the day before each shift and the nudges 14 and 3 days before a volunteer due date, a few each minute." };
}

const DID_WORDS: [key: string, one: string, many: string][] = [
  ["paid", "1 marked paid", "{n} marked paid"], ["voided", "1 ended as voided in QuickBooks", "{n} ended as voided in QuickBooks"],
  ["voiding", "1 set to be voided (its student moved)", "{n} set to be voided (their students moved)"],
  ["flagged", "1 flagged for the club", "{n} flagged for the club"], ["unflagged", "1 flag taken off", "{n} flags taken off"],
];

/** The daily check of the buy-out invoices against what the read of every family stored. */
export async function buyoutCheckLine(o: { connected: boolean; needsAdmin: boolean }, now: Date): Promise<HealthLine> {
  const [mark, [lastRun], [checked], [flags]] = await Promise.all([
    readMark(BUYOUT_CHECK_MARK),
    db.select().from(jobRun).where(and(eq(jobRun.job, MONEY_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
    db.select().from(setting).where(eq(setting.key, BUYOUTS_CHECKED_KEY)),
    // The check's own flags (an invoice QuickBooks no longer shows, or shows on another customer), waiting for the treasurer.
    db.select({ n: sql<number>`count(*)::int` }).from(buyout).where(and(eq(buyout.state, "invoiced"), inArray(buyout.flag, ["missing", "other_customer"]))),
  ]);
  // Before the worker marked it, the check still kept the run it followed: when that was written is when it last ran.
  const ranAt = mark?.ranAt ?? checked?.updatedAt.toISOString() ?? null;
  const base = { key: "buyout_check" as const, title: "Buy-out invoices", times: [{ label: "Last checked", at: ranAt }, { label: "Last failure", at: mark?.failedAt ?? null }] };
  const flagged = flags?.n ?? 0;
  const flagNote = flagged > 0 ? [`${flagged === 1 ? "1 buy-out invoice is" : `${flagged} buy-out invoices are`} flagged and waiting for the club: QuickBooks no longer shows ${flagged === 1 ? "it" : "them"}, or shows ${flagged === 1 ? "it" : "them"} on another customer. The Reconciliation page lists ${flagged === 1 ? "it" : "them"}.`] : [];
  const reconciliation = { href: "/staff/reconciliation", label: "Open Reconciliation" };
  const did = mark?.did ? DID_WORDS.filter(([k]) => (mark.did![k] ?? 0) > 0).map(([k, one, many]) => (mark.did![k] === 1 ? one : many.replace("{n}", String(mark.did![k])))) : [];
  const didNote = mark?.didAt ? [`The last time it changed something: ${did.join(", ")}.`] : ranAt ? ["It has found nothing to change so far."] : [];
  if (!o.connected || o.needsAdmin) {
    return { ...base, state: "off", word: "Not running", notes: flagNote, fix: null,
      says: "Checks the buy-out invoices after each daily read of every family's invoices. It waits until QuickBooks is connected again." };
  }
  if (failedLast(mark)) {
    return { ...base, state: "attention", word: "Needs attention", notes: [...flagNote, ...didNote], fix: flagged > 0 ? reconciliation : null,
      says: "The last check of the buy-out invoices stopped with an error. The worker tries again at its next wake, a minute later." };
  }
  const followed = lastRun && (checked?.value as { runId?: unknown } | undefined)?.runId === lastRun.id;
  if (lastRun?.finishedAt && !followed && now.getTime() - lastRun.finishedAt.getTime() > BUYOUT_CHECK_LATE_MS) {
    return { ...base, state: "attention", word: "Needs attention", notes: [...flagNote, ...didNote], fix: flagged > 0 ? reconciliation : null,
      says: "The last read of every family's invoices finished, but the buy-out invoices haven't been checked against it. Check the worker line." };
  }
  if (!ranAt) {
    return { ...base, state: "off", word: "Not yet run", notes: flagNote, fix: null,
      says: "Hasn't run yet. After each daily read of every family's invoices, it checks each buy-out invoice against what QuickBooks showed." };
  }
  return { ...base, state: flagged > 0 ? "attention" : "ok", word: flagged > 0 ? "Needs attention" : "Working", notes: [...flagNote, ...didNote], fix: flagged > 0 ? reconciliation : null,
    says: "After each daily read of every family's invoices, checks each buy-out invoice against what QuickBooks showed: a paid one is marked paid, and one QuickBooks no longer shows is flagged for the club." };
}
