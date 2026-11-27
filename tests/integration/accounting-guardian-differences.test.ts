import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, guardian, writeQueue } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { loadAccountingLinks, queueFactOf, sendGuardianNameTakenNote, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { guardianDifferenceNext, type Difference } from "@/lib/accounting/differences";
import { removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { giveUp, loadOpenWrites } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import type { MembershipShape } from "@/lib/roster/shape";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent, seedStaff } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, connectRoster, REALM, seedAnaRivera, staffWith, WORKER } from "../helpers/roster-writes";
import { rowNamed } from "../helpers/table";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * A guardian compared with their own Parent customer on Accounting links (stage 4's slice M3c3 of the app-owned
 * families spec, section 5, "Differences": "This covers an edit made in QuickBooks and a change QuickBooks refused";
 * src/lib/accounting/differences.ts): a linked family's row says where a guardian's own Parent customer has another
 * name than the person, is active while they are removed, or is inactive while they are the family's guardian, with
 * both values, the queue's change that explains it, and what staff can do about it: since slice M3c4 beside Send the
 * app's to QuickBooks for a guardian's name or a removed guardian's Parent customer (sendOffersOf()), never a Take, and
 * for an open guardian whose Parent customer the books have inactive in place of a press. The company is
 * fznCompany()'s (tests/helpers/qbo-stub.ts): the Rivera Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12
 * (Student), the Chen Family 20 with Mei Chen 21 (Parent). Ana's row is linked to 11 (seedAnaRivera()). Everything is
 * seeded before a view, and no helper that runs the whole import (syncAppRecords()) is called after a press.
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
/** Customers added or changed in QuickBooks, then read by a roster read (which makes no record of them). */
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
/** One customer of the stub changed, as an edit made in QuickBooks. */
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const isGuardians = (d: Difference) => d.kind === "guardian_name" || d.kind === "guardian_active";
const guardianDiffs = (row: LinkRow) => row.differences.filter(isGuardians);
/**
 * No take and no take note at any guardian difference's place in the row, nor a record's send (changed on purpose in
 * slice M3c4: a guardian's own send, `guardianSends`, and its sentence, may be there, and each test says which); and
 * Send the app's for all (slice M5b) over the row, whose differences are all a guardian's, sends nothing and passes
 * nothing over: a guardian's Parent customer the books have inactive isn't counted as a difference the books have
 * inactive, nor is a guardian's send taken or counted.
 */
const noPressAtGuardians = async (row: LinkRow, sends: { guardianSends: string[]; sendNotes: string[] } = { guardianSends: [], sendNotes: [] }) => {
  const at = row.differences.flatMap((d, i) => (isGuardians(d) ? [i] : []));
  expect(at.length).toBeGreaterThan(0);
  for (const list of [row.takes, row.takeNotes, row.sends]) expect(list.filter((x) => at.includes(x.at))).toEqual([]);
  expect(row.guardianSends.filter((x) => at.includes(x.at)).map((x) => x.field)).toEqual(sends.guardianSends);
  expect(row.sendNotes.filter((x) => at.includes(x.at)).map((x) => x.words)).toEqual(sends.sendNotes);
  expect(row.differences.every(isGuardians)).toBe(true);
  expect((await view()).sendAll({ status: "with_differences", q: row.name })).toMatchObject({ count: 0, later: 0, passedOver: { inactive: 0, booksInactive: 0 }, stamp: null });
};

/** A guardian row of a new person in a family, written directly with nothing queued: open, removed, or closed by a change of company. */
async function rowIn(familyId: AppFamilyId, name: string, email: string, how: "open" | "removed" | "company_changed" = "open") {
  const p = await seedParent({ name, email });
  const [row] = await db.insert(guardian).values({ parentId: p.id, familyId, status: how === "open" ? "active" : "disabled",
    disabledReason: how === "open" ? null : how, statusBeforeDisable: how === "open" ? null : "active" }).returning({ id: guardian.id });
  return row!.id;
}
const linkRowTo = (guardianId: string, customerId: string) =>
  db.insert(accountingLink).values({ system: QUICKBOOKS, realmId: REALM, customerId, guardianId, origin: "confirmed", syncedToken: "0", syncedAt: new Date() });

