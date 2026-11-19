// Staff only: check-in codes, corrections to volunteer credit, and one family's credit as staff see it (v1 spec §11.4).
// Notes and reasons staff write are read here and nowhere a parent goes. Every write is one transaction with its audit
// row (before and after); a write that names families or students, or rests on them, takes the roster lock with the
// page's roster tag first (lockRosterAs), so no refresh (which brings the app's records into step) or change of company
// runs in between. Families and students are the app's own records (stage 2 of the app-owned families spec): the
// roster is turned into them once, by loadSeasonFamilies(), and a family's page is addressed by the app's family id,
// found as the season keeps it in one place (seasonFamilyAt()). Never imported by parent code
// (tests/integration/page-guards.test.ts).
import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, requirement, season, seasonStep, staffUser, volunteerCredit, volunteerEvent, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { isCovered, type SubjectId, type SubjectsAsked } from "@/lib/seasons/progress";
import { loadFacts, toRequirement } from "@/lib/seasons/recorded";
import { loadCovers } from "@/lib/seasons/season-rows";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { loadSeasonFamilies, seasonFamilyAt, type SeasonFamily } from "@/lib/seasons/subjects";
import { getClubSettings } from "@/lib/settings/club";
import { newCheckInCode } from "./check-in";
import { clockOf, dateWords, shiftInstants, shiftMinutes, shiftTimeWords } from "./clock";
import { allocateFamilies, creditAmountWords } from "./credit";
import { sendNotices, type Notice } from "./notices";
import { amountWords } from "./rules";
import { factsOf, signupsOn, type VolunteerOp } from "./setup";

type Done<T = object> = ({ ok: true } & T) | { ok: false; errors: string[] };
const refuse = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });
const GONE = "That isn't there any more. Reload the page.";
export const REASON_MAX = 500, NOTE_MAX = 1000, SHIFTS_MAX = 50, HOURS_MAX = 200;

/* ---- Check-in codes ---- */

export type CheckInSheet = { shiftId: string; eventId: string; event: string; role: string | null; dateWords: string; timeWords: string; location: string; code: string; cancelled: boolean };

/** One shift's check-in code, with what a printed sheet says about the shift. Null when there is no such shift. */
export async function checkInSheet(shiftId: string): Promise<CheckInSheet | null> {
  const [row] = await db.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(eq(volunteerShift.id, shiftId));
  if (!row) return null;
  const { shift, event } = row;
  return { shiftId: shift.id, eventId: event.id, event: event.name, role: shift.role, dateWords: dateWords(event.onDate), timeWords: shiftTimeWords(clockOf(shift.startsAt), clockOf(shift.endsAt)),
    location: event.location, code: shift.checkinCode, cancelled: shift.cancelledAt !== null || event.cancelledAt !== null };
}

/** A new check-in code for a shift: the old one opens nothing from now on. Credit already earned stays. The codes themselves are not put in the audit log. */
export async function renewCheckInCode(shiftId: string, o: VolunteerOp): Promise<Done> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(volunteerShift).where(eq(volunteerShift.id, shiftId)).for("update");
    if (!s) return refuse(GONE);
    await tx.update(volunteerShift).set({ checkinCode: newCheckInCode(), updatedAt: new Date() }).where(eq(volunteerShift.id, s.id));
    await writeAudit({ actor: o.actor, action: "volunteer.shift.code.renew", permission: o.permission, targetType: "volunteer_shift", targetId: s.id, ip: o.ip,
      before: { code: "previous" }, after: { code: "new" } }, tx);
    return { ok: true as const };
  });
}

/* ---- Corrections ---- */

const creditFacts = (c: typeof volunteerCredit.$inferSelect) => ({ kind: c.kind, familyId: String(c.familyId), signupId: c.signupId, requirementId: c.requirementId,
  studentId: c.studentId === null ? null : String(c.studentId), minutes: c.minutes, shifts: c.shifts, note: c.note, createdAt: c.createdAt.toISOString() });

/**
 * A check-in that was missed, added by staff for one live sign-up once its shift has started (and not for one the club
 * cancelled). The sign-up's family must be on the roster now. It credits what a check-in does: the shift's length and
 * one shift. A sign-up holds one live check-in at most.
 */
