import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, withoutIds } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, qboConnection, setting, student, writeQueue, type RosterWrite } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { loadOpenWrites, queueCounts } from "@/lib/roster/queue";
import { SOURCE_KEY } from "@/lib/roster/source";
import { refreshRoster } from "@/lib/roster/refresh";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { askFamilyInactive, askRosterWrite, closeEarlierContacts, coverStamp, createInQuickBooksAndLink, deactivateLinked, familiesBeingMade, familyCover, familyCreateWaiting,
  FAMILY_WAITING, GUARDIAN_PENDING, guardianChangeWaiting, guardianMaySend, guardianStandings, KEPT_OFF_STAYS, keptContactsOf, MOVE_PENDING, moveTargets, NO_FAMILY_CUSTOMER, replaceRefusedCreates,
  sendToBooks, studentsBeingMade, takeFromBooks, WRITE_COPY, addFamily, changeInPortal } from "@/lib/roster/writes";
import { familyCreatesFiled } from "@/lib/roster/no-family";
import { loadAccountingLinks, QUEUE_IN_THE_WAY, QUEUE_IN_THE_WAY_OF_SEND, type GuardianShown, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { GUARDIAN_LINK_COPY, guardianUnlinkedWords, linkGuardian, unlinkGuardian } from "@/lib/accounting/guardian-links";
import { LINK_COPY, linkFamilyToCustomer, unlinkFamily } from "@/lib/accounting/link-writes";
import { guardianLinkStamp, sendStamp, takeStamp } from "@/lib/accounting/stamp";
import { addGuardian } from "@/lib/parents/guardians";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import HealthPage from "@/app/staff/(app)/settings/health/page";
import StaffHome from "@/app/staff/(app)/page";
import { resetDb, seedParent, seedStaff } from "../helpers/db";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Every reader of the write queue's open items reads only the roster's company's (stage 4's slice M7a3 of the app-owned
 * families spec; open question 16, "Queued requests for the old company are given up"; ofRosterCompany(),
 * src/lib/roster/source.ts). A change of company's clear gives up every item still to go, but a parent's change saved
 * after reading the old company, as the clear ran, goes in after it and is open until the worker's next wake gives it
 * up (stage 4's slice M7a2). Until then it holds nothing back, takes no name, lists and counts nowhere, and is never
 * closed as replaced by the new company's change. Each case seeds the earlier company's items itself (`old()`), as a
 * save that read the old company before a switch's clear committed leaves them (since slice M8 a switch an Admin asks for
 * reaches the clear): filed under the same
 * family, student, guardian row and customer number as the current one, as such a save leaves it (the roster's is
 * REALM, tests/helpers/roster-writes.ts). The company is fznCompany()'s (tests/helpers/qbo-stub.ts): the Rivera Family 10
 * with Ana 11 and Leo 12, the Chen Family 20 with Mei 21.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

/** The earlier company: not the roster's (REALM), as a late save under a change of company would name it. */
const OLD = "2222";
const STATES = ["waiting", "stuck", "refused"] as const;
type Seed = NonNullable<Parameters<typeof seedQueued>[1]>;
/** An earlier company's item, filed exactly as the roster's company's would be (seeded as the roster's, then moved to OLD). */
async function old(w: RosterWrite, o: Seed = {}) {
  const item = await seedQueued(w, o);
  await db.update(writeQueue).set({ realmId: OLD }).where(eq(writeQueue.id, item.id));
  return { ...item, realmId: OLD };
}
/** The same in each open state. */
const oldInEvery = async (w: RosterWrite, o: Seed = {}) => { for (const state of STATES) await old(w, { ...o, state }); };
/** A queue item filed under a student record too (seedQueued() files a create under none). */
const fileUnder = (id: string, studentId: AppStudentId) => db.update(writeQueue).set({ studentId }).where(eq(writeQueue.id, id));
const dropItem = (id: string) => db.delete(writeQueue).where(eq(writeQueue.id, id));
const oldItems = () => db.select().from(writeQueue).where(eq(writeQueue.realmId, OLD)).orderBy(asc(writeQueue.id));
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");

