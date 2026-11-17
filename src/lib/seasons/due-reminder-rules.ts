/**
 * The reminders before a required payment's or checklist item's due date (v1 spec §10.1.9), as pure functions: which
 * days to look for, which requirements, which families, and what each email says of each. The sweep that reads the
 * database and sends them is ./due-reminders.ts. Nothing here reads the database or the clock: callers pass the club's
 * zone and the time it is.
 */
import { daysAfter, reminderDay } from "@/lib/volunteer/clock";
import { NO_INVOICE_YET } from "@/lib/money/payment-rule";
import { isCovered, type Requirement, type Standing } from "./progress";

export type DueKind = "due_14" | "due_3";
/** How many days before a due date each reminder goes, and what each is called. */
export const DUE_REMINDERS: readonly { kind: DueKind; days: number }[] = [{ kind: "due_14", days: 14 }, { kind: "due_3", days: 3 }];

/**
 * Figures QuickBooks gave longer ago than this can't tell whether a family has paid since: the worker reads every
 * family once a day, so two days without a read is a read that failed. A payment whose figures are older sends nothing,
 * rather than ask a family that may have paid.
 */
export const FIGURES_TELL_MS = 48 * 3_600_000;

/**
 * What the club's date is and which due dates today's reminders are for, from 9:00 on the club's clock (the same hour
 * as the other scheduled mail); null before that. `zone` is the club's time zone, `now` the time it is.
 */
export function dueToday(zone: string, now: Date): { today: string; due: { kind: DueKind; days: number; dueOn: string }[] } | null {
  const day = reminderDay(zone, now);
  if (!day) return null;
  return { today: day.today, due: DUE_REMINDERS.map((d) => ({ ...d, dueOn: daysAfter(day.today, d.days) })) };
}

/** Whether these reminders are about a requirement at all: a required payment or checklist item with a due date. */
export const isReminded = (r: Pick<Requirement, "kind" | "required" | "dueOn">): boolean => r.required && r.dueOn !== null && (r.kind === "payment" || r.kind === "checklist");

/** Whether one family or student is reminded of one requirement, and in what words. */
export type Verdict = { remind: false } | { remind: true; words: string };
const NO: Verdict = { remind: false };

/** A checklist item: reminded while staff haven't ticked it off and it isn't waived, in its words on the parent's pages ("Not done yet"). */
export function checklistVerdict(standing: Standing, waived: boolean): Verdict {
  return waived || standing.met ? NO : { remind: true, words: standing.words };
}

/**
 * A payment: reminded only when the figures QuickBooks last gave the family may be shown and hold an invoice for it
 * still open. `standing` is paymentStanding()'s, worked out as a parent's page does (the amount only from figures
 * within freshSeconds), or undefined when no figures may be shown. Never when it is paid, whatever the figures' age;
 * never when there are no figures, or they are older than FIGURES_TELL_MS, since they can't tell whether it has been
 * paid since; and never when no invoice for it has been made yet, since there is nothing to pay. `readAt` is when the
 * figures were read, `nowMs` the time it is.
 */
export function paymentVerdict(o: { standing: Standing | undefined; readAt: Date | null; waived: boolean; nowMs: number }): Verdict {
  if (o.waived || !o.standing || o.standing.met || !o.readAt) return NO;
  if (o.nowMs - o.readAt.getTime() > FIGURES_TELL_MS) return NO;
  if (o.standing.words === NO_INVOICE_YET.words) return NO;
  return { remind: true, words: o.standing.words };
}

/** One requirement in a reminder, as the email says it: its title, who in the family it is for (null: the family), and how it stands. */
export type DueItem = { requirementId: string; kind: "payment" | "checklist"; title: string; forName: string | null; words: string };
/** One family's reminder for one due date: every requirement of theirs due that day that they still have to do. */
export type OwedReminder = { kind: DueKind; days: number; dueOn: string; familyQboId: string; items: DueItem[] };
export type ReminderFamily = { qboId: string; students: readonly { qboId: string; name: string }[] };

/**
 * Who is owed a reminder today: for each due date, each family with a requirement due that day that is asked of it (or
 * of one of its students) and that `verdict` says it still has to do. One reminder per family and due date, holding
 * all of them, in the order the requirements are given (the season's). A family with none is owed nothing.
 */
export function owedReminders(o: { due: readonly { kind: DueKind; days: number; dueOn: string }[]; requirements: readonly Requirement[]; families: readonly ReminderFamily[];
  verdict: (r: Requirement, subjectQboId: string) => Verdict }): OwedReminder[] {
  const out: OwedReminder[] = [];
  for (const d of o.due) {
    const theirs = o.requirements.filter((r) => isReminded(r) && r.dueOn === d.dueOn);
    if (theirs.length === 0) continue;
    for (const f of o.families) {
      const items = theirs.flatMap((r) => {
        const subjects = r.appliesTo === "family" ? [{ qboId: f.qboId, name: null as string | null }] : f.students.map((s) => ({ qboId: s.qboId, name: s.name as string | null }));
        return subjects.filter((s) => isCovered(r, s.qboId)).flatMap((s) => {
          const v = o.verdict(r, s.qboId);
          return v.remind ? [{ requirementId: r.id, kind: r.kind as "payment" | "checklist", title: r.title, forName: s.name, words: v.words }] : [];
        });
      });
      if (items.length > 0) out.push({ kind: d.kind, days: d.days, dueOn: d.dueOn, familyQboId: f.qboId, items });
    }
  }
  return out;
}
