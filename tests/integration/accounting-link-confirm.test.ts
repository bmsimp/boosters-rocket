import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths, withoutIds } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, familyMoney, guardian, parent, qboConnection, setting, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { confirmedWords, customerAimedAt, LINK_COPY, leaveUnlinked, linkFamilyToCustomer, undoLeaveUnlinked } from "@/lib/accounting/link-writes";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { familyFromCustomer, NO_FAMILY_COPY } from "@/lib/roster/no-family";
import { loadOpenWrites, runWriteQueue } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily, changeInPortal, createInQuickBooksAndLink, keptWordsFor, MAKING_LOCK, moveStudent, NO_FAMILY_CUSTOMER } from "@/lib/roster/writes";
import { ROSTER_LOCK, SHAPE_KEY } from "@/lib/roster/shape";
import { ROSTER_MOVED, rosterTagOf } from "@/lib/seasons/roster-lock";
import { confirmLinkAction, leaveUnlinkedAction, undoLeaveUnlinkedAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent, seedStaff, untilALockIsAwaited } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { stubInvoice } from "../helpers/money";
import { rowNamed, tableRows } from "../helpers/table";

/**
 * Linking a family the portal has to a customer the books have, on the accounting links screen (stage 4's slice M3a of
 * the app-owned families spec, section 4, "The mapping screen"; src/lib/accounting/link-writes.ts): Confirm a Suggested
 * row, Confirm a Several possible row's candidate, Pick a different customer, Leave unlinked and Undo. A confirm sends
 * nothing (open question 3), links the family and the student pairs the row proposed by name, and nothing else. The
 * company is fznCompany()'s (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3, School 4; the Rivera (10) and
 * Chen (20) families have their records, carried over. Customers added after it are read by a roster read, which makes
 * no record; a family with no link is added in the portal by a staff member who may not link it.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

/** A customer as QuickBooks answers it, as fznCompany() writes them. */
const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
/** What the links page says beside every Confirm (src/app/staff/(app)/links/page.tsx), as the text of the page reads it. */
const LINK_EFFECT = "Once linked, this family's guardians see this customer's open invoices and Pay links, and those of the students and parents the books hold directly under it, the next time they open Home or Payments, and a pay-instead choice for the family bills it. A link can be removed again on this page, with Unlink from the books in the family's row, but its guardians may have seen those invoices by then, so check it is the right household.";
/** Customers added in QuickBooks, then read by a roster read (which makes no record of them). */
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}

let tag: string;
let op: ReturnType<typeof asOp>;
let linker: Awaited<ReturnType<typeof staffWith>>;
/** How the actions call the write, as the linking permission's holder. */
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });

