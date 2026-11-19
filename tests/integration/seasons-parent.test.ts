import { describe, it, expect, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, qboCustomer, requirement, requirementProgress, season, setting } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import type { ParentCtx } from "@/lib/guards";
import type { MembershipShape } from "@/lib/roster/shape";
import { loadMySeason } from "@/lib/seasons/my-season";
import { calendarDayIn } from "@/lib/settings/club";
import ParentHome from "@/app/(parent)/page";
import SeasonPage from "@/app/(parent)/season/page";
import { resetDb } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedParentIn, seedSignedInParent, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { addToCache, moveInCache, seedCache, seedShape, stu } from "../helpers/roster-cache";
import { TWO_FAMILY_SEASON, seedSeason } from "../helpers/season";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * The season as a parent sees it: the query that reads one family's standing, the ruler and requirement lines on Home,
 * and the Season page. The cross-family gate (parent-isolation.test.ts) renders both pages for both families; this
 * file checks what each family is told, and the ways another family's progress could slip in.
 */
const ctxOf = (identity: ParentIdentity): ParentCtx => ({ ...identity, ip: null });
const mySeason = async (who: SeededParent) => loadMySeason(ctxOf(who.identity));
const day = (offset: number) => calendarDayIn("UTC", new Date(Date.now() + offset * 86_400_000));
/** The text of a page, tags dropped, as a parent reads it. */
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'");
const [AURELIO, AZALEA] = FAMILY_A.students, [BARNABY, BRISEIS] = FAMILY_B.students;

beforeEach(resetDb);

