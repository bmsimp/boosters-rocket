import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asStaff, renderPage } from "../helpers/signed-in";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, familyMoney, qboItem, requirement, role, roleAssignment, roleRule, season } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { runMoneyJob } from "@/lib/money/sweep";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { currentRosterTag, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { loadMySeason } from "@/lib/seasons/my-season";
import { loadFacts, toRequirement } from "@/lib/seasons/recorded";
import { loadFamilyProgress, loadRequirementProgress } from "@/lib/seasons/staff-progress";
import HomePage from "@/app/(parent)/page";
import RequirementProgressPage from "@/app/staff/(app)/seasons/progress/[requirementId]/page";
import SeasonPage from "@/app/(parent)/season/page";
import RequirementPage from "@/app/staff/(app)/seasons/[id]/requirements/[requirementId]/page";
import StaffSeasonPage from "@/app/staff/(app)/seasons/[id]/page";
import { addRequirementAction, createSeasonAction, setTicksAction } from "@/app/staff/(app)/seasons/actions";
import { chooseItemAction, readItemsAction } from "@/app/staff/(app)/seasons/payment-actions";
import { resetDb, seedStaff } from "../helpers/db";
import { ageMoney, connectCompany, invoiceQueries, RIVERA, stubInvoice as inv } from "../helpers/money";
import { MONEY_REALM, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, fam, moveInCache, stu } from "../helpers/roster-cache";
import { seedSeason } from "../helpers/season";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * The payment kind of requirement (v1 spec §10.2) end to end: what a parent reads, judged from the figures QuickBooks
 * last gave the family; how staff choose the product or service from the list read from QuickBooks; and what a change
 * of company clears.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const [RAFFERTY, ROMILLY] = RIVERA.students as [{ qboId: string; name: string }, { qboId: string; name: string }];
const FAMILY = RIVERA.family.qboId;
const BAND_FEE = "41", UNIFORM = "42", TRIP = "43";
const BROWSER = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const line = (qboId: string, Line: unknown[], extra: Record<string, unknown> = {}) => ({ ...inv(qboId, FAMILY), Line, ...extra });
const sale = (item: string, Amount = 85) => ({ DetailType: "SalesItemLineDetail", Amount, SalesItemLineDetail: { ItemRef: { value: item } } });

type StaffRow = Awaited<ReturnType<typeof seedStaff>>;
const withRole = async (email: string, patterns: string[]): Promise<StaffRow> => {
  const s = await seedStaff({ email, name: email });
  const [r] = await db.insert(role).values({ key: email, name: email }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};

let rivera: SeededParent;
/** The Riverquill family signed in, QuickBooks connected to its company, and a season with three payment requirements. */
async function seeded() {
  rivera = await seedSignedInParent(RIVERA);
  await connectCompany(stub);
  stub.customers = [RIVERA.family, RIVERA.parent, ...RIVERA.students].map((c) => ({ Id: c.qboId, DisplayName: c.name, Balance: 0, BalanceWithJobs: 0 }));
  return seedSeason({ name: "Fall 2026", steps: [{ name: "Fees", requirements: [
    { title: "Band fee", appliesTo: "family", kind: "payment", item: BAND_FEE },
    { title: "Uniform fee", appliesTo: "student", kind: "payment", item: UNIFORM },
    { title: "Trip deposit", appliesTo: "family", kind: "payment" }, // no product or service chosen yet
  ] }] });
}
/** The family's invoices in QuickBooks: the band fee paid; Rafferty's uniform part paid; Romilly has none. */
function invoices() {
  stub.invoices = [
    line("1", [sale(BAND_FEE), { DetailType: "SubTotalLineDetail", Amount: 85, SubTotalLineDetail: {} }], { Balance: 0 }),
    { ...line("2", [sale(UNIFORM, 100)], { TotalAmt: 100, Balance: 40.5 }), CustomerRef: { value: RAFFERTY.qboId } },
  ];
}
const seasonText = async () => { asParent(rivera.identity); return textOf(await renderPage(SeasonPage)); };

beforeEach(async () => { await resetDb(); stub.reset(); });

describe("what a parent reads for a payment requirement", () => {
  it("Paid, Not paid yet with what is left to pay, or No invoice yet, from the figures QuickBooks gave the family", async () => {
    await seeded();
    invoices();
    await runMoneyJob({ paceMs: 0 });
    const text = await seasonText();
    expect(text).toContain("Your family Band fee Paid Trip deposit No invoice yet");
    expect(text).toContain(`${RAFFERTY.name} Uniform fee Not paid yet ($40.50 left to pay)`);
    // The uniform is on Rafferty's invoice: Romilly, his sister, has none of her own.
    expect(text).toContain(`${ROMILLY.name} Uniform fee No invoice yet`);
  });

  it("a page load reads again figures stored before the portal read which items invoices carry, rather than guessing", async () => {
    await seeded();
    invoices();
    // A row as the portal stored it before this slice: fresh, but its invoices don't say what they carry.
    await db.insert(familyMoney).values({ familyQboId: FAMILY, realmId: MONEY_REALM, readAt: new Date(), totalCents: 0, currency: "USD",
      invoices: [{ qboId: "1", number: "INV-1", customerQboId: FAMILY, forName: null, date: "2026-11-01", dueDate: null, totalCents: 8500, balanceCents: 0, currency: "USD", payLink: null }] });
    expect(textOf(await seasonText())).toContain("Band fee No invoice yet");
    const { MoneyBox } = await import("@/app/(parent)/money-box");
    await renderPage(() => MoneyBox({ ctx: rivera.identity }));
    expect(invoiceQueries(stub)).toHaveLength(1); // the row was read again, not shown as it was
    expect(await seasonText()).toContain("Band fee Paid");
  });

  it("counts no invoice of a student QuickBooks has made inactive: it is never read as the family's", async () => {
    await seeded();
    await addToCache([stu("7014", "Rowan Riverquill", FAMILY, { active: false })]);
    stub.invoices = [{ ...line("5", [sale(BAND_FEE)], { Balance: 0 }), CustomerRef: { value: "7014" } }];
    await runMoneyJob({ paceMs: 0 });
    expect(invoiceQueries(stub).join(" ")).not.toContain("7014");
    expect(await seasonText()).toContain("Band fee No invoice yet");
  });

  it("is the same for staff: the progress page reads it through the same rule, and it can't be ticked by hand", async () => {
    const fall = await seeded();
    invoices();
    await runMoneyJob({ paceMs: 0 });
    const uniform = (await loadRequirementProgress(fall.requirementIds["Uniform fee"]!, "all"))!;
    expect(uniform.ticked).toBe(false);
    expect(uniform.rows!.map((r) => [r.name, r.words])).toEqual([[RAFFERTY.name, "Not paid yet ($40.50 left to pay)"], [ROMILLY.name, "No invoice yet"]]);
    expect(uniform.counts).toEqual({ asked: 2, done: 0, waived: 0, todo: 2 });
    const staff = await withRole("ticker@club.org", ["Season.*"]);
    asStaff(staff);
    // The page names the family by its own record (stage 2 of the app-owned families spec).
    expect(await setTicksAction(fall.requirementIds["Band fee"]!, await currentRosterTag(), [String(await recordOfCustomer(FAMILY, "family"))], true))
      .toEqual({ ok: false, errors: ["This kind of requirement isn't ticked off by hand."] });
    // The parent's own query agrees with the staff page.
    const mine = await loadMySeason(rivera.identity, (await loadMyFamily({ ...rivera.identity, ip: null }))!.students);
    expect(mine!.steps[0]!.family.map((l) => [l.title, l.state])).toEqual([["Band fee", "done"], ["Trip deposit", "todo"]]);
  });
});

describe("a payment requirement asked by the app's own records", () => {
  const byName = (rows: { name: string; words: string }[]) => rows.map((r) => [r.name, r.words]).sort((a, b) => a[0]!.localeCompare(b[0]!));

  it("follows a student who moved to another family: their invoice counts there, and no longer for the family they left", async () => {
    const fall = await seeded();
    invoices();
    await addToCache([fam("7020", "Rookwood Family")]);
    stub.customers.push({ Id: "7020", DisplayName: "Rookwood Family", Balance: 0, BalanceWithJobs: 0 });
    await moveInCache([RAFFERTY.qboId], "7020");
    await runMoneyJob({ paceMs: 0 });
    // Rafferty's own invoice is now in the Rookwood family's figures, and still his: the customer his own record is linked to.
    const uniform = (await loadRequirementProgress(fall.requirementIds["Uniform fee"]!, "all"))!;
    expect(byName(uniform.rows!)).toEqual([[RAFFERTY.name, "Not paid yet ($40.50 left to pay)"], [ROMILLY.name, "No invoice yet"]]);
    // The family he left keeps its own band fee and no longer lists him.
    const text = await seasonText();
    expect(text).toContain("Your family Band fee Paid");
    expect(text).toContain(`${ROMILLY.name} Uniform fee No invoice yet`);
    expect(text).not.toContain(RAFFERTY.name);
    // The family he joined has no invoice of its own for the band fee: his invoice carries the uniform, not the band fee.
    const band = (await loadRequirementProgress(fall.requirementIds["Band fee"]!, "all"))!;
    expect(byName(band.rows!)).toEqual([["Riverquill Family", "Paid"], ["Rookwood Family", "No invoice yet"]]);
  });

  it("a tick needs no link; a payment for a record with no link reads as having no figures, never another's", async () => {
    // No path the portal runs in stage 2 leaves a record without its link: it is removed by hand here.
    await seeded();
    invoices();
    await runMoneyJob({ paceMs: 0 });
    const familyId = await recordOfCustomer(FAMILY, "family"), raffertyId = await recordOfCustomer(RAFFERTY.qboId, "student");
    const rows = await db.select().from(requirement).orderBy(asc(requirement.position));
    // Two checklist items, ticked off for the family and for Rafferty as staff's page would leave them.
    const ticked = (await seedSeason({ name: "Spring 2027", current: false, steps: [{ name: "Forms", requirements: [
      { title: "Fee form handed in", appliesTo: "family", ticked: [FAMILY] },
      { title: "Locker form handed in", appliesTo: "student", ticked: [RAFFERTY.qboId] },
    ] }] })).requirementIds;
    const asked = { families: [familyId], students: [raffertyId] };
    const viewing = { amounts: "all" as const, parentId: null };
    const requirements = [...rows, ...(await db.select().from(requirement).where(eq(requirement.id, ticked["Fee form handed in"]!))),
      ...(await db.select().from(requirement).where(eq(requirement.id, ticked["Locker form handed in"]!)))].map((r) => toRequirement(r, []));
    const words = async () => {
      const { facts } = await loadFacts(requirements, asked, viewing);
      return requirements.map((r) => [r.title, facts.standing(r, r.appliesTo === "family" ? familyId : raffertyId).words]);
    };
    const linked = [["Band fee", "Paid"], ["Uniform fee", "Not paid yet ($40.50 left to pay)"], ["Trip deposit", "No invoice yet"],
      ["Fee form handed in", "Done"], ["Locker form handed in", "Done"]];
    expect(await words()).toEqual(linked);
    await db.delete(accountingLink).where(eq(accountingLink.familyId, familyId));
    await db.delete(accountingLink).where(eq(accountingLink.studentId, raffertyId));
    // The ticks are the season's own records of the app's own records: still done. The figures are kept by customer, and
    // a record with no link has none: no invoice yet, as for a family with no figures.
    expect(await words()).toEqual([["Band fee", "No invoice yet"], ["Uniform fee", "No invoice yet"], ["Trip deposit", "No invoice yet"],
      ["Fee form handed in", "Done"], ["Locker form handed in", "Done"]]);
  });
});

describe("how much is left to pay is said only from current figures, and only to whoever may read it", () => {
  it("a parent's Season page leaves the amount out of figures that are not current, and Home brings them up to date before its lines", async () => {
    await seeded();
    invoices();
    await runMoneyJob({ paceMs: 0 });
    await ageMoney(FAMILY, 2 * 86_400_000); // read two days ago
    const stale = await seasonText();
    expect(stale).toContain(`${RAFFERTY.name} Uniform fee Not paid yet`);
    expect(stale).not.toContain("$40.50");
    // Paid since: QuickBooks says so, and Home reads it before it works out the season's lines.
    stub.invoices = [stub.invoices[0]!, { ...line("2", [sale(UNIFORM, 100)], { TotalAmt: 100, Balance: 0 }), CustomerRef: { value: RAFFERTY.qboId } }];
    asParent(rivera.identity);
    const home = textOf(await renderPage(HomePage));
    expect(home).not.toContain("$40.50");
    expect(home).toContain("Uniform fee Paid");
  });

  it("staff read the amount on the progress pages only with Finance.Balance.Read", async () => {
    const fall = await seeded();
    invoices();
    await runMoneyJob({ paceMs: 0 });
    const params = { params: { requirementId: fall.requirementIds["Uniform fee"]! } };
    asStaff(await withRole("ticker@club.org", ["Season.Progress.Read"]));
    const without = textOf(await renderPage(RequirementProgressPage, params));
    expect(without).toContain("Not paid yet");
    expect(without).not.toContain("$40.50");
    expect(JSON.stringify(await loadFamilyProgress(FAMILY, fall.seasonId, "none"))).not.toContain("$40.50");
    asStaff(await withRole("treasurer@club.org", ["Season.Progress.Read", "Finance.Balance.Read"]));
    expect(textOf(await renderPage(RequirementProgressPage, params))).toContain("Not paid yet ($40.50 left to pay)");
  });
});

describe("staff choose the product or service from QuickBooks", () => {
  let setter: StaffRow;
  const items = () => db.select().from(qboItem).orderBy(asc(qboItem.qboId));
  const itemOf = async (id: string) => (await db.select().from(requirement).where(eq(requirement.id, id)))[0]!.itemQboId;
  beforeEach(async () => {
    stub.items = [
      { Id: BAND_FEE, Name: "Band fee", Type: "Service", Active: true },
      { Id: UNIFORM, Name: "Uniform <b>fee</b>", Type: "NonInventory", Active: true },
      { Id: TRIP, Name: "Old trip", Type: "Service", Active: false },
      { Id: "9", Name: "Fees", Type: "Category", Active: true }, // groups products in QuickBooks and is on no invoice
    ];
  });

  it("reads the list from QuickBooks with a GET, strictly, keeping what can be sold, and audits it", async () => {
    await seeded();
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    asStaff(setter);
    expect(await readItemsAction()).toEqual({ ok: true, message: "Read 3 products and services." });
    expect((await items()).map((i) => [i.qboId, i.name, i.active, i.realmId])).toEqual([[BAND_FEE, "Band fee", true, MONEY_REALM], [UNIFORM, "Uniform <b>fee</b>", true, MONEY_REALM], [TRIP, "Old trip", false, MONEY_REALM]]);
    const asked = stub.apiCalls().filter((c) => c.query.get("query")?.includes("from Item"));
    expect(asked.map((c) => [c.method, c.query.get("query")])).toEqual([["GET", "select * from Item orderby Id startposition 1 maxresults 1000"]]);
    expect((await audits("money.items.read")).map((r) => [r.actorId, r.permission, r.after])).toEqual([[setter.id, "Season.Steps.ReadWrite", { items: 3 }]]);
  });

  it.each([
    ["an empty object", {}],
    ["a Fault sent as a 200", { Fault: { Error: [{ Message: "nope", code: "500" }] } }],
    ["items that aren't a list", { QueryResponse: { Item: { Id: "1" } } }],
  ])("refuses an answer that is %s, and keeps the list it had", async (_what, body) => {
    await seeded();
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    asStaff(setter);
    await readItemsAction();
    stub.oddItemAnswer = { body };
    const r = await readItemsAction();
    expect(r.ok).toBe(false);
    expect(await items()).toHaveLength(3);
    expect((await audits("money.items.read.failed"))).toHaveLength(1);
  });

  it("keeps the list it had when QuickBooks answers with no products or services, and says so", async () => {
    await seeded();
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    asStaff(setter);
    await readItemsAction();
    stub.items = [];
    const r = await readItemsAction();
    expect(r).toEqual({ ok: false, errors: [expect.stringMatching(/^QuickBooks answered with no products or services, though the portal has a list read from it before\. The list was kept as it was\./)] });
    expect(await items()).toHaveLength(3);
    expect((await audits("money.items.read.failed")).map((a) => [a.actorId, a.after])).toEqual([[setter.id, { code: "no_items", kept: 3 }]]);
  });

  it("chooses one for a payment requirement, audited with before and after, and refuses what no page would send", async () => {
    const fall = await seeded();
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    asStaff(setter);
    await readItemsAction();
    const trip = fall.requirementIds["Trip deposit"]!, tag = await currentRosterTag();
    expect(await chooseItemAction(trip, tag, UNIFORM)).toEqual({ ok: true, message: "Saved." });
    expect(await itemOf(trip)).toBe(UNIFORM);
    expect((await audits("season.requirement.item")).map((r) => [r.actorId, r.permission, r.targetId, r.before, r.after])).toEqual([
      [setter.id, "Season.Steps.ReadWrite", trip, { title: "Trip deposit", item: null }, { item: { qboId: UNIFORM, name: "Uniform <b>fee</b>" } }]]);
    expect(await chooseItemAction(trip, tag, "99")).toEqual({ ok: false, errors: ["That product or service isn't in the list read from QuickBooks. Read the list again and choose from it."] });
    expect(await chooseItemAction(trip, tag, TRIP)).toEqual({ ok: false, errors: ["That product or service is inactive in QuickBooks. Choose another."] });
    expect(await chooseItemAction(trip, "another-company-tag", BAND_FEE)).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    for (const bad of ["<b>41</b>", "4".repeat(40), "", 41]) expect(await chooseItemAction(trip, tag, bad as string)).toEqual(BROWSER);
    expect(await chooseItemAction("not-a-uuid", tag, BAND_FEE)).toEqual(BROWSER);
    expect(await itemOf(trip)).toBe(UNIFORM);
    // Only a payment requirement is met by a product or service.
    const made = await addRequirementAction(fall.stepIds.Fees!, "checklist", "family", { title: "Fee form handed in", required: true, amount: null, amountUnit: null, dueOn: null });
    expect(made.ok).toBe(true);
    const checklist = (await db.select().from(requirement).where(eq(requirement.title, "Fee form handed in")))[0]!.id;
    expect(await chooseItemAction(checklist, tag, BAND_FEE)).toEqual({ ok: false, errors: ["Only a payment requirement is met by a product or service."] });
    expect(await chooseItemAction(trip, tag, null)).toMatchObject({ ok: true });
    expect(await itemOf(trip)).toBeNull();
  });

  it("says on the step's line which payment requirement has no product or service chosen yet, until one is", async () => {
    const fall = await seeded();
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    asStaff(setter);
    const NO_ITEM = "No QuickBooks product or service chosen yet";
    const step = async () => textOf(await renderPage(StaffSeasonPage, { params: { id: fall.seasonId } }));
    const before = await step();
    expect(before.match(new RegExp(NO_ITEM, "g"))).toHaveLength(1);
    expect(before).toMatch(new RegExp(`Trip deposit Payment · Required · Each family · Everyone ${NO_ITEM}`));
    await readItemsAction();
    await chooseItemAction(fall.requirementIds["Trip deposit"]!, await currentRosterTag(), BAND_FEE);
    expect(await step()).not.toContain(NO_ITEM);
  });

  it("is for staff who set seasons up: someone who can only read them can't read the list or choose", async () => {
    const fall = await seeded();
    asStaff(await withRole("reader@club.org", ["Season.*.Read", "Finance.Balance.Read"]));
    await expect(readItemsAction()).rejects.toThrow(AccessDenied);
    await expect(chooseItemAction(fall.requirementIds["Trip deposit"]!, await currentRosterTag(), BAND_FEE)).rejects.toThrow(AccessDenied);
    expect(await items()).toEqual([]);
  });

  it("shows the requirement's product or service on its page, QuickBooks' text as text, with the list to choose from", async () => {
    const fall = await seeded();
    setter = await withRole("setter@club.org", ["Season.Steps.*"]);
    asStaff(setter);
    await readItemsAction();
    await chooseItemAction(fall.requirementIds["Uniform fee"]!, await currentRosterTag(), UNIFORM);
    const html = await renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: fall.requirementIds["Uniform fee"]! } });
    expect(html).toContain("<b>Uniform &lt;b&gt;fee&lt;/b&gt;</b>");
    expect(html).not.toContain("Uniform <b>fee</b>");
    expect(textOf(html)).toContain("Met for a student when the invoices raised on that student carrying");
    expect(html).toContain(`<option value="${BAND_FEE}">Band fee</option>`);
    expect(html).not.toContain(`value="${TRIP}"`); // inactive, and not the one chosen
    expect(html).not.toContain(`value="9"`);
    const none = await renderPage(RequirementPage, { params: { id: fall.seasonId, requirementId: fall.requirementIds["Trip deposit"]! } });
    expect(textOf(none)).toContain("No product or service is chosen yet, so it reads “No invoice yet” for everyone.");
  });

  it("keeps the product or service when a season is copied", async () => {
    const fall = await seeded();
    asStaff(await withRole("setter@club.org", ["Season.Steps.*"]));
    expect((await createSeasonAction("Spring 2027", "last")).ok).toBe(true);
    const [spring] = await db.select().from(season).where(eq(season.name, "Spring 2027"));
    const copied = await db.select({ title: requirement.title, itemQboId: requirement.itemQboId }).from(requirement).orderBy(asc(requirement.title));
    expect(copied.filter((r) => r.title === "Band fee").map((r) => r.itemQboId)).toEqual([BAND_FEE, BAND_FEE]);
    expect(spring).toBeTruthy();
    expect(fall.seasonId).not.toBe(spring!.id);
  });

  it("clears the list and every choice when another QuickBooks company is connected: its ids mean other products", async () => {
    await seeded();
    invoices();
    asStaff(await withRole("setter@club.org", ["Season.Steps.*"]));
    await readItemsAction();
    await runMoneyJob({ paceMs: 0 });
    expect(await seasonText()).toContain("Band fee Paid");
    await clearRosterOfOtherCompany("9130000000000777", { actor: { door: "system", id: null, label: "test" }, ip: null });
    expect(await items()).toEqual([]);
    expect((await db.select().from(requirement)).map((r) => r.itemQboId)).toEqual([null, null, null]);
    expect((await audits("money.records.cleared"))[0]!.after).toMatchObject({ reason: "different_company", items: 3, paymentRequirementsLeftWithNoItem: 2 });
    // A list read from the old company never comes back under the new one.
    await db.transaction((tx) => setRosterSource(tx, MONEY_REALM));
    expect(await db.select().from(qboItem)).toEqual([]);
  });
});
