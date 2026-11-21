import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, family, guardian, parent, qboCustomer, setting, student, writeQueue } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { endedLinksHeld } from "@/lib/accounting/ended-links";
import { leaveUnlinked, linkFamilyToCustomer } from "@/lib/accounting/link-writes";
import { loadAccountingLinks, type LinkRow } from "@/lib/accounting/mapping";
import { addFamily, askRosterWrite, changeInPortal, createInQuickBooksAndLink, ENDED_HELD, STUDENT_HELD } from "@/lib/roster/writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { SOURCE_KEY } from "@/lib/roster/source";
import { reinstateGuardian } from "@/lib/parents/guardians";
import { createAndLinkAction } from "@/app/staff/(app)/roster/write-actions";
import RosterPage from "@/app/staff/(app)/roster/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { resetDb, seedParent } from "../helpers/db";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";
import { linkAsConfirmed, unlinkThroughThePress } from "../helpers/links";
import { rowNamed } from "../helpers/table";

/**
 * After an unlink, no second customer (stage 4's slice M3b2 of the app-owned families spec; section 4, "By hand" and
 * "The mapping screen"; open question 13): no press makes a customer in the books for a family, student or guardian
 * whose customer from before its unlink is still there (endedLinksHeld(), src/lib/accounting/ended-links.ts), and the
 * family's own pages say so and point at Accounting links. The company is fznCompany()'s (tests/helpers/qbo-stub.ts):
 * Rivera Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12 (Student), Chen Family 20 with Mei Chen 21 (Parent),
 * Lincoln High 30 (School), Old Family 40 (inactive), Stray Student 50. Everything that runs the whole import
 * (syncAppRecords(): connectRoster(), seedAnaRivera()) runs before an unlink, never after it: the import would make a
 * second family, carried over, for the old customer, whose live family link would make endedLinksHeld() answer nothing
 * for the first. A roster read (refreshRoster()) makes no record, so it may run at any time.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const sent = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
/** The text of a piece of rendered HTML: tags dropped, and the entities React writes read back. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
/** The section of a page from the element with this id to the end of its section. */
const sectionOf = (html: string, id: string) => { const at = html.indexOf(`id="${id}"`); return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at)); };
const ledeOf = (html: string) => { const at = html.indexOf('<p class="lede">'); return html.slice(at, html.indexOf("</p>", at)); };
const rowOf = async (name: string): Promise<LinkRow> => {
  const r = (await loadAccountingLinks()).rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}`);
  return r;
};

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
let rivera: AppFamilyId, chen: AppFamilyId, leo: AppStudentId, anaRow: string;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
/** How "Create in QuickBooks and link" is called by the action, for the linker. */
const createOp = () => asOp(linker);
const press = (familyId: AppFamilyId) => createInQuickBooksAndLink(String(familyId), null, tag, createOp());
/** A family added in the portal only, by a staff member who may not link it. */
async function handFamily(name: string): Promise<AppFamilyId> {
  const hand = asOp(await staffWith(`adder.${name.toLowerCase().replace(/[^a-z]+/g, ".")}@club.org`, ["Roster.Read", "Roster.Family.ReadWrite"]));
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, { ...hand, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  return (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
}
/** Rivera linked again to its customer 10 by Confirm on its Suggested row (Ana's address is on Ana Rivera 11, under it). */
async function relinkRivera() {
  const row = await rowOf("Rivera Family");
  expect(row.status.key).toBe("suggested");
  expect(await linkFamilyToCustomer({ familyId: String(rivera), customerId: "10", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
}

/** The stub's company, connected and imported, with Ana Rivera's sign-in; every import runs here, before any unlink. */
async function setUp(company = fznCompany()) {
  await resetDb(); stub.reset();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]);
  tag = await connectRoster(stub, { company });
  anaRow = (await seedAnaRivera()).row.id;
  rivera = await recordOfCustomer("10", "family");
  chen = await recordOfCustomer("20", "family");
  leo = await recordOfCustomer("12", "student");
  stub.calls.length = 0;
}

describe("endedLinksHeld(): a record's latest ended link whose customer the books still hold", () => {
  beforeEach(() => setUp());
  const ended = (o: { familyId: AppFamilyId; customerId: string; realmId?: string; endedAt: Date }) => db.insert(accountingLinkEnded).values({ id: randomUUID(), system: QUICKBOOKS,
    realmId: o.realmId ?? REALM, customerId: o.customerId, familyId: o.familyId, origin: "confirmed", linkedAt: new Date(o.endedAt.getTime() - 60_000), linkedBy: linker.id,
    endedAt: o.endedAt, endedBy: linker.id, endedHow: "unlinked" });

  it("answers each record kind an unlink ended, from the cache, and nothing for empty lists or a record with a live link", async () => {
    expect(await endedLinksHeld({})).toEqual({ families: new Map(), students: new Map(), guardians: new Map() });
    await unlinkThroughThePress(rivera, linker);
    const held = await endedLinksHeld({ families: [rivera, chen], students: [leo], guardians: [anaRow] });
    expect([...held.families.entries()]).toEqual([[rivera, { customerId: "10", customerName: "Rivera Family", parentQboId: null, typeQboId: "1", active: true, endedAt: expect.any(Date) }]]);
    expect([...held.students.entries()]).toEqual([[leo, { customerId: "12", customerName: "Leo Rivera", parentQboId: "10", typeQboId: "3", active: true, endedAt: expect.any(Date) }]]);
    expect([...held.guardians.entries()]).toEqual([[anaRow, { customerId: "11", customerName: "Ana Rivera", parentQboId: "10", typeQboId: "2", active: true, endedAt: expect.any(Date) }]]);
    // Linked again: a record with a live link of its kind is answered nothing, whatever it ended before.
    await linkAsConfirmed(rivera, "10", linker.id);
    expect((await endedLinksHeld({ families: [rivera] })).families.size).toBe(0);
  });

  it("goes by the latest ended link only, ignores another company's, and answers nothing for a customer another family is linked to or the cache doesn't hold", async () => {
    const birch = await handFamily("Birch Family");
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    // Another company's ended link answers nothing.
    await ended({ familyId: birch, customerId: "30", realmId: "9999", endedAt: at(1) });
    expect((await endedLinksHeld({ families: [birch] })).families.size).toBe(0);
    // The older of two in the roster's company is passed over for the later.
    await ended({ familyId: birch, customerId: "30", endedAt: at(120) });
    await ended({ familyId: birch, customerId: "50", endedAt: at(60) });
    expect((await endedLinksHeld({ families: [birch] })).families.get(birch)).toMatchObject({ customerId: "50", customerName: "Stray Student", typeQboId: "3" });
    // The latest names a customer the cache doesn't hold: nothing, never the one before it.
    await ended({ familyId: birch, customerId: "999", endedAt: at(30) });
    expect((await endedLinksHeld({ families: [birch] })).families.size).toBe(0);
    // A customer another family is linked to now (Chen, 20): nothing.
    const elm = await handFamily("Elm Family");
    await ended({ familyId: elm, customerId: "20", endedAt: at(10) });
    expect((await endedLinksHeld({ families: [elm] })).families.size).toBe(0);
    // A family with a live link of its own (Chen) is answered nothing for an ended one.
    await ended({ familyId: chen, customerId: "30", endedAt: at(5) });
    expect((await endedLinksHeld({ families: [chen] })).families.size).toBe(0);
  });

  it("gives the cache's name as it is, QuickBooks text", async () => {
    const birch = await handFamily("Birch Family");
    // The cache's own row renamed by hand: this test reads it and runs no import or read after it.
    await db.update(qboCustomer).set({ displayName: "<b>Bold</b> & “Lincoln”" }).where(eq(qboCustomer.qboId, "30"));
    await ended({ familyId: birch, customerId: "30", endedAt: new Date() });
    expect((await endedLinksHeld({ families: [birch] })).families.get(birch)?.customerName).toBe("<b>Bold</b> & “Lincoln”");
  });

  it("answers nothing for a student or guardian row with a live link of its own, or whose old customer another record of its kind is linked to now", async () => {
    await unlinkThroughThePress(rivera, linker);
    const both = async () => { const h = await endedLinksHeld({ students: [leo], guardians: [anaRow] }); return [h.students.size, h.guardians.size]; };
    expect(await both()).toEqual([1, 1]);
    // Another student record (Birch's, added in the portal) linked to Leo's old customer 12, and another guardian row
    // (Kim's, of Birch) to Ana's 11, by hand: each kind's customer is another record's now, so nothing is answered.
    const birch = await handFamily("Birch Family");
    expect(await changeInPortal({ op: "add_student", familyId: String(birch), name: "Kai Birch" }, tag, createOp())).toMatchObject({ ok: true });
    const [kai] = await db.select({ id: student.id }).from(student).where(eq(student.name, "Kai Birch"));
    const kim = await seedParent({ name: "Kim Birch", email: "kim@example.com" });
    const [kimRow] = await db.insert(guardian).values({ parentId: kim.id, familyId: birch }).returning();
    const others = await db.insert(accountingLink).values([
      { system: QUICKBOOKS, realmId: REALM, customerId: "12", studentId: kai!.id, origin: "confirmed", linkedBy: linker.id },
      { system: QUICKBOOKS, realmId: REALM, customerId: "11", guardianId: kimRow!.id, origin: "confirmed", linkedBy: linker.id },
    ]).returning();
    expect(await both()).toEqual([0, 0]);
    // Those links gone, and Leo and Ana each linked to another customer of their own: a live link of its kind, nothing.
    await db.delete(accountingLink).where(inArray(accountingLink.id, others.map((o) => o.id)));
    expect(await both()).toEqual([1, 1]);
    await db.insert(accountingLink).values([
      { system: QUICKBOOKS, realmId: REALM, customerId: "30", studentId: leo, origin: "confirmed", linkedBy: linker.id },
      { system: QUICKBOOKS, realmId: REALM, customerId: "21", guardianId: anaRow, origin: "confirmed", linkedBy: linker.id },
    ]);
    expect(await both()).toEqual([0, 0]);
  });

  it("answers nothing at all while the roster's company is unknown", async () => {
    await unlinkThroughThePress(rivera, linker);
    expect((await endedLinksHeld({ families: [rivera] })).families.size).toBe(1);
    // The roster's company forgotten by hand (as before a first read); nothing is read or imported after it.
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await endedLinksHeld({ families: [rivera], students: [leo], guardians: [anaRow] })).toEqual({ families: new Map(), students: new Map(), guardians: new Map() });
  });
});

describe("\"Create in QuickBooks and link\" after an unlink: no second customer while the old one is still in the books", () => {
  beforeEach(() => setUp());

  it("refuses the family, naming its customer and where to link it again, sending, queueing and auditing nothing", async () => {
    await unlinkThroughThePress(rivera, linker);
    const queued = (await db.select().from(writeQueue)).length;
    const r = await press(rivera);
    expect(r).toEqual({ changed: false, result: { ok: false, errors: [ENDED_HELD("Rivera Family", "Rivera Family", true)] } });
    expect(r.result.ok ? "" : r.result.errors[0]).toContain("on the Accounting links page: with Confirm on its row");
    expect(r.result.ok ? "" : r.result.errors[0]).not.toContain("(2)");
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toHaveLength(queued);
    expect(await auditsOf("roster.family.created_in_quickbooks")).toEqual([]);
    expect(await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera))).toEqual([]);
    // Made inactive in the books (the cache's own row, set by hand with no read or import after: a roster read writes
    // the same row, and the press reads nothing else of it): still in the books, so still refused, and Accounting links
    // can't offer it until it is sorted out there.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "10"));
    const inactive = await press(rivera);
    expect(inactive).toEqual({ changed: false, result: { ok: false, errors: [ENDED_HELD("Rivera Family", "Rivera Family", false)] } });
    expect(inactive.result.ok ? "" : inactive.result.errors[0]).toContain("can't offer “Rivera Family” for it until it is sorted out in QuickBooks");
    // Active again but under another customer (Lincoln High 30), then at the top level as a student customer: still in
    // the books, so refused, and outside the customers no family is linked to, so the same sort-it-out words.
    await db.update(qboCustomer).set({ active: true, parentQboId: "30" }).where(eq(qboCustomer.qboId, "10"));
    expect(await press(rivera)).toEqual({ changed: false, result: { ok: false, errors: [ENDED_HELD("Rivera Family", "Rivera Family", false)] } });
    await db.update(qboCustomer).set({ parentQboId: null, typeQboId: "3" }).where(eq(qboCustomer.qboId, "10"));
    expect(await press(rivera)).toEqual({ changed: false, result: { ok: false, errors: [ENDED_HELD("Rivera Family", "Rivera Family", false)] } });
    expect(stub.apiCalls()).toEqual([]);
    expect(await auditsOf("roster.family.created_in_quickbooks")).toEqual([]);
  });

  it("refuses it through the action too, for a staff member holding both permissions", async () => {
    await unlinkThroughThePress(rivera, linker);
    asStaff(linker);
    expect(await createAndLinkAction(tag, String(rivera))).toEqual({ ok: false, errors: [ENDED_HELD("Rivera Family", "Rivera Family", true)] });
    expect(stub.apiCalls()).toEqual([]);
    expect(await auditsOf("roster.family.created_in_quickbooks")).toEqual([]);
  });

  it("prepare()'s own-family create, the last line behind addFamily(), refuses a create filed under the family", async () => {
    await unlinkThroughThePress(rivera, linker);
    const queued = (await db.select().from(writeQueue)).length;
    expect(await askRosterWrite({ op: "create", role: "family", name: "Rivera Household", familyQboId: null, email: null, typeQboId: "1", familyId: rivera }, tag, createOp()))
      .toEqual({ ok: false, errors: [ENDED_HELD("Rivera Family", "Rivera Family", true)] });
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toHaveLength(queued);
    expect(await auditsOf("roster.write.refused")).toEqual([]);
  });

  it("once another family is linked to the old customer, the family is made as any family with no link; its student whose customer is still there is left out", async () => {
    await unlinkThroughThePress(rivera, linker);
    const birch = await handFamily("Birch Family");
    await linkAsConfirmed(birch, "10", linker.id);
    // The books hold "Rivera Family" as Birch's customer's name, so the family is renamed in the portal first.
    expect(await changeInPortal({ op: "rename_family", familyId: String(rivera), name: "Rivera Household" }, tag, createOp())).toMatchObject({ ok: true });
    asStaff(linker);
    const html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    expect(textOf(ledeOf(html))).toContain("not linked to QuickBooks: it is in the portal only, and a change to it is saved here only.");
    const section = sectionOf(html, "create-link-h");
    expect(textOf(section)).toContain("This makes Rivera Household a customer in QuickBooks, and links each to its record here.");
    expect(textOf(section)).toContain("Leo Rivera isn't offered: they were linked to “Leo Rivera” in QuickBooks until the family they were in was unlinked, and “Leo Rivera” is still there, so a second customer isn't made for them.");
    const r = await press(rivera);
    expect(r).toEqual({ changed: true, result: { ok: true, message: `Made in QuickBooks and linked: Rivera Household. ${STUDENT_HELD("Leo Rivera", "Leo Rivera", false)}` } });
    expect(sent()).toEqual([{ DisplayName: "Rivera Household", CustomerTypeRef: { value: "1" } }]);
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera)))[0]).toMatchObject({ origin: "created" });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.studentId, leo))).toEqual([]);
  });

  it("once the books no longer hold the old customer, the family and its students are made as any with no link", async () => {
    await unlinkThroughThePress(rivera, linker);
    // Merged away in QuickBooks: gone from the stub, and from the cache by hand. No read or import runs after it, so
    // nothing else changes; a roster read would leave the same cache, as a read drops a customer QuickBooks no longer has.
    stub.customers = stub.customers.filter((c) => c.Id !== "10" && c.Id !== "12");
    await db.delete(qboCustomer).where(inArray(qboCustomer.qboId, ["10", "12"]));
    expect((await endedLinksHeld({ families: [rivera], students: [leo] })).families.size).toBe(0);
    asStaff(linker);
    const html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    expect(textOf(sectionOf(html, "create-link-h"))).toContain("This makes Rivera Family a customer in QuickBooks, then Leo Rivera under it, one by one, and links each to its record here.");
    const r = await press(rivera);
    expect(r).toMatchObject({ changed: true, result: { ok: true } });
    expect(sent().map((b) => b.DisplayName)).toEqual(["Rivera Family", "Leo Rivera"]);
    expect(await db.select().from(accountingLink).where(eq(accountingLink.studentId, leo))).toHaveLength(1);
  });
});

describe("a relink to the same customer: the students left unpaired are made only where no customer of theirs is still there", () => {
  let mia: AppStudentId;
  beforeEach(async () => {
    const company = fznCompany();
    company.customers.push(qc("13", "Mia Rivera", "3", under("10")));
    await setUp(company);
    mia = await recordOfCustomer("13", "student");
  });

  it("makes a student with no ended link, leaves out the one whose customer is still there, and says it", async () => {
    await unlinkThroughThePress(rivera, linker);
    // Renamed in the portal while unlinked, so the relink doesn't pair Mia with her customer; Zoe added there, with none.
    expect(await changeInPortal({ op: "rename_student", studentId: String(mia), name: "Mia R. Rivera" }, tag, createOp())).toMatchObject({ ok: true });
    expect(await changeInPortal({ op: "add_student", familyId: String(rivera), name: "Zoe Rivera" }, tag, createOp())).toMatchObject({ ok: true });
    await relinkRivera();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.studentId, mia))).toEqual([]);
    asStaff(linker);
    const html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    // The Students table says it of Mia, and of Zoe, who never had one, that she has no customer.
    const students = sectionOf(html, "entry-students-h");
    expect(rowNamed(students, "Mia R. Rivera")?.at(-1)).toBe("Not linked: their customer from before an unlink is still in the books");
    expect(rowNamed(students, "Zoe Rivera")?.at(-1)).toBe("No customer");
    const section = textOf(sectionOf(html, "create-link-h"));
    expect(section).toContain("This makes Zoe Rivera customers in QuickBooks under Rivera Family, one by one, and links each to their record here.");
    expect(section).toContain("Mia R. Rivera isn't offered: they were linked to “Mia Rivera” in QuickBooks until the family they were in was unlinked, and “Mia Rivera” is still there, so a second customer isn't made for them.");
    const left = STUDENT_HELD("Mia R. Rivera", "Mia Rivera", true);
    expect(left).toContain("Accounting links shows Mia R. Rivera among the family's differences as a student in the portal only, and “Mia Rivera” as a student in the books only.");
    expect(await press(rivera)).toEqual({ changed: true, result: { ok: true, message: `Made in QuickBooks and linked: Zoe Rivera. ${left}` } });
    expect(sent().map((b) => b.DisplayName)).toEqual(["Zoe Rivera"]);
    // Only Mia left: nothing is made, and the words name her; the page offers no create.
    stub.calls.length = 0;
    expect(await press(rivera)).toEqual({ changed: false, result: { ok: false, errors: [
      "Everything in this family that can be made in QuickBooks is linked already, waiting to be, was made there after making it was given up (the Reconciliation page lists those), or is still in the books from before an unlink, so nothing was made.",
      left] } });
    expect(stub.apiCalls()).toEqual([]);
    expect(await renderPage(RosterEntryPage, { params: { id: String(rivera) } })).not.toContain('id="create-link-h"');
  });

  /** Rivera unlinked, Mia renamed so the relink leaves her unpaired, Zoe added with no customer, and Rivera linked again to 10. */
  async function unpaired() {
    await unlinkThroughThePress(rivera, linker);
    expect(await changeInPortal({ op: "rename_student", studentId: String(mia), name: "Mia R. Rivera" }, tag, createOp())).toMatchObject({ ok: true });
    expect(await changeInPortal({ op: "add_student", familyId: String(rivera), name: "Zoe Rivera" }, tag, createOp())).toMatchObject({ ok: true });
    await relinkRivera();
    stub.calls.length = 0;
  }

  it("a press stopped at a student's step still names the student it left out", async () => {
    await unpaired();
    // A customer named "Zoe Rivera" in the books, read in (a read makes no record): Zoe's step stops before anything is sent.
    stub.customers.push(qc("80", "Zoe Rivera", "1"));
    const read = await refreshRoster(WORKER);
    if (!read.ok) throw new Error("the roster couldn't be read from the stub");
    stub.calls.length = 0;
    const r = await press(rivera);
    expect(r.changed).toBe(false);
    const errors = r.result.ok ? [] : r.result.errors;
    expect(errors[0]).toBe("Nothing was made in QuickBooks.");
    expect(errors[1]).toContain("“Zoe Rivera” is already a name in QuickBooks");
    expect(errors.at(-2)).toBe(STUDENT_HELD("Mia R. Rivera", "Mia Rivera", true));
    expect(stub.apiCalls()).toEqual([]);
  });

  it("says only what Accounting links shows when her old customer is inactive, or no longer a student customer", async () => {
    await unpaired();
    // The cache's own row changed by hand, with no read or import after: the press reads nothing else of it.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "13"));
    const left = STUDENT_HELD("Mia R. Rivera", "Mia Rivera", false);
    expect(left).not.toContain("as a student in the books only");
    expect(await press(rivera)).toEqual({ changed: true, result: { ok: true, message: `Made in QuickBooks and linked: Zoe Rivera. ${left}` } });
    expect(sent().map((b) => b.DisplayName)).toEqual(["Zoe Rivera"]);
    stub.calls.length = 0;
    await db.update(qboCustomer).set({ active: true, typeQboId: "2" }).where(eq(qboCustomer.qboId, "13"));
    expect(await press(rivera)).toEqual({ changed: false, result: { ok: false, errors: [
      "Everything in this family that can be made in QuickBooks is linked already, waiting to be, was made there after making it was given up (the Reconciliation page lists those), or is still in the books from before an unlink, so nothing was made.",
      left] } });
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("a guardian's Parent customer: none made beside the one their row was linked to under this family", () => {
  let staff: ReturnType<typeof asOp>;
  let beaRow: string;
  beforeEach(async () => {
    const company = fznCompany();
    company.customers.push(qc("14", "Bea Rivera", "2", under("10")));
    await setUp(company);
    // Patel 70, a family customer no family is linked to, read in (a read makes no record).
    stub.customers.push(qc("70", "Patel Family", "1"));
    const read = await refreshRoster(WORKER);
    if (!read.ok) throw new Error("the roster couldn't be read from the stub");
    staff = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    // Bea, a guardian of the Riveras removed before the unlink, whose row was linked to her Parent customer 14 under 10.
    const bea = await seedParent({ name: "Bea Rivera", email: "bea@example.com" });
    const [row] = await db.insert(guardian).values({ parentId: bea.id, familyQboId: "10", familyId: rivera, status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" }).returning();
    beaRow = row!.id;
    await db.insert(accountingLink).values({ system: QUICKBOOKS, realmId: REALM, customerId: "14", guardianId: beaRow, origin: "confirmed", linkedBy: linker.id });
    await unlinkThroughThePress(rivera, linker);
    // Renamed in the portal since, so no customer under the family has her name.
    await db.update(parent).set({ name: "Beatrice Rivera" }).where(eq(parent.id, bea.id));
    stub.calls.length = 0;
  });
  const rowItems = () => db.select().from(writeQueue).where(sql`${writeQueue.request}->>'guardianId' = ${beaRow}`);

  it("reinstated after the family is linked to the same customer again: nothing queued or sent, linked_before said, and her row's standing says it", async () => {
    await relinkRivera();
    const r = await reinstateGuardian(beaRow, staff);
    expect(r).toEqual({ ok: true, quickbooks: ["QuickBooks has the Parent customer “Bea Rivera” under Rivera Family that Beatrice Rivera was linked to until that link ended, so no second one was made for them. While it is active in QuickBooks, it can be linked to them again on Accounting links, in the opening of the family's row."] });
    expect((await db.select().from(guardian).where(eq(guardian.id, beaRow)))[0]!.status).not.toBe("disabled");
    expect(await rowItems()).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, beaRow))).toEqual([]);
    asStaff(linker);
    const html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    expect(rowNamed(html, "Beatrice Rivera")?.[3]).toBe("QuickBooks has the Parent customer “Bea Rivera” under this family that they were linked to until that link ended, so no second one is made. No Parent customer in QuickBooks is linked to them, and none is being made: while it is active, it can be linked to them again on Accounting links, in the opening of the family's row.");
  });

  it("held back the same when her name is still her old customer's, in words of its own", async () => {
    await db.update(parent).set({ name: "Bea Rivera" }).where(eq(parent.name, "Beatrice Rivera"));
    await relinkRivera();
    expect(await reinstateGuardian(beaRow, staff)).toEqual({ ok: true, quickbooks: ["QuickBooks has the Parent customer “Bea Rivera” under Rivera Family that Bea Rivera was linked to until that link ended, so no second one was made for them. While it is active in QuickBooks, it can be linked to them again on Accounting links, in the opening of the family's row."] });
    expect(await rowItems()).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("reinstated after the family is linked to another customer: her Parent customer is made under it, as today", async () => {
    expect(await leaveUnlinked(String(rivera), tag, linkOp())).toMatchObject({ ok: true });
    const step = (await loadAccountingLinks()).step(String(rivera), "70");
    expect(step.ok).toBe(true);
    const offer = (step as Extract<typeof step, { ok: true }>).offer;
    expect(await linkFamilyToCustomer({ familyId: String(rivera), customerId: "70", chosen: offer.chosen, stamp: offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await reinstateGuardian(beaRow, staff)).toMatchObject({ ok: true });
    expect((await rowItems()).map((i) => i.request)).toEqual([expect.objectContaining({ op: "create", role: "parent", name: "Beatrice Rivera", familyQboId: "70" })]);
    expect(sent()).toEqual([expect.objectContaining({ DisplayName: "Beatrice Rivera", ParentRef: { value: "70" } })]);
  });
});

describe("the family's pages after an unlink", () => {
  beforeEach(() => setUp());
  const LEDE = "A family the portal keeps, not linked to QuickBooks: it was linked to “Rivera Family” there until it was unlinked, “Rivera Family” is still in the books, and a change to it is saved here only.";

  it("its page says what is true, links to Accounting links for a reader who may link, and offers no create", async () => {
    await unlinkThroughThePress(rivera, linker);
    asStaff(linker);
    const html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    const lede = ledeOf(html);
    expect(textOf(lede)).toBe(`${LEDE} Link it again on Accounting links. Back to the roster`);
    expect(lede).toContain('href="/staff/links"');
    expect(html).not.toContain('id="create-link-h"');
    expect(html).not.toMatch(/<button[^>]*>Create in QuickBooks and link<\/button>/);
    expect(textOf(sectionOf(html, "portal-changes-h"))).toContain("This family isn't linked to a customer in QuickBooks, so a change made here is saved in the portal only");
    expect(textOf(sectionOf(html, "changes-h"))).toContain("This family isn't linked to a customer in QuickBooks: a change to it is saved in the portal only.");
    // A reader who may not link families is told who can, with no link.
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const theirs = ledeOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    expect(textOf(theirs)).toBe(`${LEDE} Someone who may link families to accounting links it again on Accounting links. Back to the roster`);
    expect(theirs).not.toContain('href="/staff/links"');
    expect(stub.apiCalls()).toEqual([]);
  });

  it("where Accounting links can't offer its customer, its lede says to sort it out in QuickBooks first", async () => {
    await unlinkThroughThePress(rivera, linker);
    // Made inactive in the books: the cache's own row, by hand, with no read or import after it.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "10"));
    const SORT = "Accounting links can't offer “Rivera Family” for it until it is sorted out in QuickBooks, where it may be inactive, under another customer or of another type; once it is,";
    asStaff(linker);
    const lede = ledeOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    expect(textOf(lede)).toBe(`${LEDE} ${SORT} link it again on Accounting links. Back to the roster`);
    expect(lede).toContain('href="/staff/links"');
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const theirs = ledeOf(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    expect(textOf(theirs)).toBe(`${LEDE} ${SORT} someone who may link families to accounting links it again there. Back to the roster`);
    expect(theirs).not.toContain('href="/staff/links"');
  });

  it("the Families list says its customer is still in the books, beside a family that never had a link and one being made", async () => {
    await unlinkThroughThePress(rivera, linker);
    await handFamily("Birch Family");
    const elm = await handFamily("Elm Family");
    await seedQueued({ op: "create", role: "family", name: "Elm Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: elm });
    asStaff(linker);
    const html = await renderPage(RosterPage);
    expect(rowNamed(html, "Rivera Family")?.at(-1)).toBe("Not linked: its customer is still in the books");
    expect(rowNamed(html, "Birch Family")?.at(-1)).toBe("Not linked: in the portal only");
    expect(rowNamed(html, "Elm Family")?.at(-1)).toBe("Not linked yet: being made in QuickBooks");
    expect(rowNamed(html, "Chen Family")?.at(-1)).toBe("Linked: active");
    // Linked again: Linked, as any family.
    await linkAsConfirmed(rivera, "10", linker.id);
    expect(rowNamed(await renderPage(RosterPage), "Rivera Family")?.at(-1)).toBe("Linked: active");
  });
});
