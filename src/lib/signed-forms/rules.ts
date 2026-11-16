// The pure rules of signed forms for staff (v1 spec §9.3 and §9.4, as the Documenso verification changed them): how
// long the worker waits after a failed fetch of evidence, the words of each cell of the staff matrix, who still has to
// sign, which days a scheduled reminder falls on, and when a form can be started again. No database, no clock but the
// one passed in: each is unit-tested (tests/unit/signed-forms-rules.test.ts).
import type { FormReminders, RequestSigner, SignatureRequestState } from "@/lib/db/schema";

/* ---- Fetching the evidence ---- */

const MINUTE = 60_000;
/** After the first failure the worker tries again in 5 minutes, after the second in 30, and then every 3 hours. */
export const EVIDENCE_BACKOFF_MS = [5 * MINUTE, 30 * MINUTE, 180 * MINUTE] as const;
/** When to try again after `failures` failed tries in a row (1 for the first). */
export function nextEvidenceTry(failures: number, at: Date): Date {
  const wait = EVIDENCE_BACKOFF_MS[Math.min(Math.max(failures, 1), EVIDENCE_BACKOFF_MS.length) - 1]!;
  return new Date(at.getTime() + wait);
}
/** A complete form whose evidence has waited longer than this is a warning on the Health page. */
export const EVIDENCE_LATE_MS = 60 * MINUTE;
/** Microsoft Graph refuses an attachment of 3 MB or more in one request: a larger sealed PDF is sent as a link instead. */
export const ATTACH_LIMIT_BYTES = 3_000_000;

/* ---- The staff matrix ---- */

export type CellState = "not_asked" | "not_opened" | "waiting" | "waiting_other" | "sealing" | "signed" | "declined" | "waived";
/** What staff read in each cell. A requirement that doesn't cover the student has an empty cell. */
export const CELL_WORDS: Record<CellState, string> = {
  not_asked: "",
  not_opened: "Not opened yet",
  waiting: "Waiting for a guardian",
  waiting_other: "Waiting for the other guardian",
  sealing: "Signed, being sealed",
  signed: "Signed",
  declined: "Declined",
  waived: "Waived",
};
/** The states staff can filter by, in the order the filter lists them. */
export const FILTER_STATES: readonly Exclude<CellState, "not_asked">[] = ["not_opened", "waiting", "waiting_other", "sealing", "signed", "declined", "waived"];
/** How StateWords draws each: a signed form is done, a waived one waived, the rest still to do. */
export const cellTone = (s: CellState): "done" | "waived" | "todo" => (s === "signed" ? "done" : s === "waived" ? "waived" : "todo");

/**
 * One cell: what is recorded for one requirement and one family or student. A signed form reads "Signed" even when it
 * was waived as well; otherwise a waiver comes before the request's own state.
 */
export function cellState(o: { covered: boolean; waived: boolean; request: { state: SignatureRequestState; signers: readonly Pick<RequestSigner, "signedAt">[] } | null }): CellState {
  if (!o.covered) return "not_asked";
  const state = o.request?.state ?? "not_opened";
  if (state === "complete") return "signed";
  if (o.waived) return "waived";
  if (state === "signed") return "sealing";
  if (state === "declined") return "declined";
  if (state === "waiting") return o.request!.signers.some((s) => s.signedAt !== null) ? "waiting_other" : "waiting";
  return "not_opened";
}

/* ---- Reminders ---- */

/** A guardian of the family who could be reminded: a link to the family that isn't closed, and not blocked. */
export type Remindable = { parentId: string };

/**
 * The guardians who still have to sign a form, out of those with an open link to the family who are not blocked.
 * Nobody, once everyone has signed (complete, or signed and being sealed). "Any one guardian": every one of them, since
 * any of them can sign it. "Every guardian": those who haven't signed it yet.
 */
export function whoStillHasToSign(mode: "any" | "every", request: { state: SignatureRequestState; signers: readonly Pick<RequestSigner, "parentId" | "signedAt">[] } | null,
  guardians: readonly Remindable[]): string[] {
  const state = request?.state ?? "not_opened";
  if (state === "complete" || state === "signed") return [];
  const ids = [...new Set(guardians.map((g) => g.parentId))];
  if (mode === "any") return ids;
  const signed = new Set((request?.signers ?? []).filter((s) => s.signedAt !== null).map((s) => s.parentId));
  return ids.filter((id) => !signed.has(id));
}

