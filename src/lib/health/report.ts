import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, requirement, season, seasonStep } from "@/lib/db/schema";
import { lastWake } from "@/lib/jobs/runner";
import { CLEANUP_JOB } from "@/lib/jobs/cleanup";
import { CHALLENGE_SWEEP_MARK, failedLast, readMark, WELCOME_MARK } from "@/lib/jobs/marks";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { QUICKBOOKS_USE, QUICKBOOKS_WRITE_ACTION } from "@/lib/quickbooks/what-it-does";
import { loadRosterPage } from "@/lib/roster/queries";
import { queueCounts } from "@/lib/roster/queue";
import { mailFailing, mailSummary } from "@/lib/mail/settings";
import { getParentSettings } from "@/lib/parents/settings";
import { welcomesToSend } from "@/lib/parents/welcome";
import { takeInWaitingFor, takeInWaitWords } from "@/lib/parents/contact-take-in";
import { readBreachMark, type BreachMark } from "@/lib/parents/breach-mark";
import { oldAddressPasskeys } from "@/lib/parents/signin-reset";
import { OLD_PASSKEYS_COPY } from "@/lib/parents/old-passkeys-copy";
import { BREACH_TIMEOUT_MS, type BreachNotChecked } from "@/lib/parents/breach-check";
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
    | "buyout_check" | "volunteer_reminders" | "breach_check";
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

/** Why the breach check last couldn't answer, in words. */
const BREACH_FAILURE_WORDS: Record<BreachNotChecked, string> = {
  timeout: `The last time it didn't answer within ${BREACH_TIMEOUT_MS / 1000} seconds.`,
  unreachable: "The last time it couldn't be reached.",
  bad_answer: "The last time its answer couldn't be read.",
};

/**
 * The breach check's line: never asked yet, working (the service's last answer is the latest word), or a failure the
 * latest word. A password chosen while the service can't answer is taken, and its audit row says it wasn't checked.
 */
export function breachCheckLine(mark: BreachMark | null): HealthLine {
  const base = { key: "breach_check" as const, title: "Password breach check", fix: null,
    times: [{ label: "Last answered", at: mark?.answeredAt ?? null }, { label: "Last failed", at: mark?.failedAt ?? null }] };
  if (!mark || (!mark.answeredAt && !mark.failedAt)) {
    return { ...base, state: "off", word: "Not used yet", notes: [],
      says: "Not used yet. When a parent chooses a password from a set-up or reset link, the portal asks the Pwned Passwords service whether it has appeared in a known data breach, sending only the first five characters of a hash of it." };
  }
  if (mark.failedLast) {
    return { ...base, state: "attention", word: "Needs attention", notes: mark.failure ? [BREACH_FAILURE_WORDS[mark.failure]] : [],
      says: "The Pwned Passwords service didn't answer the last time a parent chose a password, so passwords chosen since then were accepted without the check. The portal's server must be able to reach the service on the internet; the line says Working again once it answers." };
  }
  return { ...base, state: "ok", word: "Working", notes: [],
    says: "Answering. Each password a parent chooses is checked against passwords known from data breaches, sending only the first five characters of a hash of it." };
}