export async function addMissedCheckIn(signupId: string, rosterTag: string, o: VolunteerOp, now: Date = new Date()): Promise<Done> {
  const zone = (await getClubSettings()).timeZone;
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const [s] = await tx.select().from(volunteerSignup).where(and(eq(volunteerSignup.id, signupId), isNull(volunteerSignup.cancelledAt))).for("update");
    if (!s) return refuse(GONE);
    const [{ shift, event }] = await tx.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
      .where(eq(volunteerShift.id, s.shiftId)) as [{ shift: typeof volunteerShift.$inferSelect; event: typeof volunteerEvent.$inferSelect }];
    if (shift.cancelledAt || event.cancelledAt) return refuse("The club cancelled this shift, so a check-in can't be added for it.");
    const when = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone);
    if (when.start.getTime() > now.getTime()) return refuse("This shift hasn't started yet. A missed check-in can be added once it has.");
    const families = await loadSeasonFamilies();
    if (!families?.some((f) => f.id === s.familyId)) return refuse("This sign-up's family isn't on the roster now, so it can't be credited.");
    const [live] = await tx.select({ id: volunteerCredit.id }).from(volunteerCredit).where(and(eq(volunteerCredit.signupId, s.id), isNull(volunteerCredit.removedAt)));
    if (live) return refuse("This person is checked in already.");
    const minutes = shiftMinutes(when);
    const [made] = await tx.insert(volunteerCredit).values({ kind: "staff_checkin", signupId: s.id, familyId: s.familyId, minutes, shifts: 1, createdByDoor: "staff", createdBy: o.actor.id! }).returning();
    await writeAudit({ actor: o.actor, action: "volunteer.checkin.add", permission: o.permission, targetType: "volunteer_credit", targetId: made!.id, ip: o.ip,
      before: { checkedIn: false }, after: { ...creditFacts(made!), shiftId: shift.id, event: event.name, onDate: event.onDate, fillerName: s.fillerName } }, tx);
    return { ok: true as const };
  });
}

/** Removes one credit (a check-in, by the guardian or added by staff, or an outside credit), with a reason that is for staff only. Its row stays, counting for nothing. */
export async function removeCredit(creditId: string, reason: string, rosterTag: string, o: VolunteerOp): Promise<Done> {
  const why = reason.trim().replace(/\s+/g, " ");
  if (!why) return refuse("Say why it's being removed. Only staff see the reason.");
  if (why.length > REASON_MAX) return refuse(`The reason is too long (${REASON_MAX} characters at most).`);
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const [c] = await tx.select().from(volunteerCredit).where(eq(volunteerCredit.id, creditId)).for("update");
    if (!c || c.removedAt) return refuse(GONE);
    const now = new Date();
    await tx.update(volunteerCredit).set({ removedAt: now, removedBy: o.actor.id, removedReason: why }).where(eq(volunteerCredit.id, c.id));
    await writeAudit({ actor: o.actor, action: "volunteer.credit.remove", permission: o.permission, targetType: "volunteer_credit", targetId: c.id, ip: o.ip,
      before: { ...creditFacts(c), removed: false }, after: { removed: true, reason: why } }, tx);
    return { ok: true as const };
  });
}

/**
 * Credit for volunteering done outside the portal, as the page sends it: the family and (for a per-student
 * requirement) the student by the app's own ids, each found among the roster's records before anything is written.
 */
export type OutsideInput = { familyId: string; requirementId: string; who: string; amount: string; note: string };

/** "2", "1.5" or "0.25" as a number of hours or shifts: digits, and at most two after the point. */
const amountOf = (typed: string): number | null => (/^\d{1,4}(\.\d{1,2})?$/.test(typed.trim()) ? Number(typed.trim()) : null);

/**
 * Credits volunteering done outside the portal toward one volunteer requirement: for the family (a per-family
 * requirement) or one of its active students (a per-student one), who must be asked it. The amount is in the
 * requirement's unit: whole shifts, or hours to the quarter-hour or finer. The note says what was done; only staff see it.
 */
