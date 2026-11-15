import { describe, it, expect, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, revalidatedPaths, signedOut } from "../helpers/signed-in";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboCustomer, requirement, requirementCover, requirementProgress, role, roleAssignment, roleRule, season, seasonStep } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { ADMIN_ONLY, GRANTABLE } from "@/lib/permissions/registry";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import type { MembershipShape } from "@/lib/roster/shape";
import { loadMySeason } from "@/lib/seasons/my-season";
import SeasonsPage from "@/app/staff/(app)/seasons/page";
import SeasonSetupPage from "@/app/staff/(app)/seasons/[id]/page";
import RequirementPage from "@/app/staff/(app)/seasons/[id]/requirements/[requirementId]/page";
import ProgressPage from "@/app/staff/(app)/seasons/progress/page";
import RequirementProgressPage from "@/app/staff/(app)/seasons/progress/[requirementId]/page";
import FamilyProgressPage from "@/app/staff/(app)/seasons/progress/family/[familyId]/page";
import {
  addRequirementAction, addStepAction, clearCurrentSeasonAction, createSeasonAction, moveStepAction, removeRequirementAction, removeStepAction, removeWaiverAction,
  renameSeasonAction, setCoverageAction, setCurrentSeasonAction, setTicksAction, updateRequirementAction, updateStepAction, waiveAction,
} from "@/app/staff/(app)/seasons/actions";
import { resetDb, seedStaff } from "../helpers/db";
import { seedSignedInParent, FAMILY_A } from "../helpers/parent";
import { addToCache, fam, par, seedShape, stu } from "../helpers/roster-cache";
import { seedSeason } from "../helpers/season";

/**
 * The staff side of a season: set-up (seasons, steps, requirements, who each covers) and progress (ticks, waivers).
 * For every page and action: the guard and its permission, each argument checked, the audit row in the write's own
 * transaction with before and after, and the result shape with the pages shown again.
 */
type Staff = Awaited<ReturnType<typeof seedStaff>>;
const BROWSER = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const NO_SUCH = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
const FIELDS = { title: "Uniform fitting attended", required: true, amount: null, amountUnit: null, dueOn: null };
const audits = async (action?: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => !action || r.action === action);
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const seasons = () => db.select().from(season).orderBy(asc(season.createdAt), asc(season.name));
const stepsOf = (seasonId: string) => db.select().from(seasonStep).where(eq(seasonStep.seasonId, seasonId)).orderBy(asc(seasonStep.position));
const recorded = () => db.select().from(requirementProgress).orderBy(asc(requirementProgress.subjectQboId));

const withRole = async (email: string, name: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name });
  const [r] = await db.insert(role).values({ key: email, name }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};

// Two active families with students, one inactive family, and a student QuickBooks has made inactive.
const ROSTER = [
  fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"), stu("13", "Maya Rivera", "10"),
  stu("14", "Gone Rivera (deleted)", "10", { active: false }),
  fam("20", "Chen <b>Family</b>"), stu("22", "Kai <i>Chen</i>", "20"),
  fam("30", "Left Family (deleted)", { active: false }), stu("32", "Lee Left", "30"),
];

let setter: Staff, ticker: Staff, reader: Staff, outsider: Staff;
beforeEach(async () => {
  await resetDb(); await seedShape(); await addToCache(ROSTER);
  setter = await withRole("setter@club.org", "Sal Setter", ["Season.Steps.*"]);
  ticker = await withRole("ticker@club.org", "Tia Ticker", ["Season.Progress.*"]);
  reader = await withRole("reader@club.org", "Rae Reader", ["Season.*.Read"]);
  outsider = await withRole("outsider@club.org", "Ozzy Outsider", ["Roster.*"]);
  asStaff(setter);
});

/** A current season with two steps: a per-student checklist item in the first and a per-family one in the second. */
const seedFall = () => seedSeason({ name: "Fall 2026", steps: [
  { name: "Uniforms", requirements: [{ title: "Uniform fitting attended", appliesTo: "student" }] },
  { name: "Wrap-up", requirements: [{ title: "Banquet RSVP", appliesTo: "family" }] },
] });

describe("the season permissions", () => {
  it("are four ordinary permissions a custom role can hold", () => {
    for (const p of ["Season.Steps.Read", "Season.Steps.ReadWrite", "Season.Progress.Read", "Season.Progress.ReadWrite"] as const) {
      expect(GRANTABLE).toContain(p);
      expect(ADMIN_ONLY).not.toContain(p);
    }
  });

  it("refuses every season page and action to staff without the permission, and to a parent", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!, uniforms = fall.stepIds.Uniforms!;
    const setupPages = [() => pageOutcome(SeasonsPage), () => pageOutcome(SeasonSetupPage, { params: { id: fall.seasonId } }),
      () => pageOutcome(RequirementPage, { params: { id: fall.seasonId, requirementId: fitting } })];
    const progressPages = [() => pageOutcome(ProgressPage), () => pageOutcome(RequirementProgressPage, { params: { requirementId: fitting } }),
      () => pageOutcome(FamilyProgressPage, { params: { familyId: "10" } })];
    const setupActions = [
      () => createSeasonAction("Spring", "template"), () => renameSeasonAction(fall.seasonId, "X"), () => setCurrentSeasonAction(fall.seasonId), () => clearCurrentSeasonAction(),
      () => addStepAction(fall.seasonId, "X"), () => updateStepAction(uniforms, "X", null, null), () => moveStepAction(uniforms, "later"), () => removeStepAction(uniforms),
      () => addRequirementAction(uniforms, "checklist", "student", FIELDS), () => updateRequirementAction(fitting, FIELDS),
      () => setCoverageAction(fitting, "chosen", ["12"]), () => removeRequirementAction(fitting),
    ];
    const progressActions = [() => setTicksAction(fitting, ["12"], true), () => waiveAction(fitting, "12", "reason"), () => removeWaiverAction(fitting, "12")];
    const before = JSON.stringify([await seasons(), await stepsOf(fall.seasonId), await db.select().from(requirement), await db.select().from(requirementCover), await recorded()]);

    // Someone with another area's permission, someone who may only read, and each half of the work without the other half.
    for (const who of [outsider, reader]) {
      asStaff(who);
      for (const act of [...setupActions, ...progressActions]) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    }
    asStaff(outsider);
    for (const page of [...setupPages, ...progressPages]) expect(await page()).toEqual({ redirect: "/refused" });
    asStaff(ticker);
    for (const act of setupActions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    for (const page of setupPages) expect(await page()).toEqual({ redirect: "/refused" });
    asStaff(setter);
    for (const act of progressActions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    for (const page of progressPages) expect(await page()).toEqual({ redirect: "/refused" });

    // A parent's session is no staff session at all.
    const parent = await seedSignedInParent();
    signedOut();
    asParent(parent.identity);
    for (const act of [...setupActions, ...progressActions]) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    for (const page of [...setupPages, ...progressPages]) expect(await page()).toEqual({ redirect: "/staff/sign-in" });

    // Nothing changed, nothing was shown again, and each refusal of a signed-in staff member is in the audit log.
    expect(JSON.stringify([await seasons(), await stepsOf(fall.seasonId), await db.select().from(requirement), await db.select().from(requirementCover), await recorded()])).toBe(before);
    expect(revalidatedPaths()).toEqual([]);
    const rows = await audits();
    expect(rows.every((r) => r.action === "access.refused")).toBe(true); // a family's page refused is a family's page not read
    expect(rows.filter((r) => r.actorId === reader.id).map((r) => r.permission)).toEqual(expect.arrayContaining(["Season.Steps.ReadWrite", "Season.Progress.ReadWrite"]));
  });

  it("lets a reader see the pages with nothing to change on them", async () => {
    const fall = await seedFall();
    asStaff(reader);
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    for (const html of [await renderPage(SeasonsPage), await renderPage(SeasonSetupPage, { params: { id: fall.seasonId } }),
      await renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: fitting } }), await renderPage(ProgressPage),
      await renderPage(FamilyProgressPage, { params: { familyId: "10" } })]) {
      expect(html).not.toMatch(/<button|<input|<select|<textarea/);
    }
    // The list of who has done it keeps its search box, and nothing that ticks or waives.
    const who = await renderPage(RequirementProgressPage, { params: { requirementId: fitting } });
    expect(who).toContain("Leo Rivera");
    expect(who.match(/<button/g)).toHaveLength(1);
    expect(who).not.toMatch(/Tick|Waive|<textarea|<select/);
  });
});