/** A family added in the portal only (by a staff member who may not link it), with these students added there too. */
async function unlinkedFamily(name: string, students: string[] = []): Promise<AppFamilyId> {
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  const id = (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
  for (const s of students) expect(await changeInPortal({ op: "add_student", familyId: String(id), name: s }, tag, op)).toMatchObject({ ok: true });
  return id;
}
/** An open guardian row of a new person in this family record. */
async function guardianIn(familyId: AppFamilyId, name: string, email: string) {
  const p = await seedParent({ name, email });
  await db.insert(guardian).values({ parentId: p.id, familyId, status: "invited" });
}
const studentNamed = async (familyId: AppFamilyId, name: string): Promise<AppStudentId> =>
  (await db.select({ id: student.id }).from(student).where(and(eq(student.familyId, familyId), eq(student.name, name))))[0]!.id;
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const linksOfFamily = (id: AppFamilyId) => db.select().from(accountingLink).where(eq(accountingLink.familyId, id));
const familyLinksOf = (customer: string) => db.select().from(accountingLink).where(and(eq(accountingLink.customerId, customer), isNotNull(accountingLink.familyId)));
const studentLinkOf = async (id: AppStudentId) => (await db.select().from(accountingLink).where(eq(accountingLink.studentId, id)))[0];
const markOf = async (id: AppFamilyId) => (await db.select({ at: family.accountingLeftUnlinkedAt, by: family.accountingLeftUnlinkedBy }).from(family).where(eq(family.id, id)))[0]!;
/** Everything a confirm must leave as it was: every family and student record, guardian row and person, the queue and the money cache. */
const untouched = async () => ({
  families: await db.select().from(family).orderBy(asc(family.id)), students: await db.select().from(student).orderBy(asc(student.id)),
  guardians: await db.select().from(guardian).orderBy(asc(guardian.id)), people: await db.select().from(parent).orderBy(asc(parent.id)),
  queue: await db.select().from(writeQueue).orderBy(asc(writeQueue.id)), money: await db.select().from(familyMoney),
});
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

/** The Patels: a family the portal has, its guardian's address on the Patel Family customer (70), with students on both sides. */
const PATELS = [qc("70", "Patel Family", "1", { ...mail("asha@example.com"), SyncToken: "4" }), qc("71", "Asha Patel", "3", { ...under("70"), SyncToken: "2" }),
  qc("72", "Ravi Patel", "3", { ...under("70"), Active: false, SyncToken: "3" }), qc("73", "Dev Patel", "3", under("70"))];
async function seedPatels(): Promise<AppFamilyId> {
  await readAgain(...PATELS);
  const patels = await unlinkedFamily("The Patels", ["Asha Patel", "ravi patel", "Mia Patel"]);
  await guardianIn(patels, "Asha Patel", "asha@example.com");
  return patels;
}

beforeEach(async () => {
  await resetDb(); stub.reset();
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
});
/** The FZN company connected, its roster read and its records made, in layered books with a student and a parent type. */
const connected = () => beforeEach(async () => { tag = await connectRoster(stub); });

describe("Confirm on a Suggested row", () => {
  connected();
  it("proposes students by name, one to one, and the press links the family and those pairs, confirmed, aligned, audited, and nothing else", async () => {
    const patels = await seedPatels();
    const [asha, ravi, mia] = [await studentNamed(patels, "Asha Patel"), await studentNamed(patels, "ravi patel"), await studentNamed(patels, "Mia Patel")];
    const row = rowOf(await loadAccountingLinks(), "The Patels");
    expect(row.status).toMatchObject({ key: "suggested" });
    expect(row.offers).toEqual({ leave: true, pick: false, undo: false });
    expect(row.confirm).toMatchObject({ customerId: "70", chosen: "suggested", stamp: expect.any(String) });
    expect(row.confirm!.proposals).toEqual({
      pairs: [{ studentId: asha, recordName: "Asha Patel", customerQboId: "71", customerName: "Asha Patel", customerActive: true },
        { studentId: ravi, recordName: "ravi patel", customerQboId: "72", customerName: "Ravi Patel", customerActive: false }],
      recordsLeft: [{ id: mia, name: "Mia Patel" }], customersLeft: [{ qboId: "73", name: "Dev Patel", active: true }] });
    // Before the press: no link, so a parent's page reads no figures and writes nothing.
    expect(await loadFamilyMoney(patels)).toMatchObject({ figures: null, notConnected: true });
    expect(await db.select().from(familyMoney).where(eq(familyMoney.familyId, patels))).toEqual([]);

    const before = await untouched();
    stub.calls.length = 0;
    const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp());
    expect(r).toEqual({ ok: true, message: "The Patels is linked to “Patel Family” in the books. 2 students linked with it: Asha Patel and ravi patel."
      + " Left with no link: Mia Patel, of the portal's students. Left with no record in the portal: Dev Patel, of the student customers under it in the books."
      + " Whoever was left shows with the family's row on this page, among its differences. Nothing was sent to the books."
      + " Its money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected;"
      + " its Balances page shows the figures once one of those has read them."
      + " Its guardians' own records in the books aren't linked by this." });
    // Nothing asked of QuickBooks, and no record, guardian row, person, queue item or money row changed.
    expect(stub.apiCalls()).toEqual([]);
    expect(await untouched()).toEqual(before);

    const [familyLink] = await linksOfFamily(patels);
    expect(familyLink).toMatchObject({ system: "quickbooks", realmId: REALM, customerId: "70", origin: "confirmed", linkedBy: linker.id, syncedToken: "4", syncedAt: expect.any(Date) });
    expect(await studentLinkOf(asha)).toMatchObject({ realmId: REALM, customerId: "71", origin: "confirmed", linkedBy: linker.id, syncedToken: "2" });
    expect(await studentLinkOf(ravi)).toMatchObject({ customerId: "72", origin: "confirmed", syncedToken: "3" });
    expect(await studentLinkOf(mia)).toBeUndefined();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "73"))).toEqual([]);
    expect(await db.select().from(accountingLink).where(isNotNull(accountingLink.guardianId))).toHaveLength(0); // no guardian link (M3c's)

    const [audit] = await auditsOf("accounting.link.confirm");
    expect(audit).toMatchObject({ actorId: linker.id, permission: "Accounting.Link.ReadWrite", targetType: "family", targetId: String(patels) });
    const ids = (await db.select({ id: accountingLink.id }).from(accountingLink).where(eq(accountingLink.linkedBy, linker.id))).map((l) => l.id).sort();
    const after = audit!.after as Record<string, unknown>;
    expect(after).toEqual({ familyId: String(patels), customerQboId: "70", realmId: REALM, chosen: "suggested",
      studentsLinked: [{ studentId: String(asha), customerQboId: "71" }, { studentId: String(ravi), customerQboId: "72" }],
      studentsLeft: [String(mia)], studentCustomersLeft: ["73"], linkIds: expect.any(Array) });
    expect([...(after.linkIds as string[])].sort()).toEqual(ids);
    expect(JSON.stringify(after)).not.toContain("asha@example.com");

    // After: the row is linked, confirmed by whom, and what was left reads as M2's differences.
    const now = rowOf(await loadAccountingLinks(), "The Patels");
    expect(now.status).toMatchObject({ key: "with_differences", made: { key: "linked", origin: "confirmed", by: "linker" } });
    expect(now.differences).toEqual(expect.arrayContaining([
      { kind: "student_unlinked", who: "Mia Patel", studentId: mia, queue: null }, { kind: "student_customer", books: "Dev Patel" }]));
    expect(now.confirm).toBeNull();
    // Its money is read live at the next page load.
    stub.invoices.push(stubInvoice("9001", "70", { TotalAmt: 20, Balance: 20 }));
    expect(await loadFamilyMoney(patels)).toMatchObject({ notConnected: false, figures: { current: true, totalCents: 2000 } });
  });

});

describe("in flat books", () => {
  it("proposes nothing of students, and links the member alone", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("71", "Asha Patel", "3", under("70")));
    expect(await addFamily({ role: "member", name: "The Patels", typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true });
    const patels = (await db.select({ id: family.id }).from(family).where(eq(family.name, "The Patels")))[0]!.id;
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const row = rowOf(await loadAccountingLinks(), "The Patels");
    expect(row.confirm!.proposals).toEqual({ pairs: [], recordsLeft: [], customersLeft: [] });
    const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp());
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("No student was linked with it.") });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "71"))).toEqual([]);
  });
});

