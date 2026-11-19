import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, familyMoney, guardian, qboConnection, qboCustomer, student, writeQueue } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { NOT_HERE } from "@/lib/roster/operations";
import { MAKING_LOCK } from "@/lib/roster/writes";
import { TRY_AGAIN_NEEDS_LINKING } from "@/lib/roster/queue";
import { addGuardianAction, reinstateGuardianAction, removeGuardianAction } from "@/app/staff/(app)/parents/actions";
import { addStudentAction, addStudentHereAction, addToFamilyAction, createAction, createAndLinkAction, deactivateAction, deactivateHereAction, familyInactiveAction, giveUpAction, moveAction,
  renameHereAction, renameLinkedAction, renameParentAction, sendPortalValueAction, tryAgainAction } from "@/app/staff/(app)/roster/write-actions";
import RosterPage from "@/app/staff/(app)/roster/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { connectRoster, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { rowNamed } from "../helpers/table";
import { recordOfCustomer } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
/** A family's page is addressed by its app family record: the one this customer's family link names. */
const idOf = async (customer: string) => String(await recordOfCustomer(customer, "family"));
const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const RENAME = { op: "rename" as const, role: "student" as const, qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" };
const SOME_UUID = "00000000-0000-4000-8000-000000000000";
/** The Rivera family's list as its page binds it: the family, Ana and Leo, each at the version the stub's company starts at. */
const RIVERA_SHOWN: [string, string][] = [["10", "0"], ["11", "0"], ["12", "0"]];
const everyAction = (tag: string, itemId: string) => [
  () => createAction(tag, "family", "Patel Family"),
  () => addStudentAction(tag, SOME_UUID, "Rosa Rivera"),
  () => addToFamilyAction(tag, "parent", "10", "Luis Rivera", "luis@example.com"),
  () => renameLinkedAction(tag, "student", SOME_UUID, "Leon Rivera"),
  () => renameParentAction(tag, "21", "0", "Mei L. Chen"),
  () => sendPortalValueAction(itemId, "", "stamp"),
  () => moveAction(tag, SOME_UUID, SOME_UUID),
  () => deactivateAction(tag, "12", "0"),
  () => familyInactiveAction(tag, "10", RIVERA_SHOWN),
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
      // A student is no longer added by customer, and the parent's form takes an address.
      () => addToFamilyAction(tag, "student" as "parent", "10", "Rosa", "rosa@example.com"),
      () => addToFamilyAction(tag, "parent", "10", "Luis", null as unknown as string),
      () => addStudentAction(tag, "10", "Rosa"),
      () => addStudentAction(tag, SOME_UUID, 7 as unknown as string),
      // A linked record's rename names it by its kind and app id, and sends no version.
      () => renameLinkedAction(tag, "student", "12", "Leon"),
      () => renameLinkedAction(tag, "parent" as "student", SOME_UUID, "Leon"),
      () => renameParentAction(tag, "21", "zero", "Mei"),
      () => renameParentAction(tag, "x".repeat(65), "0", "Mei"),
      () => sendPortalValueAction("not-a-uuid", "", "stamp"),
      () => sendPortalValueAction(SOME_UUID, 7 as unknown as string, "stamp"),
      // A move names the student and the family by the app's ids, and sends no version and no QuickBooks id.
      () => moveAction(tag, "12", SOME_UUID),
      () => moveAction(tag, SOME_UUID, "20"),
      () => moveAction(tag, SOME_UUID, 20 as unknown as string),
      () => deactivateAction(tag, ["12"] as unknown as string, "0"),
      () => familyInactiveAction(tag, "10", []),
      () => familyInactiveAction(tag, "10", "10:0" as unknown as [string, string][]),
      () => familyInactiveAction(tag, "10", [["10", "zero"]]),
      () => familyInactiveAction(tag, "10", [["10", "0", "extra"]] as unknown as [string, string][]),
      () => familyInactiveAction(tag, "10", Array.from({ length: 201 }, (_, i): [string, string] => [String(i), "0"])),
      () => familyInactiveAction(tag, 10 as unknown as string, RIVERA_SHOWN),
      () => tryAgainAction("not-a-uuid"),
      () => giveUpAction("00000000-0000-4000-8000-000000000000", 7 as unknown as string),
    ];
    for (const act of odd) expect(await act()).toEqual(NOT_FROM_PAGE);
    expect(posts()).toEqual([]);
  });

  it("send a change and show it everywhere: the pages are made again", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const leo = String(await recordOfCustomer("12", "student"));
    expect(await renameLinkedAction(tag, "student", leo, "Leon Rivera")).toEqual({ ok: true, message: "Renamed Leon Rivera in the portal and in QuickBooks." });
    expect(revalidatedPaths()).toContain("/");
    const [row] = await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, "12"));
    expect(row!.displayName).toBe("Leon Rivera");
    // A refusal before anything is saved changes nothing, and nothing is made again.
    const before = revalidatedPaths().length;
    expect(await renameLinkedAction(tag, "student", leo, "Ana Rivera")).toMatchObject({ ok: false, offer: "Ana Rivera (2)" });
    expect(revalidatedPaths().length).toBe(before);
  });
});

