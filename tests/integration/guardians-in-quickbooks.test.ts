import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, parent, writeQueue } from "@/lib/db/schema";
import { addGuardian, reinstateGuardian, removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { askFamilyInactive, askRosterWrite, coverStamp, CREDIT_BALANCE, EMAIL_TOO_LONG, familyCover, GUARDIAN_HERE, GUARDIAN_PENDING, portalValueStamp, queueForGuardian, sendPortalValue } from "@/lib/roster/writes";
import { giveUp, loadOpenWrites, runWriteQueue } from "@/lib/roster/queue";
import type { AppFamilyId } from "@/lib/families/ids";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { saveShape } from "@/lib/roster/shape";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Stage 3's slice 9h: a guardian's own Parent customer follows the portal, where the books have a parent type and the
 * family is linked. The guardian's own change (the row, its access, its audit row) is exactly slice 7b's whatever
 * QuickBooks does; the Parent customer's change is queued with it and tried after it commits. Every request is the
 * stub's: `posts()` proves what was sent, and that nothing was where nothing may be.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const rowOf = async (id: string) => (await db.select().from(guardian).where(eq(guardian.id, id)))[0]!;
const linkOfRow = async (guardianId: string) => (await db.select().from(accountingLink).where(and(eq(accountingLink.guardianId, guardianId), isNotNull(accountingLink.guardianId))))[0];
const items = () => db.select().from(writeQueue);
const personNamed = async (email: string) => (await db.select().from(parent).where(eq(parent.email, email)))[0]!;

let tag: string;
let op: ReturnType<typeof asOp>;
let staffId: string;
let rivera: AppFamilyId, chen: AppFamilyId;
beforeEach(async () => {
  await resetDb(); stub.reset();
  tag = await connectRoster(stub);
  const staff = await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]);
  op = asOp(staff); staffId = staff.id;
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
  stub.calls.length = 0;
});