export async function addOutsideCredit(input: OutsideInput, rosterTag: string, o: VolunteerOp): Promise<Done> {
  const note = input.note.trim().replace(/[ \t]+/g, " ");
  if (!note) return refuse("Add a note saying what was done. Only staff see it.");
  if (note.length > NOTE_MAX) return refuse(`The note is too long (${NOTE_MAX} characters at most).`);
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const families = await loadSeasonFamilies();
    const family = families?.find((f) => String(f.id) === input.familyId);
    if (!family) return refuse("That family isn't on the roster now. Reload the page.");
    const [row] = await tx.select().from(requirement).where(and(eq(requirement.id, input.requirementId), eq(requirement.kind, "volunteer")));
    if (!row) return refuse("That requirement isn't there any more, or isn't a volunteering one. Reload the page.");
    const student = row.appliesTo === "student" ? family.students.find((s) => String(s.id) === input.who) ?? null : null;
    if (row.appliesTo === "student" ? !student : input.who !== "family") return refuse(row.appliesTo === "student" ? "Choose which of the family's students did it." : "Choose who did it.");
    const subject: SubjectId = student?.id ?? family.id;
    const asked: SubjectsAsked = student ? { families: [], students: [student.id] } : { families: [family.id], students: [] };
    const covers = row.covers === "chosen" ? await loadCovers([row.id], asked, tx) : new Map<string, SubjectId[]>();
    if (!isCovered(toRequirement(row, covers.get(row.id) ?? []), subject)) return refuse(`${row.title} isn't asked of ${student?.name ?? family.name}, so credit can't count toward it.`);
    const n = amountOf(input.amount);
    const unit = row.amountUnit ?? "shifts";
    if (unit === "shifts" ? n === null || !Number.isInteger(n) || n < 1 || n > SHIFTS_MAX : n === null || n <= 0 || n > HOURS_MAX) {
      return refuse(unit === "shifts" ? `Enter a whole number of shifts, from 1 to ${SHIFTS_MAX}.` : `Enter the hours as a number more than 0 and up to ${HOURS_MAX}, such as 2 or 1.5.`);
    }
    const minutes = unit === "hours" ? Math.round(n! * 60) : 0, shifts = unit === "shifts" ? n! : 0;
    if (minutes + shifts === 0) return refuse("That's less than a minute. Enter more.");
    const [made] = await tx.insert(volunteerCredit).values({ kind: "outside", familyId: family.id, studentId: student?.id ?? null, requirementId: row.id, minutes, shifts, note,
      createdByDoor: "staff", createdBy: o.actor.id! }).returning();
    await writeAudit({ actor: o.actor, action: "volunteer.credit.outside.add", permission: o.permission, targetType: "volunteer_credit", targetId: made!.id, ip: o.ip,
      before: null, after: { ...creditFacts(made!), requirement: row.title, who: student?.name ?? family.name } }, tx);
    return { ok: true as const };
  });
}

/**
 * Removes one person's sign-up: the place is free again, and the guardian who took it is told by email (with a
 * calendar file that takes it out of their calendar), when the shift is still to end and they may still see the
 * family. A sign-up that is checked in is refused until its check-in is removed.
 */
export async function removeSignup(signupId: string, o: VolunteerOp, now: Date = new Date()): Promise<Done<{ told: number; failed: number }>> {
  const zone = (await getClubSettings()).timeZone;
  const r = await db.transaction(async (tx) => {
    const [s] = await tx.select().from(volunteerSignup).where(and(eq(volunteerSignup.id, signupId), isNull(volunteerSignup.cancelledAt))).for("update");
    if (!s) return refuse(GONE);
    const [live] = await tx.select({ id: volunteerCredit.id }).from(volunteerCredit).where(and(eq(volunteerCredit.signupId, s.id), isNull(volunteerCredit.removedAt)));
    if (live) return refuse(`${s.fillerName} is checked in for this shift. Remove the check-in first, then the sign-up.`);
    const [{ shift, event }] = await tx.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
      .where(eq(volunteerShift.id, s.shiftId)) as [{ shift: typeof volunteerShift.$inferSelect; event: typeof volunteerEvent.$inferSelect }];
    const stillToEnd = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone).end.getTime() > now.getTime();
    const told = stillToEnd && !shift.cancelledAt && !event.cancelledAt ? (await signupsOn([shift.id], tx)).filter((x) => x.signupId === s.id) : [];
    await tx.update(volunteerSignup).set({ cancelledAt: now, cancelledByDoor: "staff", cancelledBy: o.actor.id }).where(eq(volunteerSignup.id, s.id));
    await writeAudit({ actor: o.actor, action: "volunteer.signup.remove", permission: o.permission, targetType: "volunteer_signup", targetId: s.id, ip: o.ip,
      before: { familyId: String(s.familyId), shiftId: s.shiftId, event: event.name, onDate: event.onDate, startsAt: clockOf(shift.startsAt), fillerName: s.fillerName, removed: false },
      after: { removed: true, guardianTold: told.length > 0 } }, tx);
    const notices: Notice[] = told.map((x) => ({ kind: "removed", signup: x, facts: factsOf(event, shift), why: "staff" }));
    return { ok: true as const, notices, eventId: event.id };
  });
  if (!r.ok) return r;
  if (r.notices.length === 0) return { ok: true, told: 0, failed: 0 };
  const { sent, failed } = await sendNotices(r.notices, { zone, actor: o.actor, ip: o.ip, targetId: r.eventId });
  return { ok: true, told: sent, failed };
}

