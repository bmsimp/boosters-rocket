import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, parent, qboCustomer, writeQueue } from "@/lib/db/schema";
import { addGuardian, reinstateGuardian, removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { askFamilyInactive, askRosterWrite, coverStamp, CREDIT_BALANCE, CUSTOMER_HAS_GUARDIAN, EMAIL_TOO_LONG, familyCover, GUARDIAN_FAMILY_CHANGING, GUARDIAN_HERE, GUARDIAN_PENDING, guardianCustomers,
  guardianSentWords, guardianStandings, keptRefusalWords, portalValueStamp, queueForGuardian, SENDING_LOCK, sendGuardianSaved, sendPortalValue, whileGuardiansHeld, whoStopped } from "@/lib/roster/writes";
import { giveUp, loadOpenWrites, runWriteQueue, waitingWords } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import type { AppFamilyId } from "@/lib/families/ids";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { saveShape } from "@/lib/roster/shape";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { holdTheRosterLock } from "../helpers/reconcile";

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
    expect(r.quickbooks[0]).toContain("QuickBooks refused the name “Luis Rivera” as taken: another customer in QuickBooks has that name");
    // The words promise nothing of a rename (the lead's decision 1(b)): they say what it does, and what "Give up" leaves.
    expect(r.quickbooks[0]).toContain("Renaming Luis Rivera changes their name in the portal and on their own record in QuickBooks.");
    expect(r.quickbooks[0]).toContain("leaves them as they are, with no record of their own in QuickBooks, for the mapping screen");
    expect(r.quickbooks[0]).not.toContain("takes its place");
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

  it("a person in two families: their record under the first has their one name, so nothing is sent, kept or linked for the second", async () => {
    // As QuickBooks is understood to (the client's own note, and this stub's default): a name any customer has is refused.
    const a = await addGuardian(rivera, { name: "Sam Lee", email: "sam@example.com" }, op);
    if (!a.ok) throw new Error("not added");
    expect(bodies().map((x) => [x.DisplayName, (x.ParentRef as { value: string }).value])).toEqual([["Sam Lee", "10"]]);
    stub.calls.length = 0;
    const b = await addGuardian(chen, { name: "Sam Lee", email: "sam@example.com", samePerson: a.parentId }, op);
    expect(b).toMatchObject({ ok: true, person: "existing", outcome: "added" });
    if (!b.ok) return;
    expect(b.quickbooks).toEqual(["QuickBooks already has Sam Lee's record under Rivera Family, and takes a name once, so no Parent customer was made for them under Chen Family."]);
    expect(posts()).toEqual([]);
    expect((await items()).filter((i) => i.request.op === "create" && i.familyId === chen)).toEqual([]);
    expect(await linkOfRow(b.guardianId)).toBeUndefined();
    expect(await rowOf(b.guardianId)).toMatchObject({ status: "invited", familyId: chen });
    // The family's page says so beside them.
    expect((await guardianStandings([{ guardianId: b.guardianId, familyId: chen, name: "Sam Lee", open: true }])).get(b.guardianId))
      .toBe("QuickBooks already has their record under Rivera Family, and takes a name once, so none is made under this family.");
  });

  it("a rename doesn't replace a create kept as a taken name while the new name isn't free: the name is saved, the create stays kept, and the answer says why", async () => {
    stub.otherNames = ["Luis Rivera"];
    const r = await addGuardian(rivera, { name: "Luis Rivera", email: "luis@example.com" }, op);
    if (!r.ok) throw new Error("not added");
    const [kept] = await items();
    stub.calls.length = 0;
    // Mei Chen is a customer QuickBooks holds: by the portal's own knowledge (namesTaken()) the name isn't free.
    const renamed = await renamePerson(r.parentId, "Mei Chen", op);
    expect(renamed).toEqual({ ok: true, changed: true, quickbooks: ["Nothing was sent for their Parent customer under Rivera Family, which QuickBooks refused before as a taken name: another customer in QuickBooks has the name “Mei Chen” already. It stays kept on the Reconciliation page, where you can give it up."] });
    expect(posts()).toEqual([]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "refused", lastCode: "fault_6240" });
    expect(await items()).toHaveLength(1);
    expect(await personNamed("luis@example.com")).toMatchObject({ name: "Mei Chen" });
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
    // Nothing was sent, so it is the portal's holding back, never said as QuickBooks' refusal, and the customer is left active.
    expect(await removeGuardian(row.id, "Moved away.", op)).toMatchObject({ ok: true,
      quickbooks: ["Their Parent customer under Rivera Family was left active in QuickBooks: its balance couldn't be read, and nothing is made inactive without it. It is kept on the Reconciliation page, where you can send it again once that is settled, or give it up."] });
    expect(posts()).toEqual([]);
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: "balance_unread:no_balance" });
    expect(whoStopped(kept!.lastCode)).toBe("held");
    expect(keptRefusalWords(kept!.lastCode, null)).toContain("couldn't read what this customer owes in QuickBooks");
    expect(keptRefusalWords(kept!.lastCode, null)).toContain("left active in QuickBooks");
    expect(waitingWords({ state: "refused", finishing: false, lastCode: kept!.lastCode })).toBe("Held back by the portal, which keeps its own value");
    // A balance read QuickBooks couldn't be reached for at that moment is kept so too, and said the same way.
    expect(whoStopped("balance_unread:token_busy")).toBe("held");
    expect(keptRefusalWords("balance_unread:token_busy", null)).toContain("left active in QuickBooks");
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

  it("a removal while someone else holds the row's lock still gives up its create that never left, and the worker sends nothing", async () => {
    const [p] = await db.insert(parent).values({ name: "Kit Rivera", email: "kit@example.com" }).returning();
    const [row] = await db.insert(guardian).values({ familyQboId: "10", familyId: rivera, parentId: p!.id, status: "invited" }).returning();
    // Its at-once try got a 429, which surely sent nothing: waiting, never sent.
    const c = await seedQueued({ op: "create", role: "parent", name: "Kit Rivera", typeQboId: "2", familyQboId: "10", email: "kit@example.com", guardianId: row!.id },
      { familyQboId: "10", sent: false, code: "http_429", nextTryAt: new Date(Date.now() - MIN) });
    // "Try again now", or a rename of the person, holds the row's lock at that moment: the removal can't take it.
    const r = await whileGuardiansHeld([row!.id], () => removeGuardian(row!.id, "Left the club.", op));
    expect(r).toMatchObject({ ok: true });
    expect(await rowOf(row!.id)).toMatchObject({ status: "disabled" });
    expect(await queueItem(c.id)).toMatchObject({ state: "given_up" });
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(posts()).toEqual([]);
    expect(await linkOfRow(row!.id)).toBeUndefined();
  });

  it("a create left to finish when its row was removed, then tried again, finds the row closed and is given up, nothing sent", async () => {
    const [p] = await db.insert(parent).values({ name: "Kit Rivera", email: "kit@example.com" }).returning();
    const [row] = await db.insert(guardian).values({ familyQboId: "10", familyId: rivera, parentId: p!.id, status: "disabled", disabledReason: "removed" }).returning();
    // Its earlier try reached nothing (a key to QuickBooks that couldn't be had), so it was put back as never sent.
    const c = await seedQueued({ op: "create", role: "parent", name: "Kit Rivera", typeQboId: "2", familyQboId: "10", email: "kit@example.com", guardianId: row!.id },
      { familyQboId: "10", sent: false, nextTryAt: new Date(Date.now() - MIN) });
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(posts()).toEqual([]);
    expect(await queueItem(c.id)).toMatchObject({ state: "given_up" });
    expect(await linkOfRow(row!.id)).toBeUndefined();
    expect((await auditsOf("roster.write.given_up")).find((a) => a.targetId === c.id)?.after).toMatchObject({ why: "guardian_removed" });
  });

  it("a kept make-inactive whose customer QuickBooks has made inactive since: offered, and the press finishes it as found, nothing sent", async () => {
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    await removeGuardian(row.id, "Moved away.", op);
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: "open_balance" });
    // The treasurer settles it and makes the Parent customer inactive in QuickBooks; the roster is read again.
    stub.invoices = [];
    stub.customers.find((c) => c.Id === "11")!.Active = false;
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect((await loadOpenWrites({ familyId: rivera })).find((i) => i.id === kept!.id)).toMatchObject({ mayResend: true, notOffered: null });
    stub.calls.length = 0;
    expect(await sendPortalValue(kept!.id, "", portalValueStamp(kept!.id, ""), op)).toEqual({ ok: true, message: "QuickBooks has the parent inactive already, so nothing was sent. The change is done." });
    expect(posts()).toEqual([]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "done" });
  });

  it("a reinstate replaces the row's kept make-inactive, even once QuickBooks has the customer inactive", async () => {
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    await removeGuardian(row.id, "Moved away.", op);
    const [kept] = await items();
    stub.invoices = [];
    stub.customers.find((c) => c.Id === "11")!.Active = false;
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    stub.calls.length = 0;
    expect(await reinstateGuardian(row.id, op)).toEqual({ ok: true,
      quickbooks: ["Their Parent customer under Rivera Family is inactive in QuickBooks, and the portal never makes a customer active again, so nothing was sent there."] });
    expect(posts()).toEqual([]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.replaced")).find((a) => a.targetId === kept!.id)?.after).toMatchObject({ replacedBy: { op: "reinstate", guardianId: row.id } });
  });
});