describe("making a family inactive from its page: one action, the amount of a balance only for Finance.Balance.Read", () => {
  beforeEach(() => { stub.quirks.balances = true; });
  const owing = () => { stub.invoices = [{ Id: "901", SyncToken: "0", CustomerRef: { value: "12" }, TotalAmt: 12.5, Balance: 12.5 }]; };

  it("says who owes, with the amount only to staff who may see money, and sends nothing", async () => {
    owing();
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const plain = await familyInactiveAction(tag, "10", RIVERA_SHOWN);
    expect(plain).toMatchObject({ ok: false, errors: expect.arrayContaining(["Leo Rivera has an open balance in QuickBooks."]) });
    expect(JSON.stringify(plain)).not.toContain("$12.50");
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Finance.Balance.Read"]));
    expect(await familyInactiveAction(tag, "10", RIVERA_SHOWN)).toMatchObject({ ok: false, errors: expect.arrayContaining(["Leo Rivera owes $12.50 in QuickBooks."]) });
    expect(posts()).toEqual([]);
    expect(revalidatedPaths()).toEqual([]);
  });

  it("makes the family and everyone under it inactive, and the pages are made again", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await familyInactiveAction(tag, "10", RIVERA_SHOWN)).toEqual({ ok: true, message: "Made inactive in QuickBooks: Ana Rivera and Leo Rivera, then Rivera Family." });
    expect(revalidatedPaths()).toContain("/");
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("A family the portal keeps, linked to its customer in QuickBooks, which is inactive there.");
    // The family's own record is inactive in the portal now: no form that would send anything for it is offered.
    expect(html).not.toContain("Make Rivera Family inactive");
    for (const words of ["Change in QuickBooks", "Change the family Rivera Family", "Change the student Leo Rivera", "Change the parent Ana Rivera", "Add a student"]) expect(html).not.toContain(words);
  });

  it("a family QuickBooks made inactive itself is offered the action, which sends nothing and makes its own record inactive", async () => {
    for (const id of ["11", "12", "10"]) Object.assign(stub.customers.find((c) => c.Id === id)!, { Active: false, SyncToken: "1" });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("Make Rivera Family inactive");
    expect(html).toContain("QuickBooks has Rivera Family inactive already");
    stub.calls.length = 0;
    expect(await familyInactiveAction(tag, "10", [["10", "1"]])).toMatchObject({ ok: true, message: expect.stringContaining("Rivera Family is inactive in QuickBooks already, so nothing was sent.") });
    expect(posts()).toEqual([]);
    expect((await db.select().from(family).where(eq(family.id, await recordOfCustomer("10", "family"))))[0]).toMatchObject({ active: false });
    expect(await renderPage(RosterEntryPage, { params: { id: await idOf("10") } })).not.toContain("Make Rivera Family inactive");
  });

  it("a stop part way is made again on the pages too, so the list shown next is whoever is still active", async () => {
    stub.onApiRequest = (c) => { stub.updateFault = c.method === "POST" && /"Id":"12"/.test(c.body) ? "6000" : null; };
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const r = await familyInactiveAction(tag, "10", RIVERA_SHOWN);
    expect(r).toMatchObject({ ok: false, errors: expect.arrayContaining(["Made inactive in QuickBooks: Ana Rivera."]) });
    expect(revalidatedPaths()).toContain("/");
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("Make Rivera Family inactive");
  });
});

