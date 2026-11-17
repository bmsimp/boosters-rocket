// Staff and worker only: the reminders before a required payment's or checklist item's due date (v1 spec §10.1.9).
// 14 and 3 days before, each family that still has to do one gets one email per guardian, covering every such
// requirement of theirs due that day. It reads every family's standings and guardians, so it is never imported by
// parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). Each email is about the guardian's own
// family alone: no other family is named, and no staff note shown. Which requirements and families, and what each says,
// are the pure rules of ./due-reminder-rules.ts.
import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { guardian, parent, requirement, requirementReminder, season, seasonStep, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { requirementDueMessage } from "@/lib/mail/messages";
import { mailWorking } from "@/lib/mail/settings";
import { paymentStandings } from "@/lib/money/payment-standings";
import { moneyRows } from "@/lib/money/stored";
import { getParentSettings } from "@/lib/parents/settings";
import { getClubSettings } from "@/lib/settings/club";
import { dateWords } from "@/lib/volunteer/clock";
import { checklistVerdict, dueToday, owedReminders, paymentVerdict, type DueKind, type Verdict } from "./due-reminder-rules";
import { pairKey } from "./kinds";
import { loadCovers, loadFacts, loadRecorded, toRequirement } from "./recorded";
import { loadSubjects } from "./subjects";

export const DUE_REMINDERS_JOB = "season.due_reminders";
/** Where the last day's look is kept, for the Health page: the club's date, when, and what was sent and failed. */
export const DUE_REMINDERS_KEY = "season.due_reminders";
/** How many emails go in one wake: a roster's worth goes out over some minutes, not in one burst. */
export const DUE_REMINDER_BATCH = 10;
/** A failed send may be claimed again after this long, while it is still the day to send it. */
export const DUE_REMINDER_RETRY_MS = 15 * 60_000;
const ACTOR: Actor = { door: "system", id: null, label: "due-date reminders" };

const base = () => env.APP_URL.replace(/\/+$/, "");

/** What the Health page reads: the club's date of the last look, when it was, that day's counts, and when an email last went or failed. */
export type DueRemindersRecord = { day: string; at: string; sent: number; failed: number; lastSentAt: string | null; lastFailedAt: string | null };

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
/** The record, or null when there is none or it can't be read. */
export async function lastDueReminders(): Promise<DueRemindersRecord | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, DUE_REMINDERS_KEY));
  const v = row?.value as Partial<DueRemindersRecord> | undefined;
  if (!v || typeof v.day !== "string" || !isIso(v.at) || typeof v.sent !== "number" || typeof v.failed !== "number") return null;
  return { day: v.day, at: v.at, sent: v.sent, failed: v.failed, lastSentAt: isIso(v.lastSentAt) ? v.lastSentAt : null, lastFailedAt: isIso(v.lastFailedAt) ? v.lastFailedAt : null };
}

