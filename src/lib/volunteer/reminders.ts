// The volunteer reminders the worker sends (v1 spec §11.3): the day before a shift, to the guardian who took each
// place; and nudges 14 and 3 days before a required volunteer requirement is due, to the guardians of each family that
// hasn't met it. A few go per wake, each claimed before it is sent (volunteer_reminder), so two wakes never send the
// same email. Each email is about the guardian's own family alone: no other family is named, and no staff note shown.
// Families and students are the app's own records (stage 2 of the app-owned families spec), as the season's are: the
// families are the app's active ones, read once (loadSeasonFamilies()), and a claim names the app's family.
import "server-only";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, requirement, season, seasonStep, volunteerEvent, volunteerReminder, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { studentsStillIn } from "@/lib/families/session-family";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { volunteerDueMessage, volunteerReminderMessage, type VolunteerDueWords } from "@/lib/mail/messages";
import { mailWorking } from "@/lib/mail/settings";
import { getParentSettings } from "@/lib/parents/settings";
import { everyCover, everyonesFacts } from "@/lib/seasons/everyone";
import { isCovered, type SubjectId } from "@/lib/seasons/progress";
import { toRequirement } from "@/lib/seasons/recorded";
import { loadSeasonFamilies } from "@/lib/seasons/subjects";
import { getClubSettings } from "@/lib/settings/club";
import { dateWords, daysAfter, reminderDay } from "./clock";
import { contactWords, shiftWords, volunteerLink } from "./notices";
import { whoMustWords } from "./rules";
import { factsOf } from "./setup";

export const REMINDERS_JOB = "volunteer.reminders";
/** How many emails of each kind go in one wake: a roster's worth goes out over some minutes, not in one burst. */
export const REMINDER_BATCH = 5;
/** A failed send may be claimed again after this long, while it is still the day to send it. */
export const REMINDER_RETRY_MS = 15 * 60_000;
/** The nudges before a due date: how many days before, and what each is called. */
export const NUDGES = [{ kind: "due_14" as const, days: 14 }, { kind: "due_3" as const, days: 3 }];
const ACTOR: Actor = { door: "system", id: null, label: "volunteer reminders" };

/** A due-date nudge's claim key: the app's family, the due date and the guardian (migration 0027 rewrote the older ones to this). */
export const nudgeKey = (familyId: AppFamilyId, dueOn: string, parentId: string) => `${String(familyId)}|${dueOn}|${parentId}`;

/**
 * Takes one email for sending, in one statement: it succeeds for one wake only, and again only after a failure that
 * is at least REMINDER_RETRY_MS old. A row with no outcome is a send under way.
 */
async function claim(kind: "day_before" | "due_14" | "due_3", key: string, familyId: AppFamilyId, now: Date): Promise<string | null> {
  const [row] = await db.insert(volunteerReminder).values({ kind, key, familyId, triedAt: now })
    .onConflictDoUpdate({ target: [volunteerReminder.kind, volunteerReminder.key], set: { triedAt: now, outcome: null },
      setWhere: sql`${volunteerReminder.outcome} = 'failed' and ${volunteerReminder.triedAt} < ${new Date(now.getTime() - REMINDER_RETRY_MS).toISOString()}::timestamptz` })
    .returning({ id: volunteerReminder.id });
  return row?.id ?? null;
}
const settle = (id: string, ok: boolean) => db.update(volunteerReminder).set({ outcome: ok ? "sent" : "failed" }).where(eq(volunteerReminder.id, id));

/** Of these keys of one kind, the ones that are taken: sent, under way, or failed too recently to try again. */
async function taken(kind: "day_before" | "due_14" | "due_3", keys: string[], now: Date): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await db.select().from(volunteerReminder).where(and(eq(volunteerReminder.kind, kind), inArray(volunteerReminder.key, keys)));
  return new Set(rows.filter((r) => r.outcome !== "failed" || r.triedAt.getTime() >= now.getTime() - REMINDER_RETRY_MS).map((r) => r.key));
}

