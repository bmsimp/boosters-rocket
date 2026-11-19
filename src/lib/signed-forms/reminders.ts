// Staff only: reminders to sign (v1 spec §9.3). "Remind now" on a form, a family or one request, and the rounds a
// form's schedule sends. Each guardian is emailed about their own family's forms only, once a day per form at most,
// and only while their link to the family is open and they aren't blocked. Every send is claimed first and audited per
// batch with counts, never an address. It reads every family's forms, so it is never imported by parent code
// (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { formReminderClaim, formReminderRound, guardian, parent, requirement, signatureRequest, type FormReminders } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getFormsConfig } from "@/lib/forms/settings";
import { formReminderMessage } from "@/lib/mail/messages";
import { currentBrand, sendMail } from "@/lib/mail/send";
import { getStoredMailConfig } from "@/lib/mail/settings";
import { getParentSettings } from "@/lib/parents/settings";
import { guardianRowCounts } from "@/lib/parents/sessions";
import { calendarDayIn, getClubSettings } from "@/lib/settings/club";
// The season and the requests both name the app's own families and students (stage 2 of the app-owned families spec):
// the families are the app's active ones, read once, by loadSeasonFamilies(), and guardians are a family's by their
// membership of its record (guardian.family_id).
import { subjectOfRequest } from "@/lib/forms/requests";
import { everyCover, everyRecorded } from "@/lib/seasons/everyone";
import { isUuid } from "@/lib/seasons/ids";
import { isCovered } from "@/lib/seasons/progress";
import { toRequirement } from "@/lib/seasons/recorded";
import { loadSeasonFamilies } from "@/lib/seasons/subjects";
import { dateWords } from "@/lib/volunteer/clock";
import { currentSeason, seasonForms } from "./matrix";
import { REMINDER_HOUR, clubHour, isReminderDay, parseSchedule, whoStillHasToSign } from "./rules";

/** A family is named by the app's own id, as text (a uuid, checked by remindNow()). */
export type ReminderScope = { kind: "form"; requirementId: string } | { kind: "family"; familyId: string } | { kind: "request"; requestId: string };
export type ReminderCounts = { emailed: number; failed: number; alreadyToday: number };
type Totals = ReminderCounts & { guardians: Set<string> };
type Op = { actor: Actor; ip: string | null; permission?: string };
type Done<T = object> = ({ ok: true } & T) | { ok: false; errors: string[] };

const base = () => env.APP_URL.replace(/\/+$/, "");

/** One guardian to remind about one form: the people it is for, and the request to link to when there is just one. */
type Owed = { requirementId: string; parentId: string; names: string[]; requestIds: (string | null)[] };

/**
 * Who is owed a reminder now, for the current season's forms with a template: for each family or student a form is
 * asked of and that hasn't signed it or had it waived, the guardians who still have to sign (whoStillHasToSign), out
 * of those with an open link to that family who aren't blocked. Narrowed to one form, one family or one request.
 */
async function owedReminders(scope: ReminderScope | null, requirementIds: string[] | null): Promise<{ owed: Owed[]; forms: { id: string; title: string; dueOn: string | null }[] } | null> {
  const s = await currentSeason();
  if (!s) return null;
  let forms = (await seasonForms(s.id)).filter((f) => f.row.form !== null);
  if (requirementIds) forms = forms.filter((f) => requirementIds.includes(f.row.id));
  let requestFilter: typeof signatureRequest.$inferSelect | null = null;
  if (scope?.kind === "request") {
    const [r] = await db.select().from(signatureRequest).where(eq(signatureRequest.id, scope.requestId));
    if (!r) return { owed: [], forms: [] };
    requestFilter = r;
    forms = forms.filter((f) => f.row.id === r.requirementId);
  }
  if (scope?.kind === "form") forms = forms.filter((f) => f.row.id === scope.requirementId);
  const families = await loadSeasonFamilies();
  if (forms.length === 0) return { owed: [], forms: [] };
  const ids = forms.map((f) => f.row.id);
  const [covers, waivers, requests] = await Promise.all([
    everyCover(ids),
    everyRecorded(ids).then((rows) => rows.filter((w) => w.waivedAt !== null)),
    db.select().from(signatureRequest).where(inArray(signatureRequest.requirementId, ids)),
  ]);
  const inScope = families.filter((f) => (scope?.kind === "family" ? String(f.id) === scope.familyId : requestFilter ? String(f.id) === String(requestFilter.familyId) : true));
  const familyIds = inScope.map((f) => f.id);
  // Only guardians the gate would let in: a reminder asks them to sign in and sign.
  const { requireActiveStudents } = await getParentSettings();
  const links = familyIds.length === 0 ? [] : await db.select({ familyId: guardian.familyId, parentId: guardian.parentId }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(inArray(guardian.familyId, familyIds), guardianRowCounts(requireActiveStudents), eq(parent.blocked, false)));
  const waived = new Set(waivers.map((w) => `${w.requirementId}|${String(w.subjectId)}`));
  const owed = new Map<string, Owed>();
  for (const f of forms) {
    const r = toRequirement(f.row, covers.get(f.row.id) ?? []);
    for (const fam of inScope) {
      const subjects = r.appliesTo === "family" ? [{ id: fam.id, name: fam.name }] : fam.students;
      for (const subject of subjects) {
        if (!isCovered(r, subject.id) || waived.has(`${r.id}|${String(subject.id)}`)) continue;
        if (requestFilter && String(subjectOfRequest(requestFilter)) !== String(subject.id)) continue;
        // Only the family's own request counts: a request another family left for a student who moved is not this family's.
        const request = requests.find((q) => q.requirementId === r.id && String(subjectOfRequest(q)) === String(subject.id) && String(q.familyId) === String(fam.id)) ?? null;
        const mode = f.row.form?.signers ?? "any";
        for (const parentId of whoStillHasToSign(mode, request, links.filter((l) => String(l.familyId) === String(fam.id)))) {
          const key = `${r.id}|${parentId}`;
          const o = owed.get(key) ?? { requirementId: r.id, parentId, names: [], requestIds: [] };
          o.names.push(subject.name); o.requestIds.push(request?.id ?? null);
          owed.set(key, o);
        }
      }
    }
  }
  return { owed: [...owed.values()], forms: forms.map((f) => ({ id: f.row.id, title: f.row.title, dueOn: f.row.dueOn })) };
}

