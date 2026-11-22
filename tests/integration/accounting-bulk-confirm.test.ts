import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parent, student } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { BULK_MAX, loadAccountingLinks, suggestedRowsShown, readLinkBasics, type BulkOffer, type LinksView } from "@/lib/accounting/mapping";
import { bulkConfirmedWords, confirmAllSuggested, LINK_COPY, leaveUnlinked, linkFamilyToCustomer } from "@/lib/accounting/link-writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily, changeInPortal } from "@/lib/roster/writes";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { confirmAllAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent, untilALockIsAwaited } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";

/**
 * Confirm all exact email matches on the accounting links screen (stage 4's slice M3a2 of the app-owned families spec,
 * section 4: "bulk confirm ... confirms every Suggested row (proposed: only rows the current filter shows, with the
 * count on the button, refused and shown again if the list changed)"; src/lib/accounting/link-writes.ts). The press
 * links every Suggested row the filter shows, each with its students' pairs, as that row's Confirm would, sends
 * nothing, and is refused whole when the list it was drawn from has changed. The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3; the Rivera (10) and Chen (20) families have their records,
 * carried over. Customers added after it are read by a roster read, which makes no record; a family with no link is
 * added in the portal by a staff member who may not link it.
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
const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

let tag: string;
let op: ReturnType<typeof asOp>;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });

async function unlinkedFamily(name: string, students: string[] = []): Promise<AppFamilyId> {
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  const id = (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
  for (const s of students) expect(await changeInPortal({ op: "add_student", familyId: String(id), name: s }, tag, op)).toMatchObject({ ok: true });
  return id;
}
async function guardianIn(familyId: AppFamilyId, name: string, email: string) {
  const p = await seedParent({ name, email });
  await db.insert(guardian).values({ parentId: p.id, familyId, status: "invited" });
}
const studentNamed = async (familyId: AppFamilyId, name: string): Promise<AppStudentId> =>
  (await db.select({ id: student.id }).from(student).where(and(eq(student.familyId, familyId), eq(student.name, name))))[0]!.id;
const linksOfFamily = (id: AppFamilyId) => db.select().from(accountingLink).where(eq(accountingLink.familyId, id));
const studentLinkOf = async (id: AppStudentId) => (await db.select().from(accountingLink).where(eq(accountingLink.studentId, id)))[0];
const confirmLinks = () => db.select().from(accountingLink).where(eq(accountingLink.origin, "confirmed"));
/** Holds the roster lock until released, as a roster read would. */
async function holdRosterLock(): Promise<{ release: () => void; held: Promise<void> }> {
  let release = () => {};
  let held: Promise<void> = Promise.resolve();
  await new Promise<void>((took) => {
    held = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      took();
      await new Promise<void>((r) => { release = () => r(); });
    });
  });
  return { release, held };
}
/** The press as the page binds it: the filter as parsed (status "" for none), the count, and the stamp. */
const press = (filter: { status: string; q: string }, bulk: BulkOffer, t = tag) =>
  confirmAllSuggested({ status: filter.status, q: filter.q, count: bulk.count, stamp: bulk.stamp }, t, linkOp());
const bulkOf = (view: LinksView, status: string | null, q = "") => view.bulk({ status: status as never, q });
/** The Families section, from its heading to the end of its box. */
const listOf = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };

/**
 * The Patels (suggested Patel Family, 70, by asha@example.com; students Asha and Mia, against Asha Patel, 71, and Dev
 * Patel, 73, in the books), the Okafors (suggested Okafor Family, 80, by ike@example.com, its email field holding a
 * second address of the books' own; student Ike Jr against Ike Jr, 81), the Quiets (No match: no guardians) and the
 * Lefts (Left unlinked, though their guardian's address is on Left Family, 95).
 */
