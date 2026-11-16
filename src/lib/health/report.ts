import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun } from "@/lib/db/schema";
import { lastWake } from "@/lib/jobs/runner";
import { CLEANUP_JOB } from "@/lib/jobs/cleanup";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { QUICKBOOKS_USE, QUICKBOOKS_WRITE_ACTION } from "@/lib/quickbooks/what-it-does";
import { loadRosterPage } from "@/lib/roster/queries";
import { mailSummary } from "@/lib/mail/settings";
import { getParentSettings } from "@/lib/parents/settings";
import { lastBackup } from "./backup";
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
  key: "database" | "worker" | "cleanup" | "quickbooks" | "mail" | "parents" | "backup" | "version";
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

/** Backups are meant to be nightly. Two days without one means a night was missed and nobody noticed. */
export const BACKUP_OLD_MS = 48 * 3_600_000;

const bytesWords = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

export async function healthReport(now: Date = new Date()): Promise<HealthLine[]> {
  // The database first, on its own: if it can't answer, nothing below can be read, and the page says so.
  await db.execute(sql`select 1`);
  const [wake, [cleanup], [lastWrite], conn, problems, roster, mail, parents, backup, signins] = await Promise.all([
    lastWake(),
    db.select().from(jobRun).where(eq(jobRun.job, CLEANUP_JOB)).orderBy(desc(jobRun.id)).limit(1),
    // The one thing the portal writes to QuickBooks leaves an audit row each time: the newest is when it last worked.
    db.select({ at: auditLog.at }).from(auditLog).where(eq(auditLog.action, QUICKBOOKS_WRITE_ACTION)).orderBy(desc(auditLog.id)).limit(1),
    connectionView(), quickbooksProblems(now), loadRosterPage(), mailSummary(), getParentSettings(), lastBackup(),
    // The newest sign-ins: if none of them has an address, the header CLIENT_IP_HEADER names isn't reaching the portal.
    db.select({ ip: auditLog.ip }).from(auditLog)
      .where(and(inArray(auditLog.action, ["signin.code_sent", "signin"]), gte(auditLog.at, new Date(now.getTime() - SIGNIN_ADDRESS_LOOKBACK_MS))))
      .orderBy(desc(auditLog.id)).limit(20),
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
    { label: "Last change by a parent", at: lastWrite?.at.toISOString() ?? null }];
  // What the portal reads and what it changes, in the words the QuickBooks settings page uses.
  const use = `${QUICKBOOKS_USE.reads} ${QUICKBOOKS_USE.writes}`;
  const qboFix = { href: "/staff/settings/quickbooks", label: "Open QuickBooks settings" };
  if (!conn.configured) {
    lines.push({ key: "quickbooks", title: "QuickBooks", state: "off", word: "Not set up", says: "Not set up. Families, students and what they owe come from QuickBooks, so parents see none of it yet.", times: [], notes: [], fix: qboFix });
  } else if (!conn.connected) {
    lines.push({ key: "quickbooks", title: "QuickBooks", state: "attention", word: "Not connected", says: "Not connected. The Intuit app's keys are saved, but the portal can't read the roster or what families owe, and parents can't change their phone or address, until an Admin connects.",
      times: rosterTimes, notes: [use], fix: qboFix });
  } else {
    lines.push({
      key: "quickbooks", title: "QuickBooks", state: problems.length ? "attention" : "ok", word: problems.length ? "Needs attention" : "Connected", times: rosterTimes, notes: [...problems.map((p) => p.text), use], fix: problems.length ? qboFix : null,
      says: `Connected to ${conn.companyName ?? "a QuickBooks company"}${conn.environment === "sandbox" ? " (an Intuit sandbox, not the club's real books)" : ""}.`,
    });
  }

  const mailTimes = [{ label: "Last sent", at: mail.status.lastSuccessAt }, { label: "Last failure", at: mail.status.lastFailureAt }];
  const mailFix = { href: "/staff/settings/mail", label: "Open mail settings" };
  const failing = Boolean(mail.status.lastFailureAt && (!mail.status.lastSuccessAt || mail.status.lastFailureAt > mail.status.lastSuccessAt));
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

  // Forms adds its line here: Documenso's API and its webhook, each with when it last worked (v1 spec §14).

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

  const backupAge = backup ? now.getTime() - Date.parse(backup.at) : null;
  const backedUp: Verdict = backupAge === null ? { state: "attention", word: "None recorded", says: "No backup has been recorded. On the server, run scripts/backup.sh with a folder to keep backups in, and set it to run every night." }
    : backupAge > BACKUP_OLD_MS ? { state: "attention", word: "Needs attention", says: "The last backup is more than 2 days old. Check that the nightly backup on the server is still running." }
      : { state: "ok", word: "Recent", says: "Backed up. Keep the server's env file with the backups: without its encryption key, a backup can't bring back the QuickBooks connection or the sign-in settings." };
  lines.push({
    key: "backup", title: "Last backup", ...backedUp, times: [{ label: "Last backup", at: backup?.at ?? null }], fix: null,
    notes: backup?.file ? [`${backup.file}${backup.bytes !== null ? `, ${bytesWords(backup.bytes)}` : ""}`] : [],
  });

  lines.push({ key: "version", title: "Version", state: "ok", word: "", says: `Running ${BUILD_VERSION}.`, times: [], notes: [], fix: null });
  return lines;
}