describe("adding a guardian (item 2)", () => {
  it("Mei Chen: QuickBooks has a customer of her name under the Chen family, so nothing is sent, kept or linked", async () => {
    const r = await addGuardian(chen, { name: "Mei Chen", email: "mei@example.com" }, op);
    expect(r).toMatchObject({ ok: true, outcome: "added", person: "new" });
    if (!r.ok) return;
    expect(r.quickbooks).toEqual(["QuickBooks already has a customer named “Mei Chen” under Chen Family that isn't linked to Mei Chen, so no Parent customer was made for them. The mapping screen will offer to link the two."]);
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await linkOfRow(r.guardianId)).toBeUndefined();
    // The membership is slice 7b's, whatever QuickBooks holds.
    expect(await rowOf(r.guardianId)).toMatchObject({ status: "invited", familyId: chen, familyQboId: "20", sourceQboId: null });
  });

  it("a new guardian gets their own Parent customer under the family, with their name and address, linked to their row", async () => {
    const r = await addGuardian(rivera, { name: "Luis Rivera", email: "Luis@Example.com" }, op);
    expect(r).toMatchObject({ ok: true, outcome: "added" });
    if (!r.ok) return;
    expect(bodies()).toEqual([{ DisplayName: "Luis Rivera", CustomerTypeRef: { value: "2" }, ParentRef: { value: "10" }, Job: true, BillWithParent: false,
      PrimaryEmailAddr: { Address: "luis@example.com" } }]);
    const made = stub.customers.find((c) => c.DisplayName === "Luis Rivera")!;
    expect(await linkOfRow(r.guardianId)).toMatchObject({ customerId: made.Id, origin: "created", linkedBy: staffId, syncedToken: "0" });
    expect(r.quickbooks).toEqual(["QuickBooks has a Parent customer for Luis Rivera under Rivera Family now, linked to them."]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "done", familyId: rivera, studentId: null, request: { op: "create", role: "parent", guardianId: r.guardianId } });
    // No record becomes a parent's own: the row names no source, and its family's customer as before.
    expect(await rowOf(r.guardianId)).toMatchObject({ status: "invited", sourceQboId: null, familyQboId: "10" });
  });

  it("a name QuickBooks refuses as taken is kept refused; renaming the person takes its place, and is sent", async () => {
    stub.otherNames = ["Luis Rivera"];
    const r = await addGuardian(rivera, { name: "Luis Rivera", email: "luis@example.com" }, op);
    if (!r.ok) throw new Error("not added");
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: "fault_6240" });
    expect(r.quickbooks[0]).toContain("QuickBooks refused the name “Luis Rivera” as taken");
    expect(await rowOf(r.guardianId)).toMatchObject({ status: "invited" });
    // "Send the portal's value" isn't offered for it: the rename of the person is the way out.
    expect((await loadOpenWrites({ familyId: rivera })).find((i) => i.id === kept!.id)).toMatchObject({ mayResend: false, notOffered: "taken" });
    stub.calls.length = 0;
    const renamed = await renamePerson(r.parentId, "Luis M. Rivera", op);
    expect(renamed).toMatchObject({ ok: true, changed: true });
    expect(await queueItem(kept!.id)).toMatchObject({ state: "given_up" });
    expect(bodies()).toEqual([expect.objectContaining({ DisplayName: "Luis M. Rivera", ParentRef: { value: "10" } })]);
    expect(await linkOfRow(r.guardianId)).toMatchObject({ origin: "created" });
    expect((await auditsOf("parent.name.changed"))[0]!.after).toMatchObject({ name: "Luis M. Rivera", queueIds: [expect.any(String)] });
  });

  it("an address longer than QuickBooks takes is kept refused at once, nothing sent", async () => {
    const email = `${"a".repeat(50)}@${"b".repeat(50)}.example.com`;
    const r = await addGuardian(rivera, { name: "Long Address", email }, op);
    expect(r).toMatchObject({ ok: true, outcome: "added" });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([expect.objectContaining({ state: "refused", lastCode: EMAIL_TOO_LONG, sent: false })]);
  });

  it("sends nothing in books with no parent type, in flat books, or for a family with no link, and says nothing is waiting", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning({ id: family.id });
    const r = await addGuardian(hand!.id, { name: "Hal Handmade", email: "hal@example.com" }, op);
    expect(r).toMatchObject({ ok: true, quickbooks: [] });
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, { actor: WORKER.actor, ip: null });
    stub.calls.length = 0;
    expect(await addGuardian(rivera, { name: "Rosa Rivera", email: "rosa@example.com" }, op)).toMatchObject({ ok: true, quickbooks: [] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("a person in two families gets a Parent customer under each, as far as QuickBooks takes the name", async () => {
    stub.quirks.namesUnderParent = true;
    const a = await addGuardian(rivera, { name: "Sam Lee", email: "sam@example.com" }, op);
    if (!a.ok) throw new Error("not added");
    const b = await addGuardian(chen, { name: "Sam Lee", email: "sam@example.com", samePerson: a.parentId }, op);
    expect(b).toMatchObject({ ok: true, person: "existing" });
    expect(bodies().map((x) => [x.DisplayName, (x.ParentRef as { value: string }).value])).toEqual([["Sam Lee", "10"], ["Sam Lee", "20"]]);
    const links = await db.select().from(accountingLink).where(isNotNull(accountingLink.guardianId));
    expect(links.filter((l) => l.origin === "created")).toHaveLength(2);
  });

  it("two staff adding the same new address at once make one person, one row and one Parent customer", async () => {
    const [x, y] = await Promise.all([addGuardian(rivera, { name: "Pat Rivera", email: "pat@example.com" }, op), addGuardian(rivera, { name: "Pat Rivera", email: "pat@example.com" }, op)]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(guardian).where(eq(guardian.parentId, (await personNamed("pat@example.com")).id))).toHaveLength(1);
    expect(bodies().filter((b) => b.DisplayName === "Pat Rivera")).toHaveLength(1);
  });
});