/**
 * Sends the reminders owed, each guardian once per form: claimed first, all in one statement for the day, so a second
 * press (or the schedule) the same club day sends nothing more. Audited per form with the counts.
 */
async function sendOwed(o: { owed: Owed[]; forms: { id: string; title: string; dueOn: string | null }[] }, how: { kind: "now" | "scheduled"; scope: string; today: string }, op: Op): Promise<Totals> {
  const total: Totals = { emailed: 0, failed: 0, alreadyToday: 0, guardians: new Set() };
  for (const form of o.forms) {
    const mine = o.owed.filter((x) => x.requirementId === form.id);
    if (mine.length === 0) continue;
    const claimed = await db.insert(formReminderClaim).values(mine.map((x) => ({ requirementId: form.id, parentId: x.parentId, onDate: how.today })))
      .onConflictDoNothing().returning({ parentId: formReminderClaim.parentId });
    const got = new Set(claimed.map((c) => c.parentId));
    const counts: ReminderCounts = { emailed: 0, failed: 0, alreadyToday: mine.length - got.size };
    const people = got.size === 0 ? [] : await db.select({ id: parent.id, email: parent.email }).from(parent).where(inArray(parent.id, [...got]));
    const brand = await currentBrand();
    for (const x of mine.filter((m) => got.has(m.parentId))) {
      const to = people.find((p) => p.id === x.parentId);
      if (!to) { counts.failed++; continue; }
      const only = x.requestIds.length === 1 ? x.requestIds[0] : null;
      const sent = await sendMail(formReminderMessage(brand, to.email, { formTitle: form.title, forNames: [...new Set(x.names)], due: form.dueOn ? dateWords(form.dueOn) : null, pastDue: form.dueOn !== null && form.dueOn < how.today,
        link: only ? `${base()}/forms/${only}` : `${base()}/forms` }), { purpose: "form_reminder", actor: op.actor, ip: op.ip });
      if (sent.ok) { counts.emailed++; total.guardians.add(x.parentId); } else counts.failed++;
    }
    await writeAudit({ actor: op.actor, action: "forms.reminder.sent", permission: op.permission, targetType: "requirement", targetId: form.id, ip: op.ip,
      after: { kind: how.kind, scope: how.scope, clubDate: how.today, guardiansOwed: mine.length, ...counts } });
    total.emailed += counts.emailed; total.failed += counts.failed; total.alreadyToday += counts.alreadyToday;
  }
  return total;
}

/**
 * "Remind now", for a form, a family or one request. Needs parent sign-ins on (families must be able to open the
 * forms), forms set up and outgoing mail. Says how many guardians were emailed.
 */