describe("seasons", () => {
  it("offers the template when there are none, and starts from it: five steps to rename or trim, not yet shown to parents", async () => {
    const empty = textOf(await renderPage(SeasonsPage));
    expect(empty).toContain("There are no seasons yet.");
    expect(empty).toContain("Start your first season The template has 5 steps: Join, Forms, Volunteer, Season, Wrap-up. Rename or remove them to fit your club.");
    expect(empty).not.toContain("Copy ");

    expect(await createSeasonAction("  Fall   2027 ", "template")).toEqual({ ok: true, message: "Started. Parents don't see it until you make it the current season." });
    const [made] = await seasons();
    expect(made).toMatchObject({ name: "Fall 2027", isCurrent: false });
    expect((await stepsOf(made!.id)).map((s) => [s.position, s.name])).toEqual([[0, "Join"], [1, "Forms"], [2, "Volunteer"], [3, "Season"], [4, "Wrap-up"]]);
    expect(revalidatedPaths()).toEqual(["/"]);
    expect(await audits()).toEqual([expect.objectContaining({ action: "season.create", permission: "Season.Steps.ReadWrite", door: "staff", actorId: setter.id, actorLabel: setter.email,
      targetType: "season", targetId: made!.id, ip: "203.0.113.50", before: null,
      after: { name: "Fall 2027", start: "template", steps: ["Join", "Forms", "Volunteer", "Season", "Wrap-up"], requirements: 0 } })]);
    const listed = textOf(await renderPage(SeasonsPage));
    expect(listed).toContain("Fall 2027 5 steps · 0 requirements");
    expect(listed).toContain("Copy Fall 2027");
  });

  it("copies the last season: its steps, requirements and chosen lists, with no dates, ticks or waivers", async () => {
    const last = await seedSeason({ name: "Fall 2026", steps: [
      { name: "Join", startsOn: "2026-08-01", endsOn: "2026-08-15", requirements: [
        { title: "Handbook read", appliesTo: "family", dueOn: "2026-08-10", ticked: ["10"], waived: [{ qboId: "20", reason: "new family" }] },
        { title: "Guard gloves", appliesTo: "student", required: false, chosen: ["13", "22"] }] },
      { name: "Wrap-up" },
    ] });
    expect(await createSeasonAction("Fall 2027", "last")).toEqual({ ok: true, message: "Copied. Dates were left out, and chosen lists were copied as they were: check both before parents see it." });
    const copy = (await seasons()).find((s) => s.name === "Fall 2027")!;
    expect(copy.isCurrent).toBe(false);
    expect((await stepsOf(copy.id)).map((s) => [s.name, s.startsOn, s.endsOn])).toEqual([["Join", null, null], ["Wrap-up", null, null]]);
    const copied = await db.select().from(requirement).innerJoin(seasonStep, eq(requirement.stepId, seasonStep.id)).where(eq(seasonStep.seasonId, copy.id)).orderBy(asc(requirement.position));
    expect(copied.map((r) => [r.requirement.title, r.requirement.kind, r.requirement.required, r.requirement.appliesTo, r.requirement.covers, r.requirement.dueOn])).toEqual([
      ["Handbook read", "checklist", true, "family", "everyone", null], ["Guard gloves", "checklist", false, "student", "chosen", null]]);
    const gloves = copied[1]!.requirement.id;
    expect((await db.select().from(requirementCover).where(eq(requirementCover.requirementId, gloves))).map((c) => c.subjectQboId).sort()).toEqual(["13", "22"]);
    // The ticks and the waiver stay with the season they were recorded in.
    expect((await recorded()).every((r) => r.requirementId === last.requirementIds["Handbook read"])).toBe(true);
    expect((await audits("season.create"))[0]!.after).toMatchObject({ start: "last", steps: ["Join", "Wrap-up"], requirements: 2, copiedFrom: { id: last.seasonId, name: "Fall 2026" } });
  });

  it("refuses a copy when there is nothing to copy, and a name that is empty or too long", async () => {
    expect(await createSeasonAction("Fall", "last")).toEqual({ ok: false, errors: ["There is no season to copy yet."] });
    expect(await createSeasonAction("   ", "empty")).toEqual({ ok: false, errors: ["The season needs a name."] });
    expect(await createSeasonAction("x".repeat(61), "empty")).toEqual({ ok: false, errors: ["The season is too long (60 characters at most)."] });
    expect(await seasons()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(revalidatedPaths()).toEqual([]);
  });

  it("renames a season and marks one season, and only one, as current", async () => {
    await createSeasonAction("Fall 2026", "empty"); await createSeasonAction("Spring 2027", "empty");
    const [fall, spring] = await seasons();
    expect(await renameSeasonAction(fall!.id, "Autumn 2026")).toEqual({ ok: true, message: "Renamed." });
    expect((await audits("season.rename"))[0]).toMatchObject({ targetId: fall!.id, before: { name: "Fall 2026" }, after: { name: "Autumn 2026" }, permission: "Season.Steps.ReadWrite" });

    expect(await setCurrentSeasonAction(fall!.id)).toEqual({ ok: true, message: "This is the current season now. Parents see it on Home." });
    expect((await seasons()).map((s) => s.isCurrent)).toEqual([true, false]);
    expect(await setCurrentSeasonAction(spring!.id)).toMatchObject({ ok: true });
    expect((await seasons()).map((s) => s.isCurrent)).toEqual([false, true]);
    expect(await clearCurrentSeasonAction()).toEqual({ ok: true, message: "No season is current now. Parents see no season on Home." });
    expect((await seasons()).map((s) => s.isCurrent)).toEqual([false, false]);
    expect((await audits("season.current.set")).map((r) => [r.before, r.after])).toEqual([
      [{ current: null }, { current: { id: fall!.id, name: "Autumn 2026" } }],
      [{ current: { id: fall!.id, name: "Autumn 2026" } }, { current: { id: spring!.id, name: "Spring 2027" } }],
      [{ current: { id: spring!.id, name: "Spring 2027" } }, { current: null }],
    ]);
    expect(await renameSeasonAction(NO_SUCH, "X")).toEqual({ ok: false, errors: ["That isn't there any more. Reload the page."] });
    expect(await setCurrentSeasonAction(NO_SUCH)).toEqual({ ok: false, errors: ["That isn't there any more. Reload the page."] });
  });
});

describe("steps", () => {
  it("adds, renames, dates, reorders and removes steps, each with its audit row", async () => {
    await createSeasonAction("Fall 2026", "template");
    const [fall] = await seasons();
    expect(await addStepAction(fall!.id, "Banquet")).toEqual({ ok: true, message: "Added at the end." });
    let steps = await stepsOf(fall!.id);
    expect(steps.map((s) => s.name)).toEqual(["Join", "Forms", "Volunteer", "Season", "Wrap-up", "Banquet"]);
    const forms = steps[1]!, banquet = steps[5]!;

    expect(await updateStepAction(forms.id, "Paperwork", "2026-08-01", "2026-08-15")).toEqual({ ok: true, message: "Saved." });
    expect((await audits("season.step.update"))[0]).toMatchObject({ targetType: "season_step", targetId: forms.id,
      before: { name: "Forms", startsOn: null, endsOn: null }, after: { name: "Paperwork", startsOn: "2026-08-01", endsOn: "2026-08-15" } });
    // An empty date is no date.
    expect(await updateStepAction(forms.id, "Paperwork", "", null)).toEqual({ ok: true, message: "Saved." });
    expect((await stepsOf(fall!.id))[1]).toMatchObject({ name: "Paperwork", startsOn: null, endsOn: null });

    expect(await moveStepAction(banquet.id, "earlier")).toEqual({ ok: true, message: "Moved." });
    steps = await stepsOf(fall!.id);
    expect(steps.map((s) => [s.position, s.name])).toEqual([[0, "Join"], [1, "Paperwork"], [2, "Volunteer"], [3, "Season"], [4, "Banquet"], [5, "Wrap-up"]]);
    expect((await audits("season.step.move"))[0]).toMatchObject({ targetId: banquet.id,
      before: { order: ["Join", "Paperwork", "Volunteer", "Season", "Wrap-up", "Banquet"] }, after: { order: ["Join", "Paperwork", "Volunteer", "Season", "Banquet", "Wrap-up"] } });
    // At either end there is nowhere to go: nothing changes and nothing is recorded.
    expect(await moveStepAction(steps[0]!.id, "earlier")).toEqual({ ok: true, message: "It is the first step already." });
    expect(await moveStepAction(steps[5]!.id, "later")).toEqual({ ok: true, message: "It is the last step already." });
    expect(await audits("season.step.move")).toHaveLength(1);

    expect(await removeStepAction(steps[2]!.id)).toEqual({ ok: true, message: "Removed." });
    expect((await stepsOf(fall!.id)).map((s) => s.name)).toEqual(["Join", "Paperwork", "Season", "Banquet", "Wrap-up"]);
    expect((await audits("season.step.remove"))[0]).toMatchObject({ targetId: steps[2]!.id, before: { name: "Volunteer", requirements: [] }, after: null });
  });

  it.each([
    ["an end before the start", "Forms", "2026-08-15", "2026-08-01", "The step ends before it starts. Check the two dates."],
    ["a day that doesn't exist", "Forms", "2026-02-30", null, "Enter each date as a day on the calendar."],
    ["a date in another form", "Forms", null, "08/15/26", "Enter each date as a day on the calendar."],
    ["no name", "  ", null, null, "The step needs a name."],
  ])("refuses %s", async (_what, name, startsOn, endsOn, error) => {
    const fall = await seedFall();
    expect(await updateStepAction(fall.stepIds.Uniforms!, name, startsOn, endsOn)).toEqual({ ok: false, errors: [error] });
    expect((await stepsOf(fall.seasonId))[0]).toMatchObject({ name: "Uniforms", startsOn: null, endsOn: null });
    expect(await audits()).toEqual([]);
  });

  it("won't remove a step while a tick or a waiver is recorded in it, and says why", async () => {
    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Uniforms", requirements: [
      { title: "Uniform fitting attended", appliesTo: "student", ticked: ["12"], waived: [{ qboId: "13", reason: "borrowed one" }] }] }] });
    expect(await removeStepAction(fall.stepIds.Uniforms!)).toEqual({ ok: false, errors: [
      "Uniforms can't be removed: 2 ticks and waivers are recorded on its requirements. Clear them first on each requirement's progress page, or rename the step and keep it."] });
    expect(await stepsOf(fall.seasonId)).toHaveLength(1);
    expect(await recorded()).toHaveLength(2);
    expect(await audits()).toEqual([]);
    // Once they are cleared, the step goes, with the requirement in it named in the audit row.
    asStaff(ticker);
    await setTicksAction(fall.requirementIds["Uniform fitting attended"]!, ["12"], false);
    await removeWaiverAction(fall.requirementIds["Uniform fitting attended"]!, "13");
    asStaff(setter);
    expect(await removeStepAction(fall.stepIds.Uniforms!)).toEqual({ ok: true, message: "Removed." });
    expect(await db.select().from(requirement)).toEqual([]);
    expect((await audits("season.step.remove"))[0]!.before).toMatchObject({ name: "Uniforms", requirements: [{ title: "Uniform fitting attended", kind: "checklist", appliesTo: "student" }] });
  });
});

