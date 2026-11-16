import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMoney, qboCustomer, writeQueue } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { NOT_HERE } from "@/lib/roster/operations";
import { addToFamilyAction, createAction, deactivateAction, giveUpAction, moveAction, renameAction, tryAgainAction } from "@/app/staff/(app)/roster/write-actions";
import RosterPage from "@/app/staff/(app)/roster/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { connectRoster, REALM, seedQueued, staffWith } from "../helpers/roster-writes";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const RENAME = { op: "rename" as const, role: "student" as const, qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" };
const everyAction = (tag: string, itemId: string) => [
  () => createAction(tag, "family", "Patel Family"),
  () => addToFamilyAction(tag, "student", "10", "Rosa Rivera"),
  () => addToFamilyAction(tag, "parent", "10", "Luis Rivera", "luis@example.com"),
  () => renameAction(tag, "12", "0", "Leon Rivera"),
  () => moveAction(tag, "12", "0", "20"),
  () => deactivateAction(tag, "12", "0"),
  () => tryAgainAction(itemId),
  () => giveUpAction(itemId, "Done by hand."),
];

let tag: string;
beforeEach(async () => { await resetDb(); stub.reset(); tag = await connectRoster(stub); stub.calls.length = 0; });

describe("the roster write actions are staff actions on Roster.Family.ReadWrite, with Roster.Read", () => {
  it("refuse staff without the permission, with Roster.Read alone, and a parent session, and change nothing", async () => {
    const item = await seedQueued(RENAME);
    const { identity } = await seedSignedInParent();
    const before = await db.select().from(qboCustomer);
    for (const who of [await staffWith("nobody@club.org", []), await staffWith("reader@club.org", ["Roster.Read"])]) {
      asStaff(who);
      for (const act of everyAction(tag, item.id)) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    }
    asParent(identity);
    for (const act of everyAction(tag, item.id)) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    expect(posts()).toEqual([]);
    expect(await db.select().from(qboCustomer)).toEqual(before);
    expect((await db.select().from(writeQueue))[0]).toMatchObject({ state: "waiting" });
    expect((await db.select().from(auditLog)).filter((a) => a.action === "access.refused").length).toBeGreaterThanOrEqual(16);
  });

  it("refuse staff who may change the roster but not see it: the pages are Roster.Read's", async () => {
    const item = await seedQueued(RENAME);
    asStaff(await staffWith("writer@club.org", ["Roster.Family.ReadWrite"]));
    for (const act of everyAction(tag, item.id)) expect(await act()).toEqual(NOT_FROM_PAGE);
    expect(posts()).toEqual([]);
  });

  it("refuse arguments no page sends, before the library sees them", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const odd: (() => Promise<unknown>)[] = [
      () => createAction(tag, "student" as "family", "Rosa"),
      () => createAction("", "family", "Rosa"),
      () => createAction(tag, "family", { toString: () => "Rosa" } as unknown as string),
      () => createAction(tag, "family", "x".repeat(5000)),
      () => addToFamilyAction(tag, "student", "10", "Rosa", "rosa@example.com"),
      () => addToFamilyAction(tag, "parent", "10", "Luis", null),
      () => addToFamilyAction(tag, "family" as "student", "10", "Rosa"),
      () => renameAction(tag, "12", "zero", "Leon"),
      () => renameAction(tag, "x".repeat(65), "0", "Leon"),
      () => moveAction(tag, "12", "0", 20 as unknown as string),
      () => deactivateAction(tag, ["12"] as unknown as string, "0"),
      () => tryAgainAction("not-a-uuid"),
      () => giveUpAction("00000000-0000-4000-8000-000000000000", 7 as unknown as string),
    ];
    for (const act of odd) expect(await act()).toEqual(NOT_FROM_PAGE);
    expect(posts()).toEqual([]);
  });

  it("send a change and show it everywhere: the pages are made again", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await renameAction(tag, "12", "0", "Leon Rivera")).toEqual({ ok: true, message: "Renamed in QuickBooks." });
    expect(revalidatedPaths()).toContain("/");
    const [row] = await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, "12"));
    expect(row!.displayName).toBe("Leon Rivera");
    // A refusal changes nothing, and nothing is made again.
    const before = revalidatedPaths().length;
    expect(await renameAction(tag, "12", "1", "Ana Rivera")).toMatchObject({ ok: false, offer: "Ana Rivera (2)" });
    expect(revalidatedPaths().length).toBe(before);
  });
});