async function seedFamilies() {
  await readAgain(qc("70", "Patel Family", "1", { ...mail("asha@example.com"), SyncToken: "4" }), qc("71", "Asha Patel", "3", { ...under("70"), SyncToken: "2" }),
    qc("73", "Dev Patel", "3", under("70")),
    qc("80", "Okafor Family", "1", { ...mail("ike@example.com, books@okafor.example"), SyncToken: "5" }), qc("81", "Ike Jr", "3", { ...under("80"), SyncToken: "6" }),
    qc("90", "Quiet Family", "1"), qc("95", "Left Family", "1", mail("lefty@example.com")));
  const patels = await unlinkedFamily("The Patels", ["Asha Patel", "Mia Patel"]);
  await guardianIn(patels, "Asha Patel", "asha@example.com");
  const okafors = await unlinkedFamily("The Okafors", ["Ike Jr"]);
  await guardianIn(okafors, "Ike Okafor", "ike@example.com");
  const quiets = await unlinkedFamily("The Quiets");
  const lefts = await unlinkedFamily("The Lefts");
  await guardianIn(lefts, "Lefty Left", "lefty@example.com");
  expect(await leaveUnlinked(String(lefts), tag, linkOp())).toMatchObject({ ok: true });
  return { patels, okafors, quiets, lefts };
}

beforeEach(async () => {
  await resetDb(); stub.reset();
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
  tag = await connectRoster(stub);
});