describe("renaming a person (item 5)", () => {
  // Ana's Rivera row, linked to her own Parent customer 11, and a row of hers in Chen whose create QuickBooks refused as a
  // taken name, its id chosen so the person's rows' order is known (the order a rename goes by: decision 1(d)).
  const anaInTwo = async (chenRowId: string) => {
    const { ana, row } = await seedAnaRivera({ status: "active" });
    await db.insert(guardian).values({ id: chenRowId, familyQboId: "20", familyId: chen, parentId: ana.id, status: "active" });
    const kept = await seedQueued({ op: "create", role: "parent", name: "Ana Rivera", typeQboId: "2", familyQboId: "20", email: "ana@example.com", guardianId: chenRowId },
      { familyQboId: "20", state: "refused", code: "fault_6240", sent: true });
    stub.calls.length = 0;
    return { ana, row, kept };
  };

  it("gives a person in two families' new name to one record of theirs, the first in their rows' order: their own Parent customer", async () => {
    const { ana, row, kept } = await anaInTwo("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(row.id < "ffffffff-ffff-4fff-bfff-ffffffffffff").toBe(true);
    const r = await renamePerson(ana.id, "Ana Lopez", op);
    expect(r).toMatchObject({ ok: true, changed: true });
    // Only the rename of 11 is sent; the create under Chen isn't, and stays kept: QuickBooks would refuse the name twice.
    expect(bodies().map((x) => [x.Id ?? null, x.DisplayName])).toEqual([["11", "Ana Lopez"]]);
    expect(await queueItem(kept.id)).toMatchObject({ state: "refused", lastCode: "fault_6240" });
    if (r.ok) expect(r.quickbooks).toContain("Nothing was sent for their Parent customer under Chen Family, which QuickBooks refused before as a taken name: the new name goes to their record under Rivera Family, and QuickBooks takes a name once. It stays kept on the Reconciliation page, where you can give it up.");
  });

  it("gives a person in two families' new name to one record of theirs, the first in their rows' order: the create kept under the other family", async () => {
    const { ana, kept } = await anaInTwo("00000000-0000-4000-8000-000000000001");
    const r = await renamePerson(ana.id, "Ana Lopez", op);
    expect(r).toMatchObject({ ok: true, changed: true });
    // The create under Chen takes the new name, and the rename of 11 isn't queued: 11 keeps the name it has.
    expect(bodies().map((x) => [x.Id ?? null, x.DisplayName, (x.ParentRef as { value?: string } | undefined)?.value ?? null])).toEqual([[null, "Ana Lopez", "20"]]);
    expect(await queueItem(kept.id)).toMatchObject({ state: "given_up" });
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ DisplayName: "Ana Rivera" });
    expect((await items()).filter((i) => i.request.op === "rename")).toEqual([]);
    if (r.ok) expect(r.quickbooks).toContain("Their Parent customer under Rivera Family keeps the name it has in QuickBooks: QuickBooks takes a name once, and the new name goes to their record under Chen Family.");
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

  it("a guardian add or reinstate while the family is being changed in QuickBooks is refused, changing nothing and sending nothing", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, row.id));
    stub.calls.length = 0;
    // The family action holds the family's "being sent" lock from before its checks to its last step.
    const [added, reinstated] = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${String(rivera)}::text))`);
      return [await addGuardian(rivera, { name: "Luis Rivera", email: "luis@example.com" }, op), await reinstateGuardian(row.id, op)];
    });
    expect(added).toEqual({ ok: false, reason: "changing" });
    expect(reinstated).toEqual({ ok: false, reason: "changing" });
    expect(await db.select().from(parent).where(eq(parent.email, "luis@example.com"))).toEqual([]);
    expect(await rowOf(row.id)).toMatchObject({ status: "disabled" });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("a Parent customer is a guardian's own only while one open row of this family alone is linked to it", async () => {
    await seedAnaRivera({ status: "active" });
    expect(await guardianCustomers(["11", "21"], rivera)).toEqual(new Map([["11", "own"]]));
    // A second open row whose sign-in came from the same Parent customer: shared, nobody's own, and still no forms.
    const ben = await seedParent({ name: "Ben Rivera", email: "ben@example.com" });
    await seedGuardian({ parentId: ben.id, familyQboId: "10", sourceQboId: "11", status: "active" });
    await syncAppRecords();
    expect(await guardianCustomers(["11"], rivera)).toEqual(new Map([["11", "other"]]));
    expect(await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [GUARDIAN_HERE] });
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

describe("the last round's decisions: the family being changed, a found customer, and each refusal's own cause", () => {
  /** Runs `f` while the family action holds the Rivera family's "being sent" lock, from before its checks to its last step. */
  const whileRiveraChanged = <T,>(f: () => Promise<T>) => db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${String(rivera)}::text))`);
    return f();
  });
  const kit = async () => {
    const [p] = await db.insert(parent).values({ name: "Kit Rivera", email: "kit@example.com" }).returning();
    const [row] = await db.insert(guardian).values({ familyQboId: "10", familyId: rivera, parentId: p!.id, status: "invited" }).returning();
    return { p: p!, row: row! };
  };

  it("while the family action runs, no create is sent at once, by the worker, by \"Send the portal's value\" or for a rename's replacement", async () => {
    const { p, row } = await kit();
    // At once: the create saved, its send finds the family being changed, and leaves it waiting.
    const queued = await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: row.id, familyId: rivera, name: "Kit Rivera", email: "kit@example.com" }, op));
    const sent = await whileRiveraChanged(() => whileGuardiansHeld([row.id], (hold) => sendGuardianSaved(queued, op, { hold })));
    expect(sent).toEqual([expect.objectContaining({ outcome: "queued", deferred: "family" })]);
    expect(guardianSentWords(sent!, "grant", "Kit Rivera")).toEqual(["Making their Parent customer under Rivera Family wasn't sent just now: Rivera Family is being changed in QuickBooks at this moment. It is saved, and the portal sends it shortly; you'll find it on the Reconciliation page until then."]);
    // The worker: left for its next wake, no try counted, nothing marked as sent.
    await whileRiveraChanged(() => runWriteQueue(new Date(Date.now() + 2 * MIN)));
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, tries: 0 });
    // "Send the portal's value" on it, kept: refused in words, the item kept as it was.
    await db.update(writeQueue).set({ state: "refused", lastCode: "token_needs_admin" }).where(eq(writeQueue.id, item!.id));
    expect(await whileRiveraChanged(() => sendPortalValue(item!.id, "Kit Rivera", portalValueStamp(item!.id, "Kit Rivera"), op))).toEqual({ ok: false, errors: [GUARDIAN_FAMILY_CHANGING] });
    expect(await queueItem(item!.id)).toMatchObject({ state: "refused", lastCode: "token_needs_admin" });
    // A rename's replacement of a create kept as a taken name: saved and queued, not sent.
    await db.update(writeQueue).set({ lastCode: "fault_6240" }).where(eq(writeQueue.id, item!.id));
    const renamed = await whileRiveraChanged(() => renamePerson(p.id, "Kit M. Rivera", op));
    expect(renamed).toMatchObject({ ok: true, changed: true });
    if (renamed.ok) expect(renamed.quickbooks[0]).toContain("wasn't sent just now: Rivera Family is being changed in QuickBooks at this moment");
    expect(posts()).toEqual([]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    const replacement = (await items()).find((i) => i.state === "waiting");
    expect(replacement).toMatchObject({ sent: false, tries: 0, request: expect.objectContaining({ op: "create", name: "Kit M. Rivera", guardianId: row.id }) });
    // Once the family action is over, having stopped with the family still active, the worker sends it.
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(bodies()).toEqual([expect.objectContaining({ DisplayName: "Kit M. Rivera", ParentRef: { value: "10" } })]);
  });

  it("a create held back while the family action ran is given up at the worker's next try once the action made the family inactive, nothing sent", async () => {
    const { row } = await kit();
    await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: row.id, familyId: rivera, name: "Kit Rivera", email: "kit@example.com" }, op));
    // While the action runs, the worker leaves it.
    await whileRiveraChanged(() => runWriteQueue(new Date(Date.now() + 2 * MIN)));
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: false, tries: 0 })]);
    // The action went through: everyone under the Rivera family and the family made inactive in QuickBooks, and its record in the portal.
    await db.update(qboCustomer).set({ active: false }).where(or(eq(qboCustomer.qboId, "10"), eq(qboCustomer.parentQboId, "10")));
    await syncAppRecords();
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    stub.calls.length = 0;
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(posts()).toEqual([]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "given_up", sent: false });
    expect((await auditsOf("roster.write.given_up")).find((a) => a.targetId === item!.id)?.after).toMatchObject({ why: "family_inactive", sentNow: false });
    expect(await linkOfRow(row.id)).toBeUndefined();
  });

  it("two creates for one person queued before either was made: at its try the second finds their record under the first family, and is given up, nothing sent", async () => {
    const [p] = await db.insert(parent).values({ name: "Sam Lee", email: "sam@example.com" }).returning();
    const [inRivera] = await db.insert(guardian).values({ familyQboId: "10", familyId: rivera, parentId: p!.id, status: "invited" }).returning();
    const [inChen] = await db.insert(guardian).values({ familyQboId: "20", familyId: chen, parentId: p!.id, status: "invited" }).returning();
    // QuickBooks couldn't be reached at either add: both saved, neither made, so neither save saw the other's record.
    await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: inRivera!.id, familyId: rivera, name: "Sam Lee", email: "sam@example.com" }, op));
    await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: inChen!.id, familyId: chen, name: "Sam Lee", email: "sam@example.com" }, op));
    expect((await items()).map((i) => i.state)).toEqual(["waiting", "waiting"]);
    // The worker tries Rivera's first, then Chen's.
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 2 * MIN) }).where(sql`${writeQueue.request}->>'guardianId' = ${inRivera!.id}`);
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - MIN) }).where(sql`${writeQueue.request}->>'guardianId' = ${inChen!.id}`);
    stub.calls.length = 0;
    await runWriteQueue(new Date());
    expect(bodies().map((x) => [x.DisplayName, (x.ParentRef as { value: string }).value])).toEqual([["Sam Lee", "10"]]);
    expect(await linkOfRow(inRivera!.id)).toMatchObject({ origin: "created" });
    const chenItem = (await items()).find((i) => i.familyId === chen)!;
    expect(chenItem).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.given_up")).find((a) => a.targetId === chenItem.id)?.after).toMatchObject({ why: "named_elsewhere", sentNow: false });
    expect(await linkOfRow(inChen!.id)).toBeUndefined();
    expect((await guardianStandings([{ guardianId: inChen!.id, familyId: chen, name: "Sam Lee", open: true }])).get(inChen!.id))
      .toBe("QuickBooks already has their record under Rivera Family, and takes a name once, so none is made under this family.");
  });

  it("a create found made by name links its row only to a customer no guardian row, open or removed, is linked to", async () => {
    // A removed guardian of the same name, whose own Parent customer 70 was left active (its balance).
    stub.customers.push({ Id: "70", DisplayName: "Kit Rivera", Active: true, SyncToken: "0", CustomerTypeRef: { value: "2" }, ParentRef: { value: "10" }, Job: true });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    const other = await seedParent({ name: "Kit Rivera", email: "kit.other@example.com" });
    const removed = await seedGuardian({ parentId: other.id, familyQboId: "10", sourceQboId: "70", status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    await syncAppRecords();
    expect(await linkOfRow(removed.id)).toMatchObject({ customerId: "70" });
    // Kit's own create, its answer lost before QuickBooks got it: held as maybe sent, tried before the last roster read.
    const { row } = await kit();
    const c = await seedQueued({ op: "create", role: "parent", name: "Kit Rivera", typeQboId: "2", familyQboId: "10", email: "kit@example.com", guardianId: row.id },
      { familyQboId: "10", sent: true, lastTriedAt: new Date(Date.now() - 10 * MIN), nextTryAt: new Date(Date.now() - MIN) });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    stub.calls.length = 0;
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(posts()).toEqual([]);
    expect(await queueItem(c.id)).toMatchObject({ state: "stuck", lastCode: CUSTOMER_HAS_GUARDIAN });
    expect(await linkOfRow(row.id)).toBeUndefined();
    expect(await linkOfRow(removed.id)).toMatchObject({ customerId: "70" });
  });

  it("a removed guardian's own Parent customer, left active because of its balance, is theirs on the family's page", async () => {
    stub.quirks.balances = true;
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    await removeGuardian(row.id, "Moved away.", op);
    expect(await guardianCustomers(["11", "21"], rivera)).toEqual(new Map([["11", "removed"]]));
  });

  it("renames a person nothing could be sent for whatever the roster is doing; one something could be sent for waits at most three seconds, then changes nothing", async () => {
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning({ id: family.id });
    const hal = await addGuardian(hand!.id, { name: "Hal Handmade", email: "hal@example.com" }, op);
    if (!hal.ok) throw new Error("not added");
    const { ana } = await seedAnaRivera({ status: "active" });
    const lock = await holdTheRosterLock();
    try {
      // Hal's one membership is in a family with no link: his rename is the portal's alone, as before slice 9h.
      expect(await renamePerson(hal.parentId, "Hal H. Handmade", op, { rosterWaitMs: 50 })).toEqual({ ok: true, changed: true, quickbooks: [] });
      // Ana's is in a linked family, in books with a parent type: her rename waits for the roster, and changes nothing.
      expect(await renamePerson(ana.id, "Ana Rivera-Lopez", op, { rosterWaitMs: 50 })).toEqual({ ok: false, reason: "busy" });
    } finally {
      await lock.release();
    }
    expect(await personNamed("hal@example.com")).toMatchObject({ name: "Hal H. Handmade" });
    expect(await personNamed("ana@example.com")).toMatchObject({ name: "Ana Rivera" });
    expect(posts()).toEqual([]);
  });

  it("says each refusal's own cause: someone holding the row's lock is being_changed, never a change waiting in QuickBooks", async () => {
    const { ana, row } = await seedAnaRivera({ status: "active" });
    expect(await whileGuardiansHeld([row.id], () => renamePerson(ana.id, "Ana Rivera-Lopez", op))).toEqual({ ok: false, reason: "being_changed" });
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, row.id));
    expect(await whileGuardiansHeld([row.id], () => reinstateGuardian(row.id, op))).toEqual({ ok: false, reason: "being_changed" });
    expect(await whileGuardiansHeld([row.id], () => addGuardian(rivera, { name: "Ana Rivera", email: "ana@example.com", samePerson: ana.id }, op))).toEqual({ ok: false, reason: "being_changed" });
    expect(await rowOf(row.id)).toMatchObject({ status: "disabled" });
    expect(posts()).toEqual([]);
  });

  it("a send after the commit waits for the roster lock at most three seconds: past that the item is left waiting for the worker, nothing sent", async () => {
    const { row } = await kit();
    const queued = await db.transaction((tx) => queueForGuardian(tx, { op: "grant", guardianId: row.id, familyId: rivera, name: "Kit Rivera", email: "kit@example.com" }, op));
    const lock = await holdTheRosterLock();
    let sent: Awaited<ReturnType<typeof sendGuardianSaved>> | null = null;
    try {
      sent = await whileGuardiansHeld([row.id], (hold) => sendGuardianSaved(queued, op, { hold, rosterWaitMs: 50 }));
    } finally {
      await lock.release();
    }
    expect(sent).toEqual([expect.objectContaining({ deferred: "roster" })]);
    expect(guardianSentWords(sent!, "grant", "Kit Rivera")).toEqual(["Making their Parent customer under Rivera Family is saved, and will be sent to QuickBooks shortly: the portal is reading the roster from QuickBooks just now. You'll find it on the Reconciliation page until then."]);
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: false, tries: 0 })]);
  });
});