const RENAME_LEO = (name: string): RosterWrite => ({ op: "rename", role: "student", qboId: "12", syncToken: "0", name, was: "Leo Rivera" });
const RENAME_CHEN: RosterWrite = { op: "rename", role: "family", qboId: "20", syncToken: "0", name: "Chen Household", was: "Chen Family" };
const MOVE_LEO = (rivera: AppFamilyId, chen: AppFamilyId): RosterWrite => ({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20",
  fromFamilyId: rivera, toFamilyId: chen });
const FAMILY_CREATE = (name: string): RosterWrite => ({ op: "create", role: "family", name, typeQboId: "1", familyQboId: null, email: null });
const STUDENT_CREATE: RosterWrite = { op: "create", role: "student", name: "Leo Rivera", typeQboId: "3", familyQboId: "10", email: null };
const STUDENT_MOVE_PENDING = "A move of this student hasn't reached QuickBooks yet";
const STUDENT_WAITING = "Making this student in QuickBooks is still waiting on the queue";

let tag: string;
let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId, chen: AppFamilyId, leo: AppStudentId;
const connected = (company?: ReturnType<typeof fznCompany>) => beforeEach(async () => {
  await resetDb(); stub.reset();
  // A customer read by id carries its own Balance, as QuickBooks' does: the portal reads it before making anyone inactive.
  stub.quirks.balances = true;
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
  tag = await connectRoster(stub, company ? { company } : {});
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family"); leo = await recordOfCustomer("12", "student");
  stub.calls.length = 0;
});
/** A customer's Active changed in QuickBooks, then read: app records stay as they were (no roster read changes them). */
async function inBooks(id: string, active: boolean) {
  stub.customers.find((c) => c.Id === id)!.Active = active;
  expect((await refreshRoster(WORKER)).ok).toBe(true);
  tag = await currentRosterTag();
}

describe("the rule: the roster cache's company, read in the statement", () => {
  connected();

  it("counts and lists the roster's company's items only", async () => {
    const current = await seedQueued(RENAME_LEO("Leon New"));
    await oldInEvery(RENAME_LEO("Leon Old"));
    expect(await queueCounts()).toEqual({ waiting: 1, stuck: 0, refused: 0 });
    expect((await loadOpenWrites()).map((i) => i.id)).toEqual([current.id]);
  });

  it("still counts and lists them while QuickBooks is connected to another company: they are the records' own pending changes", async () => {
    const current = await seedQueued(RENAME_LEO("Leon New"));
    await oldInEvery(RENAME_LEO("Leon Old"));
    await db.update(qboConnection).set({ realmId: "3333" });
    expect(await queueCounts()).toEqual({ waiting: 1, stuck: 0, refused: 0 });
    expect((await loadOpenWrites()).map((i) => i.id)).toEqual([current.id]);
  });

  it("matches nothing while the cache names no company", async () => {
    await seedQueued(RENAME_LEO("Leon New"));
    await oldInEvery(RENAME_LEO("Leon Old"));
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await queueCounts()).toEqual({ waiting: 0, stuck: 0, refused: 0 });
    expect(await loadOpenWrites()).toEqual([]);
  });
});