describe("a family's page brings the portal's own records into line with what QuickBooks has, sending nothing", () => {
  beforeEach(async () => { asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"])); });

  it("a student QuickBooks has inactive while their record is active: making them inactive in the portal is offered", async () => {
    Object.assign(stub.customers.find((c) => c.Id === "12")!, { Active: false, SyncToken: "1" });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("Make Leo Rivera inactive in the portal");
    expect(await deactivateAction(tag, "12", "1")).toMatchObject({ ok: true });
    expect(posts()).toEqual([]);
    expect((await db.select().from(student).where(eq(student.id, await recordOfCustomer("12", "student"))))[0]).toMatchObject({ active: false });
    // Once the record is inactive too, nothing that would send is offered for them.
    expect(await renderPage(RosterEntryPage, { params: { id: await idOf("10") } })).not.toContain("Change the student Leo Rivera");
  });

  it("a student QuickBooks has under another family: said so in words, and moved like any other; to that family, nothing is sent (slice 9f)", async () => {
    Object.assign(stub.customers.find((c) => c.Id === "12")!, { ParentRef: { value: "20" }, SyncToken: "1" });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    const students = html.slice(html.indexOf('id="entry-students-h"'), html.indexOf('id="entry-parents-h"'));
    expect(rowNamed(students, "Leo Rivera")).toEqual(["Leo Rivera", "Under Chen Family in QuickBooks"]);
    // No special form: the move offered is the ordinary one, to each of the portal's other active families by its app id.
    const moves = html.slice(html.indexOf('id="move-students-h"'));
    expect(moves).toContain("Move the student Leo Rivera");
    expect(moves).toContain(`<option value="${await idOf("20")}">Chen Family</option>`);
    expect(moves).not.toContain(`<option value="${await idOf("10")}">`);
    expect(html).not.toContain("but the portal still holds them in this family");
    expect(await moveAction(tag, String(await recordOfCustomer("12", "student")), await idOf("20"))).toMatchObject({ ok: true });
    expect(posts()).toEqual([]);
    expect((await db.select().from(student).where(eq(student.id, await recordOfCustomer("12", "student"))))[0]).toMatchObject({ familyId: await recordOfCustomer("20", "family") });
    expect(await renderPage(RosterEntryPage, { params: { id: await idOf("10") } })).not.toContain("Move the student Leo Rivera");
    expect(await renderPage(RosterEntryPage, { params: { id: await idOf("20") } })).toContain("Move the student Leo Rivera");
  });

  it("a student moved into a family with no customer in QuickBooks: saved, kept on Reconciliation, and both pages say whose invoices each family sees until QuickBooks has it", async () => {
    const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html.slice(html.indexOf('id="move-students-h"'))).toContain(`<option value="${okafor!.id}">Okafor Family</option>`);
    expect(await moveAction(tag, String(await recordOfCustomer("12", "student")), String(okafor!.id))).toMatchObject({ ok: true, status: "attention" });
    expect(posts()).toEqual([]);
    const words = "Until QuickBooks has the move, Rivera Family still sees Leo Rivera&#x27;s invoices, and Okafor Family doesn&#x27;t.";
    for (const id of [await idOf("10"), String(okafor!.id)]) {
      const page = await renderPage(RosterEntryPage, { params: { id } });
      const kept = page.slice(page.indexOf('id="refused-h"'));
      expect(kept, id).toContain("Move the student Leo Rivera from Rivera Family to Okafor Family");
      expect(kept, id).toContain(words);
      expect(kept, id).toContain("the family the student was moved to has no customer in QuickBooks yet");
    }
    const recon = await renderPage(ReconciliationPage);
    expect(recon).toContain("Not in QuickBooks, kept in the portal (1)");
    expect(recon).toContain(words);
    // Not offered while the family joined has no customer in QuickBooks: the row says to create it there first.
    expect(recon).not.toContain("Send the portal&#x27;s value");
    expect(recon).toContain("Create the family in QuickBooks first, with “Create in QuickBooks and link” on its page; the portal&#x27;s move can be sent from here after that.");
  });
});

describe("the roster pages offer the changes the shape allows, to staff who may make them", () => {
  it("a family's page, with both permissions: rename, add a student and a parent, move and make inactive", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    for (const words of ["Change in QuickBooks", "Add a student", "Add a parent", "Change the student Leo Rivera", "Change the parent Ana Rivera", "Move to", "Make Rivera Family inactive",
      "From the portal you can make a family, add a student, add a parent with their own email address, rename a family, student or parent, move a student to another family and make a family, student or parent inactive."]) {
      expect(html, words).toContain(words.replaceAll("'", "&#x27;"));
    }
    expect(html).toContain(NOT_HERE.contact);
  });

  it("offers a Parent sub-customer its changes with no sign-in behind it, and a family with no QuickBooks customer the portal's own changes alone (stage 3's slice 9d)", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    // Sign-ins are off, so nobody has one: the parents are QuickBooks' own customers, listed and changed as before.
    expect(await db.select().from(guardian)).toEqual([]);
    const rivera = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    for (const words of ["Ana Rivera", "ana@example.com", "Change the parent Ana Rivera"]) expect(rivera, words).toContain(words);
    // A linked family is offered no portal-only change, nor "Create in QuickBooks and link".
    for (const words of ["Change in the portal", "Create in QuickBooks and link"]) expect(rivera, words).not.toContain(words);
    // A family made in the portal with no customer: listed as not linked, opened, and offered the portal's own changes
    // (no form that sends QuickBooks ids), its guardians' box, and the way to QuickBooks for whoever may link.
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    await db.insert(student).values({ name: "Hal Handmade", active: true, familyId: hand!.id });
    expect(rowNamed(await renderPage(RosterPage), "Handmade Family")).toEqual(["Handmade Family", "1", "0", "Not linked: in the portal only"]);
    const html = await renderPage(RosterEntryPage, { params: { id: String(hand!.id) } });
    expect(html).toContain("A family the portal keeps, not linked to QuickBooks: it is in the portal only, and a change to it is saved here only.");
    expect(html).toContain("Hal Handmade");
    const portal = html.slice(html.indexOf('id="portal-changes-h"'), html.indexOf("</section>", html.indexOf('id="portal-changes-h"')));
    for (const words of ["Change the family Handmade Family", "Add a student", "Change the student Hal Handmade"]) expect(portal, words).toContain(words);
    for (const words of ["Change in QuickBooks", "Add a parent"]) expect(html, words).not.toContain(words);
    expect(html).toContain("Add a guardian");
    // Without the linking permission, "Create in QuickBooks and link" says who may press it, and offers no button.
    const link = html.slice(html.indexOf('id="create-link-h"'), html.indexOf("</section>", html.indexOf('id="create-link-h"')));
    expect(link).toContain("Someone who may link families to accounting can make it in QuickBooks and link it.");
    expect(link).not.toContain("<button");
    expect(posts()).toEqual([]);
  });

  it("shows the button \"Create in QuickBooks and link\" only to staff who may change families and link them; the action checks both", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    const button = (html: string) => html.slice(html.indexOf('id="create-link-h"'), html.indexOf("</section>", html.indexOf('id="create-link-h"'))).includes("Create in QuickBooks and link</button>");
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    expect(button(await renderPage(RosterEntryPage, { params: { id: String(hand!.id) } }))).toBe(true);
    // The linking permission alone: the page offers no changes at all, and the action refuses it.
    asStaff(await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    const linkerPage = await renderPage(RosterEntryPage, { params: { id: String(hand!.id) } });
    expect(linkerPage).not.toContain('id="create-link-h"');
    await expect(createAndLinkAction(tag, String(hand!.id))).rejects.toBeInstanceOf(AccessDenied);
    // Changing families alone: the action refuses it as not from the page.
    asStaff(await staffWith("writer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await createAndLinkAction(tag, String(hand!.id))).toEqual(NOT_FROM_PAGE);
    expect(await createAndLinkAction(tag, "not-a-uuid")).toEqual(NOT_FROM_PAGE);
    expect(posts()).toEqual([]);
  });

  it("the portal's own changes refuse what no page sends, and need Roster.Read beside Roster.Family.ReadWrite", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    asStaff(await staffWith("writer@club.org", ["Roster.Family.ReadWrite"]));
    expect(await renameHereAction(tag, "family", String(hand!.id), "Hand Family")).toEqual(NOT_FROM_PAGE);
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    for (const act of [() => renameHereAction(tag, "family", "10", "Hand Family"), () => renameHereAction(tag, "parent" as "family", String(hand!.id), "Hand Family"),
      () => addStudentHereAction(tag, String(hand!.id), 7 as unknown as string), () => deactivateHereAction(tag, "student", "x".repeat(36))]) {
      expect(await act()).toEqual(NOT_FROM_PAGE);
    }
    expect(await renameHereAction(tag, "family", String(hand!.id), "Hand Family")).toEqual({ ok: true, message: "Renamed Hand Family in the portal." });
    expect(revalidatedPaths()).toContain("/");
    expect(posts()).toEqual([]);
  });

  it("with Roster.Read alone: what can be changed, and by whom, but no form", async () => {
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("Staff who may change the roster can make a family");
    for (const words of ["Change in QuickBooks", "Add a student", "Make Rivera Family inactive"]) expect(html).not.toContain(words);
    const list = await renderPage(RosterPage);
    expect(list).not.toContain("Make a family</h2>");
  });

  it("shows what is waiting to reach QuickBooks, and offers nothing for a record with a change waiting", async () => {
    await seedQueued(RENAME, { familyQboId: "10" });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("Waiting to reach QuickBooks");
    expect(html).toContain("Rename the student “Leo Rivera” to “Leon Rivera”");
    expect(html).toContain("A change to Leo Rivera is waiting to reach QuickBooks, so nothing else can be changed for now.");
    expect(html).not.toContain("Change the student Leo Rivera");
  });

  it("a club with no parent type says the parents' addresses are changed in QuickBooks, and offers no parent", async () => {
    await resetDb(); stub.reset();
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain(NOT_HERE.parentsInFamilyEmail.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Add a parent");
    expect(html).toContain("Add a student");
  });

  it("a club with no student type says the portal can't tell a student, and offers no student", async () => {
    await resetDb(); stub.reset();
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain(NOT_HERE.noStudents.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Add a student");
    expect(html).not.toContain("Move to");
  });

  it("a flat club makes a member, of the kind staff choose when there are several, and renames or makes one inactive", async () => {
    await resetDb(); stub.reset();
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    // The kind is asked only of staff whose new member is made in QuickBooks too: they may link families to accounting.
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    const list = await renderPage(RosterPage);
    expect(list).toContain("Make a member");
    expect(list).toContain("<option value=\"2\">Parent</option>");
    expect(list).toContain("<option value=\"3\">Student</option>");
    expect(list).toContain(NOT_HERE.flat.replaceAll("'", "&#x27;"));
    const member = await renderPage(RosterEntryPage, { params: { id: await idOf("11") } });
    expect(member).toContain("Change the member Ana Rivera");
    expect(member).not.toContain("Add a student");
    expect(await createAction(tag, "member", "Sky Lee", "3")).toMatchObject({ ok: true });
  });

  it("hostile names stay text on the forms", async () => {
    await resetDb(); stub.reset();
    const company = fznCompany();
    company.customers.push({ Id: "70", DisplayName: "<img src=x onerror=alert(1)> Family", Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" }, CustomerTypeRef: { value: "1" } });
    tag = await connectRoster(stub, { company });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Family");
    expect(html).not.toContain("<img src=x");
  });
});

describe("the Reconciliation page (Roster.Read)", () => {
  const seedWorthALook = async () => db.insert(familyMoney).values({ familyId: await recordOfCustomer("10", "family"), realmId: REALM, readAt: new Date(), invoices: [], totalCents: 0, currency: "USD",
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

  it("says a queued buy-out invoice's amount only to staff who may see money, here and on the family's page", async () => {
    await db.insert(writeQueue).values({ realmId: REALM, request: { op: "invoice_create", buyoutId: "00000000-0000-4000-8000-0000000000b1", customerQboId: "10", itemQboId: "4343",
      units: 2, unitCents: 3719 }, familyId: await recordOfCustomer("10", "family"), sent: false, tries: 1, lastCode: "http_429", nextTryAt: new Date(), askedByLabel: "a guardian" });
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    for (const html of [await renderPage(ReconciliationPage), await renderPage(RosterEntryPage, { params: { id: await idOf("10") } })]) {
      expect(html).toContain("for a volunteer buy-out");
      expect(html).not.toContain("$74.38");
    }
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Finance.Balance.Read"]));
    for (const html of [await renderPage(ReconciliationPage), await renderPage(RosterEntryPage, { params: { id: await idOf("10") } })]) {
      expect(html).toContain("$74.38 for a volunteer buy-out");
    }
  });

  it("links each change to the page of the family it is filed under, by that family's record, and a family's page lists every change under, about or into it", async () => {
    // The Rivera family (10) has a change of every arm: filed under it (a student's rename, a buy-out's void, a move
    // out of it) and one moving a student into Chen (20). A new family is filed under none, and the stray student (50)
    // has no family record at all: its change is found by its target alone, and links nowhere.
    await seedQueued(RENAME, { familyQboId: "10" });
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" }, { state: "stuck", familyQboId: "10" });
    await db.insert(writeQueue).values({ realmId: REALM, request: { op: "invoice_void", buyoutId: "00000000-0000-4000-8000-0000000000b2", invoiceQboId: "9001", customerQboId: "10",
      why: "switched_back" }, familyId: await recordOfCustomer("10", "family"), sent: false, tries: 1, lastCode: "http_429", nextTryAt: new Date(), askedByLabel: "a guardian" });
    await seedQueued({ op: "create", role: "family", name: "Patel Family", typeQboId: "1", familyQboId: null, email: null });
    await seedQueued({ op: "rename", role: "student", qboId: "50", syncToken: "0", name: "Stray Two", was: "Stray Student" });
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const html = await renderPage(ReconciliationPage);
    // The rename, the move (filed under the family it moves from) and the void link to Rivera; nothing to Chen or the stray.
    // Only the changes' section is read: the Needs attention list below it links families of its own (Chen has no student).
    const start = html.indexOf('id="writes-h"');
    expect(start).toBeGreaterThan(-1);
    const writes = html.slice(start, html.indexOf("</section>", start));
    const [rivera10, chen20] = [await idOf("10"), await idOf("20")];
    const links = [...writes.matchAll(/href="\/staff\/roster\/([^"]*)"/g)].map((m) => m[1]);
    expect(links).toEqual([rivera10, rivera10, rivera10]);
    expect(links).not.toContain(chen20);
    const rivera = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    for (const words of ["Rename the student “Leo Rivera” to “Leon Rivera”", "Move the student Leo Rivera from Rivera Family to Chen Family", "Void the volunteer buy-out invoice of Rivera Family"]) expect(rivera).toContain(words);
    expect(rivera).not.toContain("Make the family “Patel Family”");
    const chen = await renderPage(RosterEntryPage, { params: { id: await idOf("20") } });
    expect(chen).toContain("Move the student Leo Rivera from Rivera Family to Chen Family");
    expect(chen).not.toContain("Rename the student “Leo Rivera”");
    expect(chen).not.toContain("Void the volunteer buy-out invoice");
  });

  it("links a Needs attention family to its page by the family's record, and a customer with no family record nowhere", async () => {
    // The stub's company: Chen (20) has no student, so it is listed; the stray student (50) is under no family, and has no page.
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const html = await renderPage(ReconciliationPage);
    const start = html.indexOf('id="attention-h"');
    expect(start).toBeGreaterThan(-1);
    const attention = html.slice(start, html.indexOf("</section>", start));
    expect(attention).toContain("Stray Student");
    const links = [...attention.matchAll(/href="\/staff\/roster\/([^"]*)"/g)].map((m) => m[1]);
    // Chen is listed once for each rule it meets, and every one of those rows links to the same record.
    expect(links.length).toBeGreaterThan(0);
    expect([...new Set(links)]).toEqual([await idOf("20")]);
    expect(attention).not.toContain('href="/staff/roster/20"');
    expect(attention).not.toContain('href="/staff/roster/50"');
  });

  it("offers Try again now and Give up to staff who may change the roster, and the money worth a look to staff who may see money", async () => {
    await seedQueued(RENAME, { familyQboId: "10" });
    await seedWorthALook();
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Finance.Balance.Read"]));
    const html = await renderPage(ReconciliationPage);
    expect(html).toContain("Try again now");
    expect(html).toContain("Give up");
    expect(html).toContain("Money worth a look");
    expect(rowNamed(html, "Leo Rivera")).toEqual([expect.any(String), "Leo Rivera", "$50.00", "$0.00", expect.stringMatching(/UTC$/)]);
    expect(html).toContain(`href="/staff/balances/${await idOf("10")}"`);
    expect(html).not.toContain('href="/staff/balances/10"');
  });
});

/* ---- Families by hand on the pages (stage 3's slice 9d) ---- */

/** A family's own create, as addFamily() files it under the record saved first. */
const HAND_CREATE = { op: "create" as const, role: "family" as const, name: "Handmade Family", typeQboId: "1", familyQboId: null, email: null };
/** One section of a page, from its heading to the end of its section. */
const sectionOf = (html: string, id: string) => { const at = html.indexOf(`id="${id}"`); return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at)); };
const escaped = (words: string) => words.replaceAll("'", "&#x27;");

describe("a family with no link on the pages", () => {
  it("is offered no link to what it owes or to its buy-outs, whose pages stand for no such family; a linked family is", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Finance.Balance.Read", "Season.Progress.Read", "Volunteer.Credit.ReadWrite"]));
    const elsewhere = sectionOf(await renderPage(RosterEntryPage, { params: { id: String(hand!.id) } }), "entry-elsewhere-h");
    expect(elsewhere).toContain("Where it stands this season");
    for (const words of ["What it owes", "Its volunteer buy-outs"]) expect(elsewhere, words).not.toContain(words);
    const rivera = sectionOf(await renderPage(RosterEntryPage, { params: { id: await idOf("10") } }), "entry-elsewhere-h");
    for (const words of ["What it owes", "Its volunteer buy-outs"]) expect(rivera, words).toContain(words);
  });

  it("whose own create waits: listed and described as being made, on Reconciliation in words with its page linked, and tried again only by someone who may link", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    await seedQueued(HAND_CREATE, { familyId: hand!.id, state: "stuck", code: "customer_has_family", sent: true, nextTryAt: null });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(rowNamed(await renderPage(RosterPage), "Handmade Family")).toEqual(["Handmade Family", "0", "0", "Not linked yet: being made in QuickBooks"]);
    expect(await renderPage(RosterEntryPage, { params: { id: String(hand!.id) } })).toContain("A family the portal keeps, not linked to QuickBooks yet: its customer is being made there.");
    const writes = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(writes).toContain("another family in the portal is linked to it already, so this family was left unlinked and nothing will be sent again");
    expect(writes).toContain("(customer_has_family)");
    expect(writes).toContain(`href="/staff/roster/${hand!.id}"`);
    expect(writes).toContain(escaped(TRY_AGAIN_NEEDS_LINKING));
    expect(writes).not.toContain("Try again now");
    expect(writes).toContain("Give up");
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    const linking = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(linking).toContain("Try again now");
    expect(linking).not.toContain(escaped(TRY_AGAIN_NEEDS_LINKING));
  });

  it("a student whose own create waits on the queue is offered no change on the family's page", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    const [hal, ivy] = await db.insert(student).values([{ name: "Hal Handmade", active: true, familyId: hand!.id }, { name: "Ivy Handmade", active: true, familyId: hand!.id }]).returning();
    await db.insert(writeQueue).values({ realmId: REALM, request: { op: "create", role: "student", name: "Hal Handmade", typeQboId: "3", familyQboId: "10", email: null },
      familyId: hand!.id, studentId: hal!.id, sent: true, tries: 1, lastCode: "timeout", nextTryAt: new Date(), askedByLabel: "registrar@club.org" });
    expect(ivy).toBeDefined();
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const portal = sectionOf(await renderPage(RosterEntryPage, { params: { id: String(hand!.id) } }), "portal-changes-h");
    expect(portal).toContain("Change the student Ivy Handmade");
    expect(portal).not.toContain("Change the student Hal Handmade");
  });

  it("a create given up that QuickBooks made anyway is said on Reconciliation, pointing at Customers with no family and the family saved first", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    stub.customers.push({ Id: "77", SyncToken: "0", DisplayName: "Handmade Family", Active: true, CustomerTypeRef: { value: "1" } });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    await seedQueued(HAND_CREATE, { familyId: hand!.id, state: "given_up", sent: true, nextTryAt: null, lastTriedAt: new Date(Date.now() - 3_600_000) });
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    const html = await renderPage(ReconciliationPage);
    const made = sectionOf(html, "made-anyway-h");
    expect(made).toContain("Made in QuickBooks after it was given up (1)");
    expect(made).toContain("Handmade Family");
    expect(made).toContain("Customers with no family");
    expect(made).toContain(`href="/staff/roster/${hand!.id}"`);
    // The customer is offered there, to bring in.
    expect(sectionOf(html, "no-family-h")).toContain("Handmade Family");
    // With nothing of the kind, the section isn't drawn.
    await db.delete(writeQueue);
    expect(await renderPage(ReconciliationPage)).not.toContain('id="made-anyway-h"');
  });
});

