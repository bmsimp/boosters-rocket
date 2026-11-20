import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, setting } from "@/lib/db/schema";
import { accessToken, WORKER_ACTOR } from "@/lib/quickbooks/client";
import { connectionView } from "@/lib/quickbooks/connection";
import { QboError } from "@/lib/quickbooks/endpoints";
import { refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { rosterRefreshAsked } from "@/lib/parents/refresh-ask";
import { TAKE_IN_JOB, takeInAsksForARead, takeInContactDetails } from "@/lib/parents/contact-take-in";
import { CHALLENGE_SWEEP_JOB, CLEANUP_JOB, removedInAll, runCleanup, sweepExpiredChallenges } from "./cleanup";
import { BUYOUT_CHECK_MARK, CHALLENGE_SWEEP_MARK, failedLast, markJob, readMark, REMINDERS_MARK } from "./marks";
import { MONEY_JOB } from "@/lib/money/sweep";
import { runMoneyAndItems } from "./money-job";
import { FORMS_JOB, checkOpenForms } from "@/lib/forms/job";
import { runSignedFormsJobs } from "@/lib/signed-forms/worker";
import { REMINDERS_JOB, sendVolunteerReminders } from "@/lib/volunteer/reminders";
import { DUE_REMINDERS_JOB, sendDueReminders } from "@/lib/seasons/due-reminders";
import { WRITE_QUEUE_JOB, runWriteQueue } from "@/lib/roster/queue";
import { BUYOUT_CHECK_JOB, checkBuyoutInvoices } from "@/lib/buyouts/daily-check";

export const TOKEN_JOB = "quickbooks.token_refresh";
export const WAKE_KEY = "worker.last_wake";
const DUE_MS = 24 * 3_600_000;
const RETRY_MS = 15 * 60_000;

/** Due when the last successful run is more than 24 hours old, and the last attempt of any kind is at least 15 minutes old (spec §4). */
async function due(job: string, now: Date): Promise<boolean> {
  const [lastOk] = await db.select().from(jobRun).where(and(eq(jobRun.job, job), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (lastOk?.finishedAt && now.getTime() - lastOk.finishedAt.getTime() <= DUE_MS) return false;
  const [last] = await db.select().from(jobRun).where(eq(jobRun.job, job)).orderBy(desc(jobRun.id)).limit(1);
  return !last || now.getTime() - last.startedAt.getTime() >= RETRY_MS;
}

/** One wake of the worker: records it, then runs whichever jobs are due. `now` is only for deciding what is due. */
export async function runDueJobs(now: Date = new Date()): Promise<{ ran: { job: string; ok: boolean }[] }> {
  const wake = { at: new Date().toISOString() };
  await db.insert(setting).values({ key: WAKE_KEY, value: wake }).onConflictDoUpdate({ target: setting.key, set: { value: wake, updatedAt: new Date() } });
  const ran: { job: string; ok: boolean }[] = [];
  // Welcomes need the mail settings but not QuickBooks, so they go before the connection check.
  // A throw here (settings, mail config, database) must not stop the token and roster jobs; nothing of it is kept.
  try {
    const welcomes = await sendOwedWelcomes(now);
    if (welcomes.sent + welcomes.failed > 0) ran.push({ job: "parents.welcome", ok: welcomes.failed === 0 });
  } catch {
    ran.push({ job: "parents.welcome", ok: false });
  }
  // The daily clean-up needs neither mail nor QuickBooks. It is in the job history every day, and in this wake's answer
  // only when it removed something or failed, so a quiet day stays quiet in the worker's log. What has expired is
  // decided by the real time, never by `now`.
  try {
    if (await due(CLEANUP_JOB, now)) {
      const r = await runCleanup();
      if (!r.ok || removedInAll(r.counts!) > 0) ran.push({ job: CLEANUP_JOB, ok: r.ok });
    }
  } catch {
    ran.push({ job: CLEANUP_JOB, ok: false });
  }
  // Expired passkey challenges (and any other expired parent verification row), at every wake: what bounds them when
  // no cap per address can (cleanup.ts). Counted in its mark and this wake's answer only when it removed some, so a
  // quiet wake stays quiet; a throw is marked, with none of its text, and the Health page's clean-up line says so
  // (report.ts), so the first sweep that works after one marks too, quiet or not, and the line clears.
  try {
    const swept = await sweepExpiredChallenges();
    if (swept > 0 || failedLast(await readMark(CHALLENGE_SWEEP_MARK))) await markJob(CHALLENGE_SWEEP_MARK, { counts: { challenges: swept }, failed: 0 });
    if (swept > 0) ran.push({ job: CHALLENGE_SWEEP_JOB, ok: true });
  } catch {
    await markJob(CHALLENGE_SWEEP_MARK, "threw");
    ran.push({ job: CHALLENGE_SWEEP_JOB, ok: false });
  }
  // Forms out for signing are asked about every few minutes (Documenso's webhooks are not retried). It needs Documenso
  // and neither mail nor QuickBooks; each form is asked about only when its own last read is old enough, so most wakes
  // ask nothing and say nothing.
  try {
    const forms = await checkOpenForms(now);
    if (forms.asked > 0) ran.push({ job: FORMS_JOB, ok: forms.failed === 0 });
  } catch {
    ran.push({ job: FORMS_JOB, ok: false });
  }
  // Signed forms (src/lib/signed-forms/worker.ts): the evidence of completed forms fetched and kept, the guardians'
  // copies, and the scheduled reminders. Guarded like the steps above; in this wake's answer only when it did something.
  ran.push(...(await runSignedFormsJobs(now)));
  // Volunteer reminders (the day before a shift, and nudges before a due date) need mail and neither QuickBooks nor
  // Documenso; a few go per wake, from 9:00 on the club's clock, so most wakes send nothing and say nothing.
  try {
    const reminders = await sendVolunteerReminders(now);
    await markJob(REMINDERS_MARK, { counts: { sent: reminders.sent }, failed: reminders.failed }); // for the Health page
    if (reminders.sent + reminders.failed > 0) ran.push({ job: REMINDERS_JOB, ok: reminders.failed === 0 });
  } catch {
    await markJob(REMINDERS_MARK, "threw");
    ran.push({ job: REMINDERS_JOB, ok: false });
  }
  // Reminders before a payment's or a checklist item's due date (src/lib/seasons/due-reminders.ts), guarded the same
  // way: mail and the stored figures, never a live read of QuickBooks; in this wake's answer only when it sent something.
  try {
    const due = await sendDueReminders(now);
    if (due.sent + due.failed > 0) ran.push({ job: DUE_REMINDERS_JOB, ok: due.failed === 0 });
  } catch {
    ran.push({ job: DUE_REMINDERS_JOB, ok: false });
  }
  // A guardian's phone and mailing address taken into the portal, once, after the first successful roster read by this
  // build since migration 0044 (src/lib/parents/contact-take-in.ts). It reads the roster cache and asks QuickBooks nothing, so it
  // goes before the connection check, at the wake after that read. Guarded like the steps above; in this wake's answer
  // only on the wake it ran.
  try {
    if ((await takeInContactDetails()).ran) ran.push({ job: TAKE_IN_JOB, ok: true });
  } catch {
    ran.push({ job: TAKE_IN_JOB, ok: false });
  }
  const conn = await connectionView();
  // Not connected, or connected but only an Admin connecting again can fix it: nothing to run, nothing to record,
  // except that a read of every family under way is ended, saying how far it got.
  if (!conn.connected || conn.needsAdmin) return { ran: [...ran, ...(await moneyJob(now))] };
  if (await due(TOKEN_JOB, now)) {
    const [run] = await db.insert(jobRun).values({ job: TOKEN_JOB, startedBy: "worker", startedAt: now }).returning();
    try {
      await accessToken({ force: true }); // spends the refresh token so a quiet summer can't let it lapse; failures are audited there
      await db.update(jobRun).set({ finishedAt: new Date(), outcome: "ok" }).where(eq(jobRun.id, run!.id));
      ran.push({ job: TOKEN_JOB, ok: true });
    } catch (e) {
      // A QboError's message is a fixed sentence and its code a short code; anything else is recorded without its text.
      const detail = e instanceof QboError ? `${e.message} (${e.code})` : "The connection couldn't be refreshed. (unexpected)";
      await db.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail }).where(eq(jobRun.id, run!.id));
      ran.push({ job: TOKEN_JOB, ok: false });
    }
  }
  // Daily, or sooner when a staff roster write asked for one (refresh-ask.ts),
  // or while the take-in of contact details waits for a read that keeps the billing addresses: at the first wake of this
  // build, whatever the build before it answered, then at most once an hour (takeInAsksForARead(), asked first so that
  // every read made while it waits counts toward its hour).
  const forTakeIn = await takeInAsksForARead(now);
  if (forTakeIn || (await due(ROSTER_JOB, now)) || (await rosterRefreshAsked(now))) {
    const r = await refreshRoster({ startedBy: "worker", actor: WORKER_ACTOR, ip: null });
    if (r.ok || r.reason === "failed") ran.push({ job: ROSTER_JOB, ok: r.ok });
  }
  // Staff roster writes waiting to reach QuickBooks (src/lib/roster/queue.ts), after the roster: a write that may already
  // have been made is looked for in a roster read since its last try. Guarded, so a failure never stops the money job.
  try { const q = await runWriteQueue(now); if (q.ran) ran.push({ job: WRITE_QUEUE_JOB, ok: q.ok }); } catch { ran.push({ job: WRITE_QUEUE_JOB, ok: false }); }
  // Every family's invoices, once a day or when staff ask (src/lib/money/sweep.ts): after the roster, so it reads the
  // families as QuickBooks lists them now. A run too long for one wake carries on at the next; it is in this wake's
  // answer only when it ended.
  ran.push(...(await moneyJob(now)));
  // Buy-out invoices (src/lib/buyouts/daily-check.ts), once after each run that read every family: compared with the
  // figures it stored. Guarded like the steps above; in this wake's answer only when it marked or flagged something.
  // The Health page reads when it last followed a run, and what it did or that it failed (./marks.ts).
  try {
    const b = await checkBuyoutInvoices();
    if (b.ran) await markJob(BUYOUT_CHECK_MARK, { counts: { paid: b.paid, flagged: b.flagged, voided: b.voided, unflagged: b.unflagged }, failed: 0 });
    if (b.paid + b.flagged + b.voided + b.unflagged > 0) ran.push({ job: BUYOUT_CHECK_JOB, ok: true });
  } catch { await markJob(BUYOUT_CHECK_MARK, "threw"); ran.push({ job: BUYOUT_CHECK_JOB, ok: false }); }
  return { ran };
}

/** The money job's share of a wake: in its answer only when a run ended. A throw is recorded as a failure, with none of its text. */
async function moneyJob(now: Date): Promise<{ job: string; ok: boolean }[]> {
  try {
    const r = await runMoneyAndItems({ now }); // with the products and services once a run has read every family
    return r.ran && r.finished ? [{ job: MONEY_JOB, ok: r.ok }] : [];
  } catch {
    return [{ job: MONEY_JOB, ok: false }];
  }
}

/** When the worker last checked in, for the settings view. */
export async function lastWake(): Promise<string | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, WAKE_KEY));
  const at = (row?.value as { at?: unknown } | undefined)?.at;
  return typeof at === "string" ? at : null;
}