describe("a staff write is never held back by an earlier company's item", () => {
  connected();
  /** A linked student made inactive as their family's page asks it (deactivateHolding()). */
  const offLeo = () => deactivateLinked({ kind: "student", recordId: String(leo) }, tag, op);

  it("a rename of a customer with an earlier company's change of it open (prepare()'s waitingFor())", async () => {
    await oldInEvery(RENAME_LEO("Leon Old"));
    const current = await seedQueued(RENAME_LEO("Leon New"));
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await dropItem(current.id);
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true });
    expect(posts()).toHaveLength(1);
    // The earlier company's items are left exactly as they were, for the worker's give-up.
    expect((await oldItems()).map((i) => i.state).sort()).toEqual(["refused", "stuck", "waiting"]);
  });

  it("a name an earlier company's create or rename asked for is not taken (namesTaken())", async () => {
    await oldInEvery(FAMILY_CREATE("Oak Family"));
    // Were the earlier company's names read, the name offered would be "Oak Family (3)".
    await oldInEvery(FAMILY_CREATE("Oak Family (2)"));
    await oldInEvery(RENAME_CHEN);
    const current = await seedQueued(FAMILY_CREATE("Oak Family"));
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Oak Family" }, tag, op)).toEqual({ ok: false, offer: "Oak Family (2)",
      errors: ["“Oak Family” is already a name in QuickBooks, and every name there must be different. You could use “Oak Family (2)” instead."] });
    expect(posts()).toEqual([]);
    await dropItem(current.id);
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Oak Family" }, tag, op)).toMatchObject({ ok: true });
    expect(await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Chen Household" }, tag, op)).toMatchObject({ ok: true });
    expect(posts().map((c) => JSON.parse(c.body) as Record<string, unknown>)).toEqual([{ Id: "12", SyncToken: "0", sparse: true, DisplayName: "Oak Family" },
      { Id: "21", SyncToken: "0", sparse: true, DisplayName: "Chen Household" }]);
  });

  it("a student made inactive: an earlier company's change of their customer, their family's create, their own create, or their move (waitingForCustomer(), familyCreateWaiting(), studentCreateWaiting(), movesOf())", async () => {
    await oldInEvery(RENAME_LEO("Leon Old"));
    await oldInEvery(FAMILY_CREATE("Rivera Family"), { familyId: rivera });
    for (const state of STATES) await fileUnder((await old(STUDENT_CREATE, { state })).id, leo);
    await oldInEvery(MOVE_LEO(rivera, chen));
    const rename = await seedQueued(RENAME_LEO("Leon New"));
    expect(await offLeo()).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await dropItem(rename.id);
    const create = await seedQueued(FAMILY_CREATE("Rivera Family"), { familyId: rivera });
    expect(await offLeo()).toEqual({ ok: false, errors: [FAMILY_WAITING] });
    await dropItem(create.id);
    const own = await seedQueued(STUDENT_CREATE);
    await fileUnder(own.id, leo);
    expect(await offLeo()).toEqual({ ok: false, errors: [expect.stringContaining(STUDENT_WAITING)] });
    await dropItem(own.id);
    const move = await seedQueued(MOVE_LEO(rivera, chen), { state: "refused" });
    expect(await offLeo()).toEqual({ ok: false, errors: [expect.stringContaining(STUDENT_MOVE_PENDING)] });
    await dropItem(move.id);
    expect(await offLeo()).toMatchObject({ ok: true });
    expect(posts().map((c) => JSON.parse(c.body) as Record<string, unknown>)).toEqual([expect.objectContaining({ Id: "12", Active: false })]);
  });

  it("a family made inactive: an earlier company's change of its customers, a move into or out of it, a guardian's change in it (prepareFamily(), familyMovePending(), guardianItemsWaiting())", async () => {
    const { row } = await seedAnaRivera();
    const GUARDIAN_CREATE: RosterWrite = { op: "create", role: "parent", name: "Ana Rivera", typeQboId: "2", familyQboId: "10", email: "ana@example.com", guardianId: row.id };
    await oldInEvery(RENAME_LEO("Leon Old"));
    await oldInEvery(MOVE_LEO(rivera, chen));
    await oldInEvery(GUARDIAN_CREATE);
    const cover = (await familyCover("10"))!;
    const stamp = coverStamp(String(rivera), [cover.family.qboId, ...cover.under.map((u) => u.qboId)]);
    const press = () => askFamilyInactive(String(rivera), stamp, tag, op);
    const rename = await seedQueued(RENAME_LEO("Leon New"));
    expect((await press()).result).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await dropItem(rename.id);
    const move = await seedQueued(MOVE_LEO(rivera, chen), { state: "refused" });
    expect((await press()).result).toEqual({ ok: false, errors: [MOVE_PENDING] });
    await dropItem(move.id);
    const guardianItem = await seedQueued(GUARDIAN_CREATE);
    expect((await press()).result).toEqual({ ok: false, errors: [GUARDIAN_PENDING] });
    await dropItem(guardianItem.id);
    expect(posts()).toEqual([]);
    expect((await press()).result).toMatchObject({ ok: true });
  });

  it("Create in QuickBooks and link under a family customer with an earlier company's change of it open (prepareLink())", async () => {
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
    const oak = (await db.select().from(family).where(eq(family.name, "Oak Family")))[0]!.id;
    expect(await changeInPortal({ op: "add_student", familyId: String(oak), name: "Amy Oak" }, tag, op)).toMatchObject({ ok: true });
    // The family made and linked, Amy left unmade (QuickBooks has her name already).
    stub.otherNames = ["Amy Oak"];
    await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.otherNames = [];
    const customer = String(stub.customers.find((c) => c.DisplayName === "Oak Family")!.Id);
    const RENAME_OAK: RosterWrite = { op: "rename", role: "family", qboId: customer, syncToken: "0", name: "Oak Household", was: "Oak Family" };
    await oldInEvery(RENAME_OAK, { familyId: oak });
    const current = await seedQueued(RENAME_OAK, { familyId: oak, nextTryAt: null });
    stub.calls.length = 0;
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(posts()).toEqual([]);
    await dropItem(current.id);
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: true, message: "Made in QuickBooks and linked: Amy Oak." });
  });

  it("a family's and a student's create are found by the record only as the roster's company's (familyCreateWaiting(), familiesBeingMade(), studentsBeingMade())", async () => {
    const waiting = () => db.transaction((tx) => familyCreateWaiting(tx, rivera));
    for (const state of ["waiting", "stuck"] as const) await old(FAMILY_CREATE("Rivera Family"), { familyId: rivera, state });
    for (const state of ["waiting", "stuck"] as const) await fileUnder((await old(STUDENT_CREATE, { state })).id, leo);
    expect(await waiting()).toBeNull();
    expect(await familiesBeingMade()).toEqual(new Set());
    expect(await studentsBeingMade([leo])).toEqual(new Set());
    await seedQueued(FAMILY_CREATE("Rivera Family"), { familyId: rivera });
    await fileUnder((await seedQueued(STUDENT_CREATE)).id, leo);
    expect(await waiting()).toBe("queued");
    expect(await familiesBeingMade()).toEqual(new Set([String(rivera)]));
    expect(await studentsBeingMade([leo])).toEqual(new Set([String(leo)]));
  });

  it("the families a student may be moved to (moveRefusals(), both its queries)", async () => {
    await oldInEvery(FAMILY_CREATE("Rivera Family"), { familyId: rivera });
    await oldInEvery(RENAME_CHEN);
    expect(await moveTargets(rivera)).toEqual({ refusedHere: null, families: [{ id: String(chen), name: "Chen Family" }] });
    const create = await seedQueued(FAMILY_CREATE("Rivera Family"), { familyId: rivera });
    const rename = await seedQueued(RENAME_CHEN);
    expect(await moveTargets(rivera)).toEqual({ refusedHere: FAMILY_WAITING, families: [] });
    await dropItem(create.id); await dropItem(rename.id);
    expect(await moveTargets(rivera)).toEqual({ refusedHere: null, families: [{ id: String(chen), name: "Chen Family" }] });
  });

  it("taking a student's inactive from the books, with an earlier company's move of theirs kept (takeInactive()'s movesOf())", async () => {
    await inBooks("12", false);
    await oldInEvery(MOVE_LEO(rivera, chen));
    const take = () => takeFromBooks({ field: "inactive", kind: "student", recordId: String(leo), stamp: takeStamp("inactive", String(leo), "12", []) }, tag, op);
    const move = await seedQueued(MOVE_LEO(rivera, chen), { state: "refused" });
    expect(await take()).toEqual({ ok: false, errors: [expect.stringContaining(STUDENT_MOVE_PENDING)] });
    await dropItem(move.id);
    expect(await take()).toMatchObject({ ok: true });
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ active: false });
  });

  it("taking a student's active from the books, with an earlier company's move of theirs kept (takeActive()'s movesOf())", async () => {
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    await oldInEvery(MOVE_LEO(rivera, chen));
    const take = (holds: boolean) => takeFromBooks({ field: "active", kind: "student", recordId: String(leo), stamp: takeStamp("active", String(leo), "12", [holds]) }, tag, op);
    const move = await seedQueued(MOVE_LEO(rivera, chen), { state: "refused" });
    expect(await take(false)).toEqual({ ok: false, errors: [expect.stringContaining(STUDENT_MOVE_PENDING)] });
    await dropItem(move.id);
    expect(await take(false)).toMatchObject({ ok: true });
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ active: true });
  });

  it("taking a family's active from the books says nothing of an earlier company's kept make-inactive of its customer (offKept())", async () => {
    const OFF_CHEN: RosterWrite = { op: "deactivate", role: "family", qboId: "20", syncToken: "0" };
    await old(OFF_CHEN, { state: "refused", code: "fault_6000", nextTryAt: null });
    const chenOff = () => db.update(family).set({ active: false }).where(eq(family.id, chen));
    const take = () => takeFromBooks({ field: "active", kind: "family", recordId: String(chen), stamp: takeStamp("active", String(chen), "20", ["Chen Family"]) }, tag, op);
    await chenOff();
    const kept = await seedQueued(OFF_CHEN, { state: "refused", code: "fault_6000", nextTryAt: null });
    expect(await take()).toEqual({ ok: true, message: expect.stringContaining(KEPT_OFF_STAYS) });
    await dropItem(kept.id);
    await chenOff();
    const r = await take();
    expect(r).toMatchObject({ ok: true });
    expect((r as { message: string }).message).not.toContain(KEPT_OFF_STAYS);
  });

  it("sending a student's inactive to the books, with an earlier company's move of theirs kept (sendInactive()'s movesOf())", async () => {
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    await oldInEvery(MOVE_LEO(rivera, chen));
    const send = () => sendToBooks({ field: "inactive", kind: "student", recordId: String(leo), stamp: sendStamp("inactive", String(leo), "12", ["12"]) }, tag, op);
    const move = await seedQueued(MOVE_LEO(rivera, chen), { state: "refused" });
    expect(await send()).toEqual({ ok: false, errors: [expect.stringContaining(STUDENT_MOVE_PENDING)] });
    expect(posts()).toEqual([]);
    await dropItem(move.id);
    expect(await send()).toMatchObject({ ok: true });
    expect(posts().map((c) => JSON.parse(c.body) as Record<string, unknown>)).toEqual([expect.objectContaining({ Id: "12", Active: false })]);
  });
});