/** The list's own section, from its heading to the end of its box, then a row's cells as text. */
const list = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };
async function cellsOf(name: string): Promise<string[]> {
  asStaff(await seedStaff({ email: `admin.${Math.random().toString(36).slice(2)}@club.org`, name: "Ada Admin", admin: true }));
  const cells = rowNamed(list(await renderPage(AccountingLinksPage)), name);
  if (!cells) throw new Error(`no row ${name} on the page`);
  return cells;
}
/** A view, proving it asks QuickBooks nothing and changes nothing on the write queue. */
async function view(): Promise<LinksView> {
  const calls = stub.apiCalls().length;
  const queue = await db.select().from(writeQueue).orderBy(asc(writeQueue.id));
  const v = await loadAccountingLinks();
  expect(stub.apiCalls().length).toBe(calls);
  expect(await db.select().from(writeQueue).orderBy(asc(writeQueue.id))).toEqual(queue);
  return v;
}
/** The queue's words for its one open item, as the differences carry them. */
const noteOfOnlyItem = async () => {
  const open = await loadOpenWrites();
  expect(open).toHaveLength(1);
  const f = queueFactOf(open[0]!);
  return { state: f.state, words: f.words };
};

const RENAME_GIVEN_UP = "Given up. Nothing more will be sent for it. The portal keeps the person's new name, and QuickBooks keeps the name it has on their Parent customer. While the two names differ, they are the family's guardian, that customer is active and theirs alone under the family, and the family is still linked to a customer the books hold as a family, Accounting links shows the two names as a difference in the family's row, unless their own Parent customer under another family has the new name. Or rename it in QuickBooks.";
const DEACTIVATE_GIVEN_UP = "Given up. Nothing more will be sent for it. The guardian stays removed in the portal, and their Parent customer stays active in QuickBooks. While it is active, under the family's customer with no other guardian linked to it, and the family is still linked to a customer the books hold as a family, Accounting links shows it as a difference in the family's row. Or make it inactive in QuickBooks once its balance is settled.";
const MAY_HAVE_GONE = " QuickBooks has the change only if a try got through, which the roster's copy of QuickBooks shows after its next read.";
// Changed on purpose in slice M3c4: beside a Send, never "neither is sent from this page".
const NAME_NEXT = "No name is taken from the books here, as their name in the portal is theirs in every family they belong to and on their sign-in. If it should change, rename them on their page under Parents once nothing for them or their Parent customers is waiting or stuck on Reconciliation: while QuickBooks is connected and the family's customer is active, that asks QuickBooks to rename this Parent customer too, unless the same rename gives that name to their own Parent customer under another family first. Or rename it in QuickBooks, and this row shows it after the portal's next roster read.";
const REMOVED_NEXT = "The books having their Parent customer active doesn't make them this family's guardian again here, as that would give them a sign-in: they are added back only under Portal sign-ins, and their Parent customer is theirs again if they are. Or make it inactive in QuickBooks once its balance, owed or a credit, is settled.";
const INACTIVE_NEXT = "Neither is taken or sent from this page, and the portal never makes a customer active in the books. If they are still this family's guardian, make it active in QuickBooks; if they aren't, remove them under Portal sign-ins. While it is inactive the portal sends it nothing for them: no rename, and no change of their phone, mailing address or sign-in email.";

let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId, chen: AppFamilyId;
const asGiver = () => ({ actor: op.actor, ip: op.ip, permission: op.permission });

beforeEach(async () => {
  await resetDb(); stub.reset();
  await connectRoster(stub);
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
});