/**
 * The day-before reminders: each live place on a live shift of an event on the club's tomorrow, to the guardian who
 * took it, while their link to the family is open and they aren't blocked.
 */
async function dayBefore(tomorrow: string, now: Date): Promise<{ sent: number; failed: number }> {
  const rows = await db.select({ s: volunteerSignup, shift: volunteerShift, event: volunteerEvent, email: parent.email }).from(volunteerSignup)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .innerJoin(parent, eq(parent.id, volunteerSignup.signedUpBy))
    .innerJoin(guardian, and(eq(guardian.parentId, volunteerSignup.signedUpBy), eq(guardian.familyId, volunteerSignup.familyId)))
    .where(and(eq(volunteerEvent.onDate, tomorrow), isNull(volunteerEvent.cancelledAt), isNull(volunteerShift.cancelledAt), isNull(volunteerSignup.cancelledAt),
      ne(guardian.status, "disabled"), eq(parent.blocked, false)))
    .orderBy(asc(volunteerShift.startsAt), asc(volunteerSignup.createdAt));
  // A student who has moved to another family, or is no longer active, takes the place out of the old family's list.
  const moved = new Set<string>();
  for (const family of new Map(rows.filter((r) => r.s.studentId).map((r) => [String(r.s.familyId), r.s.familyId])).values()) {
    const ids = rows.filter((r) => String(r.s.familyId) === String(family) && r.s.studentId).map((r) => r.s.studentId!);
    const still = await studentsStillIn(family, ids);
    for (const id of ids) if (!still.has(String(id))) moved.add(`${String(family)}|${String(id)}`);
  }
  const current = rows.filter((r) => !r.s.studentId || !moved.has(`${String(r.s.familyId)}|${String(r.s.studentId)}`));
  const keyOf = (r: (typeof rows)[number]) => `${r.s.id}|${r.event.onDate}`;
  const done = await taken("day_before", current.map(keyOf), now);
  let sent = 0, failed = 0;
  const brand = await currentBrand();
  for (const r of current.filter((x) => !done.has(keyOf(x))).slice(0, REMINDER_BATCH)) {
    const id = await claim("day_before", keyOf(r), r.s.familyId, now);
    if (!id) continue;
    const facts = factsOf(r.event, r.shift);
    const who = r.s.fillerKind === "guardian" && r.s.fillerParentId === r.s.signedUpBy ? { self: true as const } : { self: false as const, name: r.s.fillerName };
    const m = volunteerReminderMessage(brand, r.email, { who, shift: shiftWords(facts), contact: contactWords(facts.event), link: volunteerLink() });
    const out = await sendMail(m, { purpose: "volunteer_reminder", actor: ACTOR });
    await settle(id, out.ok);
    if (out.ok) sent++; else failed++;
  }
  if (sent + failed > 0) await writeAudit({ actor: ACTOR, action: "volunteer.reminders.sent", targetType: "volunteer_reminder", after: { kind: "day_before", onDate: tomorrow, sent, failed } });
  return { sent, failed };
}

/**
 * The nudges before a due date: for each required volunteer requirement of the current season due 14 or 3 days from
 * the club's today, each active family that hasn't met it (for the family, or for a student it is asked of) and
 * hasn't had it waived gets one email per guardian, covering every such requirement due that day. To the family's
 * guardians with an open link who aren't blocked.
 */