describe("a guardian added or reinstated while the family's create waits, is being sent, or its link can't be told", () => {
  it("is refused in the words of each, changing nothing", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    expect(await addGuardianAction(String(hand!.id), "Hal Hand", "hal@example.com")).toMatchObject({ ok: true });
    const [row] = await db.select().from(guardian).where(eq(guardian.familyId, hand!.id));
    expect(await removeGuardianAction(row!.id, "Moved away.")).toMatchObject({ ok: true });
    const errorsOf = async (p: Promise<unknown>) => ((await p) as { errors?: string[] }).errors;
    const both = async () => [await errorsOf(addGuardianAction(String(hand!.id), "Ivy Hand", "ivy@example.com")), await errorsOf(reinstateGuardianAction(row!.id))];
    // Its own create waiting on the queue.
    const item = await seedQueued(HAND_CREATE, { familyId: hand!.id });
    expect(await both()).toEqual([[expect.stringContaining("still waiting on the queue, so nobody can be added to it for now")],
      [expect.stringContaining("still waiting on the queue, so this sign-in can't be brought back for now")]]);
    await db.delete(writeQueue).where(eq(writeQueue.id, item.id));
    // Being sent at this moment: its "being made" lock held, as a send holds it.
    await db.transaction(async (hold) => {
      await hold.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(MAKING_LOCK))}, hashtext(${String(hand!.id)}::text))`);
      expect(await both()).toEqual([[expect.stringContaining("being made in QuickBooks at this moment, so nobody can be added to it")],
        [expect.stringContaining("being made in QuickBooks at this moment, so this sign-in can't be brought back just now")]]);
    });
    // QuickBooks connected to another company: the portal can't tell the family's link.
    await db.update(qboConnection).set({ realmId: "9999" });
    expect(await both()).toEqual([[expect.stringContaining("and nobody was added")], [expect.stringContaining("and this sign-in wasn't brought back")]]);
    expect(await db.select().from(guardian).where(eq(guardian.familyId, hand!.id))).toEqual([expect.objectContaining({ id: row!.id, status: "disabled" })]);
    expect(posts()).toEqual([]);
  });
});

describe("the Families list while QuickBooks is connected to another company", () => {
  it("offers no add form, as addFamily() refuses one then", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await renderPage(RosterPage)).toContain("Make a family</h2>");
    await db.update(qboConnection).set({ realmId: "9999" });
    expect(await renderPage(RosterPage)).not.toContain("Make a family</h2>");
  });
});

describe("a change QuickBooks refused that the portal kept (stage 3's slice 9e)", () => {
  const refusedRename = () => seedQueued(RENAME, { state: "refused", code: "fault_5010", nextTryAt: null, familyQboId: "10" });

  it("is listed on Reconciliation under its own heading, in words, with Send the portal's value and Give up only for staff who may change families", async () => {
    await refusedRename();
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    const read = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(read).toContain("Not in QuickBooks, kept in the portal (1)");
    expect(read).toContain("Rename the student “Leo Rivera” to “Leon Rivera”");
    // Who stopped it, in words: here the portal, which held it back over a name changed in QuickBooks.
    expect(read).toContain("The portal held it back: someone changed the name in QuickBooks since the portal last sent it");
    expect(read).toContain("Held back by the portal, as QuickBooks has something else");
    expect(read).toContain("Why it didn&#x27;t go through");
    expect(read).toContain("QuickBooks has “Leo Rivera” now.");
    expect(read).not.toContain("fault_5010");
    expect(read).not.toContain("Send the portal");
    expect(read).not.toContain("Stuck (");
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const change = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(change).toContain("Send the portal&#x27;s value");
    expect(change).toContain("Give up");
    expect(change).not.toContain("Try again now");
  });

  it("offers no Send the portal's value where it can't go through: a name QuickBooks refused as taken, a customer QuickBooks has inactive; and says why", async () => {
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    await seedQueued(RENAME, { state: "refused", code: "fault_6240", nextTryAt: null, familyQboId: "10" });
    const taken = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(taken).not.toContain("Send the portal");
    expect(taken).toContain("rename the record on its family&#x27;s page to a free name");
    expect(taken).toContain("Give up");
    await db.delete(writeQueue);
    await refusedRename();
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "12"));
    const inactive = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(inactive).not.toContain("Send the portal");
    expect(inactive).toContain("QuickBooks has this customer inactive, and the portal never makes a customer active again");
    // Drawn as a notice, never a bare paragraph.
    expect(inactive).toMatch(/<div class="notice notice-info"><svg[\s\S]*?<\/svg><div class="notice-body"><span class="notice-word">Note<\/span> QuickBooks has this customer inactive/);
    // A customer the roster doesn't hold at all is said as that, not as inactive.
    await db.delete(qboCustomer).where(eq(qboCustomer.qboId, "12"));
    const gone = sectionOf(await renderPage(ReconciliationPage), "writes-h");
    expect(gone).not.toContain("Send the portal");
    expect(gone).toContain("This customer isn&#x27;t on the roster the portal last read from QuickBooks");
    expect(gone).not.toContain("QuickBooks has this customer inactive");
  });

  it("is listed on the family's page in words, with no buttons, and doesn't stop a change to the record", async () => {
    await refusedRename();
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(RosterEntryPage, { params: { id: await idOf("10") } });
    const kept = sectionOf(html, "refused-h");
    expect(kept).toContain("Kept in the portal, not in QuickBooks");
    expect(kept).toContain("Rename the student “Leo Rivera” to “Leon Rivera”");
    expect(kept).not.toContain("Send the portal");
    expect(html).not.toContain('id="waiting-h"');
    expect(html).toContain("Change the student Leo Rivera");
    expect(html).not.toContain("A change to Leo Rivera is waiting to reach QuickBooks");
  });

  it("the rename forms of a linked record send no version and start from the portal's own name; the student form adds by the family's record", async () => {
    await db.update(student).set({ name: "Leo R. Rivera" }).where(eq(student.id, await recordOfCustomer("12", "student")));
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = sectionOf(await renderPage(RosterEntryPage, { params: { id: await idOf("10") } }), "family-changes-h");
    expect(html).toContain('value="Leo R. Rivera"');
    expect(html).toContain("The student is saved in the portal first, then made in QuickBooks under the family.");
  });
});