describe("a rename of a guardian's Parent customer", () => {
  it("waiting, stuck, then given up: both names, the queue's words while it is on the queue, no press while it is there, and once given up a Send beside the sentence", async () => {
    const { ana, row } = await seedAnaRivera({ status: "active" });
    // QuickBooks fails every request of the at-once try: the person is renamed in the portal, and the rename of 11 waits.
    stub.failNext = 50;
    expect(await renamePerson(ana.id, "Ana Lopez", op)).toMatchObject({ ok: true, changed: true });
    stub.failNext = 0;
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ request: expect.objectContaining({ op: "rename", qboId: "11", name: "Ana Lopez", guardianId: row.id }) });
    expect(["waiting", "stuck"]).toContain(item!.state);
    const waiting = await noteOfOnlyItem();
    let riveras = rowOf(await view(), "Rivera Family");
    expect(riveras.differences).toEqual([{ kind: "guardian_name", guardianId: row.id, who: "Ana Lopez", portal: "Ana Lopez", books: "Ana Rivera", queue: waiting }]);
    await noPressAtGuardians(riveras);
    expect((await cellsOf("Rivera Family"))[2]).toContain(`Ana Lopez's name on their Parent customer. In the portal: “Ana Lopez”. In the books: “Ana Rivera”. ${waiting.words}${waiting.words.endsWith(".") ? "" : "."} See the change on Reconciliation. ${NAME_NEXT}`);

    // Stuck, as later failed tries leave it; then given up.
    await db.update(writeQueue).set({ state: "stuck", nextTryAt: null }).where(eq(writeQueue.id, item!.id));
    const stuck = await noteOfOnlyItem();
    expect(stuck.state).toBe("stuck");
    expect(rowOf(await view(), "Rivera Family").differences).toEqual([expect.objectContaining({ kind: "guardian_name", queue: stuck })]);
    expect(await giveUp(item!.id, "QuickBooks keeps failing.", asGiver())).toEqual({ ok: true, message: `${RENAME_GIVEN_UP}${MAY_HAVE_GONE}` });

    riveras = rowOf(await view(), "Rivera Family");
    expect(riveras.status).toEqual({ key: "with_differences", made: { key: "carried_over", at: expect.any(String) } });
    expect(riveras.differences).toEqual([{ kind: "guardian_name", guardianId: row.id, who: "Ana Lopez", portal: "Ana Lopez", books: "Ana Rivera", queue: null }]);
    // Since slice M3c4, with nothing on the queue for it, the person's name is offered to be sent (changed on purpose).
    await noPressAtGuardians(riveras, { guardianSends: ["guardian_name"], sendNotes: [] });
    expect(guardianDifferenceNext(riveras.differences[0]!)).toBe(NAME_NEXT);
    const cells = await cellsOf("Rivera Family");
    // The row's label counts the difference, and its main press opens the Review drawer that settles it.
    expect(cells[1]).toContain("Linked, 1 differs");
    expect(cells[2]).toContain("Settle 1 difference: Rivera Family");
    expect(cells[2]).toContain(`Ana Lopez's name on their Parent customer. In the portal: “Ana Lopez”. In the books: “Ana Rivera”. ${NAME_NEXT}`);
    expect(cells[2]).not.toContain("See the change on Reconciliation");
    expect(cells[2]).not.toContain("Take the books' value");
    expect(cells[2]).toContain("Send the portal's value to the books");
  });

  it("kept refused: the difference carries the kept change's words, with Reconciliation linked", async () => {
    const { ana, row } = await seedAnaRivera({ status: "active" });
    // A name another customer holds in QuickBooks (Mei Chen 21): the rename isn't taken, and is kept.
    expect(await renamePerson(ana.id, "Mei Chen", op)).toMatchObject({ ok: true, changed: true });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "refused", request: expect.objectContaining({ op: "rename", qboId: "11", guardianId: row.id }) });
    const kept = await noteOfOnlyItem();
    expect(kept.state).toBe("refused");
    const riveras = rowOf(await view(), "Rivera Family");
    expect(riveras.differences).toEqual([{ kind: "guardian_name", guardianId: row.id, who: "Mei Chen", portal: "Mei Chen", books: "Ana Rivera", queue: kept }]);
    // Since slice M3c4: Mei Chen 21 holds the name, so no Send, and its sentence in place (changed on purpose).
    await noPressAtGuardians(riveras, { guardianSends: [], sendNotes: [sendGuardianNameTakenNote("Mei Chen")] });
    expect((await cellsOf("Rivera Family"))[2]).toContain(`Mei Chen's name on their Parent customer. In the portal: “Mei Chen”. In the books: “Ana Rivera”. ${kept.words}${kept.words.endsWith(".") ? "" : "."} See the change on Reconciliation. ${NAME_NEXT}`);
    // Given up, it stays a difference, with no note.
    expect(await giveUp(item!.id, "Leaving it.", asGiver())).toEqual({ ok: true, message: RENAME_GIVEN_UP });
    expect(rowOf(await view(), "Rivera Family").differences).toEqual([expect.objectContaining({ kind: "guardian_name", queue: null })]);
  });

  it("an edit made in QuickBooks shows the same way, with no note", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
    expect(guardianDiffs(rowOf(await view(), "Rivera Family"))).toEqual([{ kind: "guardian_name", guardianId: row.id, who: "Ana Rivera", portal: "Ana Rivera", books: "Ana R. Lopez", queue: null }]);
  });
});