describe("requirements", () => {
  it("adds a checklist item with the settings of spec 10.1, and lists the other kinds as coming later", async () => {
    const fall = await seedFall();
    const page = await renderPage(SeasonSetupPage, { params: { id: fall.seasonId } });
    expect(page).toContain(`<option value="checklist" selected="">Checklist item</option>`);
    for (const later of ["Form", "Payment", "Volunteering"]) expect(page).toMatch(new RegExp(`<option value="[a-z]+" disabled="">${later} \\(coming later\\)</option>`));

    expect(await addRequirementAction(fall.stepIds["Wrap-up"]!, "checklist", "family", { title: " Trophy  returned ", required: false, amount: null, amountUnit: null, dueOn: "2026-11-30" }))
      .toEqual({ ok: true, message: "Added. It is asked of everyone until you choose a list." });
    const rows = await db.select().from(requirement).where(eq(requirement.stepId, fall.stepIds["Wrap-up"]!)).orderBy(asc(requirement.position));
    expect(rows[1]).toMatchObject({ kind: "checklist", title: "Trophy returned", required: false, appliesTo: "family", amount: null, amountUnit: null, dueOn: "2026-11-30", covers: "everyone", position: 1 });
    expect((await audits("season.requirement.add"))[0]).toMatchObject({ targetType: "requirement", targetId: rows[1]!.id, permission: "Season.Steps.ReadWrite",
      after: { step: "Wrap-up", kind: "checklist", title: "Trophy returned", required: false, appliesTo: "family", dueOn: "2026-11-30", covers: "everyone" } });
    expect(textOf(await renderPage(SeasonSetupPage, { params: { id: fall.seasonId } }))).toContain("Trophy returned Checklist item · Optional · Each family · Everyone Due 2026-11-30");
  });

  it("offers a club whose roster lists no students only requirements for each family", async () => {
    const fall = await seedFall();
    const offered = async () => (await renderPage(SeasonSetupPage, { params: { id: fall.seasonId } })).match(/<option value="(student|family)"/g) ?? [];
    expect(await offered()).toEqual(expect.arrayContaining([`<option value="student"`, `<option value="family"`]));
    // Members who are their own families, and families with no student type: nobody is a student.
    const shapes: MembershipShape[] = [{ kind: "flat", memberTypeIds: ["M"] }, { kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" }];
    for (const shape of shapes) {
      await seedShape(shape);
      expect(new Set(await offered())).toEqual(new Set([`<option value="family"`]));
    }
  });

  it.each(["form", "payment", "volunteer"])("won't make a %s requirement yet: its rule isn't built", async (kind) => {
    const fall = await seedFall();
    const fields = kind === "volunteer" ? { ...FIELDS, amount: 2, amountUnit: "shifts" as const } : FIELDS;
    expect(await addRequirementAction(fall.stepIds.Uniforms!, kind, "family", fields)).toEqual({ ok: false, errors: ["That kind of requirement is coming later. For now, add a checklist item."] });
    expect(await db.select().from(requirement)).toHaveLength(2);
    expect(await audits()).toEqual([]);
  });

  it("changes a requirement's title, whether it is required and its due date, and refuses an amount on a checklist item", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    expect(await updateRequirementAction(fitting, { title: "Uniform fitted", required: false, amount: null, amountUnit: null, dueOn: "2026-09-01" })).toEqual({ ok: true, message: "Saved." });
    expect((await db.select().from(requirement).where(eq(requirement.id, fitting)))[0]).toMatchObject({ title: "Uniform fitted", required: false, dueOn: "2026-09-01", kind: "checklist", appliesTo: "student" });
    expect((await audits("season.requirement.update"))[0]).toMatchObject({ targetId: fitting,
      before: { title: "Uniform fitting attended", required: true, dueOn: null }, after: { title: "Uniform fitted", required: false, dueOn: "2026-09-01" } });
    expect(await updateRequirementAction(fitting, { ...FIELDS, amount: 2, amountUnit: "hours" })).toEqual({ ok: false, errors: ["Only a volunteering requirement has an amount."] });
    expect(await updateRequirementAction(fitting, { ...FIELDS, title: "" })).toEqual({ ok: false, errors: ["The requirement needs a name."] });
    expect(await updateRequirementAction(fitting, { ...FIELDS, dueOn: "2026-02-31" })).toEqual({ ok: false, errors: ["Enter the due date as a day on the calendar."] });
    expect(await audits("season.requirement.update")).toHaveLength(1);
  });

  it("covers everyone, or a list picked from the roster, and only who the requirement applies to", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!, rsvp = fall.requirementIds["Banquet RSVP"]!;
    expect(await setCoverageAction(fitting, "chosen", ["13", "22", "13"])).toEqual({ ok: true, message: "Saved. It is asked only of those you chose." });
    expect((await db.select().from(requirementCover)).map((c) => [c.requirementId, c.subjectQboId]).sort()).toEqual([[fitting, "13"], [fitting, "22"]]);
    expect((await audits("season.requirement.cover"))[0]).toMatchObject({ targetId: fitting, before: { covers: "everyone", subjectQboIds: [] }, after: { covers: "chosen", subjectQboIds: ["13", "22"] } });

    // A family on a per-student list, a student on a per-family one, someone inactive, someone unknown: none is on the roster for it.
    for (const [id, bad] of [[fitting, ["10"]], [rsvp, ["12"]], [fitting, ["14"]], [fitting, ["32"]], [rsvp, ["30"]], [fitting, ["13", "no-such-customer"]]] as const) {
      expect(await setCoverageAction(id, "chosen", [...bad])).toEqual({ ok: false, errors: ["Someone in that list isn't on the roster any more. Reload the page and choose again."] });
    }
    expect(await setCoverageAction(fitting, "chosen", [])).toEqual({ ok: false, errors: ["Choose at least one, or ask it of everyone."] });
    expect(await audits("season.requirement.cover")).toHaveLength(1);

    // Someone on the list who has since left the roster stays on it when the list is saved again.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "22"));
    expect(await setCoverageAction(fitting, "chosen", ["12"])).toMatchObject({ ok: true });
    expect((await db.select().from(requirementCover)).map((c) => c.subjectQboId).sort()).toEqual(["12", "22"]);

    expect(await setCoverageAction(fitting, "everyone", ["12"])).toEqual({ ok: true, message: "Saved. It is asked of everyone." });
    expect(await db.select().from(requirementCover)).toEqual([]);
    expect((await db.select().from(requirement).where(eq(requirement.id, fitting)))[0]!.covers).toBe("everyone");
  });

  it("shows a requirement's settings and its chosen list, with QuickBooks names as text", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    await setCoverageAction(fitting, "chosen", ["13", "22"]);
    const html = await renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: fitting } });
    const text = textOf(html);
    expect(text).toContain("Uniform fitting attended In Uniforms, Fall 2026.");
    expect(text).toContain("Checklist item · Required · Each student");
    expect(text).toContain("A chosen list: 2 of the students on the roster.");
    expect(html).toContain("Kai &lt;i&gt;Chen&lt;/i&gt;");
    expect(html).not.toMatch(/<i>Chen|<b>Family/);
    // The address names the season too: under another season, or with an id that isn't one, there is nothing.
    const other = await seedSeason({ name: "Other", current: false, steps: [] });
    expect(await pageOutcome(RequirementPage, { params: { id: other.seasonId, requirementId: fitting } })).toEqual({ notFound: true });
    expect(await pageOutcome(RequirementPage, { params: { id: fall.seasonId, requirementId: "1 or 1=1" } })).toEqual({ notFound: true });
    expect(await pageOutcome(SeasonSetupPage, { params: { id: NO_SUCH } })).toEqual({ notFound: true });
    expect(await pageOutcome(SeasonSetupPage, { params: { id: "../roster" } })).toEqual({ notFound: true });
  });

  it("won't remove a requirement while a tick or a waiver is recorded against it, and removes it once they are cleared", async () => {
    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Uniforms", requirements: [{ title: "Uniform fitting attended", appliesTo: "student", chosen: ["12", "13"], ticked: ["12"] }] }] });
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    expect(await removeRequirementAction(fitting)).toEqual({ ok: false, errors: [
      "Uniform fitting attended can't be removed: a tick or waiver is recorded against it. Clear them first on its progress page, or make it optional so it no longer holds the step open."] });
    expect(textOf(await renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: fitting } }))).toContain("A tick or waiver is recorded against this requirement, so it can't be removed.");
    expect(await db.select().from(requirement)).toHaveLength(1);
    asStaff(ticker);
    await setTicksAction(fitting, ["12"], false);
    asStaff(setter);
    expect(await removeRequirementAction(fitting)).toEqual({ ok: true, message: "Removed." });
    expect(await db.select().from(requirement)).toEqual([]);
    expect(await db.select().from(requirementCover)).toEqual([]);
    expect((await audits("season.requirement.remove"))[0]).toMatchObject({ targetId: fitting, before: { title: "Uniform fitting attended", covers: "chosen", subjectQboIds: ["12", "13"] }, after: null });
  });
});

