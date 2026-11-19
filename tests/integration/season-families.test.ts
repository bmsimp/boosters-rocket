import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, qboCustomerType, setting, student } from "@/lib/db/schema";
import { asAppFamilyId, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { loadRosterPage } from "@/lib/roster/queries";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { setRosterSource } from "@/lib/roster/source";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { loadProgressOverview, loadRequirementProgress, setTicks } from "@/lib/seasons/staff-progress";
import { loadSeasonFamilies, seasonFamilyAt } from "@/lib/seasons/subjects";
import { loadMatrix } from "@/lib/signed-forms/matrix";
import { resetDb, seedStaff } from "../helpers/db";
import { addToCache, fam, moveInCache, par, seedRosterRead, seedShape, stu } from "../helpers/roster-cache";
import { recordOfCustomer } from "../helpers/app-records";
import { seedSeason } from "../helpers/season";
import { formSetting, seedFormRequirement } from "../helpers/forms";

/**
 * The one reader the staff side's seasons, volunteering, forms and staff home take their families from
 * (loadSeasonFamilies(), stage 3 of the app-owned families spec): the app's own active families and their active
 * students, read from the app's tables alone. No QuickBooks connection is made anywhere in this file.
 */

// Two active families with students, an inactive family whose student is still active under it, and a student
// QuickBooks has made inactive.
const ROSTER = [
  fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Maya Rivera", "10"), stu("13", "leo Rivera", "10"),
  stu("14", "Gone Rivera", "10", { active: false }),
  fam("20", "Chen <b>Family</b>"), stu("22", "Kai <i>Chen</i>", "20"),
  fam("30", "Left Family", { active: false }), stu("32", "Lee Left", "30"),
];

/** As the reader gives them: each family's name with its students' names. */
const shown = async () => (await loadSeasonFamilies()).map((f) => [f.name, f.students.map((s) => s.name)]);
/** A family and its students made by hand, with no link to any customer: the kind of family that can exist once the app makes families (S9). */
const unlinked = async (name: string | null, students: (string | null)[]): Promise<{ id: AppFamilyId; students: AppStudentId[] }> => {
  const [f] = await db.insert(family).values({ name, active: true }).returning();
  const made = students.length ? await db.insert(student).values(students.map((s) => ({ name: s, active: true, familyId: f!.id }))).returning() : [];
  return { id: f!.id, students: made.map((s) => s.id) };
};

let actor: { door: "staff"; id: string; label: string };
beforeEach(async () => {
  // A roster read from company 1111, so the app's own records are made for it, then kept in step with the cache.
  await resetDb(); await db.transaction((tx) => setRosterSource(tx, "1111")); await seedShape(); await addToCache(ROSTER);
  const staff = await seedStaff({ email: "ticker@club.org", name: "Tia Ticker" });
  actor = { door: "staff", id: staff.id, label: staff.email };
});

describe("loadSeasonFamilies()", () => {
  it("gives the app's active families by name, each with its active students by name, as the roster lists them", async () => {
    // The inactive family is left out with its student; so is the inactive student. Case is ignored in the order.
    expect(await shown()).toEqual([
      ["Chen <b>Family</b>", ["Kai <i>Chen</i>"]],
      ["Rivera Family", ["leo Rivera", "Maya Rivera"]],
    ]);
    const rivera = await recordOfCustomer("10", "family");
    expect((await loadSeasonFamilies()).find((f) => f.id === rivera)!.students.map((s) => s.id))
      .toEqual([await recordOfCustomer("13", "student"), await recordOfCustomer("12", "student")]);
  });

  it("says a family or student the portal knows no name for in words, and orders it by those words", async () => {
    await unlinked(null, [null]);
    expect(await shown()).toEqual([
      ["A family whose name the portal doesn't know", ["A student whose name the portal doesn't know"]],
      ["Chen <b>Family</b>", ["Kai <i>Chen</i>"]],
      ["Rivera Family", ["leo Rivera", "Maya Rivera"]],
    ]);
  });

  it("follows the records, not the cache: a record made inactive, and a student moved", async () => {
    await db.update(family).set({ active: false }).where(eq(family.id, await recordOfCustomer("20", "family")));
    expect(await shown()).toEqual([["Rivera Family", ["leo Rivera", "Maya Rivera"]]]);
    // While the records mirror the cache they are the same thing: a student moved in QuickBooks moves with the read.
    await db.update(family).set({ active: true }).where(eq(family.id, await recordOfCustomer("20", "family")));
    await moveInCache(["13"], "20");
    expect(await shown()).toEqual([
      ["Chen <b>Family</b>", ["Kai <i>Chen</i>", "leo Rivera"]],
      ["Rivera Family", ["Maya Rivera"]],
    ]);
  });

  it("seasonFamilyAt(): an active family with its active students; nothing for an inactive one or no record", async () => {
    const rivera = await recordOfCustomer("10", "family");
    expect(await seasonFamilyAt(rivera)).toEqual({ id: rivera, name: "Rivera Family", students: [
      { id: await recordOfCustomer("13", "student"), name: "leo Rivera" }, { id: await recordOfCustomer("12", "student"), name: "Maya Rivera" }] });
    expect(await seasonFamilyAt(await recordOfCustomer("30", "family"))).toBeNull();
    expect(await seasonFamilyAt(asAppFamilyId(crypto.randomUUID()))).toBeNull();
  });

  it("lists a family with no link, which is ticked, asked for its forms, and reads \"No invoice yet\" for a payment", async () => {
    const hand = await unlinked("Handmade Family", ["Hal Handmade"]);
    expect(await shown()).toEqual([
      ["Chen <b>Family</b>", ["Kai <i>Chen</i>"]],
      ["Handmade Family", ["Hal Handmade"]],
      ["Rivera Family", ["leo Rivera", "Maya Rivera"]],
    ]);
    expect(await seasonFamilyAt(hand.id)).toEqual({ id: hand.id, name: "Handmade Family", students: [{ id: hand.students[0], name: "Hal Handmade" }] });

    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Start", requirements: [
      { title: "Banquet RSVP", appliesTo: "family" },
      { title: "Trip deposit", appliesTo: "family", kind: "payment", item: "4242" },
    ] }] });
    await seedFormRequirement({ stepId: fall.stepIds.Start!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "tpl-1" }) });
    const rsvp = fall.requirementIds["Banquet RSVP"]!, deposit = fall.requirementIds["Trip deposit"]!;

    // Staff tick it off for the family: the write finds it among the families the reader gives.
    expect(await setTicks(rsvp, await currentRosterTag(), [String(hand.id)], true, { actor, ip: null })).toEqual({ ok: true, changed: 1 });
    const ticked = await loadRequirementProgress(rsvp, "all");
    expect(ticked!.rows.map((r) => [r.name, r.words])).toEqual([["Chen <b>Family</b>", "Not done yet"], ["Handmade Family", "Done"], ["Rivera Family", "Not done yet"]]);
    expect(ticked!.counts).toMatchObject({ asked: 3, done: 1 });
    // A payment is met from invoices on the family's customer: with none, there is none yet.
    expect((await loadRequirementProgress(deposit, "all"))!.rows.find((r) => r.id === hand.id)!.words).toBe("No invoice yet");
    // Its student is asked for the form like any other, and counted.
    const matrix = (await loadMatrix({ formId: null, state: null, search: "" }))!;
    const row = matrix.families.find((f) => f.id === String(hand.id))!.rows.find((r) => r.kind === "student")!;
    expect([row.name, row.cells[0]!.state]).toEqual(["Hal Handmade", "not_opened"]);
    expect(matrix.allForms[0]!.counts).toEqual({ signed: 0, needed: 4, waived: 0 });
  });

  it("doesn't go blank while the membership shape is broken or unsaved, as the roster pages do", async () => {
    await seedRosterRead();
    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Start", requirements: [{ title: "Banquet RSVP", appliesTo: "family" }] }] });
    const before = await shown();
    // A shape naming a type QuickBooks no longer has.
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "S"));
    expect((await loadRosterPage()).brokenTypes).toEqual(["S"]);
    expect((await loadRosterPage()).roster).toBeNull();
    expect(await shown()).toEqual(before);
    expect((await loadRequirementProgress(fall.requirementIds["Banquet RSVP"]!, "none"))!.counts).toMatchObject({ asked: 2, todo: 2 });
    expect((await loadProgressOverview(fall.seasonId))!.steps[0]!.requirements[0]!.counts).toMatchObject({ asked: 2 });
    // No shape at all: the records stand as the last roster read left them.
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect((await loadRosterPage()).roster).toBeNull();
    expect(await shown()).toEqual(before);
  });
});