describe("a guardian's items, and the changes a later one closes", () => {
  connected();
  let anaRow: string;
  beforeEach(async () => { anaRow = (await seedAnaRivera()).row.id; });
  const CONTACT = (): RosterWrite => ({ op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: anaRow });
  const CREATE = (): RosterWrite => ({ op: "create", role: "parent", name: "Ana Rivera", typeQboId: "2", familyQboId: "10", email: "ana@example.com", guardianId: anaRow });

  it("a row's waiting change, its standing, whether it may send, and its kept details answer as for an empty queue (itemsOfRow(), guardianMaySend(), keptContactsOf())", async () => {
    const rows = [{ guardianId: anaRow, familyId: rivera, name: "Ana Rivera", open: true }];
    const read = async () => ({
      waiting: await db.transaction((tx) => guardianChangeWaiting(tx, [anaRow])),
      standings: await guardianStandings(rows),
      // A row of an unlinked family may send only for an item of its own on the queue.
      maySend: await guardianMaySend([{ guardianId: anaRow, familyId: null }]),
      kept: await keptContactsOf([anaRow]),
    });
    const empty = await read();
    await oldInEvery(CREATE());
    await oldInEvery(CONTACT());
    expect(await read()).toEqual(empty);
    await seedQueued(CREATE());
    const kept = await seedQueued(CONTACT(), { state: "refused", code: "fault_6000", nextTryAt: null });
    const now = await read();
    expect(now.waiting).toBe(true);
    expect([empty.maySend, now.maySend]).toEqual([false, true]);
    expect(now.standings).not.toEqual(empty.standings);
    expect(now.kept).toEqual(new Map([[anaRow, kept.id]]));
  });

  it("a contact change done closes the roster's company's earlier ones only (closeEarlierContacts())", async () => {
    const earlier = new Date(Date.now() - 60_000);
    await oldInEvery(CONTACT(), { createdAt: earlier });
    const before = await seedQueued(CONTACT(), { createdAt: earlier });
    const done = await seedQueued(CONTACT(), { state: "done" });
    await db.transaction((tx) => closeEarlierContacts(tx, done, { actor: WORKER.actor, ip: null }));
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, before.id)))[0]).toMatchObject({ state: "given_up" });
    expect((await oldItems()).map((i) => i.state).sort()).toEqual(["refused", "stuck", "waiting"]);
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([before.id]);
  });

  it("a kept create replaced by a later change to the same record closes the roster's company's only (replaceRefused())", async () => {
    const keptOld = await old(STUDENT_CREATE, { state: "refused", code: "fault_6000", nextTryAt: null });
    await fileUnder(keptOld.id, leo);
    const kept = await seedQueued(STUDENT_CREATE, { state: "refused", code: "fault_6000", nextTryAt: null });
    await fileUnder(kept.id, leo);
    const replaced = await db.transaction((tx) => replaceRefusedCreates(tx, leo, { op: "test" }, { actor: WORKER.actor, ip: null }));
    expect(replaced).toEqual([kept.id]);
    expect((await oldItems())).toEqual([expect.objectContaining({ id: keptOld.id, state: "refused" })]);
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
  });
});