describe("Several possible and Pick a different customer", () => {
  connected();
  it("confirms one of a Several possible row's candidates from the confirm step, and picks one that isn't a candidate", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("75", "Patel Household", "1", mail("ravi@example.com")), qc("90", "Quiet Family", "1"));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await guardianIn(patels, "Ravi Patel", "ravi@example.com");
    const view = await loadAccountingLinks();
    const row = rowOf(view, "The Patels");
    expect(row.status).toMatchObject({ key: "several", why: "many", candidates: [{ qboId: "70" }, { qboId: "75" }] });
    expect(row.offers).toEqual({ leave: true, pick: true, undo: false });
    expect(row.confirm).toBeNull();
    const candidate = view.step(String(patels), "75");
    expect(candidate).toMatchObject({ ok: true, family: "The Patels", customer: { qboId: "75", name: "Patel Household", email: "ravi@example.com" }, offer: { chosen: "several" } });
    expect(view.step(String(patels), "90")).toMatchObject({ ok: true, offer: { chosen: "picked" } });
    // A candidate confirmed as picked, or a pool customer as a candidate, is refused: the way it was chosen is sealed.
    const offer = (candidate as { offer: { stamp: string } }).offer;
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "75", chosen: "picked", stamp: offer.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "75", chosen: "several", stamp: offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect((await linksOfFamily(patels)).map((l) => l.customerId)).toEqual(["75"]);
    expect((await auditsOf("accounting.link.confirm"))[0]!.after).toMatchObject({ chosen: "several", customerQboId: "75" });
  });

  it("presses Pick a different customer on a Several possible row, linking a customer of the pool that is none of its candidates", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("75", "Patel Household", "1", mail("ravi@example.com")), qc("90", "Quiet Family", "1"));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await guardianIn(patels, "Ravi Patel", "ravi@example.com");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Patels")).toMatchObject({ status: { key: "several" }, offers: { leave: true, pick: true, undo: false } });
    const step = view.step(String(patels), "90");
    expect(step).toMatchObject({ ok: true, offer: { chosen: "picked" } });
    // The same step's stamp, sent as a candidate's, is refused: the way it was chosen is sealed.
    const stamp = (step as { offer: { stamp: string } }).offer.stamp;
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "90", chosen: "several", stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "90", chosen: "picked", stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect((await linksOfFamily(patels)).map((l) => l.customerId)).toEqual(["90"]);
    const rows = (await auditsOf("accounting.link.confirm")).filter((a) => a.targetId === String(patels));
    expect(rows.map((a) => a.after)).toMatchObject([{ chosen: "picked", customerQboId: "90" }]);
    // Its two candidates stay in the pool, linked to no family.
    expect(await familyLinksOf("70")).toEqual([]);
    expect(await familyLinksOf("75")).toEqual([]);
  });

  it("picks for a No match row, and for a Several possible row, from the pool", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("75", "Patel Household", "1", mail("ravi@example.com")), qc("90", "Quiet Family", "1"));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await guardianIn(patels, "Ravi Patel", "ravi@example.com");
    const quiet = await unlinkedFamily("The Quiets");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Quiets")).toMatchObject({ status: { key: "no_match", noGuardians: true }, offers: { leave: true, pick: true, undo: false } });
    const step = view.step(String(quiet), "90");
    expect(step).toMatchObject({ ok: true, offer: { chosen: "picked" }, alsoFor: [] });
    expect(await linkFamilyToCustomer({ familyId: String(quiet), customerId: "90", chosen: "picked", stamp: (step as { offer: { stamp: string } }).offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect((await linksOfFamily(quiet)).map((l) => l.customerId)).toEqual(["90"]);
    // With 90 linked, the pool holds only the Patels' two candidates, and either reads as a candidate on their step.
    const again = await loadAccountingLinks();
    expect(again.pool!.map((c) => c.qboId)).toEqual(["70", "75"]);
    const picked = again.step(String(patels), "70");
    expect(picked).toMatchObject({ ok: true, offer: { chosen: "several" } });
    // A customer the screen suggests for another family is said on the step.
    const other = await unlinkedFamily("Asha's Other Family");
    await guardianIn(other, "Asha Two", "asha2@example.com");
    expect((await loadAccountingLinks()).step(String(other), "70")).toMatchObject({ ok: true, offer: { chosen: "picked" }, alsoFor: ["The Patels"] });
  });
});