/** Notes the day's look: once when the club's day is new, and again when this wake sent or failed something. */
async function noteLook(today: string, counts: { sent: number; failed: number }, now: Date): Promise<void> {
  const last = await lastDueReminders();
  if (last?.day === today && counts.sent + counts.failed === 0) return;
  const sameDay = last?.day === today;
  const value: DueRemindersRecord = {
    day: today, at: now.toISOString(),
    sent: (sameDay ? last!.sent : 0) + counts.sent, failed: (sameDay ? last!.failed : 0) + counts.failed,
    lastSentAt: counts.sent > 0 ? now.toISOString() : (last?.lastSentAt ?? null),
    lastFailedAt: counts.failed > 0 ? now.toISOString() : (last?.lastFailedAt ?? null),
  };
  await db.insert(setting).values({ key: DUE_REMINDERS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}

/**
 * Takes one email for sending, in one statement: it succeeds for one wake only, and again only after a failure that is
 * at least DUE_REMINDER_RETRY_MS old. A row with no outcome is a send under way.
 */
async function claim(e: { kind: DueKind; familyQboId: string; dueOn: string; parentId: string }, now: Date): Promise<string | null> {
  const [row] = await db.insert(requirementReminder).values({ ...e, triedAt: now })
    .onConflictDoUpdate({ target: [requirementReminder.kind, requirementReminder.familyQboId, requirementReminder.dueOn, requirementReminder.parentId], set: { triedAt: now, outcome: null },
      setWhere: sql`${requirementReminder.outcome} = 'failed' and ${requirementReminder.triedAt} < ${new Date(now.getTime() - DUE_REMINDER_RETRY_MS).toISOString()}::timestamptz` })
    .returning({ id: requirementReminder.id });
  return row?.id ?? null;
}
const settle = (id: string, ok: boolean) => db.update(requirementReminder).set({ outcome: ok ? "sent" : "failed" }).where(eq(requirementReminder.id, id));

/** The claims already made for these due dates: sent, under way, or failed too recently to try again. Keyed as emailKey(). */
async function taken(dueOns: string[], now: Date): Promise<Set<string>> {
  const rows = await db.select().from(requirementReminder).where(inArray(requirementReminder.dueOn, dueOns));
  return new Set(rows.filter((r) => r.outcome !== "failed" || r.triedAt.getTime() >= now.getTime() - DUE_REMINDER_RETRY_MS).map(emailKey));
}
const emailKey = (e: { kind: DueKind; familyQboId: string; dueOn: string; parentId: string }) => `${e.kind}|${e.familyQboId}|${e.dueOn}|${e.parentId}`;

/**
 * What each family still has to do for the current season's required payments and checklist items due on these days,
 * judged as the parent's pages judge them. A checklist item by its tick; a payment by the figures QuickBooks last gave
 * the family, its amount only from figures within freshSeconds, and nothing at all when they can't tell (paymentVerdict).
 * A waiver, whatever its reason, sends nothing; the reason itself is never read into an email.
 */
async function owedToday(due: { kind: DueKind; days: number; dueOn: string }[]) {
  const rows = await db.select({ r: requirement }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(eq(season.isCurrent, true), inArray(requirement.kind, ["payment", "checklist"]), eq(requirement.required, true), inArray(requirement.dueOn, due.map((d) => d.dueOn))))
    .orderBy(asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
  if (rows.length === 0) return [];
  const families = await loadSubjects();
  if (!families || families.length === 0) return [];
  const covers = await loadCovers(rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id), null);
  const requirements = rows.map((x) => toRequirement(x.r, covers.get(x.r.id) ?? []));
  const checklist = requirements.filter((r) => r.kind === "checklist"), payments = requirements.filter((r) => r.kind === "payment");
  // As a parent's page sees it: a payment's amount only from figures read within freshSeconds.
  const [{ facts }, paid, recorded, figures] = await Promise.all([
    loadFacts(checklist, null, { amounts: "fresh", parentId: null }),
    paymentStandings(payments, null, "fresh"),
    loadRecorded(payments.map((r) => r.id), null),
    moneyRows(payments.length ? families.map((f) => f.qboId) : []),
  ]);
  const payStanding = new Map(paid.map((p) => [pairKey(p.requirementId, p.subjectQboId), p.standing]));
  const payWaived = new Set(recorded.filter((r) => r.waivedAt !== null).map((r) => pairKey(r.requirementId, r.subjectQboId)));
  const familyOf = new Map(families.flatMap((f) => [[f.qboId, f.qboId] as const, ...f.students.map((s) => [s.qboId, f.qboId] as const)]));
  // The figures' age is judged by the real time, whatever day the wake is deciding for.
  const nowMs = Date.now();
  const verdict = (r: (typeof requirements)[number], subject: string): Verdict => r.kind === "checklist"
    ? checklistVerdict(facts.standing(r, subject), facts.waived(r.id, subject))
    : paymentVerdict({ standing: payStanding.get(pairKey(r.id, subject)), readAt: figures.get(familyOf.get(subject) ?? "")?.readAt ?? null, waived: payWaived.has(pairKey(r.id, subject)), nowMs });
  return owedReminders({ due, requirements, families, verdict });
}

/**
 * One wake's due-date reminders, from 9:00 on the club's clock, while parent sign-ins and welcome emails are both
 * switched on (the Admin's sign that the club is ready to email families) and outgoing mail works. At most
 * DUE_REMINDER_BATCH emails a wake, each claimed before it is sent, to the family's guardians with an open link who
 * aren't blocked; each wake that sent or failed something is audited with the counts, never an address.
 */
export async function sendDueReminders(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const none = { sent: 0, failed: 0 };
  const settings = await getParentSettings();
  if (!settings.signin || !settings.welcome || !(await mailWorking())) return none;
  const day = dueToday((await getClubSettings()).timeZone, now);
  if (!day) return none;
  const owed = await owedToday(day.due);
  const people = owed.length === 0 ? [] : await db.select({ familyQboId: guardian.familyQboId, parentId: parent.id, email: parent.email }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(inArray(guardian.familyQboId, [...new Set(owed.map((o) => o.familyQboId))]), ne(guardian.status, "disabled"), eq(parent.blocked, false)))
    .orderBy(asc(guardian.familyQboId), asc(parent.createdAt), asc(parent.id));
  const emails = owed.flatMap((o) => people.filter((p) => p.familyQboId === o.familyQboId).map((p) => ({ ...o, parentId: p.parentId, email: p.email })));
  const done = emails.length === 0 ? new Set<string>() : await taken(day.due.map((d) => d.dueOn), now);
  let sent = 0, failed = 0, tried = 0;
  const brand = emails.length === 0 ? null : await currentBrand();
  for (const e of emails.filter((x) => !done.has(emailKey(x)))) {
    if (tried >= DUE_REMINDER_BATCH) break;
    const id = await claim({ kind: e.kind, familyQboId: e.familyQboId, dueOn: e.dueOn, parentId: e.parentId }, now);
    if (!id) continue;
    tried++;
    const message = requirementDueMessage(brand!, e.email, {
      dueWords: dateWords(e.dueOn), daysLeft: e.days, items: e.items.map((i) => ({ title: i.title, forName: i.forName, standing: i.words })),
      season: `${base()}/season`, payments: e.items.some((i) => i.kind === "payment") ? `${base()}/payments` : null,
    });
    const out = await sendMail(message, { purpose: "due_reminder", actor: ACTOR });
    await settle(id, out.ok);
    if (out.ok) sent++; else failed++;
  }
  if (sent + failed > 0) await writeAudit({ actor: ACTOR, action: "season.due_reminders.sent", targetType: "requirement_reminder", after: { clubDate: day.today, sent, failed } });
  await noteLook(day.today, { sent, failed }, now);
  return { sent, failed };
}