/** The clean-up line's words while the sweep of expired passkey challenges at every wake is failing (runner.ts). */
export const SWEEP_FAILED = "The worker's sweep of expired passkey sign-in requests, which runs every minute, failed at its last try. The daily clean-up still removes them once a day; until the sweep works again, they can pile up for a day instead of five minutes. The worker tries again at its next wake.";
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

  // The sweep of expired passkey challenges at every wake (sweepExpiredChallenges(), runner.ts) has no line of its own:
  // it is the clean-up's delete of those rows, run more often. While its latest word is a failure the line says so; the
  // daily clean-up still removes them once a day.
  const sweep = await readMark(CHALLENGE_SWEEP_MARK);
  const sweepFailed = failedLast(sweep);
  const cleaned: Verdict = sweepFailed && cleanup?.outcome !== "failed" ? { state: "attention", word: "Needs attention", says: SWEEP_FAILED }
    : !cleanup ? { state: "off", word: "Not yet run", says: "Hasn't run yet. The worker runs it once a day: it removes expired sessions, used sign-in codes and other records that are past use." }
    : cleanup.outcome === "failed" ? { state: "attention", word: "Needs attention", says: "The last clean-up couldn't finish. The worker tries again in 15 minutes." }
      : { state: "ok", word: "Working", says: "Once a day, removes expired sessions, used sign-in codes and other records that are past use." };
  lines.push({
    key: "cleanup", title: "Daily clean-up", ...cleaned,
    notes: [...(cleanup?.detail ? [cleanup.detail] : []), ...(sweepFailed && cleanup?.outcome === "failed" ? [SWEEP_FAILED] : [])], fix: null,
    times: [{ label: cleanup && cleanup.outcome !== "ok" ? "Last tried" : "Last ran", at: cleanup ? (cleanup.finishedAt ?? cleanup.startedAt).toISOString() : null },
      ...(sweepFailed ? [{ label: "Challenge sweep last failed", at: sweep?.failedAt ?? null }] : [])],
  });

  const rosterTimes = [{ label: "Last token refresh", at: conn.lastTokenRefreshAt }, { label: "Last roster read", at: roster.lastOkAt },
    { label: "Last change made in QuickBooks", at: lastWrite?.at.toISOString() ?? null }];
  // What the portal reads and what it changes, in the words the QuickBooks settings page uses.
  const use = `${QUICKBOOKS_USE.reads} ${QUICKBOOKS_USE.writes}`;
  const qboFix = { href: "/staff/settings/quickbooks", label: "Open QuickBooks settings" };
  // Changes QuickBooks hasn't taken yet (src/lib/roster/queue.ts), staff's and parents': a stuck one waits for a person.
  const queueNote: string[] = writes.waiting + writes.stuck === 0 ? [] : [`Changes waiting for QuickBooks (staff roster changes, parents' phones and mailing addresses, and volunteer buy-out invoices): ${writes.waiting} waiting to reach QuickBooks, ${writes.stuck} stuck${writes.stuck ? " and waiting for someone to try them again or give them up on the Reconciliation page" : ""}.`];
  // Changes saved in the portal first that didn't go through (stage 3's slice 9e: QuickBooks refused them, the portal held
  // them back, or they couldn't be sent): the portal keeps its value, and a person decides. The staff home's Today box says the same.
  if (writes.refused) queueNote.push(`${writes.refused === 1 ? "1 change is" : `${writes.refused} changes are`} kept in the portal that QuickBooks didn't take: the portal keeps its own value until someone sends it again or gives it up on the Reconciliation page.`);
  const queueFix = { href: "/staff/reconciliation", label: "Open Reconciliation" };
  // While the one-time take-in of guardians' phones and addresses (src/lib/parents/contact-take-in.ts) has not run: what it
  // waits for, on this line, where each of its causes lives. Nothing once it has run.
  const takeInWait = await takeInWaitingFor(conn);
  const takeInNote = takeInWait === null ? [] : [takeInWaitWords(takeInWait)];
  if (!conn.configured) {
    lines.push({ key: "quickbooks", title: "QuickBooks", state: "off", word: "Not set up", says: "Not set up. Families, students and what they owe come from QuickBooks, so parents see none of it yet.", times: [], notes: takeInNote, fix: qboFix });
  } else if (!conn.connected) {
    lines.push({ key: "quickbooks", title: "QuickBooks", state: "attention", word: "Not connected", says: "Not connected. The Intuit app's keys are saved, but the portal can't read the roster or what families owe until an Admin connects.",
      times: rosterTimes, notes: [...queueNote, ...takeInNote, use], fix: qboFix });
  } else {
    // The check of the portal's own requests (src/lib/quickbooks/sandbox-check/): when it last ran, and whether every request answered as expected.
    const checkFailed = checked?.outcome === "not_as_expected";
    const checkFix = { href: "/staff/settings/quickbooks/check", label: "Check the portal's requests" };
    const attention = problems.length > 0 || writes.stuck > 0 || writes.refused > 0 || checkFailed;
    lines.push({
      key: "quickbooks", title: "QuickBooks", state: attention ? "attention" : "ok", word: attention ? "Needs attention" : "Connected",
      times: [...rosterTimes, { label: "Requests last checked", at: checked?.at ?? null }],
      notes: [...problems.map((p) => p.text), ...queueNote, ...takeInNote, lastCheckWords(checked), use], fix: problems.length ? (problems.find((p) => p.fix)?.fix ?? qboFix) : writes.stuck || writes.refused ? queueFix : checkFix,
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
    lines.push({ key: "mail", title: "Outgoing mail", state: "attention", word: "Not set up", says: "Not set up, so parents can't sign in.", times: [], notes: [], fix: mailFix });
  } else if (!mail.working) {
    lines.push({ key: "mail", title: "Outgoing mail", state: "attention", word: "Not tested", says: "Not tested with the settings it has now, so parents can't sign in. Send a test email from mail settings.", times: mailTimes, notes: [], fix: mailFix });
  } else if (failing) {
    lines.push({ key: "mail", title: "Outgoing mail", state: "attention", word: "Needs attention", says: "Tested, but the last email failed. Parents can't be sent sign-in codes, password links or welcome emails until a send works again.", times: mailTimes,
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
    ...(evidence.otherCompany > 0 ? [`${evidence.otherCompany === 1 ? "1 signed form can't" : `${evidence.otherCompany} signed forms can't`} be filed yet: QuickBooks is connected to a company other than the one the roster was read from, so the portal can't look up whose form it is in QuickBooks, and asks Documenso nothing for it. Once QuickBooks is connected to the roster's company again it tries again on its own schedule (within a few hours), and this count goes by its last try until then. Check the QuickBooks line.`] : []),
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
        : evidence.otherCompany > 0 ? { state: "attention", word: "Needs attention", says: `Connected to Documenso at ${forms.origin}, but signed forms can't be filed while QuickBooks is connected to a company other than the one the roster was read from.` }
        : waiting.sealingLate > 0 ? { state: "attention", word: "Needs attention", says: `Connected to Documenso at ${forms.origin}, but signed forms are waiting too long to be finished.` }
          : evidence.late > 0 || evidence.mismatches > 0 ? { state: "attention", word: "Needs attention", says: `Connected to Documenso at ${forms.origin}, but ${evidence.mismatches > 0 ? "a signed form's file came back different from the one kept" : "signed forms are waiting too long for their evidence to be kept"}.` }
          : !forms.status.lastApiOkAt ? { state: "attention", word: "Not checked", says: `Set up for Documenso at ${forms.origin}, but no call has worked yet. Check the connection in Forms settings.` }
            : { state: "ok", word: "Connected", says: `Connected to Documenso at ${forms.origin}.` };
    // Forms that can't be filed while QuickBooks is connected to another company are QuickBooks' connection to mend, not
    // Documenso's: the way to it is QuickBooks. A family with no link is no warning: its evidence is kept with no copy.
    const otherCompanyOnly = evidence.otherCompany > 0 && forms.origin !== null && forms.tokenReadable && !apiFailing;
    lines.push({ key: "forms", title: "Forms (Documenso)", ...verdict, times: formsTimes, fix: verdict.state !== "attention" ? null : otherCompanyOnly ? qboFix : formsFix,
      notes: [...(apiFailing && forms.status.lastApiError ? [`The failure: ${forms.status.lastApiError}.`] : []), ...notes] });
  }

  // Without a visitor's address the audit log can't say where a sign-in came from, and the flood limit per address
  // can't apply (signin-codes.ts). Chosen (none), that is said; not chosen, it is a header the proxy doesn't send.
  const noAddresses = signins.length > 0 && signins.every((r) => r.ip === null);
  const addressNote = !noAddresses ? null : env.CLIENT_IP_HEADER === "none"
    ? "Visitors' addresses aren't recorded, because CLIENT_IP_HEADER is none: the audit log shows no address, and sign-ins have no limit per address."
    : `The latest sign-ins have no address: the proxy in front of the portal doesn't send the header ${env.CLIENT_IP_HEADER}. Set CLIENT_IP_HEADER in the server's env file to the header it does send (.env.example lists them).`;
  // Welcome emails waiting because mail is failing: the last welcome the worker tried to send failed, and while that is
  // so it tries one person a wake, not five (sendOwedWelcomes(), src/lib/parents/welcome.ts; its mark, WELCOME_MARK).
  // It counts only the people the worker can send to (welcomesToSend(): owed, not blocked, and able to sign in), so the
  // note goes once none is left to send to, even though no wake has tried anyone since the failure. It shows only while
  // the worker would really try: while the saved mail settings are untested it tries nobody, and the mail line says so.
  const [welcomeMark, owed] = await Promise.all([readMark(WELCOME_MARK), welcomesToSend()]);
  const welcomesNote = parents.signin && parents.welcome && mail.working && failedLast(welcomeMark) && owed > 0
    ? `Welcome emails are waiting because mail is failing: ${owed === 1 ? "1 person is" : `${owed} people are`} owed a welcome or a link to choose a password, and the last one the worker tried to send failed. Until a send works, it tries one person a minute instead of five.`
    : null;
  // Passkeys made at an address other than the portal's now (the sign-in release, slice SI-9b): they no longer work,
  // yet the portal still asks their holders for them, until an Admin removes them on Settings, Parent sign-ins.
  const old = await oldAddressPasskeys();
  const oldNote = old.passkeys > 0 ? OLD_PASSKEYS_COPY.health(old.passkeys, old.people) : null;
  const parentsFix = { href: "/staff/settings/parents", label: "Open parent sign-ins" };
  const headerMissing = addressNote !== null && env.CLIENT_IP_HEADER !== "none";
  const parentsAttention = headerMissing || welcomesNote !== null || oldNote !== null;
  lines.push(parents.signin
    ? { key: "parents", title: "Parent sign-ins", state: parentsAttention ? "attention" : "ok", word: parentsAttention ? "Needs attention" : "On",
      says: "On. Parents sign in with their email and password, and on a device the portal doesn't know yet, a code sent to their email.", times: [],
      notes: [addressNote, welcomesNote, oldNote].filter((x): x is string => x !== null), fix: welcomesNote ? mailFix : oldNote ? parentsFix : null }
    : { key: "parents", title: "Parent sign-ins", state: "off", word: "Off", times: [], notes: oldNote ? [oldNote] : [], fix: parentsFix,
      says: "Off. No parent can sign in until an Admin switches them on." });

  // The check of a chosen password against those known from data breaches (src/lib/parents/breach-check.ts), from what
  // the portal marked each time it asked (src/lib/parents/breach-mark.ts). This page asks the service nothing.
  lines.push(breachCheckLine(await readBreachMark()));

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