describe("loadMySeason: the current season for the session's family alone", () => {
  it("gives each family its own standing: the steps, what each asks of it, and the step it is on", async () => {
    const { a, b } = await seedTwoFamilies();
    const forA = (await mySeason(a))!, forB = (await mySeason(b))!;
    expect(forA.name).toBe(TWO_FAMILY_SEASON);
    expect(forA.steps.map((s) => [s.name, s.done])).toEqual([["Sign-up", false], ["Uniforms", false], ["Wrap-up", true]]);
    expect(forA.currentIndex).toBe(0);
    // The optional forms seedTwoFamilies() adds (tests/helpers/forms.ts) are on the lines too, each in its own words.
    expect(forA.steps[0]!.family.map((l) => [l.title, l.words])).toEqual([["Handbook read", "Done"], ["Carpool pledge QA71", "Not done yet"], ["Travel consent", "Not signed yet"], ["Bus waiver QA74", "Not ready yet"]]);
    expect(forA.steps[1]!.students.map((s) => [s.name, s.done, s.lines.map((l) => [l.title, l.words])])).toEqual([
      [AURELIO!.name, true, [["Uniform fitting attended", "Done"], ["Uniform agreement", "Signed, being finished"], ["Photo release", "Declined"]]],
      [AZALEA!.name, false, [["Uniform fitting attended", "Not done yet"], ["Piccolo loan agreement QA72", "Waived"], ["Uniform agreement", "Signed"], ["Photo release", "Waiting for the other guardian"]]],
    ]);

    expect(forB.steps.map((s) => [s.name, s.done])).toEqual([["Sign-up", true], ["Uniforms", false], ["Wrap-up", true]]);
    expect(forB.currentIndex).toBe(1);
    expect(forB.steps[0]!.family.map((l) => [l.title, l.words])).toEqual([["Handbook read", "Done"], ["Trailer key returned QB82", "Waived"], ["Travel consent", "Not signed yet"], ["Field trip waiver QB85", "Not ready yet"]]);
    expect(forB.steps[1]!.students.map((s) => [s.name, s.done, s.lines.map((l) => [l.title, l.words])])).toEqual([
      [BARNABY!.name, false, [["Uniform fitting attended", "Not done yet"], ["Sousaphone harness check QB83", "Done"], ["Uniform agreement", "Signed, being finished"], ["Photo release", "Declined"]]],
      [BRISEIS!.name, true, [["Uniform fitting attended", "Done"], ["Uniform agreement", "Signed"], ["Photo release", "Waiting for the other guardian"]]],
    ]);
  });

  it("returns nothing of the other family: not a title asked only of it, not an id, not a waiver's reason", async () => {
    const { a, b } = await seedTwoFamilies();
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      const got = JSON.stringify(await mySeason(mine));
      for (const marker of theirs.markers) expect(got, `${mine.spec.family.name}'s season`).not.toContain(marker);
      // The reason for the family's own waiver is for staff: the query doesn't return it either.
      for (const reason of mine.season!.staffOnly) expect(got).not.toContain(reason);
    }
  });

  it("reads the session's family's own students alone: a student who moved to another family goes with them", async () => {
    const { a, b } = await seedTwoFamilies();
    // Azalea moves to family B, as a roster read that finds it leaves her: her record follows her.
    await moveInCache([AZALEA!.qboId], FAMILY_B.family.qboId);
    const forA = (await mySeason(a))!, forB = (await mySeason(b))!;
    expect(forA.steps[1]!.students.map((s) => s.name)).toEqual([AURELIO!.name]);
    expect(forB.steps[1]!.students.map((s) => s.name)).toEqual([AZALEA!.name, BARNABY!.name, BRISEIS!.name]);
    const azalea = String(await recordOfCustomer(AZALEA!.qboId, "student"));
    expect(JSON.stringify(forA)).not.toContain(azalea);
    for (const marker of b.markers) expect(JSON.stringify(forA)).not.toContain(marker);
  });

  it("needs no link: a family whose link is removed by hand still sees its season", async () => {
    const { a } = await seedTwoFamilies();
    const before = (await mySeason(a))!;
    await db.delete(accountingLink).where(eq(accountingLink.familyId, a.identity.familyId));
    const after = (await mySeason(a))!;
    expect(after.steps.map((s) => [s.name, s.done])).toEqual(before.steps.map((s) => [s.name, s.done]));
    expect(after.steps[1]!.students.map((s) => s.name)).toEqual([AURELIO!.name, AZALEA!.name]);
    expect(after.steps[0]!.family.map((l) => l.title)).toEqual(before.steps[0]!.family.map((l) => l.title));
  });

  it("shows nothing while the session's family record is inactive, whatever the roster cache says", async () => {
    const { a } = await seedTwoFamilies();
    const { family } = await import("@/lib/db/schema");
    await db.update(family).set({ active: false }).where(eq(family.id, await recordOfCustomer(FAMILY_A.family.qboId, "family")));
    expect(await mySeason(a)).toBeNull();
  });

  it("is null when no season is current, and takes the one that is", async () => {
    const a = await seedSignedInParent();
    expect(await mySeason(a)).toBeNull();
    await seedSeason({ name: "Last year", current: false, steps: [{ name: "Old step" }] });
    expect(await mySeason(a)).toBeNull();
    await seedSeason({ name: "This year", steps: [{ name: "New step" }] });
    expect((await mySeason(a))!.name).toBe("This year");
  });

  it("tracks a student added mid-season from then on, and drops one who has left while keeping what was recorded", async () => {
    const a = await seedSignedInParent();
    const fitting = "Uniform fitting attended";
    const seeded = await seedSeason({ name: "Fall", steps: [{ name: "Uniforms", requirements: [{ title: fitting, appliesTo: "student", ticked: [AURELIO!.qboId, AZALEA!.qboId] }] }] });
    expect((await mySeason(a))!.steps[0]!.done).toBe(true);
    expect((await mySeason(a))!.currentIndex).toBeNull();

    await addToCache([stu("QBO-ALDERQUIST-STUDENT-7009", "Anselm Alderquist", FAMILY_A.family.qboId)]);
    const grown = (await mySeason(a))!;
    expect(grown.steps[0]!.students.map((s) => [s.name, s.done])).toEqual([["Anselm Alderquist", false], [AURELIO!.name, true], [AZALEA!.name, true]]);
    expect(grown.currentIndex).toBe(0);

    // Azalea leaves: QuickBooks marks her inactive. She is no longer shown; her tick is still in the table.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, AZALEA!.qboId));
    await syncAppRecords();
    expect((await mySeason(a))!.steps[0]!.students.map((s) => s.name)).toEqual(["Anselm Alderquist", AURELIO!.name]);
    const kept = await db.select().from(requirementProgress).where(eq(requirementProgress.requirementId, seeded.requirementIds[fitting]!));
    expect(kept.map((r) => String(r.studentId)).sort()).toEqual([String(await recordOfCustomer(AURELIO!.qboId, "student")), String(await recordOfCustomer(AZALEA!.qboId, "student"))].sort());
  });

  it("follows the club's dates, on the club's own day, when a step has any", async () => {
    const a = await seedSignedInParent();
    await seedSeason({ name: "Dated", steps: [
      { name: "Join", endsOn: day(-3), requirements: [{ title: "Membership form", appliesTo: "family" }] },
      { name: "Forms", startsOn: day(-2), endsOn: day(5), requirements: [{ title: "Medical form", appliesTo: "student", dueOn: day(4) }] },
      { name: "Season", startsOn: day(6) },
    ] });
    const got = (await mySeason(a))!;
    expect(got.today).toBe(day(0));
    // By date the club is on Forms, though this family never finished Join: that is counted as left behind.
    expect(got.currentIndex).toBe(1);
    expect(got.steps.map((s) => s.done)).toEqual([false, false, true]);
    expect(got.leftBefore).toBe(1);

    // "Today" is the club's: far enough east it is already tomorrow, and there the last day of a step has passed.
    await db.delete(season);
    const now = new Date();
    const eastern = calendarDayIn("Pacific/Kiritimati", now), western = calendarDayIn("Pacific/Pago_Pago", now);
    expect(eastern > western).toBe(true); // UTC+14 and UTC-11 never share a calendar day
    await seedSeason({ name: "Zones", steps: [{ name: "Early", endsOn: western }, { name: "Late" }] });
    await db.insert(setting).values({ key: "club", value: { timeZone: "Pacific/Pago_Pago" } });
    expect((await mySeason(a))!.currentIndex).toBe(0);
    await db.update(setting).set({ value: { timeZone: "Pacific/Kiritimati" } }).where(eq(setting.key, "club"));
    expect((await mySeason(a))!.currentIndex).toBe(1);
    expect((await mySeason(a))!.today).toBe(eastern);
  });
});