describe("ticks and waivers", () => {
  beforeEach(() => asStaff(ticker));

  it("ticks an item off for one student, then for everyone shown, and unticks it; each change has its own audit row", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    expect(await setTicksAction(fitting, ["12"], true)).toEqual({ ok: true, message: "Ticked." });
    expect(await recorded()).toEqual([expect.objectContaining({ requirementId: fitting, subjectQboId: "12", metBy: ticker.id, waivedAt: null })]);
    expect(revalidatedPaths()).toEqual(["/"]);
    expect(await audits()).toEqual([expect.objectContaining({ action: "season.requirement.tick", permission: "Season.Progress.ReadWrite", actorId: ticker.id, ip: "203.0.113.50",
      targetType: "requirement_progress", targetId: `${fitting}:12`,
      before: { season: "Fall 2026", step: "Uniforms", requirement: "Uniform fitting attended", subjectQboId: "12", subject: "Leo Rivera", familyQboId: "10", ticked: false }, after: { ticked: true } })]);

    // Everyone shown: Leo is ticked already and is left alone.
    expect(await setTicksAction(fitting, ["12", "13", "22"], true)).toEqual({ ok: true, message: "Ticked 2." });
    expect((await recorded()).map((r) => r.subjectQboId)).toEqual(["12", "13", "22"]);
    expect((await audits("season.requirement.tick")).map((r) => r.targetId)).toEqual([`${fitting}:12`, `${fitting}:13`, `${fitting}:22`]);
    expect(await setTicksAction(fitting, ["12"], true)).toEqual({ ok: true, message: "Already ticked." });

    expect(await setTicksAction(fitting, ["13"], false)).toEqual({ ok: true, message: "Unticked." });
    expect((await recorded()).map((r) => r.subjectQboId)).toEqual(["12", "22"]); // an unticked row is gone: a row exists only while it records something
    expect((await audits("season.requirement.untick"))[0]).toMatchObject({ targetId: `${fitting}:13`, before: { ticked: true, tickedBy: ticker.id, subject: "Maya Rivera" }, after: { ticked: false } });
    expect(await setTicksAction(fitting, ["12", "13", "22"], false)).toEqual({ ok: true, message: "Unticked 2." });
    expect(await recorded()).toEqual([]);
    expect(await setTicksAction(fitting, ["12"], false)).toEqual({ ok: true, message: "Nothing was ticked." });
  });

  it("ticks only those the requirement is asked of now", async () => {
    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Uniforms", requirements: [
      { title: "Guard gloves", appliesTo: "student", chosen: ["13"] }, { title: "Banquet RSVP", appliesTo: "family" }] }] });
    const gloves = fall.requirementIds["Guard gloves"]!, rsvp = fall.requirementIds["Banquet RSVP"]!;
    const NOT_COVERED = { ok: false, errors: ["Someone in that list isn't covered by this requirement any more. Reload the page and try again."] };
    // Not on its chosen list; a family for a per-student item; a student for a per-family one; inactive; unknown; one bad id among good ones.
    for (const [id, who] of [[gloves, ["12"]], [gloves, ["10"]], [rsvp, ["12"]], [gloves, ["14"]], [rsvp, ["30"]], [rsvp, ["no-such"]], [rsvp, ["10", "20", "99"]]] as const) {
      expect(await setTicksAction(id, [...who], true)).toEqual(NOT_COVERED);
    }
    expect(await recorded()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(await setTicksAction(NO_SUCH, ["13"], true)).toEqual({ ok: false, errors: ["That isn't there any more. Reload the page."] });
    expect(await setTicksAction(gloves, ["13"], true)).toEqual({ ok: true, message: "Ticked." });
    expect(await setTicksAction(rsvp, ["10", "20"], true)).toEqual({ ok: true, message: "Ticked 2." });
  });

  it("waives a requirement for a family or student with a reason, which is in the audit row, and removes the waiver", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!, rsvp = fall.requirementIds["Banquet RSVP"]!;
    expect(await waiveAction(fitting, "13", "  Wears last year's uniform ")).toEqual({ ok: true, message: "Waived." });
    expect(await recorded()).toEqual([expect.objectContaining({ requirementId: fitting, subjectQboId: "13", metAt: null, waivedBy: ticker.id, waivedReason: "Wears last year's uniform" })]);
    expect(await audits()).toEqual([expect.objectContaining({ action: "season.requirement.waive", permission: "Season.Progress.ReadWrite", targetId: `${fitting}:13`,
      before: expect.objectContaining({ requirement: "Uniform fitting attended", subject: "Maya Rivera", familyQboId: "10", waived: false }), after: { waived: true, reason: "Wears last year's uniform" } })]);

    // Waiving again replaces the reason; a tick beside it is kept when the waiver goes.
    expect(await waiveAction(fitting, "13", "Has her sister's")).toEqual({ ok: true, message: "Waived." });
    expect((await audits("season.requirement.waive"))[1]).toMatchObject({ before: { waived: true, reason: "Wears last year's uniform" }, after: { waived: true, reason: "Has her sister's" } });
    await setTicksAction(fitting, ["13"], true);
    expect(await removeWaiverAction(fitting, "13")).toEqual({ ok: true, message: "The waiver is removed." });
    expect(await recorded()).toEqual([expect.objectContaining({ subjectQboId: "13", waivedAt: null, waivedReason: null, waivedBy: null })]);
    expect((await recorded())[0]!.metAt).not.toBeNull();
    expect((await audits("season.requirement.unwaive"))[0]).toMatchObject({ targetId: `${fitting}:13`, before: { waived: true, reason: "Has her sister's", waivedBy: ticker.id }, after: { waived: false } });
    expect(await removeWaiverAction(fitting, "13")).toEqual({ ok: true, message: "There was no waiver to remove." });
    expect(await audits("season.requirement.unwaive")).toHaveLength(1);

    // A per-family requirement is waived for the family; alone, the waiver's row goes when the waiver does.
    expect(await waiveAction(rsvp, "20", "Out of town")).toEqual({ ok: true, message: "Waived." });
    expect(await removeWaiverAction(rsvp, "20")).toEqual({ ok: true, message: "The waiver is removed." });
    expect((await recorded()).map((r) => r.subjectQboId)).toEqual(["13"]);
  });

  it("refuses a waiver with no reason, or for someone the requirement isn't asked of", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    expect(await waiveAction(fitting, "13", "   ")).toEqual({ ok: false, errors: ["Say why, in a few words. The reason is kept in the audit log."] });
    expect(await waiveAction(fitting, "13", "x".repeat(501))).toEqual({ ok: false, errors: ["The reason is too long (500 characters at most)."] });
    for (const who of ["10", "14", "32", "no-such"]) {
      expect(await waiveAction(fitting, who, "reason")).toEqual({ ok: false, errors: ["Someone in that list isn't covered by this requirement any more. Reload the page and try again."] });
    }
    expect(await recorded()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(revalidatedPaths()).toEqual([]);
  });

  it("shows who has done a requirement, by name, in words; finds by name; and keeps what is recorded for someone who has left", async () => {
    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Uniforms", requirements: [{ title: "Uniform fitting attended", appliesTo: "student", dueOn: "2026-09-01" }] }] });
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    await setTicksAction(fitting, ["12", "22"], true);
    await waiveAction(fitting, "13", "Wears <b>last</b> year's");
    const html = await renderPage(RequirementProgressPage, { params: { requirementId: fitting } });
    const text = textOf(html);
    expect(text).toContain("Uniform fitting attended In Uniforms, Fall 2026. Checklist item · Required · Each student · Due 2026-09-01 .");
    expect(text).toContain("2 of 3 done, 1 waived, 0 still to do.");
    expect(text).toMatch(/Leo Rivera Rivera Family Done Ticked .{1,30}? UTC by Tia Ticker/);
    expect(text).toMatch(/Maya Rivera Rivera Family Waived Waived .{1,30}? UTC by Tia Ticker: Wears &lt;b&gt;last&lt;\/b&gt; year's/);
    expect(html).toContain("Wears &lt;b&gt;last&lt;/b&gt; year&#x27;s");
    expect(html).toContain("Kai &lt;i&gt;Chen&lt;/i&gt;");
    expect(html).not.toMatch(/<i>Chen|<b>last|<b>Family/);
    // Inactive in QuickBooks: not asked, not listed.
    expect(text).not.toMatch(/Gone Rivera|Lee Left|No longer asked/);
    expect(text).toContain("Tick everyone shown (3)");
    expect(text).toContain("Untick everyone shown (3)");

    const found = textOf(await renderPage(RequirementProgressPage, { params: { requirementId: fitting }, searchParams: { q: "maya" } }));
    expect(found).toContain("Maya Rivera");
    expect(found).not.toContain("Leo Rivera");
    expect(found).toContain("Tick everyone shown (1)");
    expect(textOf(await renderPage(RequirementProgressPage, { params: { requirementId: fitting }, searchParams: { q: "zz" } }))).toContain('Nobody matches "zz".');

    // Kai leaves the roster: his tick is kept and shown apart, where it can still be taken away.
    await db.update(qboCustomer).set({ active: false, displayName: "Kai Chen (deleted)" }).where(eq(qboCustomer.qboId, "22"));
    const after = textOf(await renderPage(RequirementProgressPage, { params: { requirementId: fitting } }));
    expect(after).toContain("1 of 2 done, 1 waived, 0 still to do.");
    expect(after).toMatch(/No longer asked .* Kai Chen \(deleted\) Ticked/);
    expect(await setTicksAction(fitting, ["22"], true)).toMatchObject({ ok: false });
    expect(await setTicksAction(fitting, ["22"], false)).toEqual({ ok: true, message: "Unticked." });
    expect(textOf(await renderPage(RequirementProgressPage, { params: { requirementId: fitting } }))).not.toContain("No longer asked");

    expect(await pageOutcome(RequirementProgressPage, { params: { requirementId: NO_SUCH } })).toEqual({ notFound: true });
    expect(await pageOutcome(RequirementProgressPage, { params: { requirementId: "x" } })).toEqual({ notFound: true });
    // Reading a list across families is not one family's record opened in full: no read is audited here.
    expect((await audits()).map((r) => r.action).filter((a) => a.endsWith(".read"))).toEqual([]);
  });

  it("counts each requirement of a season, the current one unless another is asked for", async () => {
    const fall = await seedSeason({ name: "Fall 2026", steps: [
      { name: "Uniforms", requirements: [{ title: "Uniform fitting attended", appliesTo: "student", ticked: ["12"], waived: [{ qboId: "13", reason: "r" }] },
        { title: "Guard gloves", appliesTo: "student", required: false, chosen: ["13"] }] },
      { name: "Wrap-up", requirements: [{ title: "Banquet RSVP", appliesTo: "family", ticked: ["10", "20"] }] }, { name: "Empty" }] });
    const old = await seedSeason({ name: "Fall 2025", current: false, steps: [{ name: "Old step", requirements: [{ title: "Old item", appliesTo: "family" }] }] });
    const text = textOf(await renderPage(ProgressPage));
    expect(text).toContain("Fall 2026 The current season.");
    expect(text).toContain("1. Uniforms Uniform fitting attended Required · Each student 1 of 3 done, 1 waived Guard gloves Optional · Each student 0 of 1 done");
    expect(text).toContain("2. Wrap-up Banquet RSVP Required · Each family 2 of 2 done");
    expect(text).toContain("3. Empty Nothing is asked in this step.");
    expect(text).toContain("Other seasons Fall 2025");
    expect(text).not.toContain("Old item");
    const asked = textOf(await renderPage(ProgressPage, { searchParams: { season: old.seasonId } }));
    expect(asked).toContain("Fall 2025 Not the current season: parents don't see it.");
    expect(asked).toContain("Old item Required · Each family 0 of 2 done");
    // The season in the address is checked before it is looked up.
    expect(await pageOutcome(ProgressPage, { searchParams: { season: NO_SUCH } })).toEqual({ notFound: true });
    expect(await pageOutcome(ProgressPage, { searchParams: { season: `${fall.seasonId}' or '1'='1` } })).toEqual({ notFound: true });
  });

  it("is what the parent then sees: a tick moves the family on, and a waiver reads as waived", async () => {
    const parent = await seedSignedInParent();
    const fall = await seedSeason({ name: "Fall 2026", steps: [
      { name: "Uniforms", requirements: [{ title: "Uniform fitting attended", appliesTo: "student" }] }, { name: "Wrap-up", requirements: [{ title: "Banquet RSVP", appliesTo: "family" }] }] });
    const fitting = fall.requirementIds["Uniform fitting attended"]!;
    const [aurelio, azalea] = FAMILY_A.students;
    const mine = async () => (await loadMySeason({ familyQboId: FAMILY_A.family.qboId }, FAMILY_A.students))!;
    expect((await mine()).currentIndex).toBe(0);
    await setTicksAction(fitting, [aurelio!.qboId], true);
    await waiveAction(fitting, azalea!.qboId, "Borrowed one");
    const now = await mine();
    expect(now.steps[0]!.students.map((s) => s.lines[0]!.words)).toEqual(["Done", "Waived"]);
    expect(now.currentIndex).toBe(1);
    expect(parent.identity.familyQboId).toBe(FAMILY_A.family.qboId);
  });
});