/* ---- One family's credit, for staff ---- */

/** `id`: the app's own family, which its page's address names. */
export type CreditFamilyRow = { id: AppFamilyId; name: string; credits: number };

/** Every active family on the roster, with how many live credits it has, by name. Null when the roster can't be shown. A list like the roster's: not audited. */
export async function creditFamilies(): Promise<CreditFamilyRow[] | null> {
  const families = await loadSeasonFamilies();
  if (!families) return null;
  const rows = await db.select({ familyId: volunteerCredit.familyId }).from(volunteerCredit).where(isNull(volunteerCredit.removedAt));
  const count = new Map<string, number>();
  for (const r of rows) count.set(String(r.familyId), (count.get(String(r.familyId)) ?? 0) + 1);
  return families.map((f) => ({ id: f.id, name: f.name, credits: count.get(String(f.id)) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
}

export type StaffCreditLine = {
  id: string; kind: "checkin" | "staff_checkin" | "outside";
  /** "Checked in", "Check-in added by staff", "Done outside the portal". */
  label: string; what: string; who: string; amount: string; at: string; by: string;
  note: string | null;
  /** Where the rule spent it: "1 shift toward Concessions (Leo)". Empty when it counts toward nothing now. */
  spent: string[];
  removed: { at: string; by: string; reason: string } | null;
};
export type StaffRequirementLine = {
  id: string; title: string; required: boolean; appliesTo: "family" | "student"; unit: "shifts" | "hours"; amount: number | null; dueOn: string | null;
  /** The family or each student it is asked of, by the app's own id as text. */
  subjects: { id: string; who: string; words: string; waived: boolean }[];
};
export type FamilyCreditDetail = {
  family: SeasonFamily; rosterTag: string;
  requirements: StaffRequirementLine[];
  credits: StaffCreditLine[];
  removed: StaffCreditLine[];
};

/**
 * One family's volunteer credit as staff see it: each credit, notes and all, with where the rule spent it; each
 * volunteer requirement of the current season asked of the family or its students, with how it stands; and the
 * credit staff removed, with why. The family is the app's record its page's address names (checked by
 * familyRecordAt() first), found as the season keeps it (seasonFamilyAt()). `rosterTag` is read before the roster, for
 * the page's forms. The read is audited, naming the app's family, before anything is returned. Null for a family the
 * roster doesn't show now as an active family.
 */
export async function familyCreditDetail(familyId: AppFamilyId, rosterTag: string, o: VolunteerOp): Promise<FamilyCreditDetail | null> {
  const family = await seasonFamilyAt(familyId);
  if (!family) return null;
  await writeAudit({ actor: o.actor, action: "volunteer.credit.family.read", permission: o.permission, targetType: "family", targetId: String(family.id), ip: o.ip });
  const asked: SubjectsAsked = { families: [family.id], students: family.students.map((s) => s.id) };
  const nameOf = (id: SubjectId | null) => (id === family.id ? family.name : family.students.find((s) => s.id === id)?.name ?? "A student no longer in this family");

  // The current season's volunteer requirements asked of the family or one of its students.
  const rows = await db.select({ r: requirement }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(eq(season.isCurrent, true), eq(requirement.kind, "volunteer"))).orderBy(asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
  const covers = await loadCovers(rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id), asked);
  const askedOf = rows.map((x) => toRequirement(x.r, covers.get(x.r.id) ?? []))
    .map((r) => {
      const who: SubjectId[] = r.appliesTo === "family" ? [family.id] : family.students.map((s) => s.id);
      return { r, who: who.filter((s) => isCovered(r, s)) };
    })
    .filter((x) => x.who.length > 0);
  const { facts } = await loadFacts(askedOf.map((x) => x.r), asked, { amounts: "none", parentId: null });
  const requirements: StaffRequirementLine[] = askedOf.map(({ r, who }) => ({
    id: r.id, title: r.title, required: r.required, appliesTo: r.appliesTo, unit: r.amountUnit ?? "shifts", amount: r.amount, dueOn: r.dueOn,
    subjects: who.map((s) => ({ id: String(s), who: nameOf(s), words: facts.standing(r, s).words, waived: facts.waived(r.id, s) })),
  }));

  // Every credit of the family, live and removed, with where the live ones are spent.
  const allocation = (await allocateFamilies([family.id], askedOf.map((x) => x.r.id))).get(String(family.id));
  const titles = new Map((allocation?.requirements ?? []).map((r) => [r.id, r]));
  const credits = await db.select({ c: volunteerCredit, s: volunteerSignup, shift: volunteerShift, event: volunteerEvent, req: requirement }).from(volunteerCredit)
    .leftJoin(volunteerSignup, eq(volunteerSignup.id, volunteerCredit.signupId)).leftJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId))
    .leftJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId)).leftJoin(requirement, eq(requirement.id, volunteerCredit.requirementId))
    .where(eq(volunteerCredit.familyId, family.id)).orderBy(desc(volunteerCredit.createdAt), desc(volunteerCredit.id));
  const people = [...new Set(credits.flatMap(({ c }) => [c.createdBy, c.removedBy]).filter((id): id is string => id !== null))];
  const [staff, parents] = people.length === 0 ? [[], []] : await Promise.all([
    db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, people)),
    db.select({ id: parent.id, name: parent.name }).from(parent).where(inArray(parent.id, people)),
  ]);
  const byName = (id: string | null, door: "staff" | "parent") => (door === "staff" ? staff.find((x) => x.id === id)?.name ?? "A staff member no longer in the portal" : parents.find((x) => x.id === id)?.name ?? "A parent no longer in the portal");
  const lines = credits.map(({ c, s, shift, event, req }): StaffCreditLine => {
    const spent = (allocation?.allocation.given ?? []).filter((g) => g.creditId === c.id).map((g) => {
      const r = titles.get(g.requirementId);
      const amount = g.shifts > 0 ? amountWords("shifts", g.shifts) : amountWords("hours", Math.round((g.minutes / 60) * 100) / 100);
      return `${amount} toward ${r?.title ?? "a requirement"}${r?.appliesTo === "student" ? ` (${nameOf(g.subjectId)})` : ""}`;
    });
    const removed = c.removedAt ? { at: c.removedAt.toISOString(), by: byName(c.removedBy, "staff"), reason: c.removedReason ?? "" } : null;
    if (c.kind === "outside") {
      return { id: c.id, kind: c.kind, label: "Done outside the portal", what: req?.title ?? "A requirement that is gone", who: nameOf(c.studentId ?? c.familyId),
        amount: creditAmountWords(req?.amountUnit ?? null, c), at: c.createdAt.toISOString(), by: byName(c.createdBy, "staff"), note: c.note, spent, removed };
    }
    return { id: c.id, kind: c.kind, label: c.kind === "checkin" ? "Checked in" : "Check-in added by staff",
      what: event && shift ? `${event.name}${shift.role ? `, ${shift.role}` : ""}: ${dateWords(event.onDate)}, ${shiftTimeWords(clockOf(shift.startsAt), clockOf(shift.endsAt))}` : "A shift",
      who: s?.fillerName ?? "Someone in the family", amount: `${amountWords("shifts", c.shifts)}, ${amountWords("hours", Math.round((c.minutes / 60) * 100) / 100)}`,
      at: c.createdAt.toISOString(), by: byName(c.createdBy, c.createdByDoor), note: null, spent, removed };
  });
  return { family, rosterTag, requirements, credits: lines.filter((l) => !l.removed), removed: lines.filter((l) => l.removed) };
}