describe("a removed guardian's Parent customer left active", () => {
  beforeEach(() => { stub.quirks.balances = true; });

  it("kept for a balance: whether they are the guardian, with the kept note; given up, the same with none, and the given-up words", async () => {
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    expect(await removeGuardian(row.id, "Moved away.", op)).toMatchObject({ ok: true });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "refused", lastCode: "open_balance", request: expect.objectContaining({ op: "deactivate", qboId: "11", guardianId: row.id }) });
    const kept = await noteOfOnlyItem();
    let riveras = rowOf(await view(), "Rivera Family");
    expect(riveras.differences).toEqual([{ kind: "guardian_active", guardianId: row.id, who: "Ana Rivera", portalOpen: false, queue: kept }]);
    // Since slice M3c4 the kept make-inactive's place is taken by a Send, which closes it once QuickBooks has it inactive (changed on purpose).
    await noPressAtGuardians(riveras, { guardianSends: ["guardian_inactive"], sendNotes: [] });
    expect(riveras.guardianSends[0]!.words.at(-1)).toBe("The make-inactive kept on the Reconciliation page is closed once QuickBooks has the customer inactive, as this takes its place.");
    expect((await cellsOf("Rivera Family"))[2]).toContain(`Whether Ana Rivera is this family's guardian. In the portal: Removed from this family. In the books: Their Parent customer is active. ${kept.words}${kept.words.endsWith(".") ? "" : "."} See the change on Reconciliation. ${REMOVED_NEXT}`);

    expect(await giveUp(item!.id, "Settled by hand.", asGiver())).toEqual({ ok: true, message: DEACTIVATE_GIVEN_UP });
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: true });
    riveras = rowOf(await view(), "Rivera Family");
    expect(riveras.status).toMatchObject({ key: "with_differences" });
    expect(riveras.differences).toEqual([{ kind: "guardian_active", guardianId: row.id, who: "Ana Rivera", portalOpen: false, queue: null }]);
    await noPressAtGuardians(riveras, { guardianSends: ["guardian_inactive"], sendNotes: [] });
    expect(riveras.guardianSends[0]!.words).toHaveLength(1);
    const cells = await cellsOf("Rivera Family");
    // The row's label counts the difference, and its main press opens the Review drawer that settles it.
    expect(cells[1]).toContain("Linked, 1 differs");
    expect(cells[2]).toContain("Settle 1 difference: Rivera Family");
    expect(cells[2]).toContain(`Whether Ana Rivera is this family's guardian. In the portal: Removed from this family. In the books: Their Parent customer is active. ${REMOVED_NEXT}`);
    // Still listed among the removed guardians, as slice M3c draws them.
    expect(cells[2]).toContain("Removed guardians:Ana Rivera: linked to Ana Rivera, active in the books");
  });

  it("kept for a balance, then stuck and given up: the given-up words say QuickBooks may have it, and the difference stays", async () => {
    stub.invoices = [{ Id: "909", SyncToken: "0", CustomerRef: { value: "11" }, TotalAmt: 5, Balance: 5 }];
    const { row } = await seedAnaRivera({ status: "active" });
    expect(await removeGuardian(row.id, "Moved away.", op)).toMatchObject({ ok: true });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ request: expect.objectContaining({ op: "deactivate", qboId: "11", guardianId: row.id }) });
    // Stuck, as a later try held back by the balance leaves it (src/lib/roster/queue.ts), then given up.
    await db.update(writeQueue).set({ state: "stuck", nextTryAt: null }).where(eq(writeQueue.id, item!.id));
    expect(await giveUp(item!.id, "Settled by hand.", asGiver())).toEqual({ ok: true, message: `${DEACTIVATE_GIVEN_UP}${MAY_HAVE_GONE}` });
    expect(rowOf(await view(), "Rivera Family").differences).toEqual([{ kind: "guardian_active", guardianId: row.id, who: "Ana Rivera", portalOpen: false, queue: null }]);
  });

  it("made inactive in QuickBooks once settled: no difference", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    expect(await removeGuardian(row.id, "Moved away.", op)).toMatchObject({ ok: true, quickbooks: ["Their Parent customer under Rivera Family is inactive in QuickBooks now."] });
    await readAgain();
    expect(guardianDiffs(rowOf(await view(), "Rivera Family"))).toEqual([]);
  });
});