describe("Home: the season ruler and the current step's requirements", () => {
  it("draws the ruler for the family's own step, with a dot for each student, and the way to the Season page", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(b.identity);
    const html = await renderPage(ParentHome);
    // The steps in order, the first done, the second current.
    expect(html).toContain(`<p id="season-h" class="season-title">${TWO_FAMILY_SEASON} · <b>Set 2 of 3<span class="current-name">: Uniforms</span></b></p>`);
    expect(html).toContain(`<ol class="sets" style="--count:3">`);
    expect(html).toMatch(/<li class="done"><span class="n"><svg[^>]*>.*?<\/svg>1<\/span><span class="label">Sign-up<\/span><span class="visually-hidden">, done<\/span><\/li>/);
    expect(html).toMatch(/<li aria-current="step"><span class="n">2<\/span><span class="label">Uniforms<\/span><span class="visually-hidden">, current set<\/span>/);
    // Barnaby still has the fitting to do; Briseis has finished the step. The dots are decoration, hidden from a screen reader.
    expect(html).toContain(`<span class="on-set" aria-hidden="true"><i title="Barnaby has more to do">B</i><i class="done" title="Briseis is done">B</i></span>`);
    expect(html).toContain(`<a href="/season">See the whole season</a>`);
    expect(html.indexOf(`class="season"`)).toBeLessThan(html.indexOf("<main"));

    // The same facts in words, under each student.
    const text = textOf(html);
    expect(text).toContain(`${BARNABY!.name} 1 of 2 done 1 thing left to do in Uniforms Uniform fitting attended Not done yet Sousaphone harness check QB83 Done`);
    expect(text).toContain(`${BRISEIS!.name} 1 of 1 done Done with Uniforms Uniform fitting attended Done`);
    // Nothing of step one, which is behind them, and nothing asked only of family A.
    expect(text).not.toContain("Trailer key");
    for (const marker of a.season!.markers) expect(html).not.toContain(marker);
  });

  it("shows what the step asks of the family itself after the students, and says a waiver in words without its reason", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(a.identity);
    const html = await renderPage(ParentHome), text = textOf(html);
    expect(text).toContain("Set 1 of 3 : Sign-up");
    // Wrap-up asks nothing, so it is done already; but it is still ahead, and the ruler draws it as a set to come.
    expect(html).not.toContain(`<li class="done">`);
    expect(html).toContain(`<li><span class="n">3</span><span class="label">Wrap-up</span><span class="visually-hidden"></span></li>`);
    expect(text).toContain(`${AURELIO!.name} Nothing to do in Sign-up`);
    expect(text).toContain("Your family 1 thing left to do in Sign-up Handbook read Done Carpool pledge QA71 Not done yet");

    // On the Season page the waiver reads "Waived"; the reason is nowhere.
    const page = textOf(await renderPage(SeasonPage));
    expect(page).toContain(`${AZALEA!.name} Uniform fitting attended Not done yet Piccolo loan agreement QA72 Waived`);
    expect(page).not.toContain(a.season!.staffOnly[0]);
    for (const marker of b.season!.markers) expect(page).not.toContain(marker);
  });

  it("has no ruler, and nothing in its place, when no season is current", async () => {
    const a = await seedSignedInParent();
    await seedSeason({ name: "Not current yet", current: false, steps: [{ name: "Hidden step", requirements: [{ title: "Hidden item", appliesTo: "student" }] }] });
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).not.toContain(`class="season"`);
    expect(html).not.toContain("sets");
    expect(html).not.toMatch(/Not current yet|Hidden step|Hidden item|Set \d|\/season/);
    // The students are listed as before, with nothing under them.
    expect(html).toContain(`<li><span class="who"><b>${AURELIO!.name}</b></span></li>`);
    expect(textOf(await renderPage(SeasonPage))).toContain("The club hasn't set up a season here yet.");
  });

  it("ticks every step and thanks the family once nothing is left; a season that asks nothing of it is not called done", async () => {
    const a = await seedSignedInParent();
    await seedSeason({ name: "Fall", steps: [
      { name: "Join", requirements: [{ title: "Handbook read", appliesTo: "family", ticked: [FAMILY_A.family.qboId] }] },
      { name: "Wrap-up", requirements: [{ title: "Booster shirt ordered", appliesTo: "student", required: false }] },
    ] });
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("<b>All 2 sets done</b>");
    expect(html).not.toContain("aria-current=\"step\"");
    expect(html.match(/<li class="done">/g)).toHaveLength(2);
    expect(textOf(html)).toContain("You've finished every set of Fall. Thank you!");

    await db.delete(requirementProgress); await db.delete(season);
    // Staff have made the season current and not yet said what it asks: nothing is done, because nothing was to do.
    const bareSeason = await seedSeason({ name: "Bare", steps: [{ name: "Join" }, { name: "Wrap-up" }] });
    const bare = await renderPage(ParentHome);
    expect(bare).toContain("Bare · <b>Nothing to do yet</b>");
    expect(bare).not.toMatch(/sets? (is )?done/);
    expect(bare).not.toContain(`<li class="done">`);
    expect(bare).not.toContain("aria-current=\"step\"");
    expect(textOf(bare)).not.toContain("Thank you");
    expect(textOf(bare)).toContain("1 Join 2 Wrap-up"); // the sets are still drawn, with nothing said of them
    // The same for a family that every requirement's chosen list leaves out.
    await db.insert(requirement).values({ stepId: bareSeason.stepIds.Join!, kind: "checklist", title: "Asked of another family", appliesTo: "family", covers: "chosen", position: 0 });
    expect(await renderPage(ParentHome)).toContain("Bare · <b>Nothing to do yet</b>");
    // Once something is asked of it, the ruler is on that set.
    await db.insert(requirement).values({ stepId: bareSeason.stepIds.Join!, kind: "checklist", title: "Handbook read", appliesTo: "family", covers: "everyone", position: 1 });
    const asked = await renderPage(ParentHome);
    expect(asked).toContain("<b>Set 1 of 2<span class=\"current-name\">: Join</span></b>");
    expect(asked).not.toContain("Nothing to do yet");
  });

  it("says a due date in words on the club's day, and only while something is left", async () => {
    const a = await seedSignedInParent();
    await seedSeason({ name: "Fall", steps: [{ name: "Forms", requirements: [
      { title: "Soon item", appliesTo: "student", dueOn: day(8) },
      { title: "Late item", appliesTo: "student", dueOn: day(-16) },
      { title: "Far item", appliesTo: "family", dueOn: day(40) },
      { title: "Done item", appliesTo: "family", dueOn: day(-2), ticked: [FAMILY_A.family.qboId] },
    ] }] });
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<span class="when soon">Due <time dateTime="${day(8)}">${day(8)}</time>, in 8 days</span>`);
    expect(html).toContain(`<span class="when late">Was due <time dateTime="${day(-16)}">${day(-16)}</time></span>`);
    expect(html).toContain(`<span class="when">Due <time dateTime="${day(40)}">${day(40)}</time></span>`);
    expect(html).not.toContain(day(-2));
    // The state is words with an icon beside them, never a color alone.
    expect(html).toMatch(/<span class="state todo"><svg[^>]*aria-hidden="true">.*?<\/svg>Not done yet<\/span>/);
    expect(html).toMatch(/<span class="state done"><svg[^>]*aria-hidden="true">.*?<\/svg>Done<\/span>/);
  });

  it("tells a family what is left from an earlier step when the club has moved on by date", async () => {
    const a = await seedSignedInParent();
    await seedSeason({ name: "Dated", steps: [
      { name: "Join", endsOn: day(-3), requirements: [{ title: "Membership form", appliesTo: "family" }] },
      { name: "Forms", startsOn: day(-2), requirements: [{ title: "Medical form", appliesTo: "student", ticked: [AURELIO!.qboId, AZALEA!.qboId] }] },
    ] });
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toMatch(/<li><span class="n">1<\/span><span class="label">Join<\/span><span class="visually-hidden">, not finished<\/span><\/li>/);
    expect(textOf(html)).toContain("1 thing from an earlier set is still to do. See the whole season");
    expect(textOf(html)).not.toContain("Membership form"); // it is on the Season page, with the step it belongs to
    expect(textOf(await renderPage(SeasonPage))).toContain("1. Join Ends " + day(-3) + " 1 thing left to do Your family Membership form Not done yet");
  });

  it("writes a club's and QuickBooks' text as text: a step, a title or a name can't become markup", async () => {
    await seedShape();
    await seedCache([{ qboId: "XF", displayName: "Xss Family", typeQboId: "F" }, stu("XS", "<img src=x onerror=alert(1)> Xss", "XF")]);
    const p = await seedParentIn({ familyQboId: "XF", name: "Xavier Xss", email: "xavier@xss.example" });
    await seedSeason({ name: "<b>Season</b>", steps: [{ name: "<script>alert(1)</script>", requirements: [{ title: "<i>Item</i>", appliesTo: "student" }] }] });
    asParent(p.identity);
    for (const page of [ParentHome, SeasonPage]) {
      const html = await renderPage(page);
      expect(html).not.toMatch(/<img src=x|<script>alert|<i>Item|<b>Season/);
      expect(html).toContain("&lt;i&gt;Item&lt;/i&gt;");
    }
  });
});

describe("the Season page", () => {
  it("lists every step in order with what it asks of the family and each student, and marks the current one", async () => {
    const { b } = await seedTwoFamilies();
    asParent(b.identity);
    const text = textOf(await renderPage(SeasonPage));
    expect(text).toContain(`${TWO_FAMILY_SEASON} Every set of the season for ${FAMILY_B.family.name}, and what's done so far.`);
    expect(text).toContain("1. Sign-up Done Your family Handbook read Done Trailer key returned QB82 Waived Travel consent (optional) Not signed yet Field trip waiver QB85 (optional) Not ready yet");
    expect(text).toContain(`2. Uniforms The current set 1 thing left to do ${BARNABY!.name} Uniform fitting attended Not done yet Sousaphone harness check QB83 Done `
      + `Uniform agreement (optional) Signed, being finished Photo release (optional) Declined ${BRISEIS!.name} Uniform fitting attended Done Uniform agreement (optional) Signed Photo release (optional) Waiting for the other guardian`);
    // The trip deposit is optional, so the set is done while it is still to pay (tests/helpers/season.ts).
    expect(text).toContain("3. Wrap-up Done Your family Trip deposit (optional) Not paid yet ($8,242.08 left to pay)");
  });

  it("shows a family the roster can't show nothing of the season", async () => {
    const { a } = await seedTwoFamilies();
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, FAMILY_A.family.qboId));
    await syncAppRecords();
    asParent(a.identity);
    for (const page of [ParentHome, SeasonPage]) {
      const html = await renderPage(page);
      expect(html).toContain("set up here yet");
      expect(html).not.toMatch(/Autumn Field Season|Sign-up|Carpool|class="season"/);
    }
  });

  it("is not audited: a parent looking at their own family's season leaves no row", async () => {
    const { a } = await seedTwoFamilies();
    asParent(a.identity);
    await renderPage(ParentHome); await renderPage(SeasonPage);
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});