describe("Leave unlinked, and Undo", () => {
  connected();
  it("leaves a Suggested, a Several possible and a No match row; the family reads Left unlinked, by whom, with its filter and count, and gives no suggestion", async () => {
    // Ike's and Ada's families share the Okafor customer's field: both Several possible, shared.
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("80", "Okafor Family", "1", mail("ike@example.com, ada@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const ike = await unlinkedFamily("Ike's Family");
    await guardianIn(ike, "Ike Okafor", "ike@example.com");
    const ada = await unlinkedFamily("Ada's Family");
    await guardianIn(ada, "Ada Okafor", "ada@example.com");
    const quiet = await unlinkedFamily("The Quiets");
    let view = await loadAccountingLinks();
    expect(rowOf(view, "Ike's Family").status).toMatchObject({ key: "several", why: "shared" });

    for (const [id, name] of [[patels, "The Patels"], [ada, "Ada's Family"], [quiet, "The Quiets"]] as const) {
      expect(await leaveUnlinked(String(id), tag, linkOp()), name).toEqual({ ok: true, message: `${name} is left unlinked: this page suggests no customer for it, and it takes no part in another family's suggestion, until someone undoes it or links it. Nothing was sent to the books.` });
      expect(await markOf(id)).toEqual({ at: expect.any(Date), by: linker.id });
    }
    view = await loadAccountingLinks();
    for (const name of ["The Patels", "Ada's Family", "The Quiets"]) {
      expect(rowOf(view, name)).toMatchObject({ status: { key: "left_unlinked", by: "linker", at: expect.any(String) }, customer: null, confirm: null, offers: { leave: false, pick: true, undo: true } });
    }
    // Ada's family is given to no matcher, so Ike's is Suggested now.
    expect(rowOf(view, "Ike's Family").status).toMatchObject({ key: "suggested", holders: [{ address: "ike@example.com" }] });
    const [audit] = await auditsOf("accounting.link.leave_unlinked");
    expect(audit).toMatchObject({ targetType: "family", permission: "Accounting.Link.ReadWrite" });
    expect(audit!.before).toMatchObject({ leftUnlinkedAt: null, leftUnlinkedBy: null });
    expect(audit!.after).toMatchObject({ leftUnlinkedAt: expect.any(String), leftUnlinkedBy: linker.id });
    // A second press changes nothing.
    expect(await leaveUnlinked(String(quiet), tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.alreadyLeft] });
    expect(await auditsOf("accounting.link.leave_unlinked")).toHaveLength(3);

    // The page: the status in words with who and when, its filter and count, and Undo and Pick in the opening.
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await renderPage(AccountingLinksPage);
    expect(html).toContain('<option value="left_unlinked">Left unlinked (3)</option>');
    const list = html.slice(html.indexOf('id="links-list-h"'));
    expect(rowNamed(list, "The Quiets")![3]).toMatch(/^Left unlinkedLeft unlinked by linker, on .+\. No customer is suggested for it until someone undoes this or links it\.$/);
    expect(rowNamed(list, "The Quiets")![4]).toBe("Students and guardians: The QuietsNo active students.No guardians.Pick a different customer: The QuietsUndo Left unlinked: The Quiets");
    const filtered = await renderPage(AccountingLinksPage, { searchParams: { status: "left_unlinked" } });
    expect(tableRows(filtered.slice(filtered.indexOf('id="links-list-h"'))).map((r) => r[0])).toEqual(["Ada's Family", "The Patels", "The Quiets"]);

    // Undo: the mark goes, and the family is suggested again.
    expect(await undoLeaveUnlinked(String(patels), tag, linkOp())).toEqual({ ok: true, message: "The Patels is no longer left unlinked: this page suggests a customer for it again where one matches." });
    expect(await markOf(patels)).toEqual({ at: null, by: null });
    expect(rowOf(await loadAccountingLinks(), "The Patels").status).toMatchObject({ key: "suggested" });
    const [undone] = await auditsOf("accounting.link.leave_unlinked.undo");
    expect(undone).toMatchObject({ targetType: "family", targetId: String(patels), before: { leftUnlinkedBy: linker.id }, after: { leftUnlinkedAt: null, leftUnlinkedBy: null } });
    expect(await undoLeaveUnlinked(String(patels), tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.notLeft] });
  });

  it("refuses to leave a linked family, an inactive one or one whose create waits; reads Left unlinked in every state", async () => {
    const rivera = (await db.select({ id: accountingLink.familyId }).from(accountingLink).where(and(eq(accountingLink.customerId, "10"), isNotNull(accountingLink.familyId))))[0]!.id!;
    expect(await leaveUnlinked(String(rivera), tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.linkedAlready] });
    const oak = await unlinkedFamily("Oak Family");
    await seedQueued({ op: "create", role: "family", name: "Oak Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: oak });
    expect(await leaveUnlinked(String(oak), tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.createWaiting] });
    const elm = await unlinkedFamily("Elm Family");
    expect(await leaveUnlinked(String(elm), tag, linkOp())).toMatchObject({ ok: true });
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect(rowOf(await loadAccountingLinks(), "Elm Family")).toMatchObject({ status: { key: "left_unlinked" }, offers: { leave: false, pick: false, undo: true } });
    await db.update(family).set({ active: false }).where(eq(family.id, elm));
    expect(await leaveUnlinked(String(elm), tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.familyGone] });
  });
});

describe("the mark is cleared by every path that gives the family a link", () => {
  connected();
  it("by Pick a different customer on a Left unlinked row, said in its audit row", async () => {
    await readAgain(qc("90", "Quiet Family", "1"));
    const quiet = await unlinkedFamily("The Quiets");
    expect(await leaveUnlinked(String(quiet), tag, linkOp())).toMatchObject({ ok: true });
    const step = (await loadAccountingLinks()).step(String(quiet), "90");
    expect(step).toMatchObject({ ok: true, offer: { chosen: "picked" } });
    expect(await linkFamilyToCustomer({ familyId: String(quiet), customerId: "90", chosen: "picked", stamp: (step as { offer: { stamp: string } }).offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await markOf(quiet)).toEqual({ at: null, by: null });
    expect((await auditsOf("accounting.link.confirm"))[0]!.after).toMatchObject({ chosen: "picked", leftUnlinkedCleared: true });
  });

  it("by Create in QuickBooks and link, sent at once", async () => {
    const oak = await unlinkedFamily("Oak Family");
    expect(await leaveUnlinked(String(oak), tag, linkOp())).toMatchObject({ ok: true });
    expect((await createInQuickBooksAndLink(String(oak), null, tag, op)).result).toMatchObject({ ok: true });
    expect((await linksOfFamily(oak))).toHaveLength(1);
    expect(await markOf(oak)).toEqual({ at: null, by: null });
    expect(await clearedInAudit(oak)).toBe(true);
  });

  it("by a create the queue finishes, after a lost answer", async () => {
    const oak = await unlinkedFamily("Oak Family");
    expect(await leaveUnlinked(String(oak), tag, linkOp())).toMatchObject({ ok: true });
    stub.loseUpdateAnswer = true;
    await createInQuickBooksAndLink(String(oak), null, tag, op);
    stub.loseUpdateAnswer = false;
    expect(await markOf(oak)).toMatchObject({ by: linker.id }); // not linked yet
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 1000) });
    await runWriteQueue();
    expect((await linksOfFamily(oak))).toHaveLength(1);
    expect(await markOf(oak)).toEqual({ at: null, by: null });
    expect(await clearedInAudit(oak)).toBe(true);
  });

  it("by an add on Families sent at once by a holder of the linking permission", async () => {
    // The mark can't be pressed on a family while its create is on its way (it is being made), so it is set by hand at
    // the moment QuickBooks receives the create, standing for a mark that is there when the link is made.
    const adder = asOp(await staffWith("both@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    stub.onApiRequest = async (call) => {
      if (call.method !== "POST") return;
      stub.onApiRequest = null;
      await db.update(family).set({ accountingLeftUnlinkedAt: new Date(), accountingLeftUnlinkedBy: linker.id }).where(eq(family.name, "Oak Family"));
    };
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, { ...adder, mayLink: true })).toMatchObject({ ok: true, message: expect.stringContaining("linked to its new customer") });
    const oak = (await db.select({ id: family.id }).from(family).where(eq(family.name, "Oak Family")))[0]!.id;
    expect((await linksOfFamily(oak))).toHaveLength(1);
    expect(await markOf(oak)).toEqual({ at: null, by: null });
    expect(await clearedInAudit(oak)).toBe(true);
  });
});
/** Whether an audit row of a roster write says it cleared this family's mark (its appRecord, from changeOwnRecord()). */
async function clearedInAudit(familyId: AppFamilyId): Promise<boolean> {
  return (await db.select().from(auditLog)).some((a) => {
    const rec = (a.after as { appRecord?: { familyId?: string; leftUnlinkedCleared?: boolean } } | null)?.appRecord;
    return rec?.familyId === String(familyId) && rec.leftUnlinkedCleared === true;
  });
}