describe("the rows a filter shows", () => {
  it("counts only Suggested rows, under a status filter and a search by a guardian's address or the customer's email field, never a Left unlinked one", async () => {
    const { patels, okafors } = await seedFamilies();
    const view = await loadAccountingLinks();
    expect(bulkOf(view, null)).toEqual({ count: 2, stamp: expect.any(String), waiting: 0 });
    expect(bulkOf(view, "suggested")).toMatchObject({ count: 2 });
    for (const status of ["no_match", "left_unlinked", "carried_over", "with_differences", "linked", "several"]) expect(bulkOf(view, status), status).toBeNull();
    expect(bulkOf(view, null, "IKE@")).toMatchObject({ count: 1 }); // a guardian's sign-in address
    expect(bulkOf(view, null, "books@okafor")).toMatchObject({ count: 1 }); // the customer's own email field
    expect(bulkOf(view, null, "patel family")).toMatchObject({ count: 1 }); // the customer's name
    expect(bulkOf(view, null, "lefty")).toBeNull(); // a Left unlinked family's guardian: not Suggested
    // The page's rule and the press's are one: the rows worked out from the reads alone are the list's own Suggested rows.
    const b = await readLinkBasics();
    expect(suggestedRowsShown(b, { status: null, q: "" }).map((r) => [r.name, r.customerId])).toEqual([["The Okafors", "80"], ["The Patels", "70"]]);
    expect(suggestedRowsShown(b, { status: null, q: "books@okafor" }).map((r) => String(r.familyId))).toEqual([String(okafors)]);
    const listed = view.rows.filter((r) => r.status.key === "suggested").map((r) => String(r.familyId)).sort();
    expect(suggestedRowsShown(b, { status: null, q: "" }).map((r) => String(r.familyId)).sort()).toEqual(listed);
    expect(listed).toContain(String(patels));

    asStaff(linker);
    const list = listOf(await renderPage(AccountingLinksPage));
    expect(list).toContain("Confirm all exact email matches (2)<span class=\"visually-hidden\">: Confirm all exact email matches</span>");
    expect(list).toContain("Links each of the 2 Suggested families shown to the customer on its row");
    expect(list).toContain("Nothing is sent to the books.");
    expect(listOf(await renderPage(AccountingLinksPage, { searchParams: { q: "books@okafor" } }))).toContain("Confirm all exact email matches (1)");
    expect(listOf(await renderPage(AccountingLinksPage, { searchParams: { status: "no_match" } }))).not.toContain("Confirm all exact email matches (");
  });

  it("links each family the filter shows to its customer with its students' pairs, as its own Confirm would, sends nothing, and audits each link and the press", async () => {
    const { patels, okafors, quiets, lefts } = await seedFamilies();
    const guardiansBefore = await db.select().from(guardian).orderBy(asc(guardian.id));
    // The search narrows it to the Okafors: only they are linked.
    let bulk = bulkOf(await loadAccountingLinks(), null, "books@okafor")!;
    stub.calls.length = 0;
    const narrowed = await press({ status: "", q: "books@okafor" }, bulk);
    expect(narrowed).toEqual({ ok: true, message: bulkConfirmedWords({ families: ["The Okafors"], students: 1, recordsLeft: 0, activeCustomersLeft: 0, inactiveCustomersLeft: 0, keptMoves: 0, guardians: { linked: 0, held: 0 } }) });
    expect((narrowed as { message: string }).message).toContain("1 family linked, to the customer that was filled in on its row: The Okafors. 1 student linked with it in all. No guardian was linked with it. "
      + "Another open guardian of the family can be linked in its row's opening on this page, with Link this guardian, where an active Parent customer directly under it is free for them and no change for them or that customer is waiting, stuck or kept on Reconciliation. Nothing was sent to the books.");
    expect(await linksOfFamily(okafors)).toEqual([expect.objectContaining({ realmId: REALM, customerId: "80", origin: "confirmed", linkedBy: linker.id, syncedToken: "5" })]);
    expect(await studentLinkOf(await studentNamed(okafors, "Ike Jr"))).toMatchObject({ customerId: "81", origin: "confirmed", linkedBy: linker.id, syncedToken: "6" });
    expect(await linksOfFamily(patels)).toEqual([]);
    const [bulkRow] = await auditsOf("accounting.link.bulk");
    expect(bulkRow).toMatchObject({ actorId: linker.id, permission: "Accounting.Link.ReadWrite", targetType: "accounting_link" });
    expect(bulkRow!.after).toEqual({ pressId: bulkRow!.targetId, count: 1, familyIds: [String(okafors)], realmId: REALM, status: null, searched: true });
    expect(JSON.stringify(bulkRow!.after)).not.toContain("okafor.example"); // never the search text

    // No search: the Patels are the one Suggested row left.
    bulk = bulkOf(await loadAccountingLinks(), null)!;
    expect(bulk.count).toBe(1);
    const r = await press({ status: "", q: "" }, bulk);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("1 family linked, to the customer that was filled in on its row: The Patels. 1 student linked with it in all."
      + " Whoever was left on either side shows with each family's row on this page, among its differences. No guardian was linked with it."
      + " Another open guardian of the family can be linked in its row's opening on this page, with Link this guardian, where an active Parent customer directly under it is free for them and no change for them or that customer is waiting, stuck or kept on Reconciliation. Nothing was sent to the books.") });
    expect(await linksOfFamily(patels)).toEqual([expect.objectContaining({ customerId: "70", origin: "confirmed", linkedBy: linker.id, syncedToken: "4" })]);
    expect(await studentLinkOf(await studentNamed(patels, "Asha Patel"))).toMatchObject({ customerId: "71", origin: "confirmed", syncedToken: "2" });
    expect(await studentLinkOf(await studentNamed(patels, "Mia Patel"))).toBeUndefined();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "73"))).toEqual([]);
    // The No match and Left unlinked families are left as they were.
    expect(await linksOfFamily(quiets)).toEqual([]);
    expect(await linksOfFamily(lefts)).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(guardian).orderBy(asc(guardian.id))).toEqual(guardiansBefore);
    expect(await db.select().from(accountingLink).where(isNotNull(accountingLink.guardianId))).toEqual([]);

    // One confirm row per family linked, each with its press's id, as a single Confirm writes it; one bulk row per press.
    const confirms = await auditsOf("accounting.link.confirm");
    const bulks = await auditsOf("accounting.link.bulk");
    expect(bulks).toHaveLength(2);
    expect(confirms).toHaveLength(2);
    for (const c of confirms) {
      const after = c.after as Record<string, unknown>;
      const mine = bulks.find((x) => x.targetId === after.bulk)!;
      expect((mine.after as { familyIds: string[] }).familyIds).toEqual([after.familyId]);
      expect(after).toMatchObject({ chosen: "suggested", realmId: REALM, linkIds: expect.any(Array) });
    }
    expect(confirms.find((c) => c.targetId === String(patels))!.after).toMatchObject({ customerQboId: "70",
      studentsLinked: [{ studentId: String(await studentNamed(patels, "Asha Patel")), customerQboId: "71" }],
      studentsLeft: [String(await studentNamed(patels, "Mia Patel"))], studentCustomersLeft: ["73"] });
    expect((bulks.find((x) => (x.after as { searched: boolean }).searched === false)!.after as Record<string, unknown>)).toMatchObject({ count: 1, familyIds: [String(patels)], status: null });
    // Nothing more to confirm: the button is gone.
    expect(bulkOf(await loadAccountingLinks(), null)).toBeNull();
  });

  it("leaves out a Suggested family whose own create in the books is waiting or stuck, says so beside the button, and links the others", async () => {
    const { patels, okafors } = await seedFamilies();
    // The Riveras' guardian signs in with the address on Rivera Household (75), so their row is Suggested; their own
    // create, filed under them, is stuck on the queue (a lost answer tried eight times), so a press would refuse them.
    await readAgain(qc("75", "Rivera Household", "1", mail("riv@example.org")));
    const riveras = await unlinkedFamily("The Riveras");
    await guardianIn(riveras, "Ana Rivera", "riv@example.org");
    await seedQueued({ op: "create", role: "family", name: "The Riveras", typeQboId: "1", familyQboId: null, email: null }, { familyId: riveras, sent: true, state: "stuck", tries: 8 });
    const view = await loadAccountingLinks();
    const row = view.rows.find((r) => String(r.familyId) === String(riveras))!;
    expect(row.status.key).toBe("suggested");
    expect(row.confirm).toMatchObject({ customerId: "75", chosen: "suggested" });
    const bulk = bulkOf(view, null)!;
    expect(bulk).toEqual({ count: 2, stamp: expect.any(String), waiting: 1 });
    expect(suggestedRowsShown(await readLinkBasics(), { status: null, q: "" }).map((r) => r.name)).toEqual(["The Okafors", "The Patels"]);
    // Narrowed to the Riveras alone, no press is offered, and the notice says why.
    expect(bulkOf(view, null, "riv@")).toEqual({ count: 0, stamp: null, waiting: 1 });
    asStaff(linker);
    const notice = "1 Suggested row isn&#x27;t included: it is waiting to be made in the books";
    const all = listOf(await renderPage(AccountingLinksPage)).replaceAll("<!-- -->", "");
    expect(all).toContain("Confirm all exact email matches (2)");
    expect(all).toContain(notice);
    const narrowed = listOf(await renderPage(AccountingLinksPage, { searchParams: { q: "riv@" } })).replaceAll("<!-- -->", "");
    expect(narrowed).toContain(notice);
    expect(narrowed).not.toContain("Confirm all exact email matches (");
    // The press links the other two, every time; the Riveras' own Confirm says why it can't.
    expect(await press({ status: "", q: "" }, bulk)).toMatchObject({ ok: true, message: expect.stringContaining("2 families linked") });
    expect(await linksOfFamily(patels)).toHaveLength(1);
    expect(await linksOfFamily(okafors)).toHaveLength(1);
    expect(await linksOfFamily(riveras)).toEqual([]);
    expect(await linkFamilyToCustomer({ familyId: String(riveras), customerId: "75", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp()))
      .toEqual({ ok: false, errors: [LINK_COPY.createWaiting] });
    expect(bulkOf(await loadAccountingLinks(), null)).toEqual({ count: 0, stamp: null, waiting: 1 });
  });

  it("says the families linked up to a handful, then how many more, and the students over all of them", () => {
    const words = bulkConfirmedWords({ families: ["A", "B", "C", "D", "E", "F", "G"], students: 3, recordsLeft: 0, activeCustomersLeft: 0, inactiveCustomersLeft: 2, keptMoves: 2,
      guardians: { linked: 2, held: 1 } });
    expect(words).toContain("7 families linked, each to the customer that was filled in on its row: A, B, C, D, E and 2 more. 3 students linked with them in all.");
    expect(words).toContain("The inactive student customers left in the books are counted with their families' rows on this page, not listed among their differences.");
    expect(words).toContain("Each family's money is read from the books the next time a parent opens Home or Payments");
    expect(words).toContain("2 guardians linked with them in all, each to the Parent customer under their family's customer whose email field holds their sign-in address."
      + " A guardian whose sign-in address a Parent customer under them holds wasn't linked, as a change for that guardian or for that Parent customer is waiting, stuck or kept on the Reconciliation page."
      + " Another open guardian of these families can be linked in the opening of its family's row on this page, with Link this guardian,"
      + " where an active Parent customer directly under that family's customer is free for them and no change for them or that customer is waiting, stuck or kept on Reconciliation.");
    // More than one held: each by their own row or their own Parent customer.
    expect(bulkConfirmedWords({ families: ["A", "B"], students: 0, recordsLeft: 0, activeCustomersLeft: 0, inactiveCustomersLeft: 0, keptMoves: 0, guardians: { linked: 0, held: 2 } }))
      .toContain("No guardian was linked with them. 2 guardians whose sign-in addresses Parent customers under them hold weren't linked,"
        + " as a change for each of them or for their Parent customer is waiting, stuck or kept on the Reconciliation page.");
    expect(words).not.toContain("guardians' own records");
    // In books with no parent type, nothing about guardians.
    expect(bulkConfirmedWords({ families: ["A"], students: 0, recordsLeft: 0, activeCustomersLeft: 0, inactiveCustomersLeft: 0, keptMoves: 0, guardians: null })).not.toContain("guardian");
    expect(words).toContain("2 students' moves into these families, kept on Reconciliation only because the families had no customer in the books, can now be sent from there.");
  });
});