describe("removing a guardian (item 4)", () => {
  beforeEach(() => { stub.quirks.balances = true; });

  it("with nothing owed: access ends, and their own Parent customer is made inactive, the link aligned", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    const r = await removeGuardian(row.id, "Moved away.", op);
    expect(r).toMatchObject({ ok: true, quickbooks: ["Their Parent customer under Rivera Family is inactive in QuickBooks now."] });
    expect(await rowOf(row.id)).toMatchObject({ status: "disabled", disabledReason: "removed" });
    expect(bodies()).toEqual([expect.objectContaining({ Id: "11", Active: false })]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: false });
    expect(await linkOfRow(row.id)).toMatchObject({ customerId: "11", syncedToken: "1" });
  });

  it("owing, with a credit, or with a balance that can't be read: access ends at once, nothing is sent, and it is kept refused", async () => {
    for (const [invoices, code] of [[[{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }], "open_balance"],
      [[{ Id: "903", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: -20, Balance: -20 }], CREDIT_BALANCE]] as const) {
      await resetDb(); stub.reset(); stub.quirks.balances = true;
      tag = await connectRoster(stub);
      op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
      stub.invoices = [...invoices];
      const { row } = await seedAnaRivera({ status: "active" });
      stub.calls.length = 0;
      const r = await removeGuardian(row.id, "Moved away.", op);
      expect(r).toMatchObject({ ok: true });
      expect(await rowOf(row.id)).toMatchObject({ status: "disabled" });
      expect(posts()).toEqual([]);
      expect(await items()).toEqual([expect.objectContaining({ state: "refused", lastCode: code, request: expect.objectContaining({ op: "deactivate", qboId: "11", guardianId: row.id }) })]);
      if (r.ok) expect(r.quickbooks[0]).toContain("was left active in QuickBooks");
    }
    // A balance that can't be read keeps it refused at once too.
    await resetDb(); stub.reset(); stub.quirks.balances = false;
    tag = await connectRoster(stub);
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const { row } = await seedAnaRivera({ status: "active" });
    stub.calls.length = 0;
    expect(await removeGuardian(row.id, "Moved away.", op)).toMatchObject({ ok: true });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([expect.objectContaining({ state: "refused", lastCode: "no_balance" })]);
  });

  it("\"Send the portal's value\" reads the balance again: still owing, still kept; settled, made inactive; and \"Give up\" leaves it active", async () => {
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    await removeGuardian(row.id, "Moved away.", op);
    const [kept] = await items();
    const stamp = portalValueStamp(kept!.id, "");
    expect(await sendPortalValue(kept!.id, "", stamp, op)).toMatchObject({ ok: false });
    expect(await queueItem(kept!.id)).toMatchObject({ state: "refused" });
    expect(posts()).toEqual([]);
    stub.invoices = [];
    expect(await sendPortalValue(kept!.id, "", stamp, op)).toMatchObject({ ok: true });
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: false });
    expect(await queueItem(kept!.id)).toMatchObject({ state: "done" });
  });

  it("\"Give up\" leaves the Parent customer active, for the mapping screen", async () => {
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    await removeGuardian(row.id, "Moved away.", op);
    const [kept] = await items();
    const r = await giveUp(kept!.id, "Settled by hand.", { actor: op.actor, ip: op.ip, permission: op.permission });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("stays active in QuickBooks") });
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: true });
  });

  it("a reinstate of a row whose Parent customer QuickBooks has inactive sends nothing, and says so", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    await removeGuardian(row.id, "Moved away.", op);
    stub.calls.length = 0;
    const r = await reinstateGuardian(row.id, op);
    expect(r).toEqual({ ok: true, quickbooks: ["Their Parent customer under Rivera Family is inactive in QuickBooks, and the portal never makes a customer active again, so nothing was sent there."] });
    expect(posts()).toEqual([]);
    expect(await rowOf(row.id)).toMatchObject({ status: "active" });
  });

  it("whatever QuickBooks does: a lost answer leaves access ended and the make-inactive waiting as maybe sent", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    stub.loseUpdateAnswer = true;
    const r = await removeGuardian(row.id, "Moved away.", op);
    expect(r).toMatchObject({ ok: true });
    expect(await rowOf(row.id)).toMatchObject({ status: "disabled" });
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: true })]);
  });
});