describe("the pages", () => {
  connected();
  beforeEach(async () => { asStaff(await staffWith("reader@club.org", ["Roster.Read"])); });

  it("Reconciliation and a family's page list the current item only, loadOpenWrites() by family too", async () => {
    await oldInEvery(RENAME_LEO("Leon Old"));
    const current = await seedQueued(RENAME_LEO("Leon New"));
    expect((await loadOpenWrites({ familyId: rivera })).map((i) => i.id)).toEqual([current.id]);
    for (const html of [await renderPage(ReconciliationPage), await renderPage(RosterEntryPage, { params: { id: String(rivera) } })]) {
      expect(html).toContain("Leon New");
      expect(html).not.toContain("Leon Old");
    }
  });

  it("the staff home counts the current items only", async () => {
    await seedQueued(RENAME_LEO("Leon New"));
    await oldInEvery(RENAME_LEO("Leon Old"));
    const html = await renderPage(StaffHome);
    expect(html).toContain("1 change waiting to reach QuickBooks");
    expect(html).not.toContain("stuck on its way to QuickBooks");
    expect(html).not.toContain("kept in the portal that QuickBooks");
  });

  it("Health counts the current items only", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    await seedQueued(RENAME_LEO("Leon New"));
    await oldInEvery(RENAME_LEO("Leon Old"));
    const html = await renderPage(HealthPage);
    expect(html).toContain("1 waiting to reach QuickBooks, 0 stuck.");
    expect(html).not.toContain("kept in the portal that QuickBooks");
  });
});