describe("a guardian's own Parent customer the books have inactive", () => {
  it("whether they are the guardian, and no name, though the names differ", async () => {
    const { row } = await seedAnaRivera({ status: "active" });
    changeInBooks("11", { Active: false, DisplayName: "Ana R." });
    await readAgain();
    const riveras = rowOf(await view(), "Rivera Family");
    expect(riveras.differences).toEqual([{ kind: "guardian_active", guardianId: row.id, who: "Ana Rivera", portalOpen: true, queue: null }]);
    await noPressAtGuardians(riveras);
    expect((await cellsOf("Rivera Family"))[2]).toContain(`Whether Ana Rivera is this family's guardian. In the portal: A guardian of this family. In the books: Their Parent customer is inactive. ${INACTIVE_NEXT}`);
  });
});

describe("not compared", () => {
  it("a customer two open rows share, whatever its name or whether it is active", async () => {
    await seedAnaRivera({ status: "active" });
    await linkRowTo(await rowIn(rivera, "Raul Rivera", "raul@example.com"), "11");
    changeInBooks("11", { DisplayName: "Ana R." });
    await readAgain();
    const v = await view();
    expect(rowOf(v, "Rivera Family").guardians.map((g) => g.standing)).toEqual(["shared", "shared"]);
    expect(guardianDiffs(rowOf(v, "Rivera Family"))).toEqual([]);
    changeInBooks("11", { Active: false });
    await readAgain();
    expect(guardianDiffs(rowOf(await view(), "Rivera Family"))).toEqual([]);
  });

  it("a link to a customer under another customer, of another type, or gone from the books' copy, open or removed", async () => {
    await seedAnaRivera({ status: "active" });
    await readAgain(qc("14", "Pat Vendor", "5", under("10")), qc("15", "Top Parent", "2"));
    // Mei Chen 21 is a Parent customer under the Chens'; Pat Vendor 14 is under the Riveras' but no Parent; Leo Rivera 12 is a student; 15 is at the top; 99 is gone.
    for (const [name, customerId] of [["Sol Rivera", "21"], ["Pat Rivera", "14"], ["Eli Rivera", "12"], ["Top Rivera", "15"], ["Gus Rivera", "99"]] as const) {
      await linkRowTo(await rowIn(rivera, name, `${name.split(" ")[0]!.toLowerCase()}@example.com`), customerId);
      await linkRowTo(await rowIn(rivera, `${name} Sr`, `${name.split(" ")[0]!.toLowerCase()}.sr@example.com`, "removed"), customerId);
    }
    const v = await view();
    expect(rowOf(v, "Rivera Family").guardians.filter((g) => g.name !== "Ana Rivera").map((g) => g.standing).sort()).toEqual(["elsewhere", "elsewhere", "elsewhere", "elsewhere", "gone"]);
    expect(guardianDiffs(rowOf(v, "Rivera Family"))).toEqual([]);
  });

  it("a row closed by a change of company", async () => {
    await seedAnaRivera({ status: "active" });
    await readAgain(qc("13", "Luz Rivera", "2", under("10")));
    await linkRowTo(await rowIn(rivera, "Luz Rivera", "luz@example.com", "company_changed"), "13");
    expect(guardianDiffs(rowOf(await view(), "Rivera Family"))).toEqual([]);
  });

  it("a person in two families whose other family's Parent customer holds their name (one person, one name)", async () => {
    const { ana, row } = await seedAnaRivera({ status: "active" });
    changeInBooks("11", { DisplayName: "Ana R." });
    await readAgain(qc("25", "Ana Rivera", "2", under("20")));
    // Before her Chen row is linked to 25, the Riveras' row says her name differs.
    expect(guardianDiffs(rowOf(await view(), "Rivera Family"))).toEqual([expect.objectContaining({ kind: "guardian_name", guardianId: row.id, books: "Ana R." })]);
    const [inChen] = await db.insert(guardian).values({ parentId: ana.id, familyId: chen, status: "active" }).returning({ id: guardian.id });
    await linkRowTo(inChen!.id, "25");
    const v = await view();
    expect(guardianDiffs(rowOf(v, "Rivera Family"))).toEqual([]);
    expect(guardianDiffs(rowOf(v, "Chen Family"))).toEqual([]);
  });

  it("a person in two families renamed: the one record QuickBooks gives the name to, and the other compared with none", async () => {
    const { ana } = await seedAnaRivera({ status: "active" });
    await readAgain(qc("25", "Ana Rivera", "2", under("20")));
    const [inChen] = await db.insert(guardian).values({ parentId: ana.id, familyId: chen, status: "active" }).returning({ id: guardian.id });
    await linkRowTo(inChen!.id, "25");
    expect((await view()).rows.flatMap((r) => r.differences).filter(isGuardians)).toEqual([]);
    // QuickBooks takes the name once: the rename goes to one of her own Parent customers only (name_once).
    expect(await renamePerson(ana.id, "Ana Lopez", op)).toMatchObject({ ok: true, changed: true });
    await readAgain();
    expect(stub.customers.filter((c) => (c.Id === "11" || c.Id === "25") && c.DisplayName === "Ana Lopez")).toHaveLength(1);
    const v = await view();
    expect(guardianDiffs(rowOf(v, "Rivera Family"))).toEqual([]);
    expect(guardianDiffs(rowOf(v, "Chen Family"))).toEqual([]);
  });

  it("the same names after the portal's own name rule (a doubled space)", async () => {
    await seedAnaRivera({ status: "active" });
    changeInBooks("11", { DisplayName: "Ana  Rivera" });
    await readAgain();
    expect(rowOf(await view(), "Rivera Family").differences).toEqual([]);
  });

  it("in flat books, and in layered books with no parent type", async () => {
    for (const shape of [{ kind: "flat", memberTypeIds: ["1"] }, { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }] satisfies MembershipShape[]) {
      await resetDb(); stub.reset();
      await connectRoster(stub, { shape });
      const { row } = await seedAnaRivera({ status: "active" });
      expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, row.id))).toHaveLength(1);
      changeInBooks("11", { DisplayName: "Ana R." });
      await readAgain();
      expect((await view()).rows.flatMap((r) => r.differences).filter(isGuardians)).toEqual([]);
    }
  });

  it("a family with no link, Not a family now, or Customer gone", async () => {
    // Mei Lin's row in the Chens' is linked to her own Parent customer 21, named Mei Chen in the books: a difference while the link stands.
    await linkRowTo(await rowIn(chen, "Mei Lin", "mei@example.com"), "21");
    await readAgain(qc("23", "Old Chen", "2", under("20")));
    await linkRowTo(await rowIn(chen, "Old Chen", "old@example.com", "removed"), "23");
    expect(guardianDiffs(rowOf(await view(), "Chen Family")).map((d) => d.kind)).toEqual(["guardian_name", "guardian_active"]);
    changeInBooks("20", { CustomerTypeRef: { value: "4" } });
    await readAgain();
    expect(rowOf(await view(), "Chen Family")).toMatchObject({ status: { key: "not_a_family", reasons: ["other_type"] }, differences: [] });
    stub.customers = stub.customers.filter((c) => c.Id !== "20" && c.Id !== "21" && c.Id !== "23");
    await readAgain();
    expect(rowOf(await view(), "Chen Family")).toMatchObject({ status: { key: "customer_gone" }, differences: [] });
    await db.delete(accountingLink).where(eq(accountingLink.familyId, chen));
    const unlinked = rowOf(await view(), "Chen Family");
    expect(["no_match", "not_checked", "suggested", "several"]).toContain(unlinked.status.key);
    expect(unlinked.differences).toEqual([]);
  });
});