describe("one family's season, for staff", () => {
  const seedFamilyFall = () => seedSeason({ name: "Fall 2026", steps: [
    { name: "Join", requirements: [{ title: "Handbook read", appliesTo: "family", ticked: ["10", "20"] }, { title: "Chen carpool pledge", appliesTo: "family", chosen: ["20"] }] },
    { name: "Uniforms", requirements: [
      { title: "Uniform fitting attended", appliesTo: "student", dueOn: "2026-09-01", ticked: ["12", "22"] },
      { title: "Guard gloves", appliesTo: "student", required: false, chosen: ["13"], waived: [{ qboId: "13", reason: "Brings <b>her</b> own" }] },
      { title: "Tuba strap", appliesTo: "student", chosen: ["22"], waived: [{ qboId: "22", reason: "Kai's own reason" }] }] },
    { name: "Wrap-up" },
  ] });

  it("shows where one family stands in every step, with the reason for a waiver, and audits the read", async () => {
    const fall = await seedFamilyFall();
    asStaff(reader);
    const html = await renderPage(FamilyProgressPage, { params: { familyId: "10" } });
    const text = textOf(html);
    expect(text).toContain("Rivera Family Where this family stands in Fall 2026, the current season.");
    expect(text).toContain("1. Join Done The family Handbook read Done");
    expect(text).toContain("2. Uniforms The step this family is on. 1 thing left to do Leo Rivera Uniform fitting attended Done");
    expect(text).toMatch(/Maya Rivera Uniform fitting attended Not done yet Due 2026-09-01 Guard gloves Optional Waived Waived .{1,30}? UTC : Brings &lt;b&gt;her&lt;\/b&gt; own/);
    expect(text).toContain("3. Wrap-up Nothing is asked of this family in this step.");
    expect(html).not.toContain("<b>her</b>");
    // Each requirement leads to the page where it is ticked off or waived; nothing is changed from here.
    expect(html).toContain(`href="/staff/seasons/progress/${fall.requirementIds["Uniform fitting attended"]}"`);
    expect(html).not.toMatch(/<button|<input|<textarea/);
    // One family's page: nothing of the Chens, not their name, a title asked only of them, or their waiver's reason.
    expect(html).not.toMatch(/Chen|Kai|Tuba strap/);
    // A student QuickBooks has made inactive is not shown.
    expect(text).not.toContain("Gone Rivera");

    expect(await audits()).toEqual([expect.objectContaining({ action: "season.progress.family.read", permission: "Season.Progress.Read", actorId: reader.id, actorLabel: "reader@club.org",
      targetType: "qbo_customer", targetId: "10", ip: "203.0.113.50", after: { season: "Fall 2026" } })]);
  });

  it("is reached from a requirement's list, and shows another season when the address asks for it", async () => {
    const fall = await seedFamilyFall();
    const old = await seedSeason({ name: "Fall 2025", current: false, steps: [{ name: "Old step", requirements: [{ title: "Old item", appliesTo: "family", ticked: ["10"] }] }] });
    asStaff(reader);
    const list = await renderPage(RequirementProgressPage, { params: { requirementId: fall.requirementIds["Uniform fitting attended"]! } });
    expect(list).toContain(`href="/staff/seasons/progress/family/10?season=${fall.seasonId}"`);
    expect(list).toContain(`href="/staff/seasons/progress/family/20?season=${fall.seasonId}"`);
    expect(textOf(list)).toContain("Everything asked of Rivera Family");
    expect(list).not.toContain("<b>Family</b>");
    const text = textOf(await renderPage(FamilyProgressPage, { params: { familyId: "10" }, searchParams: { season: old.seasonId } }));
    expect(text).toContain("Where this family stands in Fall 2025, which parents don't see.");
    expect(text).toContain("1. Old step Done The family Old item Done");
    expect(text).not.toContain("Handbook read");
  });

  it("is not found, and writes no audit row, for anything that isn't an active family or a season", async () => {
    const fall = await seedFamilyFall();
    asStaff(reader);
    // A student, a parent, a family QuickBooks has made inactive, nobody at all, and text that isn't an id.
    for (const familyId of ["12", "11", "30", "999", "10%27", "%E0%A4%A", "x".repeat(65)]) {
      expect(await pageOutcome(FamilyProgressPage, { params: { familyId } }), familyId).toEqual({ notFound: true });
    }
    for (const seasonId of [NO_SUCH, "x", `${fall.seasonId}' or '1'='1`]) {
      expect(await pageOutcome(FamilyProgressPage, { params: { familyId: "10" }, searchParams: { season: seasonId } }), seasonId).toEqual({ notFound: true });
    }
    // With no season at all there is nothing to show for anyone.
    await db.delete(requirementProgress); await db.delete(season);
    expect(await pageOutcome(FamilyProgressPage, { params: { familyId: "10" } })).toEqual({ notFound: true });
    expect(await audits()).toEqual([]);
  });
});

