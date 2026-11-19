import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, qboConnection, qboCustomerType, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { addFamily, changeInPortal, createInQuickBooksAndLink, FAMILY_SENDING, FAMILY_WAITING, studentsBeingMade, WRITE_COPY } from "@/lib/roster/writes";
import { CUSTOMER_HAS_FAMILY, FAMILY_HAS_CUSTOMER, giveUp, loadMadeAfterGivingUp, runWriteQueue, tryAgainNow, TRY_AGAIN_NEEDS_LINKING } from "@/lib/roster/queue";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { customersWithNoFamily } from "@/lib/roster/no-family";
import { refreshRoster } from "@/lib/roster/refresh";
import { addGuardian } from "@/lib/parents/guardians";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";

/**
 * Families by hand (stage 3's slice 9d of the app-owned families spec, section 4: "Staff add families, students and
 * guardians in the app. These start unlinked."): a family staff add is the portal's own record first, sent to
 * QuickBooks only by someone who may link families to accounting (the owner's decision of 2026-11-18); a family with
 * no link is changed in the portal only; "Create in QuickBooks and link" makes its customer, and its students', later.
 * Nothing here runs the import (syncAppRecords()) after a family is added: a whole run of it makes a family with no
 * link inactive, which stage 4 takes up.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const sent = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const familyNamed = async (name: string) => (await db.select().from(family).where(eq(family.name, name)))[0];
const linkOfFamily = async (id: AppFamilyId) => (await db.select().from(accountingLink).where(eq(accountingLink.familyId, id)))[0];
const linkOfStudent = async (id: AppStudentId) => (await db.select().from(accountingLink).where(eq(accountingLink.studentId, id)))[0];
const familyLinks = () => db.select().from(accountingLink).where(isNotNull(accountingLink.familyId));
const studentsOf = async (id: AppFamilyId) => db.select().from(student).where(eq(student.familyId, id)).orderBy(asc(student.name));
const stubNamed = (name: string) => stub.customers.filter((c) => c.DisplayName === name);
const ago = (ms: number) => new Date(Date.now() - ms);
const OAK_CREATE = { op: "create" as const, role: "family" as const, name: "Oak Family", typeQboId: "1", familyQboId: null, email: null };
/** What "Create in QuickBooks and link" answers when QuickBooks made the family's customer for a create given up. */
const MADE_ANYWAY = "QuickBooks made the customer “Oak Family” for this family before making it was given up on the Reconciliation page";

let tag: string;
let op: ReturnType<typeof asOp>;
const linker = () => ({ ...op, mayLink: true });
const nonLinker = () => ({ ...op, mayLink: false });
/** A family added in the portal only (by a staff member who may not link it), with these students added there too. */
async function unlinkedFamily(name: string, students: string[] = []): Promise<AppFamilyId> {
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, nonLinker())).toMatchObject({ ok: true, unlinked: true });
  const id = (await familyNamed(name))!.id;
  for (const s of students) expect(await changeInPortal({ op: "add_student", familyId: String(id), name: s }, tag, op)).toMatchObject({ ok: true });
  return id;
}

beforeEach(async () => {
  await resetDb(); stub.reset();
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
  tag = await connectRoster(stub);
  stub.calls.length = 0;
});

