// What volunteering does when staff move a student to another family (the roster writes slice calls this; nothing here
// calls it yet). A place belongs to the family it was taken from: the old family's places for that student on shifts
// still to start are given up, their guardians told; what the student has already done stays with the family it was
// earned for, so a check-in keeps its credit there, and the new family takes nothing over.
import "server-only";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { volunteerEvent, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
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
 */
export async function volunteerForMovedStudent(tx: Tx, move: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string }, o: { actor?: Actor; ip?: string | null; now?: Date } = {}):
  Promise<{ cancelled: number; tell: () => Promise<{ sent: number; failed: number }> }> {
  const now = o.now ?? new Date(), actor = o.actor ?? MOVE_ACTOR;
  const zone = (await getClubSettings()).timeZone;
  const rows = await tx.select({ s: volunteerSignup, shift: volunteerShift, event: volunteerEvent }).from(volunteerSignup)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(and(eq(volunteerSignup.familyQboId, move.fromFamilyQboId), eq(volunteerSignup.studentQboId, move.studentQboId), isNull(volunteerSignup.cancelledAt)))
    .for("update", { of: volunteerSignup });
  const credited = await creditedSignups(rows.map((r) => r.s.id), tx);
  const ids = placesToGiveUp(rows.map((r) => ({ id: r.s.id, start: shiftInstants(r.event.onDate, r.shift.startsAt, r.shift.endsAt, zone).start,
    cancelled: r.shift.cancelledAt !== null || r.event.cancelledAt !== null, checkedIn: credited.has(r.s.id) })), now);
  if (ids.length === 0) return { cancelled: 0, tell: async () => ({ sent: 0, failed: 0 }) };
  const giving = rows.filter((r) => ids.includes(r.s.id));
  // Who to tell, read before the places are given up: the guardian who took each, while they may still see the family.
  const told = (await signupsOn([...new Set(giving.map((r) => r.shift.id))], tx)).filter((x) => ids.includes(x.signupId));
  for (const r of giving) await tx.update(volunteerSignup).set({ cancelledAt: now, cancelledByDoor: "staff", cancelledBy: actor.id }).where(eq(volunteerSignup.id, r.s.id));
  await writeAudit({ actor, action: "volunteer.signup.moved", targetType: "student", targetId: move.studentQboId, ip: o.ip ?? null,
    before: { familyQboId: move.fromFamilyQboId, signups: giving.map((r) => ({ id: r.s.id, shiftId: r.shift.id, event: r.event.name, onDate: r.event.onDate, startsAt: clockOf(r.shift.startsAt) })) },
    after: { familyQboId: move.toFamilyQboId, cancelled: giving.length, guardiansTold: told.length } }, tx);
  const notices: Notice[] = told.map((x) => {
    const r = giving.find((g) => g.s.id === x.signupId)!;
    return { kind: "removed", signup: x, facts: factsOf(r.event, r.shift), why: "moved" };
  });
  return { cancelled: giving.length, tell: () => sendNotices(notices, { zone, actor, ip: o.ip ?? null, targetType: "student", targetId: move.studentQboId }) };
}

/**
 * The students' places on shifts still to start held under another family than the one each is under now (`under`:
 * student to family, studentsUnderFamilies() in src/lib/roster/moves.ts): the places a move's follow-up would give up,
 * for a roster refresh to follow a move it didn't see in one read. A followed move leaves none: its places still to
 * start are given up, and the places done stay with the family they were earned for, which this leaves out.
 */
export async function placesHeldElsewhere(tx: Tx, under: ReadonlyMap<string, string>, now: Date = new Date()): Promise<{ studentQboId: string; familyQboId: string }[]> {
  if (under.size === 0) return [];
  const rows = (await tx.select({ s: volunteerSignup, shift: volunteerShift, event: volunteerEvent }).from(volunteerSignup)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(and(isNotNull(volunteerSignup.studentQboId), isNull(volunteerSignup.cancelledAt))))
    .filter((r) => r.s.studentQboId !== null && under.has(r.s.studentQboId) && under.get(r.s.studentQboId) !== r.s.familyQboId);
  if (rows.length === 0) return [];
  const zone = (await getClubSettings()).timeZone;
  const credited = await creditedSignups(rows.map((r) => r.s.id), tx);
  const ids = new Set(placesToGiveUp(rows.map((r) => ({ id: r.s.id, start: shiftInstants(r.event.onDate, r.shift.startsAt, r.shift.endsAt, zone).start,
    cancelled: r.shift.cancelledAt !== null || r.event.cancelledAt !== null, checkedIn: credited.has(r.s.id) })), now));
  const out = new Map<string, { studentQboId: string; familyQboId: string }>();
  for (const r of rows) if (ids.has(r.s.id)) out.set(`${r.s.studentQboId}|${r.s.familyQboId}`, { studentQboId: r.s.studentQboId!, familyQboId: r.s.familyQboId });
  return [...out.values()];
}
