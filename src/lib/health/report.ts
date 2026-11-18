import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, requirement, season, seasonStep } from "@/lib/db/schema";
import { lastWake } from "@/lib/jobs/runner";
import { CLEANUP_JOB } from "@/lib/jobs/cleanup";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { QUICKBOOKS_USE, QUICKBOOKS_WRITE_ACTION } from "@/lib/quickbooks/what-it-does";
import { loadRosterPage } from "@/lib/roster/queries";
import { queueCounts } from "@/lib/roster/queue";
import { mailFailing, mailSummary } from "@/lib/mail/settings";
import { getParentSettings } from "@/lib/parents/settings";
import { apiFailing as formsApiFailing, formsSummary } from "@/lib/forms/settings";
import { formsWaiting } from "@/lib/forms/job";
import { evidenceHealth } from "@/lib/signed-forms/evidence-job";
import { moneyRunView } from "@/lib/money/sweep";
import { lastCheck, lastCheckWords } from "@/lib/quickbooks/sandbox-check/view";
import { lastDueReminders } from "@/lib/seasons/due-reminders";
import { dateWords } from "@/lib/volunteer/clock";
import { lastBackup } from "./backup";
import { buyoutCheckLine, volunteerRemindersLine } from "./job-lines";
import { BUILD_VERSION } from "./version";
import { env } from "@/env";

/**
 * What the staff Health page shows (v1 spec §14): one line per part of the portal, in plain words, each with when it
 * last worked. Admin only (Admin.Health.Read). It is the page to open after a restore or an update, to see that
 * nothing was silently left broken. It reads what the portal already records and calls nothing outside it.
 *
 * `/api/health` is something else: a bare up-or-down answer for Docker and the deploy script, which says nothing more.
 */
export type HealthState = "ok" | "attention" | "off";
export type HealthLine = {
  key: "database" | "worker" | "cleanup" | "quickbooks" | "money" | "mail" | "forms" | "parents" | "due_reminders" | "backup" | "version"
    | "buyout_check" | "volunteer_reminders";
  title: string;
  /** "ok": working. "attention": something a person should look at. "off": not set up or switched off, which may be by choice. */
  state: HealthState;
  /** The state in a word or two, as the page shows it beside the title. Empty when the line has no state to speak of. */
  word: string;
  says: string;
  /** When each thing last worked (or failed); `at` is null when it never has. */
  times: { label: string; at: string | null }[];
  notes: string[];
  fix: { href: string; label: string } | null;
};

/** The worker wakes every minute (scripts/worker.mjs). Five minutes without a wake is a worker that has stopped. */
export const WORKER_LATE_MS = 5 * 60_000;
/** How far back the parent line looks for sign-ins, to tell whether the portal learns visitors' addresses. */
export const SIGNIN_ADDRESS_LOOKBACK_MS = 14 * 24 * 3_600_000;

/** The read of every family's invoices is daily. Two days without one finishing means runs are failing or not starting. */
export const MONEY_OLD_MS = 48 * 3_600_000;

/** Backups are meant to be nightly. Two days without one means a night was missed and nobody noticed. */
export const BACKUP_OLD_MS = 48 * 3_600_000;

const bytesWords = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