describe("adding a family: the portal's own record first, sent to QuickBooks only by someone who may link", () => {
  it("a holder's add is saved, made in QuickBooks once and linked to it: one customer, one link", async () => {
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker())).toEqual({ ok: true, message: "Oak Family is saved in the portal, made in QuickBooks and linked to its new customer." });
    expect(sent()).toEqual([{ DisplayName: "Oak Family", CustomerTypeRef: { value: "1" } }]);
    const oak = (await familyNamed("Oak Family"))!;
    expect(stubNamed("Oak Family")).toHaveLength(1);
    expect(await linkOfFamily(oak.id)).toMatchObject({ customerId: stubNamed("Oak Family")[0]!.Id, origin: "created", linkedBy: op.staffUserId, realmId: REALM });
    expect((await familyLinks()).filter((l) => l.customerId === stubNamed("Oak Family")[0]!.Id)).toHaveLength(1);
  });

  it("without the linking permission: saved, active and unlinked, nothing sent, and the answer says why", async () => {
    const r = await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, nonLinker());
    expect(r).toEqual({ ok: true, unlinked: true, message: expect.stringContaining("nothing was sent to QuickBooks: making its customer there and linking the two takes the permission to link families to accounting") });
    expect(stub.apiCalls()).toEqual([]);
    const oak = (await familyNamed("Oak Family"))!;
    expect(oak).toMatchObject({ active: true });
    expect(await linkOfFamily(oak.id)).toBeUndefined();
    expect((await auditsOf("roster.family.added"))[0]).toMatchObject({ targetType: "family", targetId: String(oak.id), after: { name: "Oak Family", quickbooks: "no_permission" } });
    expect(await db.select().from(writeQueue)).toEqual([]);
  });

  it("disconnected: saved and unlinked, nothing sent, and the words say QuickBooks isn't connected", async () => {
    await db.delete(qboConnection);
    const r = await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker());
    expect(r).toEqual({ ok: true, unlinked: true, message: expect.stringContaining("QuickBooks isn't connected, so it isn't in QuickBooks yet") });
    expect(stub.apiCalls()).toEqual([]);
    expect(await familyNamed("Oak Family")).toMatchObject({ active: true });
  });

  it("a name another active family of the portal holds is refused, nothing saved, with Name (2) offered", async () => {
    await unlinkedFamily("Oak Family");
    const before = (await db.select().from(family)).length;
    expect(await addFamily({ role: "family", name: " oak  family ", typeQboId: null }, tag, nonLinker())).toEqual({ ok: false, offer: "oak family (2)",
      errors: ["Another family in the portal is called “oak family”, and every family's name must be different. You could use “oak family (2)” instead."] });
    expect(await db.select().from(family)).toHaveLength(before);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a name the cache holds is refused before anything is saved, when it would be sent", async () => {
    const before = (await db.select().from(family)).length;
    expect(await addFamily({ role: "family", name: "Lincoln High", typeQboId: null }, tag, linker())).toMatchObject({ ok: false, offer: "Lincoln High (2)" });
    expect(await db.select().from(family)).toHaveLength(before);
    expect(posts()).toEqual([]);
  });

  it("a name the cache holds is saved when nothing will be sent (no linking permission), and met at Create in QuickBooks and link", async () => {
    expect(await addFamily({ role: "family", name: "Lincoln High", typeQboId: null }, tag, nonLinker())).toMatchObject({ ok: true, unlinked: true });
    const lincoln = (await familyNamed("Lincoln High"))!;
    expect(lincoln).toMatchObject({ active: true });
    expect(await linkOfFamily(lincoln.id)).toBeUndefined();
    expect((await createInQuickBooksAndLink(String(lincoln.id), null, tag, op)).result).toEqual({ ok: false, errors: [expect.stringContaining("for instance to “Lincoln High (2)”")] });
    expect(posts()).toEqual([]);
  });

  it("refuses, saving nothing, while QuickBooks is connected to another company than the roster's", async () => {
    await db.update(qboConnection).set({ realmId: "9999" });
    const before = (await db.select().from(family)).length;
    for (const o of [linker(), nonLinker()]) expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, o)).toEqual({ ok: false, errors: [WRITE_COPY.noRoster] });
    expect(await db.select().from(family)).toHaveLength(before);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("refused by QuickBooks with a fault: the family stays, unlinked, and the staff member is told at once", async () => {
    stub.updateFault = "6000";
    const r = await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker());
    expect(r).toEqual({ ok: true, unlinked: true, message: "Oak Family is saved in the portal, but it isn't in QuickBooks: QuickBooks wouldn't take it. Check QuickBooks. Once that is sorted, press “Create in QuickBooks and link” on its page." });
    const oak = (await familyNamed("Oak Family"))!;
    expect(oak).toMatchObject({ active: true });
    expect(await linkOfFamily(oak.id)).toBeUndefined();
    expect(await db.select().from(writeQueue)).toEqual([]);
  });

  it("unreachable: waits on the queue filed under the record, and the worker links that record once QuickBooks takes it", async () => {
    stub.dropApi = true;
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker())).toMatchObject({ ok: true, queued: true });
    stub.dropApi = false;
    const oak = (await familyNamed("Oak Family"))!;
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", familyId: oak.id, studentId: null, sent: true, request: { op: "create", role: "family", name: "Oak Family" } });
    await db.update(writeQueue).set({ nextTryAt: ago(1000) });
    await runWriteQueue();
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(stubNamed("Oak Family")).toHaveLength(1);
    expect(await linkOfFamily(oak.id)).toMatchObject({ customerId: stubNamed("Oak Family")[0]!.Id, origin: "created", linkedBy: op.staffUserId });
    expect(await db.select().from(family).where(eq(family.name, "Oak Family"))).toHaveLength(1);
  });

  it("a lost answer is held as possibly made, found after the next read, linked, and never sent again", async () => {
    stub.loseUpdateAnswer = true;
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker())).toMatchObject({ ok: true, queued: true });
    stub.loseUpdateAnswer = false;
    const oak = (await familyNamed("Oak Family"))!;
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ sent: true, familyId: oak.id });
    await db.update(writeQueue).set({ nextTryAt: ago(1000) });
    await runWriteQueue();
    expect(posts()).toHaveLength(1); // the first try only
    expect(await queueItem(item!.id)).toMatchObject({ state: "done", resultQboId: stubNamed("Oak Family")[0]!.Id });
    expect(await linkOfFamily(oak.id)).toMatchObject({ customerId: stubNamed("Oak Family")[0]!.Id, origin: "created" });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found", appRecord: { kind: "family", familyId: String(oak.id), linked: true } });
  });

  it("a customer a waiting create would be found as is no customer with no family; found linked to another family meanwhile, the item is stuck with its own code", async () => {
    stub.loseUpdateAnswer = true;
    await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker());
    stub.loseUpdateAnswer = false;
    const oak = (await familyNamed("Oak Family"))!;
    const [item] = await db.select().from(writeQueue);
    // A read shows the customer QuickBooks made: the queue is about to link it, so Reconciliation doesn't offer it.
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    const made = stubNamed("Oak Family")[0]!.Id as string;
    const list = await customersWithNoFamily();
    expect(list.state === "listed" && list.customers.map((c) => c.qboId)).not.toContain(made);
    // Had another family been linked to it meanwhile (as a link made before this slice could be), no second link is made.
    const [other] = await db.insert(family).values({ name: "Another Oak", active: true }).returning({ id: family.id });
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: made, familyId: other!.id, origin: "confirmed", linkedBy: op.staffUserId });
    await db.update(writeQueue).set({ nextTryAt: ago(1000) });
    expect(await runWriteQueue()).toMatchObject({ ok: true });
    expect(await queueItem(item!.id)).toMatchObject({ state: "stuck", lastCode: CUSTOMER_HAS_FAMILY, resultQboId: made });
    expect(await linkOfFamily(oak.id)).toBeUndefined();
    expect((await familyLinks()).filter((l) => l.customerId === made)).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it("while a family's own create waits, nothing else is changed on it: students, names, inactive, guardians and Create in QuickBooks and link", async () => {
    stub.dropApi = true;
    await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker());
    stub.dropApi = false;
    expect(posts()).toHaveLength(1); // the create itself, dropped: nothing after it may send anything
    stub.calls.length = 0;
    const oak = String((await familyNamed("Oak Family"))!.id);
    for (const ask of [{ op: "add_student" as const, familyId: oak, name: "Ash Oak" }, { op: "rename_family" as const, familyId: oak, name: "Oak Household" }, { op: "deactivate_family" as const, familyId: oak }]) {
      expect(await changeInPortal(ask, tag, op), ask.op).toEqual({ ok: false, errors: [FAMILY_WAITING] });
    }
    expect((await createInQuickBooksAndLink(oak, null, tag, op)).result).toEqual({ ok: false, errors: [FAMILY_WAITING] });
    expect(await addGuardian((await familyNamed("Oak Family"))!.id, { name: "Ann Oak", email: "ann@example.com" }, op)).toEqual({ ok: false, reason: "waiting" });
    expect(posts()).toEqual([]);
  });

  it("while a family's create is on its way to QuickBooks, nothing else is changed on it, so no second customer can be made", async () => {
    // At the moment QuickBooks receives the create, before it answers: a rename, a make-inactive, a second "Create in
    // QuickBooks and link" and a guardian are each tried, as staff on another page could.
    const tried: unknown[] = [];
    stub.onApiRequest = async (call) => {
      if (call.method !== "POST") return;
      stub.onApiRequest = null;
      const oak = (await familyNamed("Oak Family"))!.id;
      tried.push(await changeInPortal({ op: "rename_family", familyId: String(oak), name: "Oak Household" }, tag, op));
      tried.push(await changeInPortal({ op: "deactivate_family", familyId: String(oak) }, tag, op));
      tried.push((await createInQuickBooksAndLink(String(oak), null, tag, op)).result);
      tried.push(await addGuardian(oak, { name: "Ann Oak", email: "ann@example.com" }, op));
    };
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, linker())).toMatchObject({ ok: true, message: expect.stringContaining("linked to its new customer") });
    expect(tried).toEqual([{ ok: false, errors: [FAMILY_SENDING] }, { ok: false, errors: [FAMILY_SENDING] }, { ok: false, errors: [FAMILY_SENDING] }, { ok: false, reason: "making" }]);
    expect(posts()).toHaveLength(1);
    expect(stubNamed("Oak Family")).toHaveLength(1);
    const oak = (await familyNamed("Oak Family"))!;
    expect(oak).toMatchObject({ active: true });
    expect(await linkOfFamily(oak.id)).toMatchObject({ customerId: stubNamed("Oak Family")[0]!.Id });
    // Once the answer is in, the family is changed as any linked one is.
    expect(await changeInPortal({ op: "rename_family", familyId: String(oak.id), name: "Oak Household" }, tag, op)).toMatchObject({ ok: false, errors: [expect.stringContaining("linked to QuickBooks")] });
  });

  it("a waiting create found made while its family was linked to another customer meanwhile makes no second link, and is stuck with its own code", async () => {
    const oak = await unlinkedFamily("Oak Family");
    stub.customers.push({ Id: "77", SyncToken: "0", DisplayName: "Oak Family", Active: true, CustomerTypeRef: { value: "1" } });
    const item = await seedQueued({ op: "create", role: "family", name: "Oak Family", typeQboId: "1", familyQboId: null, email: null },
      { familyId: oak, sent: true, code: "unreachable", lastTriedAt: new Date(), nextTryAt: ago(1000) });
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "78", familyId: oak, origin: "confirmed", linkedBy: op.staffUserId });
    expect(await runWriteQueue()).toMatchObject({ ok: true });
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: FAMILY_HAS_CUSTOMER, resultQboId: "77" });
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, oak))).map((l) => l.customerId)).toEqual(["78"]);
    expect((await familyLinks()).filter((l) => l.customerId === "77")).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("refuses, saving nothing, on a page shown another company's roster", async () => {
    const before = (await db.select().from(family)).length;
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, "an-old-tag", linker())).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    const oak = await unlinkedFamily("Ash Family");
    expect(await changeInPortal({ op: "rename_family", familyId: String(oak), name: "Ash Household" }, "an-old-tag", op)).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    expect(await db.select().from(family)).toHaveLength(before + 1);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("flat books: a holder's member is made of the type chosen and linked; without the permission, no type is asked", async () => {
    await resetDb(); stub.reset();
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    stub.calls.length = 0;
    expect(await addFamily({ role: "member", name: "Sky Lee", typeQboId: null }, tag, linker())).toEqual({ ok: false, errors: ["Choose which kind of member this is."] });
    expect(await addFamily({ role: "member", name: "Sky Lee", typeQboId: "3" }, tag, linker())).toMatchObject({ ok: true, message: expect.stringContaining("linked to its new customer") });
    expect(sent()).toEqual([{ DisplayName: "Sky Lee", CustomerTypeRef: { value: "3" } }]);
    expect(await linkOfFamily((await familyNamed("Sky Lee"))!.id)).toMatchObject({ origin: "created" });
    expect(await addFamily({ role: "member", name: "Ray Lee", typeQboId: null }, tag, nonLinker())).toMatchObject({ ok: true, unlinked: true });
    expect(posts()).toHaveLength(1);
  });
});