describe("a club that lists no students", () => {
  const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["M"] };
  const seedMember = async () => {
    await seedShape(FLAT);
    await seedCache([{ qboId: "MEM-1", displayName: "Marisol Member", typeQboId: "M", email: "marisol@member.example" }, { qboId: "MEM-2", displayName: "Other Member", typeQboId: "M" }]);
    return seedParentIn({ familyQboId: "MEM-1", name: "Marisol Member", email: "marisol@member.example", sourceQboId: "MEM-1" });
  };

  it("shows what the step asks of the member in the students box's place, and never another member's", async () => {
    const p = await seedMember();
    await seedSeason({ name: "Members' year", steps: [{ name: "Join", requirements: [
      { title: "Dues form", appliesTo: "family" },
      { title: "Only the other member", appliesTo: "family", chosen: ["MEM-2"], waived: [{ qboId: "MEM-2", reason: "Other member's reason" }] },
      { title: "A per-student item", appliesTo: "student" },
    ] }] });
    asParent(p.identity);
    const html = await renderPage(ParentHome);
    const text = textOf(html);
    expect(text).toContain("Set 1 of 1 : Join");
    expect(text).toContain("Members' year Join Your family 1 thing left to do in Join Dues form Not done yet");
    expect(html).not.toContain("on-set"); // nobody is a student, so the ruler has no dots
    expect(html).not.toMatch(/Only the other member|Other member|A per-student item|Your students/);
    expect(textOf(await renderPage(SeasonPage))).toContain("1. Join The current set 1 thing left to do Your family Dues form Not done yet");
  });

  it("draws no box when the step asks nothing of the member", async () => {
    const p = await seedMember();
    await seedSeason({ name: "Members' year", steps: [{ name: "Join", requirements: [{ title: "A per-student item", appliesTo: "student" }] }] });
    asParent(p.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("Nothing to do yet");
    expect(html).not.toContain("The one set is done");
    expect(html).not.toContain("students-box");
  });
});