export async function healthReport(now: Date = new Date()): Promise<HealthLine[]> {
  // The database first, on its own: if it can't answer, nothing below can be read, and the page says so.
  await db.execute(sql`select 1`);
  const [wake, [cleanup], [lastWrite], conn, problems, roster, mail, parents, backup, signins, forms, waiting, untemplated, moneyRun, writes, checked] = await Promise.all([
    lastWake(),
    db.select().from(jobRun).where(eq(jobRun.job, CLEANUP_JOB)).orderBy(desc(jobRun.id)).limit(1),
    // Each change the portal makes in QuickBooks leaves an audit row: the newest is when one last worked.
    db.select({ at: auditLog.at }).from(auditLog).where(inArray(auditLog.action, [...QUICKBOOKS_WRITE_ACTION])).orderBy(desc(auditLog.id)).limit(1),
    connectionView(), quickbooksProblems(now), loadRosterPage(), mailSummary(), getParentSettings(), lastBackup(),
    // The newest sign-ins: if none of them has an address, the header CLIENT_IP_HEADER names isn't reaching the portal.
    db.select({ ip: auditLog.ip }).from(auditLog)
      .where(and(inArray(auditLog.action, ["signin.code_sent", "signin"]), gte(auditLog.at, new Date(now.getTime() - SIGNIN_ADDRESS_LOOKBACK_MS))))
      .orderBy(desc(auditLog.id)).limit(20),
    formsSummary(), formsWaiting(now),
    // Form requirements of the current season that have no template: parents read "not ready" for them.
    db.select({ id: requirement.id }).from(requirement).innerJoin(seasonStep, eq(requirement.stepId, seasonStep.id)).innerJoin(season, eq(seasonStep.seasonId, season.id))
      .where(and(eq(season.isCurrent, true), eq(requirement.kind, "form"), isNull(requirement.form))),
    moneyRunView(),
    queueCounts(),
    lastCheck(),
  ]);
  const lines: HealthLine[] = [];

  lines.push({ key: "database", title: "Database", state: "ok", word: "Working", says: "Answering. This page read it just now.", times: [{ label: "Last answered", at: now.toISOString() }], notes: [], fix: null });

  type Verdict = Pick<HealthLine, "state" | "word" | "says">;
  const wakeAge = wake ? now.getTime() - Date.parse(wake) : null;
  const stopped = "Until it runs, QuickBooks isn't refreshed, welcome emails aren't sent and nothing is cleaned up. Check on the server that the worker is running.";
  const worker: Verdict = wakeAge === null ? { state: "attention", word: "Needs attention", says: `The worker has never checked in. ${stopped}` }
    : wakeAge > WORKER_LATE_MS ? { state: "attention", word: "Needs attention", says: `The worker has stopped checking in. It should wake every minute. ${stopped}` }
      : { state: "ok", word: "Working", says: "Waking every minute to run the scheduled jobs." };
  lines.push({ key: "worker", title: "Worker", ...worker, times: [{ label: "Last woke", at: wake }], notes: [], fix: null });

  const cleaned: Verdict = !cleanup ? { state: "off", word: "Not yet run", says: "Hasn't run yet. The worker runs it once a day: it removes expired sessions, used sign-in codes and other records that are past use." }
    : cleanup.outcome === "failed" ? { state: "attention", word: "Needs attention", says: "The last clean-up couldn't finish. The worker tries again in 15 minutes." }
      : { state: "ok", word: "Working", says: "Once a day, removes expired sessions, used sign-in codes and other records that are past use." };
  lines.push({
    key: "cleanup", title: "Daily clean-up", ...cleaned, notes: cleanup?.detail ? [cleanup.detail] : [], fix: null,
    times: [{ label: cleanup && cleanup.outcome !== "ok" ? "Last tried" : "Last ran", at: cleanup ? (cleanup.finishedAt ?? cleanup.startedAt).toISOString() : null }],
  });

  const rosterTimes = [{ label: "Last token refresh", at: conn.lastTokenRefreshAt }, { label: "Last roster read", at: roster.lastOkAt },
    { label: "Last change made in QuickBooks", at: lastWrite?.at.toISOString() ?? null }];
  // What the portal reads and what it changes, in the words the QuickBooks settings page uses.
  const use = `${QUICKBOOKS_USE.reads} ${QUICKBOOKS_USE.writes}`;
  const qboFix = { href: "/staff/settings/quickbooks", label: "Open QuickBooks settings" };
  // Staff changes QuickBooks hasn't taken yet (src/lib/roster/queue.ts): a stuck one waits for a person.
  const queueNote = writes.waiting + writes.stuck === 0 ? [] : [`Changes waiting for QuickBooks (staff roster changes and volunteer buy-out invoices): ${writes.waiting} waiting to reach QuickBooks, ${writes.stuck} stuck${writes.stuck ? " and waiting for someone to try them again or give them up on the Reconciliation page" : ""}.`];
  const queueFix = { href: "/staff/reconciliation", label: "Open Reconciliation" };
  if (!conn.configured) {
    lines.push({ key: "quickbooks", title: "QuickBooks", state: "off", word: "Not set up", says: "Not set up. Families, students and what they owe come from QuickBooks, so parents see none of it yet.", times: [], notes: [], fix: qboFix });
  } else if (!conn.connected) {
    lines.push({ key: "quickbooks", title: "QuickBooks", state: "attention", word: "Not connected", says: "Not connected. The Intuit app's keys are saved, but the portal can't read the roster or what families owe, and parents can't change their phone or address, until an Admin connects.",
      times: rosterTimes, notes: [...queueNote, use], fix: qboFix });
  } else {
    // The check of the portal's own requests (src/lib/quickbooks/sandbox-check/): when it last ran, and whether every request answered as expected.
    const checkFailed = checked?.outcome === "not_as_expected";
    const checkFix = { href: "/staff/settings/quickbooks/check", label: "Check the portal's requests" };
    const attention = problems.length > 0 || writes.stuck > 0 || checkFailed;
    lines.push({
      key: "quickbooks", title: "QuickBooks", state: attention ? "attention" : "ok", word: attention ? "Needs attention" : "Connected",
      times: [...rosterTimes, { label: "Requests last checked", at: checked?.at ?? null }],
      notes: [...problems.map((p) => p.text), ...queueNote, lastCheckWords(checked), use], fix: problems.length ? qboFix : writes.stuck ? queueFix : checkFix,
      says: `Connected to ${conn.companyName ?? "a QuickBooks company"}${conn.environment === "sandbox" ? " (an Intuit sandbox, not the club's real books)" : ""}.`,
    });
  }

  // The worker's daily read of every family's invoices (src/lib/money/sweep.ts), which the Balances page shows.
  const moneyTimes = [{ label: "Last finished", at: moneyRun.last?.ok ? moneyRun.last.finishedAt : null },
    { label: "Last stopped", at: moneyRun.last && !moneyRun.last.ok ? moneyRun.last.finishedAt : null }];
  const moneyFix = { href: "/staff/balances", label: "Open Balances" };
  const moneyAge = moneyRun.last ? now.getTime() - Date.parse(moneyRun.last.finishedAt) : null;
  const money: Verdict = !conn.connected || conn.needsAdmin ? { state: "off", word: "Not running", says: "Reads every family's invoices once a day while QuickBooks is connected. It waits until QuickBooks is connected again." }
    : moneyRun.running ? { state: "ok", word: "Reading", says: `Reading every family's invoices now: ${moneyRun.running.read} read so far.` }
      : !moneyRun.last ? { state: "off", word: "Not yet run", says: "Hasn't run yet. The worker reads every family's invoices once a day, one family at a time, so Balances shows what each family owes." }
        : !moneyRun.last.ok ? { state: "attention", word: "Needs attention", says: "The last read of every family's invoices stopped part way. The worker carries on from there 15 minutes later." }
          : moneyAge !== null && moneyAge > MONEY_OLD_MS ? { state: "attention", word: "Needs attention", says: "The last read of every family's invoices finished more than 2 days ago. It should run once a day." }
            : { state: "ok", word: "Working", says: "Once a day, reads every family's invoices from QuickBooks, one family at a time, for the Balances page and the parents' pages." };
  lines.push({ key: "money", title: "Every family's invoices", ...money, times: moneyTimes, fix: money.state === "attention" ? moneyFix : null,
    notes: [...(moneyRun.last && !moneyRun.last.ok && moneyRun.last.detail ? [moneyRun.last.detail] : []), ...(moneyRun.asked ? ["A staff member asked for a read; the worker starts it within a minute."] : [])] });

  // The daily check of the buy-out invoices, which follows that read (./job-lines.ts).
  lines.push(await buyoutCheckLine(conn, now));

  const mailTimes = [{ label: "Last sent", at: mail.status.lastSuccessAt }, { label: "Last failure", at: mail.status.lastFailureAt }];
  const mailFix = { href: "/staff/settings/mail", label: "Open mail settings" };
  const failing = mailFailing(mail.status);
  if (!mail.config) {
    lines.push({ key: "mail", title: "Outgoing mail", state: "attention", word: "Not set up", says: "Not set up, so parents can't be sent sign-in codes.", times: [], notes: [], fix: mailFix });
  } else if (!mail.working) {
    lines.push({ key: "mail", title: "Outgoing mail", state: "attention", word: "Not tested", says: "Not tested with the settings it has now, so parents can't sign in. Send a test email from mail settings.", times: mailTimes, notes: [], fix: mailFix });
  } else if (failing) {
    lines.push({ key: "mail", title: "Outgoing mail", state: "attention", word: "Needs attention", says: "Tested, but the last email failed. Parents can't get sign-in codes until a send works again.", times: mailTimes,
      notes: mail.status.lastError ? [mail.status.lastError] : [], fix: mailFix });
  } else {
    lines.push({ key: "mail", title: "Outgoing mail", state: "ok", word: "Working", says: `Tested and working, sending ${mail.config.method === "graph" ? "through Microsoft 365" : "by SMTP"}.`, times: mailTimes, notes: [], fix: null });
  }

  // The volunteer reminders the worker sends (./job-lines.ts).
  lines.push(await volunteerRemindersLine({ signin: parents.signin, welcome: parents.welcome, mailWorking: mail.working }));

  // Forms: the club's Documenso, from what the portal recorded of its own calls (this page calls nothing outside the
  // portal). Documenso can't be asked whether its webhook is set up, so the line shows when one last arrived.
  const formsFix = { href: "/staff/settings/forms", label: "Open Forms settings" };
  const formsTimes = [{ label: "Last answered", at: forms.status.lastApiOkAt }, { label: "Last webhook", at: forms.status.lastWebhookAt }, { label: "Last asked about open forms", at: forms.status.lastAskedAt }];
  // Signed forms whose evidence (the sealed PDF, the certificate, the audit log) isn't kept yet, and any kept file a later fetch gave a different hash.
  const evidence = await evidenceHealth(now);
  const evidenceNotes = [
    ...(evidence.waiting > 0 ? [`Evidence waiting: ${evidence.waiting === 1 ? "1 signed form hasn't" : `${evidence.waiting} signed forms haven't`} had the signed copy and its record kept yet. The worker fetches them from Documenso a few at a time.`] : []),
    ...(evidence.late > 0 ? [`${evidence.late === 1 ? "1 signed form has" : `${evidence.late} signed forms have`} waited more than an hour for the signed copy to be kept. Check that Documenso answers, and the forms line above.`] : []),
    ...(evidence.noLink > 0 ? [`${evidence.noLink === 1 ? "1 signed form can't" : `${evidence.noLink} signed forms can't`} be filed: the family or student it was signed for has no link to a customer in the QuickBooks company the roster was read from, so the portal can't record whose form it is. Nothing is asked of Documenso for them until the roster is read again. Check the QuickBooks line and read the roster again.`] : []),
    ...(evidence.mismatches > 0 ? [`${evidence.mismatches === 1 ? "1 signed form" : `${evidence.mismatches} signed forms`} came back from Documenso with a different file than the one kept. The first copy is kept; the audit log has the details (forms.evidence.mismatch).`] : []),
  ];
  if (forms.origin === null && evidence.waiting + evidence.mismatches === 0) {
    lines.push({ key: "forms", title: "Forms (Documenso)", state: "off", word: "Not set up", says: "Not set up. Parents read that forms aren't ready to sign yet; nothing else changes for them.", times: [], notes: [], fix: formsFix });
  } else {
    const apiFailing = formsApiFailing(forms.status);
    const notes: string[] = [];
    if (waiting.open > 0) notes.push(`${waiting.open === 1 ? "1 form is" : `${waiting.open} forms are`} out for signing and not finished. The worker asks Documenso about each every few minutes.`);
    if (waiting.sealingLate > 0) notes.push(`${waiting.sealingLate === 1 ? "1 form was" : `${waiting.sealingLate} forms were`} signed by everyone more than an hour ago and Documenso still hasn't finished the signed copy. Check Documenso on its server: its signing certificate, and its timestamp service if one is set.`);
    if (!forms.webhookSecretSaved) notes.push("No webhook secret is made, so Documenso can't tell the portal when a form is signed. The portal still asks every few minutes.");
    notes.push(...evidenceNotes);
    if (untemplated.length > 0) notes.push(`${untemplated.length === 1 ? "1 form requirement" : `${untemplated.length} form requirements`} of the current season ${untemplated.length === 1 ? "has" : "have"} no template attached, so parents read that ${untemplated.length === 1 ? "it isn't" : "they aren't"} ready.`);
    const verdict: Verdict = forms.origin === null ? { state: "attention", word: "Needs attention", says: "Forms aren't set up any more, but signed forms still wait to have their evidence kept, or a kept file was found changed." }
      : !forms.tokenReadable ? { state: "attention", word: "Needs attention", says: "The saved API token can't be opened with this server's encryption key. Enter it again in Forms settings." }
      : apiFailing ? { state: "attention", word: "Needs attention", says: "The last call to Documenso failed. Parents can't open a form to sign until it answers again." }
        : evidence.noLink > 0 ? { state: "attention", word: "Needs attention", says: `Connected to Documenso at ${forms.origin}, but signed forms can't be filed until their families are linked in the roster's QuickBooks company.` }
        : waiting.sealingLate > 0 ? { state: "attention", word: "Needs attention", says: `Connected to Documenso at ${forms.origin}, but signed forms are waiting too long to be finished.` }
          : evidence.late > 0 || evidence.mismatches > 0 ? { state: "attention", word: "Needs attention", says: `Connected to Documenso at ${forms.origin}, but ${evidence.mismatches > 0 ? "a signed form's file came back different from the one kept" : "signed forms are waiting too long for their evidence to be kept"}.` }
          : !forms.status.lastApiOkAt ? { state: "attention", word: "Not checked", says: `Set up for Documenso at ${forms.origin}, but no call has worked yet. Check the connection in Forms settings.` }
            : { state: "ok", word: "Connected", says: `Connected to Documenso at ${forms.origin}.` };
    // Forms that can't be filed for want of a link are the roster's to mend, not Documenso's: the way to it is QuickBooks.
    const unlinkedOnly = evidence.noLink > 0 && forms.origin !== null && forms.tokenReadable && !apiFailing;
    lines.push({ key: "forms", title: "Forms (Documenso)", ...verdict, times: formsTimes, fix: verdict.state !== "attention" ? null : unlinkedOnly ? qboFix : formsFix,
      notes: [...(apiFailing && forms.status.lastApiError ? [`The failure: ${forms.status.lastApiError}.`] : []), ...notes] });
  }

  // Without a visitor's address the audit log can't say where a sign-in came from, and the flood limit per address
  // can't apply (signin-codes.ts). Chosen (none), that is said; not chosen, it is a header the proxy doesn't send.
  const noAddresses = signins.length > 0 && signins.every((r) => r.ip === null);
  const addressNote = !noAddresses ? null : env.CLIENT_IP_HEADER === "none"
    ? "Visitors' addresses aren't recorded, because CLIENT_IP_HEADER is none: the audit log shows no address, and sign-ins have no limit per address."
    : `The latest sign-ins have no address: the proxy in front of the portal doesn't send the header ${env.CLIENT_IP_HEADER}. Set CLIENT_IP_HEADER in the server's env file to the header it does send (.env.example lists them).`;
  lines.push(parents.signin
    ? addressNote && env.CLIENT_IP_HEADER !== "none"
      ? { key: "parents", title: "Parent sign-ins", state: "attention", word: "Needs attention", says: "On. Parents sign in with a code sent to their email.", times: [], notes: [addressNote], fix: null }
      : { key: "parents", title: "Parent sign-ins", state: "ok", word: "On", says: "On. Parents sign in with a code sent to their email.", times: [], notes: addressNote ? [addressNote] : [], fix: null }
    : { key: "parents", title: "Parent sign-ins", state: "off", word: "Off", times: [], notes: [], fix: { href: "/staff/settings/parents", label: "Open parent sign-ins" },
      says: parents.everEnabled ? "Switched off. No parent can sign in right now." : "Not switched on yet. No parent can sign in until an Admin switches them on." });

  // The reminders before a payment's or a checklist item's due date (src/lib/seasons/due-reminders.ts): when the worker
  // last looked, and what it sent or couldn't send that day.
  const due = await lastDueReminders();
  const dueTimes = [{ label: "Last looked", at: due?.at ?? null }, { label: "Last sent", at: due?.lastSentAt ?? null }, { label: "Last failure", at: due?.lastFailedAt ?? null }];
  const reminders = (n: number) => (n === 1 ? "1 reminder" : `${n} reminders`);
  const dueNote = !due ? "It hasn't looked yet. It looks each day from 9:00 club time."
    : due.sent + due.failed === 0 ? `On ${dateWords(due.day)}, the last day it looked, no family was owed a reminder.`
      : `On ${dateWords(due.day)}, the last day it looked: ${reminders(due.sent)} sent${due.failed ? `, and ${due.failed === 1 ? "1 email" : `${due.failed} emails`} couldn't be sent` : ""}.`;
  const dueFailing = Boolean(due?.lastFailedAt && (!due.lastSentAt || due.lastFailedAt >= due.lastSentAt));
  lines.push(!parents.signin || !parents.welcome
    ? { key: "due_reminders", title: "Payment and checklist reminders", state: "off", word: "Off", times: dueTimes, notes: due ? [dueNote] : [], fix: { href: "/staff/settings/parents", label: "Open parent sign-ins" },
      says: "Off. Families are emailed before a payment or a checklist item is due only while parent sign-ins and welcome emails are both switched on." }
    : !mail.working
      ? { key: "due_reminders", title: "Payment and checklist reminders", state: "off", word: "Waiting for mail", times: dueTimes, notes: due ? [dueNote] : [], fix: { href: "/staff/settings/mail", label: "Open mail settings" },
        says: "Not sending until outgoing mail is set up and tested (the Outgoing mail line)." }
    : dueFailing
      ? { key: "due_reminders", title: "Payment and checklist reminders", state: "attention", word: "Needs attention", times: dueTimes, notes: [dueNote], fix: { href: "/staff/settings/mail", label: "Open mail settings" },
        says: "The last reminder email couldn't be sent. The worker tries it again 15 minutes later, while it is still the day to send it. Check the outgoing mail line." }
      : { key: "due_reminders", title: "Payment and checklist reminders", state: "ok", word: "On", times: dueTimes, notes: [dueNote], fix: null,
        says: "On. From 9:00 club time, families are emailed 14 days and 3 days before a required payment or checklist item of theirs is due." });

  const backupAge = backup ? now.getTime() - Date.parse(backup.at) : null;
  const backedUp: Verdict = backupAge === null ? { state: "attention", word: "None recorded", says: "No backup has been recorded. On the server, check that the backup service is running, or run scripts/backup.sh with a folder to keep backups in and set it to run every night." }
    : backupAge > BACKUP_OLD_MS ? { state: "attention", word: "Needs attention", says: "The last backup is more than 2 days old. Check that the nightly backup on the server is still running." }
      : { state: "ok", word: "Recent", says: "Backed up. Keep the server's env file, and Documenso's signing certificate with its passphrase, with the backups: without the env file's encryption key, a backup can't bring back the QuickBooks connection or the sign-in settings." };
  // Whether Documenso's database was in it, as scripts/backup.sh recorded (a record from before it did says nothing).
  const documensoNote = !backup || backup.documenso === "unknown" ? []
    : backup.documenso === "none"
      ? [forms.origin !== null
        ? "Documenso's database wasn't part of this backup, though forms are signed in Documenso. Its templates and unfinished forms are only in its own database: back that up too."
        : "Documenso's database wasn't part of this backup."]
      : [`Documenso's database too: ${backup.documenso.file}${backup.documenso.bytes !== null ? `, ${bytesWords(backup.documenso.bytes)}` : ""}`];
  lines.push({
    key: "backup", title: "Last backup", ...backedUp, times: [{ label: "Last backup", at: backup?.at ?? null }], fix: null,
    notes: [...(backup?.file ? [`${backup.file}${backup.bytes !== null ? `, ${bytesWords(backup.bytes)}` : ""}`] : []), ...documensoNote],
  });

  lines.push({ key: "version", title: "Version", state: "ok", word: "", says: `Running ${BUILD_VERSION}.`, times: [], notes: [], fix: null });
  return lines;
}