describe("a list that changed since the page", () => {
  it("is refused whole, nothing linked, for a row newly in it, one gone, a suggestion changed, a student renamed, and a customer linked by a single Confirm meanwhile", async () => {
    const { patels, okafors } = await seedFamilies();
    const refusedAfter = async (change: () => Promise<void>) => {
      const bulk = bulkOf(await loadAccountingLinks(), null)!;
      await change();
      expect(await press({ status: "", q: "" }, bulk)).toEqual({ ok: false, errors: [LINK_COPY.listChanged] });
      expect(await auditsOf("accounting.link.bulk")).toEqual([]);
      expect(await linksOfFamily(patels)).toEqual([]);
    };
    // A Suggested row newly in the filter: the Kims, whose guardian's address is on Kim Family.
    await refusedAfter(async () => {
      await readAgain(qc("85", "Kim Family", "1", mail("kim@example.com")));
      await guardianIn(await unlinkedFamily("The Kims"), "Kim Kim", "kim@example.com");
    });
    // One gone from it: the Kims left unlinked.
    await refusedAfter(async () => {
      const kims = (await db.select({ id: family.id }).from(family).where(eq(family.name, "The Kims")))[0]!.id;
      expect(await leaveUnlinked(String(kims), tag, linkOp())).toMatchObject({ ok: true });
    });
    // A suggestion changed: Ike's address moved in the books from Okafor Family to Okafor Household (86), as many rows as before.
    await refusedAfter(async () => {
      changeInBooks("80", { PrimaryEmailAddr: { Address: "books@okafor.example" } });
      await readAgain(qc("86", "Okafor Household", "1", mail("ike@example.com")));
      expect((await loadAccountingLinks()).bulk({ status: null, q: "" })).toMatchObject({ count: 2 });
    });
    // A student renamed in one family: Mia Patel becomes Dev Patel, who now pairs with customer 73.
    await refusedAfter(async () => {
      expect(await changeInPortal({ op: "rename_student", studentId: String(await studentNamed(patels, "Mia Patel")), name: "Dev Patel" }, tag, op)).toMatchObject({ ok: true });
    });
    // A student added in one family, pairing with a student customer under its suggestion: what the press would link changes.
    await refusedAfter(async () => {
      await readAgain(qc("82", "Ada Okafor", "3", under("86")));
      expect(await changeInPortal({ op: "add_student", familyId: String(okafors), name: "Ada Okafor" }, tag, op)).toMatchObject({ ok: true });
    });
    // A customer linked to a family by a single Confirm between the page and the press.
    await refusedAfter(async () => {
      const row = (await loadAccountingLinks()).rows.find((x) => String(x.familyId) === String(okafors))!;
      expect(await linkFamilyToCustomer({ familyId: String(okafors), customerId: "86", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    });
    // Nothing of a bulk press was kept: the one link of the Okafors is the single Confirm's.
    expect((await confirmLinks()).filter((l) => l.familyId !== null).map((l) => l.customerId)).toEqual(["86"]);
  });

  it("refuses a forged count, a count over the most, a stamp of another filter, and values no page sends", async () => {
    await seedFamilies();
    const view = await loadAccountingLinks();
    const all = bulkOf(view, null)!;
    const suggested = bulkOf(view, "suggested")!;
    expect(suggested.count).toBe(all.count);
    const changed = { ok: false, errors: [LINK_COPY.listChanged] };
    expect(await confirmAllSuggested({ status: "", q: "", count: all.count + 1, stamp: all.stamp }, tag, linkOp())).toEqual(changed);
    expect(await confirmAllSuggested({ status: "", q: "", count: all.count - 1, stamp: all.stamp }, tag, linkOp())).toEqual(changed);
    expect(await confirmAllSuggested({ status: "", q: "", count: BULK_MAX + 1, stamp: all.stamp }, tag, linkOp())).toEqual(changed);
    // The same rows under the Suggested filter: its stamp seals the filter, so it doesn't hold for no filter.
    expect(await confirmAllSuggested({ status: "", q: "", count: suggested.count, stamp: suggested.stamp }, tag, linkOp())).toEqual(changed);
    expect(await confirmAllSuggested({ status: "suggested", q: "", count: all.count, stamp: all.stamp }, tag, linkOp())).toEqual(changed);
    expect(await confirmAllSuggested({ status: "", q: "", count: all.count, stamp: "forged" }, tag, linkOp())).toEqual(changed);
    const notFromPage = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const odd of [{ status: "bogus" }, { status: null }, { q: "x".repeat(101) }, { q: 7 }, { count: 0 }, { count: 1.5 }, { count: "2" }, { stamp: null }]) {
      expect(await confirmAllSuggested({ status: "", q: "", count: all.count, stamp: all.stamp, ...odd }, tag, linkOp()), JSON.stringify(odd)).toEqual(notFromPage);
    }
    expect(await confirmLinks()).toEqual([]);
    expect(await auditsOf("accounting.link.bulk")).toEqual([]);
  });

  it("offers no button over the most a press may link, says to narrow the list, and refuses the press", async () => {
    // 201 families, each with a guardian whose address is on a family customer of its own: 201 Suggested rows.
    const n = BULK_MAX + 1;
    stub.customers.push(...Array.from({ length: n }, (_, i) => qc(String(1000 + i), `Bulk Family ${i}`, "1", mail(`bulk${i}@example.com`))));
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    const families = await db.insert(family).values(Array.from({ length: n }, (_, i) => ({ name: `Bulk ${i}`, active: true }))).returning({ id: family.id, name: family.name });
    const people = await db.insert(parent).values(families.map((_, i) => ({ name: `Bulk Parent ${i}`, email: `bulk${i}@example.com` }))).returning({ id: parent.id, email: parent.email });
    await db.insert(guardian).values(families.map((f, i) => ({ parentId: people.find((p) => p.email === `bulk${i}@example.com`)!.id, familyId: f.id, status: "invited" as const })));
    const view = await loadAccountingLinks();
    expect(bulkOf(view, null)).toEqual({ count: n, stamp: null, waiting: 0 });
    // Narrowed by the search, it is offered again.
    expect(bulkOf(view, null, "bulk1")).toMatchObject({ count: 111, stamp: expect.any(String) }); // bulk1, bulk10 to bulk19, bulk100 to bulk199
    asStaff(linker);
    const list = listOf(await renderPage(AccountingLinksPage));
    expect(list).toContain(`This list shows ${n} Suggested rows. Up to ${BULK_MAX} can be confirmed at once, so narrow the list with the search first.`);
    expect(list).not.toContain("Confirm all exact email matches (");
    expect(await confirmAllAction("", "", n, tag, "x".repeat(22))).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    expect(await confirmAllSuggested({ status: "", q: "", count: n, stamp: "x".repeat(22) }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.listChanged] });
    expect(await confirmLinks()).toEqual([]);
  });

  it("links once for two presses at once: the second waits on the roster lock and is told the list changed", async () => {
    const { patels, okafors } = await seedFamilies();
    const bulk = bulkOf(await loadAccountingLinks(), null)!;
    const lock = await holdRosterLock();
    const presses = [press({ status: "", q: "" }, bulk), press({ status: "", q: "" }, bulk)];
    await untilALockIsAwaited(15_000, 2);
    lock.release();
    await lock.held;
    const answers = await Promise.all(presses);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok)).toEqual([{ ok: false, errors: [LINK_COPY.listChanged] }]);
    expect(await linksOfFamily(patels)).toHaveLength(1);
    expect(await linksOfFamily(okafors)).toHaveLength(1);
    expect(await auditsOf("accounting.link.bulk")).toHaveLength(1);
    expect(await auditsOf("accounting.link.confirm")).toHaveLength(2);
  });
});