describe("the roster pages offer the changes the shape allows, to staff who may make them", () => {
  it("a family's page, with both permissions: rename, add a student and a parent, move and make inactive", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: "10" } });
    for (const words of ["Change in QuickBooks", "Add a student", "Add a parent", "Change the student Leo Rivera", "Change the parent Ana Rivera", "Move to", "Make Rivera Family inactive",
      "From the portal you can make a family, add a student, add a parent with their own email address, rename a family, student or parent, move a student to another family and make a family, student or parent inactive."]) {
      expect(html, words).toContain(words.replaceAll("'", "&#x27;"));
    }
    expect(html).toContain(NOT_HERE.contact);
  });

  it("with Roster.Read alone: what can be changed, and by whom, but no form", async () => {
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const html = await renderPage(RosterEntryPage, { params: { id: "10" } });
    expect(html).toContain("Staff who may change the roster can make a family");
    for (const words of ["Change in QuickBooks", "Add a student", "Make Rivera Family inactive"]) expect(html).not.toContain(words);
    const list = await renderPage(RosterPage);
    expect(list).not.toContain("Make a family</h2>");
  });

  it("shows what is waiting to reach QuickBooks, and offers nothing for a record with a change waiting", async () => {
    await seedQueued(RENAME, { familyQboId: "10" });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: "10" } });
    expect(html).toContain("Waiting to reach QuickBooks");
    expect(html).toContain("Rename the student “Leo Rivera” to “Leon Rivera”");
    expect(html).toContain("A change to Leo Rivera is waiting to reach QuickBooks, so nothing else can be changed for now.");
    expect(html).not.toContain("Change the student Leo Rivera");
  });

  it("a club with no parent type says the parents' addresses are changed in QuickBooks, and offers no parent", async () => {
    await resetDb(); stub.reset();
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: "10" } });
    expect(html).toContain(NOT_HERE.parentsInFamilyEmail.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Add a parent");
    expect(html).toContain("Add a student");
  });

  it("a club with no student type says the portal can't tell a student, and offers no student", async () => {
    await resetDb(); stub.reset();
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: "10" } });
    expect(html).toContain(NOT_HERE.noStudents.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Add a student");
    expect(html).not.toContain("Move to");
  });

  it("a flat club makes a member, of the kind staff choose when there are several, and renames or makes one inactive", async () => {
    await resetDb(); stub.reset();
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const list = await renderPage(RosterPage);
    expect(list).toContain("Make a member");
    expect(list).toContain("<option value=\"2\">Parent</option>");
    expect(list).toContain("<option value=\"3\">Student</option>");
    expect(list).toContain(NOT_HERE.flat.replaceAll("'", "&#x27;"));
    const member = await renderPage(RosterEntryPage, { params: { id: "11" } });
    expect(member).toContain("Change the member Ana Rivera");
    expect(member).not.toContain("Add a student");
    expect(await createAction(tag, "member", "Sky Lee", "3")).toMatchObject({ ok: true });
  });

  it("hostile names stay text on the forms", async () => {
    await resetDb(); stub.reset();
    const company = fznCompany();
    company.customers.push({ Id: "70", DisplayName: "<img src=x onerror=alert(1)> Family", Active: true, SyncToken: "0", MetaData: {}, CustomerTypeRef: { value: "1" } });
    tag = await connectRoster(stub, { company });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: "10" } });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Family");
    expect(html).not.toContain("<img src=x");
  });
});

describe("the Reconciliation page (Roster.Read)", () => {
  const seedWorthALook = () => db.insert(familyMoney).values({ familyQboId: "10", realmId: REALM, readAt: new Date(), invoices: [], totalCents: 0, currency: "USD",
    checkedAt: new Date(), customerChecks: [{ customerQboId: "12", name: "Leo Rivera", balanceCents: 5000, invoicesCents: 0, currency: "USD" }] });

  it("is refused without Roster.Read", async () => {
    asStaff(await staffWith("nobody@club.org", ["Finance.Balance.Read"]));
    expect(await pageOutcome(ReconciliationPage)).toEqual({ redirect: "/refused" });
  });

  it("lists waiting and stuck changes with who asked, when and the last code, Needs attention, and nothing about money without Finance.Balance.Read", async () => {
    await seedQueued(RENAME, { familyQboId: "10", code: "timeout", sent: true });
    await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { state: "stuck", code: "moved_on", tries: 4, familyQboId: "20" });
    await seedWorthALook();
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const before = (await db.select().from(auditLog)).length;
    const html = await renderPage(ReconciliationPage);
    expect(html).toContain("Rename the student “Leo Rivera” to “Leon Rivera”");
    expect(html).toContain("Make the parent Mei Chen inactive");
    expect(html).toContain("Stuck (1)");
    expect(html).toContain("Waiting (1)");
    expect(html).toContain("registrar@club.org");
    expect(html).toContain("QuickBooks didn&#x27;t answer in time (timeout)");
    expect(html).toContain("the record changed in QuickBooks since, so it wasn&#x27;t sent again (moved_on)");
    expect(html).toContain("Needs attention in the roster");
    expect(html).toContain("Stray Student");
    expect(html).not.toContain("Try again now");
    expect(html).not.toContain("Money worth a look");
    expect(html).not.toContain("$50.00");
    // It lists many families: not audited as a read of one.
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("offers Try again now and Give up to staff who may change the roster, and the money worth a look to staff who may see money", async () => {
    await seedQueued(RENAME, { familyQboId: "10" });
    await seedWorthALook();
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Finance.Balance.Read"]));
    const html = await renderPage(ReconciliationPage);
    expect(html).toContain("Try again now");
    expect(html).toContain("Give up");
    expect(html).toContain("Money worth a look");
    expect(html).toContain("Leo Rivera: QuickBooks says $50.00, its open invoices add up to $0.00");
    expect(html).toContain('href="/staff/balances/10"');
  });
});