describe("never a wrong link", () => {
  connected();
  it("refuses a customer linked to another family between the page and the press, by Create a family from this or by a second confirm", async () => {
    // Since slice M3a2 "Create a family from this" refuses a customer a row aims at (the Patels' suggestion, 70), so a
    // customer taken by it between the page and the press is one no row aims at: Lone Family (95), which The Loners,
    // a No match row, pick from the pool.
    const patels = await seedPatels();
    await readAgain(qc("95", "Lone Family", "1"));
    const loners = await unlinkedFamily("The Loners");
    const step = (await loadAccountingLinks()).step(String(loners), "95");
    expect(step).toMatchObject({ ok: true, offer: { chosen: "picked" }, alsoFor: [] });
    expect(await familyFromCustomer("70", { ...linkOp(), mayChangeFamilies: false }, customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.suggestedFor(["The Patels"])] });
    expect(await familyFromCustomer("95", { ...linkOp(), mayChangeFamilies: false }, customerAimedAt)).toMatchObject({ ok: true });
    expect(await linkFamilyToCustomer({ familyId: String(loners), customerId: "95", chosen: "picked", stamp: (step as { offer: { stamp: string } }).offer.stamp }, tag, linkOp()))
      .toEqual({ ok: false, errors: [LINK_COPY.customerTaken] });
    expect(await linksOfFamily(loners)).toEqual([]);
    expect(await linksOfFamily(patels)).toEqual([]);
    expect(await auditsOf("accounting.link.confirm")).toEqual([]);

    // A second confirm: two No match rows drawn on one page, each with Pick for customer 90; The Quiets press first.
    await readAgain(qc("90", "Quiet Family", "1"));
    const quiet = await unlinkedFamily("The Quiets");
    const other = await unlinkedFamily("The Others");
    const view = await loadAccountingLinks();
    const stampOf = (id: AppFamilyId) => (view.step(String(id), "90") as { offer: { stamp: string } }).offer.stamp;
    const [forQuiet, forOther] = [stampOf(quiet), stampOf(other)];
    expect(await linkFamilyToCustomer({ familyId: String(quiet), customerId: "90", chosen: "picked", stamp: forQuiet }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await linkFamilyToCustomer({ familyId: String(other), customerId: "90", chosen: "picked", stamp: forOther }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.customerTaken] });
    expect(await linksOfFamily(other)).toEqual([]);
    expect(await familyLinksOf("90")).toHaveLength(1);
    // And the screen no longer offers it to The Others.
    expect((await loadAccountingLinks()).step(String(other), "90")).toEqual({ ok: false, why: "customer" });
  });

  it("links one of two presses at once for one customer from two families; the other waits on the roster lock and is told, nothing half made", async () => {
    await readAgain(qc("90", "Quiet Family", "1"), qc("91", "Kim Quiet", "3", under("90")));
    const a = await unlinkedFamily("The Quiets", ["Kim Quiet"]);
    const b = await unlinkedFamily("Quiet House", ["Kim Quiet"]);
    const view = await loadAccountingLinks();
    const stampOf = (id: AppFamilyId) => { const s = view.step(String(id), "90"); return (s as { offer: { stamp: string } }).offer.stamp; };
    const [sa, sb] = [stampOf(a), stampOf(b)];
    const lock = await holdRosterLock();
    const presses = [linkFamilyToCustomer({ familyId: String(a), customerId: "90", chosen: "picked", stamp: sa }, tag, linkOp()),
      linkFamilyToCustomer({ familyId: String(b), customerId: "90", chosen: "picked", stamp: sb }, tag, linkOp())];
    await untilALockIsAwaited(15_000, 2);
    lock.release();
    await lock.held;
    const answers = await Promise.all(presses);
    expect(answers.filter((x) => x.ok)).toHaveLength(1);
    expect(answers.filter((x) => !x.ok)).toEqual([{ ok: false, errors: [LINK_COPY.customerTaken] }]);
    expect(await familyLinksOf("90")).toHaveLength(1);
    // The one linked has its student; the other has nothing at all.
    const won = (await familyLinksOf("90"))[0]!.familyId!;
    const lost = String(won) === String(a) ? b : a;
    expect(await studentLinkOf(await studentNamed(won, "Kim Quiet"))).toMatchObject({ customerId: "91" });
    expect(await studentLinkOf(await studentNamed(lost, "Kim Quiet"))).toBeUndefined();
    expect(await linksOfFamily(lost)).toEqual([]);
    expect(await auditsOf("accounting.link.confirm")).toHaveLength(1);
  });

  it("refuses a stale stamp: a student renamed, added or moved in since the page", async () => {
    const patels = await seedPatels();
    const stale = async () => {
      const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: stamp }, tag, linkOp());
      expect(r).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
      expect(await linksOfFamily(patels)).toEqual([]);
    };
    let stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    // Renamed: Mia becomes Dev Patel, so she would pair with customer 73 now.
    expect(await changeInPortal({ op: "rename_student", studentId: String(await studentNamed(patels, "Mia Patel")), name: "Dev Patel" }, tag, op)).toMatchObject({ ok: true });
    await stale();
    stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    // Added: a second Asha Patel, so neither Asha is paired.
    expect(await changeInPortal({ op: "add_student", familyId: String(patels), name: "Asha Patel" }, tag, op)).toMatchObject({ ok: true });
    await stale();
    stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    // Moved in: a Kim Patel from another family, as the books have a Kim Patel under the Patels.
    await readAgain(qc("74", "Kim Patel", "3", under("70")));
    stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    const others = await unlinkedFamily("The Others", ["Kim Patel"]);
    expect(await moveStudent(String(await studentNamed(others, "Kim Patel")), String(patels), tag, op)).toMatchObject({ ok: true });
    await stale();
    expect(await auditsOf("accounting.link.confirm")).toEqual([]);
  });

  it("refuses forged values: another family's customer, a student customer, one not in the pool, not digits, a forged way of choosing, a family that isn't one", async () => {
    const patels = await seedPatels();
    const stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    const press = (customerId: unknown, chosen: unknown = "suggested", familyId: unknown = String(patels)) => linkFamilyToCustomer({ familyId, customerId, chosen, stamp }, tag, linkOp());
    expect(await press("20")).toEqual({ ok: false, errors: [LINK_COPY.customerTaken] }); // the Chens'
    expect(await press("40")).toEqual({ ok: false, errors: [LINK_COPY.customerTaken] }); // the inactive Old Family's, whose record is linked to it
    for (const id of ["71", "30", "50", "99999"]) expect(await press(id), id).toEqual({ ok: false, errors: [LINK_COPY.notInPool] });
    for (const id of ["7O", "", " 70", "1".repeat(20), 70, null]) expect(await press(id), String(id)).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    for (const chosen of ["anything", "", null, 1]) expect(await press("70", chosen), String(chosen)).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    expect(await press("70", "several")).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await press("70", "picked")).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await press("70", "suggested", "not-a-uuid")).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    expect(await press("70", "suggested", "00000000-0000-4000-8000-000000000999")).toEqual({ ok: false, errors: [LINK_COPY.familyGone] });
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: "forged" }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.linkedBy, linker.id))).toEqual([]);
  });

  it("refuses while the family's own create waits or is being made, and for a roster tag of another company", async () => {
    const patels = await seedPatels();
    const stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    const press = (t = tag) => linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp }, t, linkOp());
    expect(await press(rosterTagOf("9130000000000999"))).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    expect(await press("none")).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    // Being made: its sender holds the family's "being made" lock.
    let release = () => {};
    let held: Promise<void> = Promise.resolve();
    await new Promise<void>((took) => {
      held = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(MAKING_LOCK))}, hashtext(${String(patels)}::text))`);
        took();
        await new Promise<void>((r) => { release = () => r(); });
      });
    });
    expect(await press()).toEqual({ ok: false, errors: [LINK_COPY.createSending] });
    // Leave unlinked is refused the same way while the family is being made, setting no mark.
    expect(await leaveUnlinked(String(patels), tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.createSending] });
    expect(await markOf(patels)).toEqual({ at: null, by: null });
    release();
    await held;
    // Waiting on the queue, filed under the record (another name, so its customer isn't the one a create would be found as).
    const item = await seedQueued({ op: "create", role: "family", name: "The Patels", typeQboId: "1", familyQboId: null, email: null }, { familyId: patels });
    expect(await press()).toEqual({ ok: false, errors: [LINK_COPY.createWaiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, item.id));
    // While the books are connected to another company, nothing is linked.
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    expect(await press()).toEqual({ ok: false, errors: [LINK_COPY.other_company] });
    await db.update(qboConnection).set({ realmId: REALM });
    expect(await press()).toMatchObject({ ok: true });
  });
});

describe("after a confirm", () => {
  connected();
  it("offers Send the portal's value for a move into the family kept only because it had no customer, and says so", async () => {
    const patels = await seedPatels();
    // Leo Rivera, linked, moved in the portal to The Patels, which has no customer: the move is kept refused.
    const leo = (await db.select({ id: accountingLink.studentId }).from(accountingLink).where(and(eq(accountingLink.customerId, "12"), isNotNull(accountingLink.studentId))))[0]!.id!;
    expect(await moveStudent(String(leo), String(patels), tag, op)).toMatchObject({ ok: true });
    let [kept] = (await loadOpenWrites()).filter((i) => i.write.op === "move");
    expect(kept).toMatchObject({ state: "refused", lastCode: NO_FAMILY_CUSTOMER, notOffered: "create_family_first", joined: null });
    expect(keptWordsFor(kept!.write, kept!.lastCode, kept!.holds, kept!.differs, kept!.joined)).toContain("Create the family in QuickBooks first");
    const stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp }, tag, linkOp());
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("A student's move into this family, kept on Reconciliation only because the family had no customer in the books, can now be sent from there.") });
    [kept] = (await loadOpenWrites()).filter((i) => i.write.op === "move");
    expect(kept).toMatchObject({ state: "refused", notOffered: null, mayResend: true, joined: "sendable" });
    // The kept row's words go by what is so now: the family has its customer, and the move can be sent.
    expect(keptWordsFor(kept!.write, kept!.lastCode, kept!.holds, kept!.differs, kept!.joined)).toBe("The portal held it back when it was saved: the family the student was moved to had no customer in QuickBooks then."
      + " It has one now, so the portal's move can be sent with “Send the portal's value” on the Reconciliation page.");
    // Leo's own link is his record's: never moved or touched by the confirm.
    expect(await studentLinkOf(leo)).toMatchObject({ customerId: "12", origin: "carried_over" });
  });

  it("doesn't say a kept move can now be sent while the books have the moved student's customer inactive, since Reconciliation offers no press for it", async () => {
    const patels = await seedPatels();
    const leo = (await db.select({ id: accountingLink.studentId }).from(accountingLink).where(and(eq(accountingLink.customerId, "12"), isNotNull(accountingLink.studentId))))[0]!.id!;
    expect(await moveStudent(String(leo), String(patels), tag, op)).toMatchObject({ ok: true });
    // Leo's customer made inactive in QuickBooks, then a roster read: the cache has it inactive (the roster tag is the company's, so it holds).
    stub.customers.find((c) => c.Id === "12")!.Active = false;
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    const stamp = rowOf(await loadAccountingLinks(), "The Patels").confirm!.stamp;
    const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp }, tag, linkOp());
    expect(r).toMatchObject({ ok: true });
    expect((r as { message: string }).message).not.toContain("can now be sent");
    const [kept] = (await loadOpenWrites()).filter((i) => i.write.op === "move");
    expect(kept).toMatchObject({ state: "refused", lastCode: NO_FAMILY_CUSTOMER, notOffered: "inactive", joined: "not_offered" });
    // The family has its customer now, said as so, and nothing says the move can be sent (the row's notice says why not).
    expect(keptWordsFor(kept!.write, kept!.lastCode, kept!.holds, kept!.differs, kept!.joined)).toBe("The portal held it back when it was saved: the family the student was moved to had no customer in QuickBooks then. It has one now.");
  });

  it("says where an inactive student customer left goes once the family is linked: counted on its row, never among its differences", () => {
    const base = { family: "The Patels", customer: "Patel Family", linked: [], recordsLeft: [], keptMoves: 0 };
    expect(confirmedWords({ ...base, customersLeft: [{ name: "Ravi Patel", active: false }] })).toContain(
      "Left with no record in the portal: Ravi Patel (inactive in the books), of the student customers under it in the books."
      + " That inactive student customer is counted with the family's row on this page, not listed among its differences.");
    const both = confirmedWords({ ...base, recordsLeft: ["Mia Patel"], customersLeft: [{ name: "Dev Patel", active: true }, { name: "Ravi Patel", active: false }] });
    expect(both).toContain("Whoever was left shows with the family's row on this page: an inactive student customer in the books in a count there, everyone else among its differences.");
    expect(both).not.toContain("Whoever was left shows with the family's row on this page, among its differences.");
  });
});

describe("who may press, and the page", () => {
  connected();
  it("is the linking permission's with Roster.Read: either alone is refused as the guard refuses, changing nothing", async () => {
    const patels = await seedPatels();
    const row = rowOf(await loadAccountingLinks(), "The Patels");
    const args = [String(patels), "70", "suggested", tag, row.confirm!.stamp] as const;
    const onlyLink = await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]);
    const onlyRead = await staffWith("onlyread@club.org", ["Roster.Read"]);
    for (const who of [onlyLink, onlyRead]) {
      asStaff(who);
      await expect(confirmLinkAction(...args)).rejects.toBeInstanceOf(AccessDenied);
      await expect(leaveUnlinkedAction(String(patels), tag)).rejects.toBeInstanceOf(AccessDenied);
      await expect(undoLeaveUnlinkedAction(String(patels), tag)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === onlyLink.id).map((a) => a.permission)).toEqual(["Roster.Read", "Roster.Read", "Roster.Read"]);
    expect(refusals.filter((a) => a.actorId === onlyRead.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite", "Accounting.Link.ReadWrite", "Accounting.Link.ReadWrite"]);
    expect(await linksOfFamily(patels)).toEqual([]);
    expect(await markOf(patels)).toEqual({ at: null, by: null });

    asStaff(linker);
    const notFromPage = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const odd of [undefined, null, 70, ["70"], "", "x".repeat(65)]) expect(await confirmLinkAction(String(patels), odd as never, "suggested", tag, row.confirm!.stamp), JSON.stringify(odd)).toEqual(notFromPage);
    expect(await confirmLinkAction(String(patels), "70", "bulk", tag, row.confirm!.stamp)).toEqual(notFromPage);
    expect(await leaveUnlinkedAction(null as never, tag)).toEqual(notFromPage);
    expect(await confirmLinkAction(...args)).toMatchObject({ ok: true });
    expect(revalidatedPaths()).toContain("/");
    expect((await linksOfFamily(patels)).map((l) => l.customerId)).toEqual(["70"]);
  });

  it("draws a Suggested row's proposals with Confirm and Leave unlinked, the chooser and the confirm step, the books' text as text", async () => {
    await readAgain(...PATELS, qc("95", "<b>Bold</b> Family", "1", mail("bold@example.com")));
    const patels = await unlinkedFamily("The Patels", ["Asha Patel", "ravi patel", "Mia Patel"]);
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const quiet = await unlinkedFamily("The Quiets");
    asStaff(linker);
    const list = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };
    const pick = (html: string) => { const at = html.indexOf('id="links-pick-h"'); return at < 0 ? null : html.slice(at, html.indexOf("</section>", at)); };
    let html = await renderPage(AccountingLinksPage);
    expect(rowNamed(list(html), "The Patels")![4]).toBe("Students and guardians: The PatelsStudents:Asha Patel: no link of its ownMia Patel: no link of its ownravi patel: no link of its own"
      + "Guardians:Asha Patel (asha@example.com): no link of its own"
      + "Confirming links it to “Patel Family”. Nothing is sent to the books.Students linked with it, by name:Asha Patel with Asha Patelravi patel with Ravi Patel (inactive in the books)"
      + "Left with no link, of the portal's students:Mia PatelLeft with no record in the portal, of the student customers under it in the books:Dev Patel"
      + "Students left aren't linked by this press. Once the family is linked, they show with its row among its differences." + LINK_EFFECT + "Confirm: The PatelsLeave unlinked: The Patels");
    expect(withoutIds(list(html))).toContain('href="/staff/links?pick=<id>#links-pick-h"');
    expect(pick(html)).toBeNull();

    // The chooser: the pool by name with its email field, searchable; the books' text as text.
    html = await renderPage(AccountingLinksPage, { searchParams: { pick: String(quiet) } });
    let part = pick(html)!;
    expect(part).toContain("A customer for The Quiets");
    expect(tableRows(part).map((r) => r[0]).sort()).toEqual(["<b>Bold</b> Familybold@example.com", "Patel Familyasha@example.com"]);
    expect(part).toContain("&lt;b&gt;Bold&lt;/b&gt; Family");
    expect(part).not.toContain("<b>Bold</b>");
    part = pick(await renderPage(AccountingLinksPage, { searchParams: { pick: String(quiet), cq: "ASHA@" } }))!;
    expect(tableRows(part).map((r) => r[0])).toEqual(["Patel Familyasha@example.com"]);
    // The confirm step: the family, the customer, how it was chosen, the proposals, the other family it is suggested for, and Confirm.
    part = pick(await renderPage(AccountingLinksPage, { searchParams: { pick: String(quiet), customer: "70" } }))!;
    expect(part).toContain("Link The Quiets to “Patel Family”?");
    expect(part).toContain("You picked it from the customers no family is linked to. Its email field in the books: asha@example.com.");
    expect(part).toContain("This page also suggests this customer for, or lists it as a possible customer of, The Patels.");
    expect(part).toContain("Left with no record in the portal, of the student customers under it in the books:");
    expect(part).toContain("Confirm<span class=\"visually-hidden\">: The Quiets</span>");
    // What the link does on the parents' side, and how it is removed again; Patel Family has no Parent customer under it.
    expect(part).toContain(`<p>${LINK_EFFECT.replaceAll("'", "&#x27;")}</p>`);
    expect(part).toContain("<p>The books hold no Parent customers directly under it.</p>");
    // Refused as plain notices: a family not on the list, a Suggested row (no pick), a customer not in the pool.
    expect(await renderPage(AccountingLinksPage, { searchParams: { pick: "00000000-0000-4000-8000-000000000999" } })).toContain("That family isn&#x27;t one a customer can be picked for here now");
    expect(await renderPage(AccountingLinksPage, { searchParams: { pick: String(patels) } })).toContain("That family isn&#x27;t one a customer can be picked for here now");
    expect(pick(await renderPage(AccountingLinksPage, { searchParams: { pick: String(quiet), customer: "20" } }))).toContain("That customer isn&#x27;t one with no family in the portal now");
    // The words of the screen, each true now.
    expect(html).toContain("A family the portal has is linked here");
    expect(html).toContain("Nothing here is sent to the books.");
    expect(await auditsOf("accounting.link.confirm")).toEqual([]);
  });

  it("the confirm step names, as text, the Parent customers the books hold directly under the customer, and no other", async () => {
    // Two Parent customers under Patel Family (one inactive), and one under a student customer, which isn't directly under it.
    await readAgain(...PATELS, qc("74", "Kiran <i>Patel</i>", "2", under("70")), qc("76", "Old Patel", "2", { ...under("70"), Active: false }), qc("77", "Asha Patel Sr", "2", under("71")));
    const quiet = await unlinkedFamily("The Quiets");
    asStaff(linker);
    const html = await renderPage(AccountingLinksPage, { searchParams: { pick: String(quiet), customer: "70" } });
    const at = html.indexOf('id="links-pick-h"');
    const part = html.slice(at, html.indexOf("</section>", at));
    expect(part).toContain("<p>Parent customers the books hold directly under it:</p><ul><li>Kiran &lt;i&gt;Patel&lt;/i&gt;</li><li>Old Patel (inactive in the books)</li></ul>");
    expect(part).not.toContain("Asha Patel Sr");
    expect(part).not.toContain("no Parent customers");
    expect((await loadAccountingLinks()).step(String(quiet), "70")).toMatchObject({ ok: true,
      parents: [{ qboId: "74", name: "Kiran <i>Patel</i>", active: true }, { qboId: "76", name: "Old Patel", active: false }] });
  });

  it("draws a Several possible row's candidates, each to look at before linking, and says on the chooser what a create given up after a try left in the books", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("75", "Patel Household", "1", mail("ravi@example.com")), qc("90", "Quiet Family", "1"));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await guardianIn(patels, "Ravi Patel", "ravi@example.com");
    const quiet = await unlinkedFamily("The Quiets");
    // The Quiets' own create, given up after a try the books may have taken: they have its customer, Quiet Family (90), with no family linked to it.
    await seedQueued({ op: "create", role: "family", name: "Quiet Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: quiet, sent: true, state: "given_up", lastTriedAt: new Date() });
    asStaff(linker);
    const list = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };
    const pick = (html: string) => { const at = html.indexOf('id="links-pick-h"'); return at < 0 ? null : html.slice(at, html.indexOf("</section>", at)).replaceAll("<!-- -->", ""); };
    const html = await renderPage(AccountingLinksPage);
    const opening = rowNamed(list(html), "The Patels")![4]!;
    expect(opening).toContain("Possible customers:Patel Family (asha@example.com) Look at it before linking: Patel FamilyPatel Household (ravi@example.com) Look at it before linking: Patel Household");
    expect(opening).not.toContain("Confirm: The Patels");
    expect(opening).toContain("Leave unlinked: The Patels");
    expect(list(html)).toContain(`href="/staff/links?pick=${String(patels)}&amp;customer=70#links-pick-h"`);
    expect(list(html)).toContain(`href="/staff/links?pick=${String(patels)}&amp;customer=75#links-pick-h"`);
    // A candidate's confirm step says how it was chosen and holds Confirm.
    const candidate = pick(await renderPage(AccountingLinksPage, { searchParams: { pick: String(patels), customer: "75" } }))!;
    expect(candidate).toContain("Link The Patels to “Patel Household”?");
    expect(candidate).toContain("Confirm<span class=\"visually-hidden\">: The Patels</span>");
    // The Quiets' chooser says what their given-up create left, and lists that customer in the pool.
    const chooser = pick(await renderPage(AccountingLinksPage, { searchParams: { pick: String(quiet) } }))!;
    expect(chooser).toContain("Making this family in the books was given up after a try the books may have taken, and they have the customer “Quiet Family” from it, with no family linked to it. If it is this family, picking it ties the two together.");
    expect(tableRows(chooser).map((r) => r[0]).sort()).toEqual(["Patel Familyasha@example.com", "Patel Householdravi@example.com", "Quiet FamilyNo email address"]);
    // The Patels' chooser says nothing of it: the create was filed under The Quiets.
    expect(pick(await renderPage(AccountingLinksPage, { searchParams: { pick: String(patels) } }))).not.toContain("was given up");
    expect(await auditsOf("accounting.link.confirm")).toEqual([]);
  });
});