export const REMINDER_DAYS_BEFORE = [14, 7, 3, 1] as const;
/** Once a week after the due date, this many times at most. */
export const WEEKLY_AFTER_TIMES = 4;
/** Scheduled reminders go at the worker's first wake on or after this hour of the club's day. */
export const REMINDER_HOUR = 9;

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The club dates a form's reminders fall on, in order: some of 14, 7, 3 and 1 days before it is due, and then weekly. */
export function reminderDates(dueOn: string | null, schedule: FormReminders | null): string[] {
  if (!dueOn || !schedule) return [];
  const before = [...new Set(schedule.before)].filter((d) => (REMINDER_DAYS_BEFORE as readonly number[]).includes(d)).map((d) => addDays(dueOn, -d));
  const after = schedule.weeklyAfter ? Array.from({ length: WEEKLY_AFTER_TIMES }, (_, i) => addDays(dueOn, 7 * (i + 1))) : [];
  return [...before, ...after].sort();
}
/** True when `today` (the club's date) is one of a form's reminder days. */
export const isReminderDay = (today: string, dueOn: string | null, schedule: FormReminders | null): boolean => reminderDates(dueOn, schedule).includes(today);

/** The hour of the day on the club's clock, 0 to 23. */
export function clubHour(timeZone: string, at: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(at);
  return Number(hour) % 24;
}

/** A schedule from what staff sent, or null when it says nothing should go. Anything not on the list is dropped. */
export function parseSchedule(raw: { before: readonly unknown[]; weeklyAfter: unknown }): FormReminders | null {
  const before = REMINDER_DAYS_BEFORE.filter((d) => raw.before.some((b) => String(b) === String(d)));
  const weeklyAfter = raw.weeklyAfter === true || raw.weeklyAfter === "on" || raw.weeklyAfter === "true";
  return before.length === 0 && !weeklyAfter ? null : { before: [...before], weeklyAfter };
}

/* ---- Starting a form again ---- */

/** Signed by everyone this long ago and still not sealed: staff may start it again. Documenso's own sweep stops after six hours. */
export const UNSEALED_RESTART_MS = 6 * 60 * MINUTE;
export type RestartReason = "declined" | "not_sealed" | "gone" | "lost_access";
export const RESTART_REASONS: Record<RestartReason, string> = {
  declined: "A guardian declined it",
  not_sealed: "Everyone signed more than six hours ago and it still isn't sealed",
  gone: "Documenso no longer has the document",
  lost_access: "A guardian who must sign it has lost access",
};

export type RestartPlan =
  | { ok: true; withdraw: "none" | "delete" | "cancel" }
  | { ok: false; why: string };

/**
 * What starting a request again does, in each state. A complete form is never touched. A request with no document has
 * nothing to start again. Otherwise its document is withdrawn as the verification says (deleted while nobody has
 * signed it, cancelled once someone has), and the request goes back to not opened. Each reason is allowed only in the
 * state it describes: "declined" for a declined form, "not_sealed" for one everyone signed more than six hours ago;
 * "gone" and "lost_access" for any form that is out and not finished.
 */
export function restartPlan(row: { state: SignatureRequestState; envelopeId: string | null; allSignedAt: Date | null; signers: readonly Pick<RequestSigner, "signedAt">[] },
  reason: RestartReason, now: Date): RestartPlan {
  if (row.state === "complete") return { ok: false, why: "This form is signed and sealed. A signed form is the club's record and is never started again." };
  if (row.state === "not_opened" || row.envelopeId === null) return { ok: false, why: "Nothing has been made for this form yet, so there is nothing to start again." };
  if (reason === "declined" && row.state !== "declined") return { ok: false, why: "This form wasn't declined." };
  if (reason === "not_sealed" && (row.state !== "signed" || row.allSignedAt === null || now.getTime() - row.allSignedAt.getTime() <= UNSEALED_RESTART_MS)) {
    return { ok: false, why: "This form hasn't waited more than six hours to be sealed. Documenso may still finish it." };
  }
  const anySigned = row.state === "signed" || row.signers.some((s) => s.signedAt !== null);
  return { ok: true, withdraw: anySigned ? "cancel" : "delete" };
}