describe("a family's own guardians only", () => {
  it("family A's row never shows family B's guardian nor B's removed one, whatever customers they share", async () => {
    await seedAnaRivera({ status: "active" });
    await readAgain(qc("13", "Luz Rivera", "2", under("10")), qc("14", "Bea Rivera", "2", under("10")), qc("23", "Old Chen", "2", under("20")));
    // The Chens': Mei Lin, her own 21 named Mei Chen; Old Chen removed, his own 23 still active; Kai Chen linked to the
    // Riveras' 13; Bo Chen removed, linked to the Riveras' 14.
    const mei = await rowIn(chen, "Mei Lin", "mei@example.com"); await linkRowTo(mei, "21");
    const old = await rowIn(chen, "Old Chen", "old@example.com", "removed"); await linkRowTo(old, "23");
    const kai = await rowIn(chen, "Kai Chen", "kai@example.com"); await linkRowTo(kai, "13");
    const bo = await rowIn(chen, "Bo Chen", "bo@example.com", "removed"); await linkRowTo(bo, "14");
    changeInBooks("13", { DisplayName: "Luz R." });
    await readAgain();
    const v = await view();
    expect(rowOf(v, "Rivera Family").differences).toEqual([]);
    expect(guardianDiffs(rowOf(v, "Chen Family"))).toEqual([
      { kind: "guardian_name", guardianId: mei, who: "Mei Lin", portal: "Mei Lin", books: "Mei Chen", queue: null },
      { kind: "guardian_active", guardianId: old, who: "Old Chen", portalOpen: false, queue: null }]);
    const riveraCells = (await cellsOf("Rivera Family")).join(" ");
    for (const name of ["Mei Lin", "Old Chen", "Kai Chen", "Bo Chen"]) expect(riveraCells).not.toContain(name);
  });
});