export async function remindNow(scope: ReminderScope, op: Op): Promise<Done<{ message: string; counts: ReminderCounts & { guardians: number } }>> {
  const id = scope.kind === "form" ? scope.requirementId : scope.kind === "request" ? scope.requestId : scope.familyId;
  if (scope.kind !== "family" && !isUuid(id)) return { ok: false, errors: ["That form isn't there any more. Reload the page."] };
  if (scope.kind === "family" && !isUuid(id)) return { ok: false, errors: ["That family isn't there any more. Reload the page."] };
  if (!(await getParentSettings()).signin) return { ok: false, errors: ["Parent sign-ins are switched off, so families couldn't open the forms. An Admin can switch them on under Parent sign-ins."] };
  if (!(await getFormsConfig())) return { ok: false, errors: ["Forms aren't set up yet, so there is nothing families can sign. An Admin can connect Documenso under Forms settings."] };
  if (!(await getStoredMailConfig())) return { ok: false, errors: ["Outgoing mail isn't set up, so no reminder can be sent. An Admin can set it up under Mail."] };
  const owed = await owedReminders(scope, null);
  if (!owed) return { ok: false, errors: ["There is no current season, so there are no forms to remind anyone about."] };
  const today = calendarDayIn((await getClubSettings()).timeZone);
  const { guardians, ...counts } = await sendOwed(owed, { kind: "now", scope: scope.kind, today }, op);
  const people = (n: number) => (n === 1 ? "1 guardian" : `${n} guardians`);
  // One email per guardian per form: a family's guardian may get one for each of its forms.
  const emailed = counts.emailed === guardians.size ? `Emailed ${people(guardians.size)}.` : `Emailed ${people(guardians.size)}, ${counts.emailed} reminders in all.`;
  const message = counts.emailed + counts.failed + counts.alreadyToday === 0 ? "Nobody needs a reminder: everyone has signed, the form was waived, or it isn't ready to sign yet."
    : [emailed, counts.alreadyToday ? `${counts.alreadyToday === 1 ? "1 reminder" : `${counts.alreadyToday} reminders`} had already gone today, so ${counts.alreadyToday === 1 ? "it wasn't" : "they weren't"} sent again.` : "",
      counts.failed ? `${counts.failed === 1 ? "1 email" : `${counts.failed} emails`} couldn't be sent: see Mail settings.` : ""].filter(Boolean).join(" ");
  return { ok: true, message, counts: { ...counts, guardians: guardians.size } };
}

/**
 * The scheduled rounds, at the worker's first wake on or after 9:00 on the club's clock: each form whose schedule
 * falls on the club's date today, once (the round is claimed first). Only while parent sign-ins and welcome emails are
 * both switched on, the Admin's sign that the club is ready to email families, and forms and mail are set up.
 */
export async function runScheduledReminders(now: Date = new Date(), op: Op = { actor: { door: "system", id: null, label: "worker" }, ip: null }): Promise<{ rounds: number } & ReminderCounts> {
  const done = { rounds: 0, emailed: 0, failed: 0, alreadyToday: 0 };
  const settings = await getParentSettings();
  if (!settings.signin || !settings.welcome) return done;
  const { timeZone } = await getClubSettings();
  if (clubHour(timeZone, now) < REMINDER_HOUR) return done;
  if (!(await getFormsConfig()) || !(await getStoredMailConfig())) return done;
  const s = await currentSeason();
  if (!s) return done;
  const today = calendarDayIn(timeZone, now);
  const due = (await seasonForms(s.id)).filter((f) => f.row.form !== null && isReminderDay(today, f.row.dueOn, f.row.formReminders ?? null));
  for (const f of due) {
    const round = await db.insert(formReminderRound).values({ requirementId: f.row.id, onDate: today }).onConflictDoNothing().returning({ id: formReminderRound.id });
    if (round.length === 0) continue;
    done.rounds++;
    const owed = await owedReminders(null, [f.row.id]);
    if (!owed) continue;
    const counts = await sendOwed(owed, { kind: "scheduled", scope: "form", today }, op);
    done.emailed += counts.emailed; done.failed += counts.failed; done.alreadyToday += counts.alreadyToday;
  }
  return done;
}

/** Saves a form's reminder schedule (staff Forms page), with the audit row in the same transaction. */
export async function saveReminderSchedule(requirementId: unknown, raw: { before: readonly unknown[]; weeklyAfter: unknown }, op: Op): Promise<Done<{ message: string }>> {
  if (!isUuid(requirementId)) return { ok: false, errors: ["That form isn't there any more. Reload the page."] };
  const next: FormReminders | null = parseSchedule(raw);
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ id: requirement.id, kind: requirement.kind, formReminders: requirement.formReminders }).from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r || r.kind !== "form") return { ok: false, errors: ["That form isn't there any more. Reload the page."] };
    await tx.update(requirement).set({ formReminders: next, updatedAt: new Date() }).where(eq(requirement.id, requirementId));
    await writeAudit({ actor: op.actor, action: "forms.reminder.schedule", permission: op.permission, targetType: "requirement", targetId: requirementId, ip: op.ip,
      before: { reminders: r.formReminders ?? null }, after: { reminders: next } }, tx);
    return { ok: true, message: next ? "Saved. Reminders will go on the days you chose." : "Saved. No reminders will go for this form." };
  });
}