describe("a different QuickBooks company", () => {
  const SYSTEM = { actor: { door: "system" as const, id: null, label: "test" }, ip: null };

  it("takes every tick, waiver and chosen list with it: the same ids are other people there", async () => {
    const fall = await seedSeason({ name: "Fall 2026", steps: [{ name: "Uniforms", requirements: [
      { title: "Uniform fitting attended", appliesTo: "student", ticked: ["12", "22"], waived: [{ qboId: "13", reason: "Borrowed one" }] },
      { title: "Guard gloves", appliesTo: "student", chosen: ["13"], ticked: ["13"] }] }] });
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    // The same company keeps it all.
    expect(await clearRosterOfOtherCompany("1111", SYSTEM)).toBe(false);
    expect(await recorded()).toHaveLength(4);
    expect(await db.select().from(requirementCover)).toHaveLength(1);

    expect(await clearRosterOfOtherCompany("2222", SYSTEM)).toBe(true);
    expect(await recorded()).toEqual([]);
    expect(await db.select().from(requirementCover)).toEqual([]);
    // The season is the club's own and stays. The chosen list is empty, not "everyone": it asks nobody until staff choose again.
    expect((await seasons()).map((x) => x.name)).toEqual(["Fall 2026"]);
    expect((await db.select().from(requirement).orderBy(asc(requirement.position))).map((r) => [r.title, r.covers])).toEqual([["Uniform fitting attended", "everyone"], ["Guard gloves", "chosen"]]);
    expect(await audits("season.records.cleared")).toEqual([expect.objectContaining({ door: "system", targetType: "season", before: { realmId: "1111" },
      after: { reason: "different_company", realmId: "2222", ticks: 3, waivers: 1, chosenListEntries: 1, requirementsLeftWithNobodyChosen: 1 } })]);

    // The new company's customer 13 is somebody else: nothing is ticked for them, and the gloves aren't asked of them.
    await seedShape(); await addToCache(ROSTER);
    asStaff(reader);
    const text = textOf(await renderPage(RequirementProgressPage, { params: { requirementId: fall.requirementIds["Uniform fitting attended"]! } }));
    expect(text).toContain("0 of 3 done, 3 still to do.");
    expect(textOf(await renderPage(RequirementProgressPage, { params: { requirementId: fall.requirementIds["Guard gloves"]! } }))).toContain("It is asked of no students on the roster right now.");
  });

  it("writes no season row when the seasons record nothing against anyone", async () => {
    await seedFall();
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    expect(await clearRosterOfOtherCompany("2222", SYSTEM)).toBe(true);
    expect(await audits("season.records.cleared")).toEqual([]);
  });
});

