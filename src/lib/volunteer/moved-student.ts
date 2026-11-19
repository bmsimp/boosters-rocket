// What volunteering does when staff move a student to another family in the portal (afterStudentMoved() in
// src/lib/roster/writes.ts; since stage 3's slice 9c a move made in QuickBooks is no longer followed). A place belongs
// to the family it was taken from: the old family's places for that student on shifts still to start are given up,
// their guardians told; what the student has already done stays with the family it was earned for, so a check-in keeps
// its credit there, and the new family takes nothing over. The staff move names the move by QuickBooks ids; sign-ups
// name the app's own family and student (stage 2 of the app-owned families spec), so the move is turned into those
// records here, through their links in the records' company: a boundary AGENTS.md lists, until the order of a staff
// write flips (stage 3's slice 9d).
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { volunteerEvent, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { familyLinkedTo, studentLinkedTo } from "@/lib/families/links";
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
