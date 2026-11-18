// What volunteering does when a student moves to another family (afterStudentMoved() in src/lib/roster/writes.ts for a
// move staff make, and the roster refresh for one made in QuickBooks). A place belongs to the family it was taken from:
// the old family's places for that student on shifts still to start are given up, their guardians told; what the
// student has already done stays with the family it was earned for, so a check-in keeps its credit there, and the new
// family takes nothing over. The roster names the move by QuickBooks ids; sign-ups name the app's own family and
// student (stage 2 of the app-owned families spec), so the move is turned into those records here, through their
// links in the records' company: a boundary AGENTS.md lists, until stage 3 moves the roster to the app.
import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Tx } from "@/lib/db/client";
import { accountingLink, volunteerEvent, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { QUICKBOOKS } from "@/lib/families/ids";
import { familyLinkedTo, recordsCompany, studentLinkedTo } from "@/lib/families/links";
import { getClubSettings } from "@/lib/settings/club";
import { clockOf, shiftInstants } from "./clock";
import { creditedSignups } from "./credit";
import { sendNotices, type Notice } from "./notices";
import { placesToGiveUp } from "./rules";
import { factsOf, signupsOn } from "./setup";

const MOVE_ACTOR: Actor = { door: "system", id: null, label: "student moved" };

/**
 * Call inside the transaction that moves a student from one family to another, after the move is written. The old
 * family's live places for the student on shifts still to start are cancelled; the guardians who took them are told by
 * email once the transaction has committed, by calling `tell()`. Credit already earned is left with the old family.
 * The move comes by QuickBooks ids, as the roster has it; a student or old family with no app record has no places.
 */
export async function volunteerForMovedStudent(tx: Tx, move: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string }, o: { actor?: Actor; ip?: string | null; now?: Date } = {}):
  Promise<{ cancelled: number; tell: () => Promise<{ sent: number; failed: number }> }> {
  const nothing = { cancelled: 0, tell: async () => ({ sent: 0, failed: 0 }) };
  const now = o.now ?? new Date(), actor = o.actor ?? MOVE_ACTOR;
  const [studentId, fromFamilyId] = await Promise.all([studentLinkedTo(move.studentQboId, tx), familyLinkedTo(move.fromFamilyQboId, tx)]);
  if (studentId === null || fromFamilyId === null) return nothing;
  const zone = (await getClubSettings()).timeZone;
  const rows = await tx.select({ s: volunteerSignup, shift: volunteerShift, event: volunteerEvent }).from(volunteerSignup)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(and(eq(volunteerSignup.familyId, fromFamilyId), eq(volunteerSignup.studentId, studentId), isNull(volunteerSignup.cancelledAt)))
    .for("update", { of: volunteerSignup });
  const credited = await creditedSignups(rows.map((r) => r.s.id), tx);
  const ids = placesToGiveUp(rows.map((r) => ({ id: r.s.id, start: shiftInstants(r.event.onDate, r.shift.startsAt, r.shift.endsAt, zone).start,
    cancelled: r.shift.cancelledAt !== null || r.event.cancelledAt !== null, checkedIn: credited.has(r.s.id) })), now);
  if (ids.length === 0) return nothing;
  const giving = rows.filter((r) => ids.includes(r.s.id));
  const toFamilyId = await familyLinkedTo(move.toFamilyQboId, tx);
  // Who to tell, read before the places are given up: the guardian who took each, while they may still see the family.
  const told = (await signupsOn([...new Set(giving.map((r) => r.shift.id))], tx)).filter((x) => ids.includes(x.signupId));
  for (const r of giving) await tx.update(volunteerSignup).set({ cancelledAt: now, cancelledByDoor: "staff", cancelledBy: actor.id }).where(eq(volunteerSignup.id, r.s.id));
  await writeAudit({ actor, action: "volunteer.signup.moved", targetType: "student", targetId: String(studentId), ip: o.ip ?? null,
    before: { familyId: String(fromFamilyId), signups: giving.map((r) => ({ id: r.s.id, shiftId: r.shift.id, event: r.event.name, onDate: r.event.onDate, startsAt: clockOf(r.shift.startsAt) })) },
    after: { familyId: toFamilyId === null ? null : String(toFamilyId), cancelled: giving.length, guardiansTold: told.length } }, tx);
  const notices: Notice[] = told.map((x) => {
    const r = giving.find((g) => g.s.id === x.signupId)!;
    return { kind: "removed", signup: x, facts: factsOf(r.event, r.shift), why: "moved" };
  });
  return { cancelled: giving.length, tell: () => sendNotices(notices, { zone, actor, ip: o.ip ?? null, targetType: "student", targetId: String(studentId) }) };
}

const studentLink = alias(accountingLink, "student_link");
const familyLink = alias(accountingLink, "family_link");

/**
 * The students' places on shifts still to start held under another family than the one each is under now (`under`:
 * student to family, by QuickBooks id, studentsUnderFamilies() in src/lib/roster/moves.ts, from the roster a refresh is
 * about to store): the places a move's follow-up would give up, for a roster refresh to follow a move it didn't see in
 * one read. Each place's student and family are taken to the customers their links name, in the records' company. A
 * followed move leaves none: its places still to start are given up, and the places done stay with the family they
 * were earned for, which this leaves out.
 */
export async function placesHeldElsewhere(tx: Tx, under: ReadonlyMap<string, string>, now: Date = new Date()): Promise<{ studentQboId: string; familyQboId: string }[]> {
  if (under.size === 0) return [];
  const realmId = await recordsCompany(tx);
  if (realmId === null) return [];
  const rows = (await tx.select({ s: volunteerSignup, shift: volunteerShift, event: volunteerEvent, studentQboId: studentLink.customerId, familyQboId: familyLink.customerId })
    .from(volunteerSignup)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .innerJoin(studentLink, and(eq(studentLink.studentId, volunteerSignup.studentId), eq(studentLink.system, QUICKBOOKS), eq(studentLink.realmId, realmId)))
    .innerJoin(familyLink, and(eq(familyLink.familyId, volunteerSignup.familyId), eq(familyLink.system, QUICKBOOKS), eq(familyLink.realmId, realmId)))
    .where(and(isNotNull(volunteerSignup.studentId), isNull(volunteerSignup.cancelledAt))))
    .filter((r) => under.has(r.studentQboId) && under.get(r.studentQboId) !== r.familyQboId);
  if (rows.length === 0) return [];
  const zone = (await getClubSettings()).timeZone;
  const credited = await creditedSignups(rows.map((r) => r.s.id), tx);
  const ids = new Set(placesToGiveUp(rows.map((r) => ({ id: r.s.id, start: shiftInstants(r.event.onDate, r.shift.startsAt, r.shift.endsAt, zone).start,
    cancelled: r.shift.cancelledAt !== null || r.event.cancelledAt !== null, checkedIn: credited.has(r.s.id) })), now));
  const out = new Map<string, { studentQboId: string; familyQboId: string }>();
  for (const r of rows) if (ids.has(r.s.id)) out.set(`${r.studentQboId}|${r.familyQboId}`, { studentQboId: r.studentQboId, familyQboId: r.familyQboId });
  return [...out.values()];
}