describe("values no page sends", () => {
  it("are refused before anything is looked up or written", async () => {
    const fall = await seedFall();
    const fitting = fall.requirementIds["Uniform fitting attended"]!, uniforms = fall.stepIds.Uniforms!;
    const any = (v: unknown) => v as never;
    const long = "x".repeat(2001);
    const setup = [
      createSeasonAction(any(7), "empty"), createSeasonAction("Fall", any("copy")), createSeasonAction(long, "empty"),
      renameSeasonAction("not-a-uuid", "X"), renameSeasonAction(fall.seasonId, any(null)), setCurrentSeasonAction(any({ id: fall.seasonId })),
      addStepAction(any(undefined), "X"), addStepAction(fall.seasonId, any(["X"])),
      updateStepAction(uniforms, "X", any(20260801), null), updateStepAction(uniforms, "X", null, "2026-08-01T00:00:00Z"), updateStepAction("1; drop table season", "X", null, null),
      moveStepAction(uniforms, any("up")), removeStepAction(any(null)),
      addRequirementAction(uniforms, "raffle", "student", FIELDS), addRequirementAction(uniforms, "checklist", any("everyone"), FIELDS),
      addRequirementAction(uniforms, "checklist", "student", any(null)), addRequirementAction(uniforms, "checklist", "student", any({ ...FIELDS, required: "yes" })),
      addRequirementAction(uniforms, "checklist", "student", any({ ...FIELDS, amount: "2" })), addRequirementAction(uniforms, "checklist", "student", any({ ...FIELDS, amountUnit: "days" })),
      updateRequirementAction(fitting, any({ ...FIELDS, title: long })), updateRequirementAction(any(12), FIELDS),
      setCoverageAction(fitting, any("some"), ["12"]), setCoverageAction(fitting, "chosen", any("12")), setCoverageAction(fitting, "chosen", any([12])),
      setCoverageAction(fitting, "chosen", [""]), setCoverageAction(fitting, "chosen", ["x".repeat(65)]), removeRequirementAction("x"),
    ];
    for (const r of await Promise.all(setup)) expect(r).toEqual(BROWSER);
    asStaff(ticker);
    const progress = [
      setTicksAction("x", ["12"], true), setTicksAction(fitting, any("12"), true), setTicksAction(fitting, ["12"], any("true")), setTicksAction(fitting, any([{ qboId: "12" }]), true),
      setTicksAction(fitting, Array.from({ length: 5001 }, (_v, i) => String(i)), true),
      waiveAction(fitting, any(12), "reason"), waiveAction(fitting, "12", any(null)), waiveAction(fitting, "12", long), waiveAction(any(undefined), "12", "reason"),
      removeWaiverAction(fitting, any(["12"])), removeWaiverAction("x", "12"),
    ];
    for (const r of await Promise.all(progress)) expect(r).toEqual(BROWSER);
    // An object from the browser can carry more than the fields a page sends: only those fields go on.
    asStaff(setter);
    expect(await updateRequirementAction(fitting, any({ ...FIELDS, title: "Fitted", kind: "payment", appliesTo: "family", covers: "chosen", stepId: fall.stepIds["Wrap-up"] }))).toEqual({ ok: true, message: "Saved." });
    expect((await db.select().from(requirement).where(eq(requirement.id, fitting)))[0]).toMatchObject({ title: "Fitted", kind: "checklist", appliesTo: "student", covers: "everyone", stepId: uniforms });
    expect(await recorded()).toEqual([]);
    expect((await audits()).map((r) => r.action)).toEqual(["season.requirement.update"]);
  });
});