describe("renaming a person (item 5)", () => {
  it("sends the new name to the Parent customer of each of their memberships that has one", async () => {
    stub.quirks.namesUnderParent = true;
    const { ana, row } = await seedAnaRivera({ status: "active" });
    const b = await addGuardian(chen, { name: "Ana Rivera", email: "ana@example.com", samePerson: ana.id }, op);
    if (!b.ok) throw new Error("not added");
    const theirs = (await linkOfRow(b.guardianId))!.customerId;
    stub.calls.length = 0;
    const r = await renamePerson(ana.id, "Ana Rivera-Lopez", op);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(bodies().filter((x) => x.DisplayName === "Ana Rivera-Lopez").map((x) => x.Id).sort()).toEqual(["11", theirs].sort());
    expect(await linkOfRow(row.id)).toMatchObject({ customerId: "11" });
  });

  it("is refused, changing nothing, while a change to one of their Parent customers waits", async () => {
    const { ana, row } = await seedAnaRivera({ status: "active" });
    await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "A. Rivera", was: "Ana Rivera", guardianId: row.id }, { familyQboId: "10" });
    expect(await renamePerson(ana.id, "Ana Rivera-Lopez", op)).toEqual({ ok: false, reason: "qbo_pending" });
    expect(await personNamed("ana@example.com")).toMatchObject({ name: "Ana Rivera" });
  });
});

describe("the family's page and the family action (items 6 and 7)", () => {
  it("a guardian's own Parent customer is changed only through them; a QuickBooks-only one keeps its forms", async () => {
    await seedAnaRivera({ status: "active" });
    expect(await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "A. Rivera", parentOnly: true }, tag, op)).toEqual({ ok: false, errors: [GUARDIAN_HERE] });
    expect(await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [GUARDIAN_HERE] });
    // Mei Chen is in QuickBooks only: renamed there as before.
    expect((await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Mei L. Chen", parentOnly: true }, tag, op)).ok).toBe(true);
  });

  it("the family action waits while a guardian's Parent customer change for the family waits", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    await seedQueued({ op: "create", role: "parent", name: "Ana Rivera", typeQboId: "2", familyQboId: "10", email: "ana@example.com", guardianId: row.id }, { familyQboId: "10" });
    const c = (await familyCover("10"))!;
    const r = await askFamilyInactive(String(rivera), coverStamp(String(rivera), [c.family.qboId, ...c.under.map((u) => u.qboId)]), tag, op);
    expect(r.result).toEqual({ ok: false, errors: [GUARDIAN_PENDING] });
    expect(posts()).toEqual([]);
  });
});

describe("the queue (item 7)", () => {
  it("a create queued before this slice names no guardian, and is finished as today, linking nothing", async () => {
    await seedQueued({ op: "create", role: "parent", name: "Wen Chen", typeQboId: "2", familyQboId: "20", email: "wen@example.com" }, { familyQboId: "20", nextTryAt: new Date(Date.now() - MIN) });
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(bodies()).toEqual([expect.objectContaining({ DisplayName: "Wen Chen" })]);
    expect(await db.select().from(accountingLink).where(eq(accountingLink.origin, "created"))).toEqual([]);
  });

  it("a crash between the save and the try leaves the item for the worker, which sends it once its lease runs out", async () => {
    const [p] = await db.insert(parent).values({ name: "Kit Rivera", email: "kit@example.com" }).returning();
    const [row] = await db.insert(guardian).values({ familyQboId: "10", familyId: rivera, parentId: p!.id, status: "invited" }).returning();
    // The save alone, as addGuardian() makes it, with no at-once try after it.
    await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: row!.id, familyId: rivera, name: "Kit Rivera", email: "kit@example.com" }, op));
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: false, tries: 0 })]);
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(bodies()).toEqual([expect.objectContaining({ DisplayName: "Kit Rivera" })]);
    expect(await linkOfRow(row!.id)).toMatchObject({ origin: "created" });
  });
});