describe("who may press", () => {
  it("is the linking permission's with Roster.Read: either alone is refused as the guard refuses, linking nothing", async () => {
    await seedFamilies();
    const bulk = bulkOf(await loadAccountingLinks(), null)!;
    const onlyLink = await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]);
    const onlyRead = await staffWith("onlyread@club.org", ["Roster.Read"]);
    for (const who of [onlyLink, onlyRead]) {
      asStaff(who);
      await expect(confirmAllAction("", "", bulk.count, tag, bulk.stamp!)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === onlyLink.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    expect(refusals.filter((a) => a.actorId === onlyRead.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    expect(await confirmLinks()).toEqual([]);

    asStaff(linker);
    const notFromPage = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const [status, q, count] of [["bogus", "", bulk.count], ["", "x".repeat(101), bulk.count], ["", "", 0], ["", "", 1.5], ["", "", "2"], ["", "", BULK_MAX + 1], [null, "", bulk.count]] as const) {
      expect(await confirmAllAction(status as never, q as never, count as never, tag, bulk.stamp!), JSON.stringify([status, q, count])).toEqual(notFromPage);
    }
    expect(await confirmAllAction("", "", bulk.count, tag, bulk.stamp!)).toMatchObject({ ok: true });
    expect(revalidatedPaths()).toContain("/");
    expect((await confirmLinks()).filter((l) => l.familyId !== null)).toHaveLength(2);
  });
});