// The accounting links screen and its presses: fznCompany() with May Chen 22 (Parent, under the Chen Family 20), as
// tests/integration/accounting-guardian-links.test.ts has it; Mei Chen is added by staff to the Chens, unlinked.
const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const withMay = () => {
  const c = fznCompany();
  c.customers.push(qc("22", "May Chen", "2", { ...under("20"), PrimaryEmailAddr: { Address: "may@example.com" } }));
  return c;
};
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
/** A view as plain data (its Maps and Sets as entries), for comparing two reads of it. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (x instanceof Map ? [...x.entries()] : x instanceof Set ? [...x] : x))) as unknown;
const guardianIn = (view: LinksView, familyName: string, person: string): GuardianShown => {
  const g = rowOf(view, familyName).guardians.find((x) => x.name === person);
  if (!g) throw new Error(`no guardian ${person} in ${familyName}`);
  return g;
};

describe("the accounting links screen and its presses", () => {
  connected(withMay());
  let linker: Awaited<ReturnType<typeof staffWith>>;
  let meiRow: string, anaRow: string;
  const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
  const chenLinkId = async () => (await db.select().from(accountingLink).where(eq(accountingLink.familyId, chen)))[0]!.id;
  beforeEach(async () => {
    linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    anaRow = (await seedAnaRivera()).row.id;
    const mei = await addGuardian(chen, { name: "Mei Chen", email: "mei@example.com" }, asOp(await staffWith("people@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"])));
    if (!mei.ok) throw new Error("Mei Chen wasn't added");
    meiRow = mei.guardianId;
    expect(await db.select().from(writeQueue)).toEqual([]);
    stub.calls.length = 0;
  });
  const MEI_CREATE = (): RosterWrite => ({ op: "create", role: "parent", name: "Mei Chen", typeQboId: "2", familyQboId: "20", email: "mei@example.com", guardianId: meiRow });
  const RENAME_MEI: RosterWrite = { op: "rename", role: "parent", qboId: "21", syncToken: "0", name: "M. Chen", was: "Mei Chen" };
  const RENAME_ANA: RosterWrite = { op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "A. Rivera", was: "Ana Rivera" };
  const pressMei = async () => linkGuardian({ guardianId: meiRow, customerId: "21", chosen: "suggested", stamp: guardianLinkStamp(meiRow, await chenLinkId(), "21", "suggested") }, tag, linkOp());

  it("the screen and its page answer as for an empty queue (readLinkBasics() and what reads loadOpenWrites())", async () => {
    asStaff(linker);
    const empty = await loadAccountingLinks();
    const emptyData = plain(empty);
    const page = withoutIds(await renderPage(AccountingLinksPage));
    await oldInEvery(MEI_CREATE());
    await oldInEvery(RENAME_MEI);
    await oldInEvery({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" });
    await oldInEvery({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" });
    expect(plain(await loadAccountingLinks())).toEqual(emptyData);
    expect(withoutIds(await renderPage(AccountingLinksPage))).toEqual(page);
    expect(guardianIn(empty, "Chen Family", "Mei Chen")).toMatchObject({ offer: { suggested: "21" } });
    await seedQueued(MEI_CREATE());
    expect(guardianIn(await loadAccountingLinks(), "Chen Family", "Mei Chen")).toMatchObject({ offer: null, linkHeld: { row: 1, customers: 0 } });
    expect(withoutIds(await renderPage(AccountingLinksPage))).not.toEqual(page);
  });

  it("a take and a send on a real difference are held back by the roster's company's items only (takeOffersOf(), sendFactsOf(), sendOffersOf())", async () => {
    // The books have Leo under the Chens (a read: the portal's records stay as they were), so the Rivera row offers to
    // take QuickBooks' place into the app and to send the portal's to the books.
    stub.customers = stub.customers.map((c) => (c.Id === "12" ? { ...c, ParentRef: { value: "20" }, Job: true, SyncToken: "1" } : c));
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    const RENAME_RIVERA: RosterWrite = { op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" };
    await oldInEvery(RENAME_RIVERA);
    await oldInEvery(MOVE_LEO(rivera, chen));
    const placeOffers = async () => {
      const r = rowOf(await loadAccountingLinks(), "Rivera Family");
      const at = r.differences.findIndex((d) => d.kind === "place");
      expect(at).toBeGreaterThanOrEqual(0);
      return { take: r.takes.some((t) => t.field === "place"), send: r.sends.some((s) => s.field === "place"),
        notes: [...r.takeNotes, ...r.sendNotes].filter((n) => n.at === at).map((n) => n.words) };
    };
    expect(await placeOffers()).toEqual({ take: true, send: true, notes: [] });
    await seedQueued(RENAME_RIVERA);
    expect(await placeOffers()).toEqual({ take: false, send: false, notes: [QUEUE_IN_THE_WAY, QUEUE_IN_THE_WAY_OF_SEND] });
  });

  it("Link this guardian (linkGuardian()'s two queries)", async () => {
    await oldInEvery(MEI_CREATE());
    await oldInEvery(RENAME_MEI);
    const create = await seedQueued(MEI_CREATE());
    expect(await pressMei()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.rowWaiting(1)] });
    await dropItem(create.id);
    const rename = await seedQueued(RENAME_MEI);
    expect(await pressMei()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.customerWaiting(1)] });
    await dropItem(rename.id);
    expect(await pressMei()).toMatchObject({ ok: true });
  });

  it("Unlink this guardian (unlinkGuardian()'s two queries: nothing holds it back, and no change of their details is said)", async () => {
    const g = guardianIn(await loadAccountingLinks(), "Rivera Family", "Ana Rivera");
    const press = () => unlinkGuardian({ guardianId: anaRow, linkId: g.unlink!.linkId, stamp: g.unlink!.stamp }, tag, linkOp());
    await oldInEvery(RENAME_ANA);
    await oldInEvery({ op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: anaRow });
    const rename = await seedQueued(RENAME_ANA);
    expect(await press()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.unlinkWaiting(1)] });
    await dropItem(rename.id);
    expect(await press()).toEqual({ ok: true, message: guardianUnlinkedWords({ who: "Ana Rivera", customer: "Ana Rivera", details: { waiting: 0, held: 0 }, relink: true }), familyId: rivera });
  });

  it("Unlink from the books (unlinkFamily()'s three queries)", async () => {
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    const press = () => unlinkFamily({ familyId: String(row.familyId), linkId: row.unlink!.linkId, stamp: row.unlink!.stamp }, tag, linkOp());
    await oldInEvery(MOVE_LEO(rivera, chen));
    await oldInEvery({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" });
    await oldInEvery({ op: "contact", role: "family", qboId: "10", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" } });
    const move = await seedQueued(MOVE_LEO(rivera, chen));
    expect(await press()).toEqual({ ok: false, errors: [LINK_COPY.unlinkMoving(1)] });
    await dropItem(move.id);
    const rename = await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" });
    expect(await press()).toEqual({ ok: false, errors: [LINK_COPY.unlinkWaiting(1)] });
    await dropItem(rename.id);
    const r = await press();
    expect(r).toMatchObject({ ok: true });
    expect((r as { message: string }).message).not.toMatch(/of (their|guardians') details/);
  });

  it("the accounting links screen counts no family's create of an earlier company as filed (familyCreatesFiled())", async () => {
    const empty = await familyCreatesFiled();
    for (const state of ["waiting", "stuck"] as const) await old(FAMILY_CREATE("Rivera Family"), { familyId: rivera, state });
    expect(await familyCreatesFiled()).toEqual(empty);
    await seedQueued(FAMILY_CREATE("Rivera Family"), { familyId: rivera });
    expect(await familyCreatesFiled()).toEqual([{ write: FAMILY_CREATE("Rivera Family"), familyId: String(rivera) }]);
  });
});

describe("a confirm's kept moves into the family (keptMovesInto())", () => {
  connected();
  const KEPT_WORDS = "A student's move into this family, kept on Reconciliation only because the family had no customer in the books, can now be sent from there.";
  let linker: Awaited<ReturnType<typeof staffWith>>;
  let patels: AppFamilyId;
  const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
  beforeEach(async () => {
    linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    stub.customers.push(qc("70", "Patel Family", "1", { PrimaryEmailAddr: { Address: "asha@example.com" } }));
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    tag = await currentRosterTag();
    expect(await addFamily({ role: "family", name: "The Patels", typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
    patels = (await db.select().from(family).where(eq(family.name, "The Patels")))[0]!.id;
    const p = await seedParent({ name: "Asha Patel", email: "asha@example.com" });
    await db.insert(guardian).values({ parentId: p.id, familyId: patels, status: "invited" });
  });
  const KEPT_MOVE = (): RosterWrite => ({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "", fromFamilyId: rivera, toFamilyId: patels });
  const confirm = async () => linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp }, tag, linkOp());

  it("an earlier company's is never counted", async () => {
    await old(KEPT_MOVE(), { state: "refused", code: NO_FAMILY_CUSTOMER, nextTryAt: null });
    const r = await confirm();
    expect(r).toMatchObject({ ok: true });
    expect((r as { message: string }).message).not.toContain(KEPT_WORDS);
  });

  it("the roster's company's is", async () => {
    await seedQueued(KEPT_MOVE(), { state: "refused", code: NO_FAMILY_CUSTOMER, nextTryAt: null });
    expect(await confirm()).toMatchObject({ ok: true, message: expect.stringContaining(KEPT_WORDS) });
  });
});
