import { describe, it, expect, beforeEach, vi } from "vitest";

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, requirementProgress, volunteerCredit, volunteerSignup } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { Requirement } from "@/lib/seasons/progress";
import { checkIn, loadCheckInForMe } from "@/lib/volunteer/check-in";
import { loadMyVolunteering } from "@/lib/volunteer/my-volunteer";
import { allocateFamilies } from "@/lib/volunteer/credit";
import { signedUpAmounts } from "@/lib/volunteer/signed-up";
import { resetDb, untilALockIsAwaited } from "../helpers/db";
import { FAMILY_A, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { seedCheckIn, seedEvent, seedSignup, shiftAround } from "../helpers/volunteer";
import { subjectColumns } from "../helpers/app-records";

/**
 * Three rules of how volunteering counts (v1 spec §11.4) that the review of step 5 found broken: a requirement staff
 * waived takes no credit, so a requirement sharing its shifts gets it; a check-in staff removed can't be put back by
 * the guardian pressing again; and a place on a shift that is over and wasn't checked in is no longer "signed up for".
 */
vi.setConfig({ testTimeout: 30_000 });
const [LEO] = FAMILY_A.students;
const key = (requirementId: string, subject: string) => `${requirementId}|${subject}`;
let a: SeededParent, stepId: string;
const ctx = (): ParentCtx => ({ ...a.identity, ip: "203.0.113.50" });
const live = () => db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.createdAt));

async function volunteerRequirement(title: string, o: { appliesTo: "family" | "student"; amount: number; position: number }): Promise<Requirement> {
  const [row] = await db.insert(requirement).values({ stepId, kind: "volunteer", title, required: true, appliesTo: o.appliesTo, amount: o.amount, amountUnit: "shifts", position: o.position }).returning();
  return { id: row!.id, kind: "volunteer", title, required: true, appliesTo: o.appliesTo, amount: o.amount, amountUnit: "shifts", dueOn: null, covers: "everyone", coveredQboIds: [] } as unknown as Requirement;
}

beforeEach(async () => {
  await resetDb();
  a = await seedSignedInParent(FAMILY_A);
  stepId = (await seedSeason({ name: "Fall", steps: [{ name: "Help out" }] })).stepIds["Help out"]!;
});

describe("a waived requirement", () => {
  it("takes no credit, so what it would have taken counts toward a requirement linked to the same shifts", async () => {
    const leos = await volunteerRequirement("Leo: 2 shifts", { appliesTo: "student", amount: 2, position: 0 });
    const family = await volunteerRequirement("2 shifts", { appliesTo: "family", amount: 2, position: 1 });
    await db.insert(requirementProgress).values({ requirementId: leos.id, ...(await subjectColumns(LEO!.qboId, "student")), waivedAt: new Date(), waivedReason: "Injured; staff only" });
    const { shifts } = await seedEvent({ inDays: -3, shifts: [{ requirementIds: [leos.id, family.id] }, { startsAt: "10:00", endsAt: "12:00", requirementIds: [leos.id, family.id] }] });
    for (const shift of shifts) {
      const s = await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: LEO! });
      await seedCheckIn({ signupId: s.id, familyQboId: FAMILY_A.family.qboId, by: a.identity.parentId });
    }
    const credit = (await allocateFamilies([FAMILY_A.family.qboId])).get(FAMILY_A.family.qboId)!;
    expect(credit.allocation.filled.get(key(family.id, FAMILY_A.family.qboId))).toBe(2);
    expect(credit.allocation.filled.has(key(leos.id, LEO!.qboId))).toBe(false);
    expect(credit.allocation.given.map((g) => g.requirementId)).toEqual([family.id, family.id]);
  });
});

describe("a check-in staff removed", () => {
  it("can't be checked in again by the guardian: the page says the club updated it, and pressing records nothing", async () => {
    const t = shiftAround(new Date(), 10, 120);
    const { shifts: [shift] } = await seedEvent({ onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt }] });
    const mine = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    const leo = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, student: LEO! });
    await seedCheckIn({ signupId: mine.id, familyQboId: FAMILY_A.family.qboId, by: a.identity.parentId, removed: { by: a.identity.parentId, reason: "Wasn't there; staff only" } });
    const view = (await loadCheckInForMe(ctx(), shift!.checkinCode))!;
    expect(view.people).toEqual([
      { signupId: mine.id, who: "You", checkedIn: false, corrected: true },
      { signupId: leo.id, who: LEO!.name, checkedIn: false, corrected: false },
    ]);
    expect(JSON.stringify(view)).not.toContain("staff only");
    // The Volunteer page says the same, rather than sending the guardian to scan a code that can't check them in.
    const signups = (await loadMyVolunteering(ctx())).signups;
    expect(signups.map((s) => [s.id, s.checkedIn, s.corrected])).toEqual([[mine.id, false, true], [leo.id, false, false]]);
    expect(await checkIn(ctx(), shift!.checkinCode, mine.id)).toEqual({ ok: false,
      errors: ["The club has updated this check-in, so it can't be checked in again here. If something isn't right, please talk to Pat Organizer (pat.organizer@club.example)."] });
    // "Everyone" checks in only the place nobody corrected.
    expect(await checkIn(ctx(), shift!.checkinCode, "all")).toEqual({ ok: true, message: `Checked in: ${LEO!.name}. Thank you for helping!` });
    expect((await live()).map((c) => [c.signupId, c.removedAt === null])).toEqual([[mine.id, false], [leo.id, true]]);
  });

  it("is not made for a place cancelled while the press was on its way", async () => {
    const t = shiftAround(new Date(), 10, 120);
    const { shifts: [shift] } = await seedEvent({ onDate: t.onDate, shifts: [{ startsAt: t.startsAt, endsAt: t.endsAt }] });
    const mine = await seedSignup({ shiftId: shift!.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    // The place is cancelled (by staff) while the check-in waits for its row.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cancelling = db.transaction(async (tx) => {
      await tx.select().from(volunteerSignup).where(eq(volunteerSignup.id, mine.id)).for("update");
      await tx.update(volunteerSignup).set({ cancelledAt: new Date(), cancelledByDoor: "staff" }).where(eq(volunteerSignup.id, mine.id));
      await held;
    });
    const pressing = checkIn(ctx(), shift!.checkinCode, mine.id);
    await untilALockIsAwaited();
    release();
    await cancelling;
    expect(await pressing).toEqual({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
    expect(await live()).toEqual([]);
  });
});

describe("a place on a shift that is over", () => {
  it("isn't counted as signed up for once the shift has ended without a check-in", async () => {
    const family = await volunteerRequirement("2 shifts", { appliesTo: "family", amount: 2, position: 0 });
    const { shifts: [past] } = await seedEvent({ inDays: -21, shifts: [{ requirementIds: [family.id] }] });
    const { shifts: [coming] } = await seedEvent({ inDays: 10, shifts: [{ requirementIds: [family.id] }] });
    for (const shift of [past!, coming!]) await seedSignup({ shiftId: shift.id, familyQboId: FAMILY_A.family.qboId, signedUpBy: a.identity.parentId, guardianName: FAMILY_A.parent.name });
    const amounts = await signedUpAmounts([family], [FAMILY_A.family.qboId], key);
    expect(amounts.get(key(family.id, FAMILY_A.family.qboId))).toBe(1);
  });
});