async function nudges(today: string, now: Date): Promise<{ sent: number; failed: number }> {
  const due = NUDGES.map((n) => ({ ...n, dueOn: daysAfter(today, n.days) }));
  const rows = await db.select({ r: requirement }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(eq(season.isCurrent, true), eq(requirement.kind, "volunteer"), eq(requirement.required, true), inArray(requirement.dueOn, due.map((d) => d.dueOn))))
    .orderBy(asc(seasonStep.position), asc(requirement.position));
  if (rows.length === 0) return { sent: 0, failed: 0 };
  const families = await loadSeasonFamilies();
  if (families.length === 0) return { sent: 0, failed: 0 };
  const covers = await everyCover(rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id));
  const requirements = rows.map((x) => toRequirement(x.r, covers.get(x.r.id) ?? []));
  const { facts } = await everyonesFacts(requirements, { amounts: "none", parentId: null });
  // What each family still has to do, by nudge: never another family's, and never a waiver's reason.
  const owed: { kind: "due_14" | "due_3"; dueOn: string; days: number; familyId: AppFamilyId; items: VolunteerDueWords[] }[] = [];
  for (const d of due) {
    const theirs = requirements.filter((r) => r.dueOn === d.dueOn);
    for (const f of families) {
      const items = theirs.flatMap((r) => {
        const subjects: { id: SubjectId; name: string | null }[] = r.appliesTo === "family" ? [{ id: f.id, name: null }] : f.students.map((s) => ({ id: s.id, name: s.name }));
        return subjects.filter((s) => isCovered(r, s.id) && !facts.waived(r.id, s.id) && !facts.standing(r, s.id).met)
          .map((s) => ({ title: r.title, whoMust: whoMustWords(r, s.name), standing: facts.standing(r, s.id).words }));
      });
      if (items.length > 0) owed.push({ kind: d.kind, dueOn: d.dueOn, days: d.days, familyId: f.id, items });
    }
  }
  if (owed.length === 0) return { sent: 0, failed: 0 };
  const people = await db.select({ familyId: guardian.familyId, parentId: parent.id, email: parent.email }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(inArray(guardian.familyId, [...new Map(owed.map((o) => [String(o.familyId), o.familyId])).values()]), ne(guardian.status, "disabled"), eq(parent.blocked, false)))
    .orderBy(asc(guardian.familyId), asc(parent.createdAt), asc(parent.id));
  const emails = owed.flatMap((o) => people.filter((p) => String(p.familyId) === String(o.familyId))
    .map((p) => ({ ...o, parentId: p.parentId, email: p.email, key: nudgeKey(o.familyId, o.dueOn, p.parentId) })));
  let sent = 0, failed = 0, tried = 0;
  const brand = await currentBrand();
  for (const kind of ["due_14", "due_3"] as const) {
    const mine = emails.filter((e) => e.kind === kind);
    const done = await taken(kind, mine.map((e) => e.key), now);
    for (const e of mine.filter((x) => !done.has(x.key))) {
      if (tried >= REMINDER_BATCH) break;
      const id = await claim(kind, e.key, e.familyId, now);
      if (!id) continue;
      tried++;
      const out = await sendMail(volunteerDueMessage(brand, e.email, { dueWords: dateWords(e.dueOn), daysLeft: e.days, items: e.items, link: volunteerLink() }), { purpose: "volunteer_reminder", actor: ACTOR });
      await settle(id, out.ok);
      if (out.ok) sent++; else failed++;
    }
  }
  if (sent + failed > 0) await writeAudit({ actor: ACTOR, action: "volunteer.reminders.sent", targetType: "volunteer_reminder", after: { kind: "due", sent, failed } });
  return { sent, failed };
}

/**
 * One wake's volunteer reminders, from 9:00 on the club's clock: the day-before reminders while parent sign-ins are
 * on, and the due-date nudges while parent sign-ins and welcome emails are both on (the Admin's sign that the club is
 * ready to email families). Nothing at all while outgoing mail isn't working.
 */
export async function sendVolunteerReminders(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const settings = await getParentSettings();
  if (!settings.signin || !(await mailWorking())) return { sent: 0, failed: 0 };
  const day = reminderDay((await getClubSettings()).timeZone, now);
  if (!day) return { sent: 0, failed: 0 };
  const a = await dayBefore(day.tomorrow, now);
  const b = settings.welcome ? await nudges(day.today, now) : { sent: 0, failed: 0 };
  return { sent: a.sent + b.sent, failed: a.failed + b.failed };
}