describe("Create in QuickBooks and link", () => {
  it("makes the family, then its students one by one in name order, each linked to its record; one audit row", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Zed Oak", "Amy Oak"]);
    const [amy, zed] = await studentsOf(oak);
    const r = await createInQuickBooksAndLink(String(oak), null, tag, op);
    expect(r).toEqual({ changed: true, result: { ok: true, message: "Made in QuickBooks and linked: Oak Family, Amy Oak and Zed Oak." } });
    const familyCustomer = stubNamed("Oak Family")[0]!.Id as string;
    expect(sent()).toEqual([{ DisplayName: "Oak Family", CustomerTypeRef: { value: "1" } },
      { DisplayName: "Amy Oak", CustomerTypeRef: { value: "3" }, ParentRef: { value: familyCustomer }, Job: true, BillWithParent: true },
      { DisplayName: "Zed Oak", CustomerTypeRef: { value: "3" }, ParentRef: { value: familyCustomer }, Job: true, BillWithParent: true }]);
    expect(await linkOfFamily(oak)).toMatchObject({ customerId: familyCustomer, origin: "created", linkedBy: op.staffUserId });
    expect(await linkOfStudent(amy!.id)).toMatchObject({ customerId: stubNamed("Amy Oak")[0]!.Id, origin: "created" });
    expect(await linkOfStudent(zed!.id)).toMatchObject({ customerId: stubNamed("Zed Oak")[0]!.Id, origin: "created" });
    // The records it linked, none made beside them.
    expect(await studentsOf(oak)).toHaveLength(2);
    expect(await auditsOf("roster.customer.create")).toHaveLength(3);
    const [row] = await auditsOf("roster.family.created_in_quickbooks");
    expect(row).toMatchObject({ targetType: "family", targetId: String(oak), after: { outcome: "done", notMade: [],
      made: [{ kind: "family", id: String(oak), customerQboId: familyCustomer }, { kind: "student", id: String(amy!.id) }, { kind: "student", id: String(zed!.id) }] } });
    // Nothing left to make.
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toMatchObject({ ok: false });
  });

  it("stops at the first step that doesn't go through, says what was made and why, and pressing again carries on", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Amy Oak", "Zed Oak"]);
    stub.otherNames = ["Zed Oak"]; // an employee has the name: QuickBooks refuses it (6240)
    const r = await createInQuickBooksAndLink(String(oak), null, tag, op);
    expect(r.changed).toBe(true);
    expect(r.result).toEqual({ ok: false, errors: ["Made in QuickBooks and linked: Oak Family and Amy Oak.",
      "“Zed Oak” is already a name in QuickBooks, and every name there must be different, so Zed Oak wasn't made there. Rename them on this page, for instance to “Zed Oak (2)”, then press “Create in QuickBooks and link” again.",
      "Not made in QuickBooks yet: Zed Oak.", "Press “Create in QuickBooks and link” again to carry on with whatever is still unlinked."] });
    expect((await auditsOf("roster.family.created_in_quickbooks"))[0]!.after).toMatchObject({ outcome: "stopped", code: "fault_6240", stoppedAt: { kind: "student" } });
    stub.otherNames = [];
    stub.calls.length = 0;
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: true, message: "Made in QuickBooks and linked: Zed Oak." });
    expect(sent()).toEqual([{ DisplayName: "Zed Oak", CustomerTypeRef: { value: "3" }, ParentRef: { value: stubNamed("Oak Family")[0]!.Id }, Job: true, BillWithParent: true }]);
    expect(stubNamed("Oak Family")).toHaveLength(1);
  });

  it("a lost answer is held on the queue as possibly made, never sent again from here, and the family waits for it", async () => {
    const oak = await unlinkedFamily("Oak Family");
    stub.loseUpdateAnswer = true;
    const r = await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.loseUpdateAnswer = false;
    expect(r.result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining("The portal can't tell whether QuickBooks made Oak Family")]) });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, familyId: oak, studentId: null });
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [FAMILY_WAITING] });
    // The worker finds it after the next read and links the record.
    await db.update(writeQueue).set({ nextTryAt: ago(1000) });
    await runWriteQueue();
    expect(await linkOfFamily(oak)).toMatchObject({ customerId: stubNamed("Oak Family")[0]!.Id });
    expect(posts()).toHaveLength(1);
  });

  it("a student's lost answer is held filed under the family and that student, left out of what wasn't made, and linked to the student's record by the found-done path", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Amy Oak"]);
    const [amy] = await studentsOf(oak);
    // The family's create is answered; the student's is made, and its answer lost.
    let creates = 0;
    stub.onApiRequest = (call) => { if (call.method === "POST" && ++creates === 2) stub.loseUpdateAnswer = true; };
    const r = await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.onApiRequest = null; stub.loseUpdateAnswer = false;
    expect(r.result).toMatchObject({ ok: false, errors: expect.arrayContaining(["Made in QuickBooks and linked: Oak Family.", expect.stringContaining("The portal can't tell whether QuickBooks made Amy Oak")]) });
    expect((r.result as { errors: string[] }).errors.join(" ")).not.toContain("Not made in QuickBooks yet");
    expect((await auditsOf("roster.family.created_in_quickbooks"))[0]!.after).toMatchObject({ outcome: "stopped", notMade: [], maybe: true, stoppedAt: { kind: "student", id: String(amy!.id) } });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, familyId: oak, studentId: amy!.id, request: { op: "create", role: "student", name: "Amy Oak" } });
    // Changed nowhere meanwhile, and not offered on the family's page.
    expect(await changeInPortal({ op: "rename_student", studentId: String(amy!.id), name: "Amy Oakes" }, tag, op)).toEqual({ ok: false, errors: [expect.stringContaining("Making this student in QuickBooks is still waiting on the queue")] });
    expect(await studentsBeingMade([amy!.id])).toEqual(new Set([String(amy!.id)]));
    await db.update(writeQueue).set({ nextTryAt: ago(1000) });
    await runWriteQueue();
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(await linkOfStudent(amy!.id)).toMatchObject({ customerId: stubNamed("Amy Oak")[0]!.Id, origin: "created" });
    expect(await studentsOf(oak)).toHaveLength(1);
    expect(posts()).toHaveLength(2);
  });

  it("a student's name QuickBooks' names hold (a waiting rename's) stops the run before it is sent, with Name (2) offered", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Sam Oak"]);
    const [sam] = await studentsOf(oak);
    const rivera = stub.customers.find((c) => c.DisplayName === "Rivera Family")!;
    await seedQueued({ op: "rename", role: "family", qboId: rivera.Id as string, syncToken: String(rivera.SyncToken), name: "Sam Oak", was: "Rivera Family" }, { nextTryAt: null });
    const r = await createInQuickBooksAndLink(String(oak), null, tag, op);
    expect(r.result).toEqual({ ok: false, errors: ["Made in QuickBooks and linked: Oak Family.",
      "“Sam Oak” is already a name in QuickBooks, and every name there must be different, so Sam Oak wasn't made there. Rename them on this page, for instance to “Sam Oak (2)”, then press “Create in QuickBooks and link” again.",
      "Not made in QuickBooks yet: Sam Oak.", "Press “Create in QuickBooks and link” again to carry on with whatever is still unlinked."] });
    expect(sent().map((b) => b.DisplayName)).toEqual(["Oak Family"]);
    expect((await auditsOf("roster.family.created_in_quickbooks"))[0]!.after).toMatchObject({ code: "name_taken", notMade: [String(sam!.id)] });
  });

  it("adds nobody under a linked family's customer with a change of its own waiting", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Amy Oak"]);
    stub.otherNames = ["Amy Oak"];
    await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.otherNames = [];
    const customer = (await linkOfFamily(oak))!.customerId;
    await seedQueued({ op: "rename", role: "family", qboId: customer, syncToken: "0", name: "Oak Household", was: "Oak Family" }, { nextTryAt: null });
    stub.calls.length = 0;
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(posts()).toEqual([]);
  });

  it("giving up a student's create held as possibly made says the student stays in the portal, unlinked", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Amy Oak"]);
    let creates = 0;
    stub.onApiRequest = (call) => { if (call.method === "POST" && ++creates === 2) stub.loseUpdateAnswer = true; };
    await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.onApiRequest = null; stub.loseUpdateAnswer = false;
    const [item] = await db.select().from(writeQueue);
    const r = await giveUp(item!.id, "Checking it in QuickBooks", op);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("The student the portal saved first stays in the portal, unlinked") });
    expect((r as { message: string }).message).not.toContain("family the portal saved first");
  });

  it("QuickBooks too busy to take it (429): nothing queued, try again", async () => {
    const oak = await unlinkedFamily("Oak Family");
    stub.rateLimitNext = 1;
    const r = await createInQuickBooksAndLink(String(oak), null, tag, op);
    expect(r).toMatchObject({ changed: false, result: { ok: false, errors: expect.arrayContaining(["QuickBooks couldn't take that just now, so Oak Family wasn't made there. Try again in a few minutes."]) } });
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(await linkOfFamily(oak)).toBeUndefined();
  });

  it("a given-up create that may have been made waits for a roster read; one QuickBooks made is named, never linked, and no second customer is made", async () => {
    const oak = await unlinkedFamily("Oak Family");
    // QuickBooks made it at a try whose answer was lost; staff gave the item up before any read since.
    stub.customers.push({ Id: "77", SyncToken: "0", DisplayName: "Oak Family", Active: true, CustomerTypeRef: { value: "1" } });
    const item = await seedQueued(OAK_CREATE, { familyId: oak, sent: true, state: "given_up", lastTriedAt: new Date() });
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [expect.stringContaining("Once the roster has been read again")] });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    // The read shows it made: the answer points at it, offered under Customers with no family, rather than advising a
    // rename that would make a second customer.
    const r = (await createInQuickBooksAndLink(String(oak), null, tag, op)).result;
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining(MADE_ANYWAY)] });
    expect(JSON.stringify(r)).not.toContain("Oak Family (2)");
    expect(await loadMadeAfterGivingUp()).toEqual([expect.objectContaining({ queueId: item.id, role: "family", name: "Oak Family", customerQboId: "77", familyPage: oak })]);
    const list = await customersWithNoFamily();
    expect(list.state === "listed" && list.customers.map((c) => c.qboId)).toContain("77");
    expect(await linkOfFamily(oak)).toBeUndefined();
    // Made inactive in QuickBooks (not this family's after all): it is no longer named, and the name is met with another.
    stub.customers.find((c) => c.Id === "77")!.Active = false;
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    expect(await loadMadeAfterGivingUp()).toEqual([]);
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [expect.stringContaining("for instance to “Oak Family (2)”")] });
    expect(posts()).toEqual([]);
  });

  it("a create given up while the worker's send is on its way stays given up: nothing linked, its customer kept and named, and no second one made", async () => {
    const oak = await unlinkedFamily("Oak Family");
    const item = await seedQueued(OAK_CREATE, { familyId: oak, sent: false, code: "http_429", nextTryAt: ago(1000) });
    // At the moment QuickBooks receives the worker's create, before it answers, staff give the item up.
    let gaveUp: unknown = null;
    let markedSent: unknown = null;
    stub.onApiRequest = async (call) => {
      if (call.method !== "POST") return;
      stub.onApiRequest = null;
      markedSent = (await queueItem(item.id))!.sent;
      gaveUp = await giveUp(item.id, "Making it in QuickBooks by hand.", op);
    };
    expect(await runWriteQueue()).toMatchObject({ ok: true });
    expect(markedSent).toBe(true); // marked as maybe sent before it went
    expect(gaveUp).toMatchObject({ ok: true });
    const made = stubNamed("Oak Family")[0]!.Id as string;
    expect(await queueItem(item.id)).toMatchObject({ state: "given_up", sent: true, resultQboId: made });
    expect(await linkOfFamily(oak)).toBeUndefined();
    expect(await auditsOf("roster.write.done")).toEqual([]);
    const [create] = await auditsOf("roster.customer.create");
    expect(create!.after).toMatchObject({ queue: "given_up" });
    expect(create!.after).not.toHaveProperty("appRecord");
    // Named on Reconciliation, offered under Customers with no family, and "Create in QuickBooks and link" makes no second.
    expect(await loadMadeAfterGivingUp()).toEqual([expect.objectContaining({ queueId: item.id, name: "Oak Family", customerQboId: made, familyPage: oak })]);
    const list = await customersWithNoFamily();
    expect(list.state === "listed" && list.customers.map((c) => c.qboId)).toContain(made);
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [expect.stringContaining(MADE_ANYWAY)] });
    expect(posts()).toHaveLength(1);
    expect(stubNamed("Oak Family")).toHaveLength(1);
  });

  it("Try again now on a family's create takes the linking permission: refused without it, the item left as it was", async () => {
    const oak = await unlinkedFamily("Oak Family");
    const item = await seedQueued(OAK_CREATE, { familyId: oak, state: "stuck", nextTryAt: null, tries: 8 });
    for (const o of [op, nonLinker()]) expect(await tryAgainNow(item.id, o)).toEqual({ ok: false, errors: [TRY_AGAIN_NEEDS_LINKING] });
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck" });
    expect(await auditsOf("roster.write.again")).toEqual([]);
    expect(await tryAgainNow(item.id, linker())).toMatchObject({ ok: true });
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting" });
    expect(posts()).toEqual([]);
  });

  it("flat books with several member types: the kind is chosen, and checked", async () => {
    await resetDb(); stub.reset();
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    stub.calls.length = 0;
    expect(await addFamily({ role: "member", name: "Sky Lee", typeQboId: null }, tag, nonLinker())).toMatchObject({ ok: true, unlinked: true });
    const sky = String((await familyNamed("Sky Lee"))!.id);
    for (const type of [null, "1"]) expect((await createInQuickBooksAndLink(sky, type, tag, op)).result).toEqual({ ok: false, errors: ["Choose which kind of member this is."] });
    expect((await createInQuickBooksAndLink(sky, "2", tag, op)).result).toEqual({ ok: true, message: "Made in QuickBooks and linked: Sky Lee." });
    expect(sent()).toEqual([{ DisplayName: "Sky Lee", CustomerTypeRef: { value: "2" } }]);
  });

  it("books with no student type: the family alone, no student step", async () => {
    await resetDb(); stub.reset();
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } });
    stub.calls.length = 0;
    const oak = await unlinkedFamily("Oak Family");
    await db.insert(student).values({ familyId: oak, name: "Amy Oak", active: true });
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: true, message: "Made in QuickBooks and linked: Oak Family." });
    expect(sent()).toEqual([{ DisplayName: "Oak Family", CustomerTypeRef: { value: "1" } }]);
  });

  it("refuses an inactive family, a family that isn't there, a broken shape, another company, and anything while QuickBooks isn't connected", async () => {
    const oak = await unlinkedFamily("Oak Family");
    const ash = await unlinkedFamily("Ash Family");
    const result = async (id: string) => (await createInQuickBooksAndLink(id, null, tag, op)).result;
    expect(await result("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, errors: [WRITE_COPY.gone] });
    expect(await changeInPortal({ op: "deactivate_family", familyId: String(ash) }, tag, op)).toMatchObject({ ok: true });
    expect(await result(String(ash))).toEqual({ ok: false, errors: [WRITE_COPY.inactiveHere] });
    await db.update(qboConnection).set({ realmId: "9999" });
    expect(await result(String(oak))).toEqual({ ok: false, errors: [WRITE_COPY.otherCompany] });
    await db.update(qboConnection).set({ realmId: REALM });
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2")); // the shape's parent type, gone from QuickBooks
    expect(await result(String(oak))).toEqual({ ok: false, errors: [WRITE_COPY.noRoster] });
    expect(stub.apiCalls()).toEqual([]);
    await db.delete(qboConnection);
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("an unlinked family's own changes are saved in the portal only, and audited", () => {
  it("students added, renamed and made inactive; the family renamed and made inactive with its students; nothing sent", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Amy Oak", "Zed Oak"]);
    const [amy, zed] = await studentsOf(oak);
    expect(amy).toMatchObject({ name: "Amy Oak", active: true, familyId: oak });
    expect((await auditsOf("roster.student.added")).map((a) => a.targetId).sort()).toEqual([String(amy!.id), String(zed!.id)].sort());
    expect(await changeInPortal({ op: "rename_student", studentId: String(amy!.id), name: "Amy Oakes" }, tag, op)).toEqual({ ok: true, message: "Renamed Amy Oakes in the portal." });
    expect(await changeInPortal({ op: "deactivate_student", studentId: String(zed!.id) }, tag, op)).toEqual({ ok: true, message: "Made Zed Oak inactive in the portal." });
    expect(await changeInPortal({ op: "rename_family", familyId: String(oak), name: "Oak Household" }, tag, op)).toEqual({ ok: true, message: "Renamed Oak Household in the portal." });
    expect(await changeInPortal({ op: "deactivate_family", familyId: String(oak) }, tag, op)).toEqual({ ok: true, message: "Made Oak Household inactive in the portal, with its student." });
    expect(await db.select().from(family).where(eq(family.id, oak))).toEqual([expect.objectContaining({ name: "Oak Household", active: false })]);
    expect((await studentsOf(oak)).map((s) => [s.name, s.active])).toEqual([["Amy Oakes", false], ["Zed Oak", false]]);
    const renamed = await auditsOf("roster.record.renamed");
    expect(renamed.map((a) => [a.targetType, a.before, (a.after as { quickbooks: string }).quickbooks])).toEqual(expect.arrayContaining([["family", { name: "Oak Family" }, "not_sent"], ["student", { name: "Amy Oak" }, "not_sent"]]));
    expect((await auditsOf("roster.record.made_inactive")).find((a) => a.targetType === "family")!.after).toMatchObject({ students: [String(amy!.id)] });
    // Inactive now: refused.
    expect(await changeInPortal({ op: "rename_family", familyId: String(oak), name: "Oak Again" }, tag, op)).toEqual({ ok: false, errors: ["That is inactive in the portal, so nothing was changed."] });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a guardian is refused, not added with no customer, while QuickBooks is connected to another company and the portal can't tell a family's link", async () => {
    const rivera = (await familyNamed("Rivera Family"))!.id;
    await db.update(qboConnection).set({ realmId: "9999" });
    expect(await addGuardian(rivera, { name: "Ann Rivera", email: "ann.rivera@example.com" }, op)).toEqual({ ok: false, reason: "other_company" });
  });

  it("refuses a linked family or student, which go to QuickBooks first, and a name another family holds", async () => {
    const rivera = (await familyNamed("Rivera Family"))!.id;
    const [leo] = await studentsOf(rivera);
    const linked = { ok: false, errors: [expect.stringContaining("linked to QuickBooks, so it is changed there first")] };
    expect(await changeInPortal({ op: "rename_family", familyId: String(rivera), name: "Rivera Household" }, tag, op)).toEqual(linked);
    expect(await changeInPortal({ op: "add_student", familyId: String(rivera), name: "Rosa Rivera" }, tag, op)).toEqual(linked);
    expect(await changeInPortal({ op: "deactivate_family", familyId: String(rivera) }, tag, op)).toEqual(linked);
    expect(await changeInPortal({ op: "rename_student", studentId: String(leo!.id), name: "Leon Rivera" }, tag, op)).toEqual(linked);
    expect(await changeInPortal({ op: "deactivate_student", studentId: String(leo!.id) }, tag, op)).toEqual(linked);
    const oak = await unlinkedFamily("Oak Family");
    expect(await changeInPortal({ op: "rename_family", familyId: String(oak), name: "chen family" }, tag, op)).toMatchObject({ ok: false, offer: "chen family (2)" });
    expect(await changeInPortal({ op: "rename_family", familyId: "not-a-uuid", name: "Oak" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.gone] });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "roster.record.renamed")))).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a student with no link in a linked family (left by a stopped Create in QuickBooks and link) is renamed and made inactive in the portal only", async () => {
    const oak = await unlinkedFamily("Oak Family", ["Amy Oak"]);
    stub.otherNames = ["Amy Oak"];
    await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.otherNames = [];
    const [amy] = await studentsOf(oak);
    expect(await linkOfFamily(oak)).toBeDefined();
    expect(await linkOfStudent(amy!.id)).toBeUndefined();
    stub.calls.length = 0;
    expect(await changeInPortal({ op: "rename_student", studentId: String(amy!.id), name: "Amy Oak-Ash" }, tag, op)).toEqual({ ok: true, message: "Renamed Amy Oak-Ash in the portal." });
    expect(await changeInPortal({ op: "deactivate_student", studentId: String(amy!.id) }, tag, op)).toMatchObject({ ok: true });
    // The family itself is linked now: its own changes go to QuickBooks first.
    expect(await changeInPortal({ op: "add_student", familyId: String(oak), name: "Bo Oak" }, tag, op)).toMatchObject({ ok: false });
    expect(stub.apiCalls()).toEqual([]);
  });
});