describe("the view's reads", () => {
  it("reads as many times with guardian differences as without: no query of its own", async () => {
    await seedAnaRivera({ status: "active" });
    const spy = vi.spyOn(db, "select");
    try {
      const plain = await loadAccountingLinks();
      expect(rowOf(plain, "Rivera Family").differences).toEqual([]);
      const none = spy.mock.calls.length;
      spy.mockClear();
      await readAgain(qc("14", "Bea Rivera", "2", under("10")), qc("23", "Old Chen", "2", under("20")));
      changeInBooks("11", { DisplayName: "Ana R." });
      await readAgain();
      await linkRowTo(await rowIn(rivera, "Bea Rivera", "bea@example.com", "removed"), "14");
      await linkRowTo(await rowIn(chen, "Mei Lin", "mei@example.com"), "21");
      await linkRowTo(await rowIn(chen, "Old Chen", "old@example.com", "removed"), "23");
      spy.mockClear();
      const v = await loadAccountingLinks();
      expect(guardianDiffs(rowOf(v, "Rivera Family")).map((d) => d.kind)).toEqual(["guardian_name", "guardian_active"]);
      expect(guardianDiffs(rowOf(v, "Chen Family")).map((d) => d.kind)).toEqual(["guardian_name", "guardian_active"]);
      expect(spy.mock.calls.length).toBe(none);
    } finally {
      spy.mockRestore();
    }
  });
});
