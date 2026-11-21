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
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, auditLog, family, guardian, parent, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { loadAccountingLinks, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { bulkConfirmedWords, confirmAllSuggested, confirmedWords, LINK_COPY, leaveUnlinked, linkFamilyToCustomer } from "@/lib/accounting/link-writes";
import { pairKeys } from "@/lib/accounting/proposals";
import { linkStamp } from "@/lib/accounting/stamp";
import { renamePerson } from "@/lib/parents/people";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily, changeInPortal, guardianStandings, SENDING_LOCK } from "@/lib/roster/writes";
import { confirmAllAction, confirmLinkAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";
import { rowNamed } from "../helpers/table";

/**
 * The Parent customer a match was on, linked with the family (stage 4's slice M3c2 of the app-owned families spec;
 * section 4, "A match on a parent record suggests the family above it, and the parent record is linked under it"; open
 * question 3, "Each student and parent link proposed under the family is shown in the row and confirmed with it";
 * src/lib/accounting/proposals.ts, proposeGuardians(), and link-writes.ts, linkIn()): a family's Confirm and Confirm all
 * exact email matches link each guardian row paired by its sign-in address alone, one to one, with the Parent customer
 * under the chosen customer whose email field holds it, send nothing and queue nothing. The company is fznCompany()'s
 * (Family 1, Parent 2, Student 3; the Rivera 10 and Chen 20 families carried over), with each test's customers read
 * after it by a roster read, which makes no record. Everything is seeded before a press: no helper that runs the whole
 * import (syncAppRecords()) is called after one, as the import can make or move links; seedQueued() is given each item's
 * family record, so it doesn't run the import to find one (familyRecord(), tests/helpers/volunteer.ts).
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

let tag: string;
let reg: ReturnType<typeof asOp>;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });

/** A family added in the portal only (by a staff member who may not link it), with these students added there too. */
async function unlinkedFamily(name: string, students: string[] = [], role: "family" | "member" = "family"): Promise<AppFamilyId> {
  expect(await addFamily({ role, name, typeQboId: null }, tag, { ...reg, mayLink: false })).toMatchObject({ ok: true });
  const id = (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
  for (const s of students) expect(await changeInPortal({ op: "add_student", familyId: String(id), name: s }, tag, reg)).toMatchObject({ ok: true });
  return id;
}
/** A guardian row of a new person in this family record, written directly, with no link and nothing queued. */
async function rowIn(familyId: AppFamilyId, name: string, email: string, o: { status?: "invited" | "disabled"; blocked?: boolean } = {}) {
  const p = await seedParent({ name, email, blocked: o.blocked });
  const closed = o.status === "disabled";
  const [row] = await db.insert(guardian).values({ parentId: p.id, familyId, status: o.status ?? "invited",
    disabledReason: closed ? "removed" : null, statusBeforeDisable: closed ? "invited" : null }).returning({ id: guardian.id });
  return { id: row!.id, parentId: p.id };
}
const linkRowTo = (guardianId: string, customerId: string) =>
  db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId, guardianId, origin: "confirmed", linkedBy: linker.id, syncedToken: "0", syncedAt: new Date() });
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const studentNamed = async (familyId: AppFamilyId, name: string): Promise<AppStudentId> =>
  (await db.select({ id: student.id }).from(student).where(and(eq(student.familyId, familyId), eq(student.name, name))))[0]!.id;
const linkOfRow = async (id: string) => (await db.select().from(accountingLink).where(eq(accountingLink.guardianId, id)))[0];
const guardianLinks = () => db.select().from(accountingLink).where(isNotNull(accountingLink.guardianId)).orderBy(asc(accountingLink.id));
/** Every link, guardian row, person, queue item and confirm's audit row: what a refusal must leave as it was. */
const everything = async () => ({
  links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
  guardians: await db.select().from(guardian).orderBy(asc(guardian.id)),
  people: await db.select().from(parent).orderBy(asc(parent.id)),
  queue: await db.select().from(writeQueue).orderBy(asc(writeQueue.id)),
  audits: (await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.action} in ('accounting.link.confirm', 'accounting.link.bulk')`)).length,
});
/** An advisory lock held by another session until released, as a send in progress holds a record's "being sent" lock. */
async function holdLock(first: number, id: string) {
  let release!: () => void, locked!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const taken = new Promise<void>((r) => { locked = r; });
  const holder = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(first))}, hashtext(${id}::text))`); locked(); await held; });
  await taken;
  return async () => { release(); await holder; };
}
/** The opening of a family's row on the page, as text. */
const openingOf = async (name: string) => {
  const html = await renderPage(AccountingLinksPage);
  const at = html.indexOf('id="links-list-h"');
  return rowNamed(html.slice(at, html.indexOf("</section>", at)), name)![4]!;
};

/** A page's text: tags and React's text markers gone, apostrophes and quotes as written. */
const textOf = (html: string) => html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

/** The Patels: Asha's address is on A. Patel 74, a Parent customer under the Patel Family 70; Raj Patel 75 holds no address. */
const PATELS = [qc("70", "Patel Family", "1", { SyncToken: "4" }), qc("71", "Asha Jr", "3", { ...under("70"), SyncToken: "2" }),
  qc("74", "A. Patel", "2", { ...under("70"), ...mail("asha@example.com"), SyncToken: "7" }), qc("75", "Raj Patel", "2", under("70"))];
/** The Okafors: Ike's address is on Ike Okafor 82, under the Okafor Family 80. */
const OKAFORS = [qc("80", "Okafor Family", "1"), qc("82", "Ike Okafor", "2", { ...under("80"), ...mail("ike@example.com"), SyncToken: "3" })];

beforeEach(async () => {
  await resetDb(); stub.reset();
  reg = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
});
/** The FZN company connected, its roster read and its records made, in layered books with a student and a parent type. */
const connected = () => beforeEach(async () => { tag = await connectRoster(stub); });

describe("a family's Confirm links the guardian a match was on", () => {
  connected();
  it("pairs Asha with the Parent customer holding her address, links her with the family and its student, sends nothing, and what follows goes to it", async () => {
    await readAgain(...PATELS);
    const patels = await unlinkedFamily("The Patels", ["Asha Jr"]);
    const asha = await rowIn(patels, "Asha Patel", "asha@example.com");
    const jr = await studentNamed(patels, "Asha Jr");
    const row = rowOf(await loadAccountingLinks(), "The Patels");
    expect(row.status).toEqual({ key: "suggested", holders: [{ address: "asha@example.com", on: { kind: "parent", customerId: "74", name: "A. Patel" } }] });
    expect(row.confirm!.proposals.guardians).toEqual([{ guardianId: asha.id, who: "Asha Patel", customerQboId: "74", customerName: "A. Patel" }]);
    expect(row.confirm!.proposals.guardiansHeld).toEqual([]);
    expect(row.confirm!.proposals.pairs).toEqual([expect.objectContaining({ studentId: jr, customerQboId: "71" })]);
    asStaff(linker);
    const opening = await openingOf("The Patels");
    expect(opening).toContain("Students linked with it, by name:Asha Jr with Asha Jr"
      + "Guardians linked with it, by the sign-in address their Parent customer's email field holds:Asha Patel with A. Patel");
    expect(opening).not.toContain("Raj Patel with");

    const guardiansBefore = await db.select().from(guardian).orderBy(asc(guardian.id));
    stub.calls.length = 0;
    const r = await confirmLinkAction(String(patels), "70", "suggested", tag, row.confirm!.stamp);
    expect(r).toEqual({ ok: true, message: confirmedWords({ family: "The Patels", customer: "Patel Family", linked: ["Asha Jr"], recordsLeft: [], customersLeft: [], keptMoves: 0,
      guardians: { linked: [{ who: "Asha Patel", customer: "A. Patel" }], held: 0 } }) });
    expect(r.ok && r.message).toContain("1 student linked with it: Asha Jr. 1 guardian linked with it, each to the Parent customer under it whose email field holds their sign-in address: Asha Patel to “A. Patel”."
      + " Another open guardian of the family can be linked in its row's opening on this page, with Link this guardian, where an active Parent customer directly under it is free for them and no change for them or that customer is waiting, stuck or kept on Reconciliation. Nothing was sent to the books.");
    // Nothing asked of QuickBooks, nothing queued, and the guardian row as it was: no column of it is the link's.
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(await db.select().from(guardian).orderBy(asc(guardian.id))).toEqual(guardiansBefore);

    const link = await linkOfRow(asha.id);
    expect(link).toMatchObject({ system: "quickbooks", realmId: REALM, customerId: "74", guardianId: asha.id, familyId: null, studentId: null, origin: "confirmed", linkedBy: linker.id,
      syncedToken: "7", syncedAt: expect.any(Date) });
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, patels)))[0]).toMatchObject({ customerId: "70", origin: "confirmed", syncedToken: "4" });
    expect((await db.select().from(accountingLink).where(eq(accountingLink.studentId, jr)))[0]).toMatchObject({ customerId: "71", origin: "confirmed", syncedToken: "2" });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "75"))).toEqual([]);
    const audits = (await auditsOf("accounting.link.confirm")).filter((a) => a.targetId === String(patels));
    expect(audits).toHaveLength(1);
    const after = audits[0]!.after as Record<string, unknown>;
    expect(after).toMatchObject({ guardiansLinked: [{ guardianId: asha.id, customerQboId: "74" }], guardiansHeld: [] });
    expect(after.linkIds).toContain(link!.id);

    // The row's opening shows her linked to her own Parent customer, and the family's page says so.
    const g = rowOf(await loadAccountingLinks(), "The Patels").guardians.find((x) => x.name === "Asha Patel")!;
    expect(g).toMatchObject({ standing: "own", link: { state: "linked", customer: "A. Patel" }, offer: null, unlink: { linkId: link!.id } });
    expect((await guardianStandings([{ guardianId: asha.id, familyId: patels, name: "Asha Patel", open: true }])).get(asha.id)).toBe("Linked to their own Parent customer “A. Patel”.");
    // A rename of the person now goes to that Parent customer.
    expect(await renamePerson(asha.parentId, "Asha R. Patel", reg)).toMatchObject({ ok: true });
    expect((await db.select().from(writeQueue)).map((i) => i.request)).toEqual([expect.objectContaining({ op: "rename", role: "parent", qboId: "74", name: "Asha R. Patel", guardianId: asha.id })]);
  });

  it("links each family's guardian through Confirm all exact email matches, as each row's Confirm would", async () => {
    await readAgain(...PATELS, ...OKAFORS);
    const patels = await unlinkedFamily("The Patels");
    const okafors = await unlinkedFamily("The Okafors");
    const asha = await rowIn(patels, "Asha Patel", "asha@example.com");
    const ike = await rowIn(okafors, "Ike Okafor", "ike@example.com");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Okafors").confirm!.proposals.guardians).toEqual([{ guardianId: ike.id, who: "Ike Okafor", customerQboId: "82", customerName: "Ike Okafor" }]);
    const bulk = view.bulk({ status: null, q: "" })!;
    expect(bulk.count).toBe(2);
    asStaff(linker);
    // The page says what the bulk press and a family's Confirm link of guardians; the Okafors have no student, and their row says both.
    const page = textOf(await renderPage(AccountingLinksPage));
    expect(page).toContain("to the customer filled in on its row, with the students and guardians its row's opening lists.");
    expect(page).toContain("and, where the books have Parent customers, each of its guardians whose sign-in address is in the email field of exactly one Parent customer under it"
      + " that no one is linked to (nor kept for another guardian whose link to it an unlink ended) and that holds no other of its guardians' addresses,"
      + " unless a change for them or that customer is waiting, stuck or kept on Reconciliation.");
    expect(await openingOf("The Okafors")).toContain("No student would be linked with it."
      + "Guardians linked with it, by the sign-in address their Parent customer's email field holds:Ike Okafor with Ike Okafor");
    stub.calls.length = 0;
    const r = await confirmAllAction("", "", bulk.count, tag, bulk.stamp!);
    // Asha Jr 71, a student customer under the Patel Family with no record in the portal, is left (a difference).
    expect(r).toEqual({ ok: true, message: bulkConfirmedWords({ families: ["The Okafors", "The Patels"], students: 0, recordsLeft: 0, activeCustomersLeft: 1, inactiveCustomersLeft: 0,
      keptMoves: 0, guardians: { linked: 2, held: 0 } }) });
    expect(r.ok && r.message).toContain("2 guardians linked with them in all, each to the Parent customer under their family's customer whose email field holds their sign-in address.");
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(await linkOfRow(asha.id)).toMatchObject({ customerId: "74", origin: "confirmed", linkedBy: linker.id, syncedToken: "7" });
    expect(await linkOfRow(ike.id)).toMatchObject({ customerId: "82", origin: "confirmed", linkedBy: linker.id, syncedToken: "3" });
    const [press] = await auditsOf("accounting.link.bulk");
    for (const [familyId, rowId, customer] of [[patels, asha.id, "74"], [okafors, ike.id, "82"]] as const) {
      const [audit] = (await auditsOf("accounting.link.confirm")).filter((a) => a.targetId === String(familyId));
      expect(audit!.after).toMatchObject({ bulk: (press!.after as { pressId: string }).pressId, guardiansLinked: [{ guardianId: rowId, customerQboId: customer }], guardiansHeld: [] });
    }
  });

  it("pairs by the same rule for a Several possible row's candidate and for a customer picked", async () => {
    // The Lees: Kim's address is on Kim Lee 91 and Jo's on Jo Lee 92, both under the Lee Family 90; the Lee Household 95 holds Jo's in its own field.
    await readAgain(qc("90", "Lee Family", "1"), qc("91", "Kim Lee", "2", { ...under("90"), ...mail("kim@example.com") }), qc("92", "Jo Lee", "2", { ...under("90"), ...mail("jo@example.com") }),
      qc("95", "Lee Household", "1", mail("jo@example.com")),
      // The Kos: Mina's address is on M. Ko 98 under the Ko Family 97: Suggested, then left unlinked and the customer picked.
      qc("97", "Ko Family", "1"), qc("98", "M. Ko", "2", { ...under("97"), ...mail("ko@example.com") }));
    const lees = await unlinkedFamily("The Lees");
    const kim = await rowIn(lees, "Kim Lee", "kim@example.com");
    const jo = await rowIn(lees, "Jo Lee", "jo@example.com");
    const kos = await unlinkedFamily("The Kos");
    const mina = await rowIn(kos, "Mina Ko", "ko@example.com");
    expect(await leaveUnlinked(String(kos), tag, linkOp())).toMatchObject({ ok: true });
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Lees").status).toMatchObject({ key: "several", why: "many" });
    const several = view.step(String(lees), "90");
    const picked = view.step(String(kos), "97");
    if (!several.ok || !picked.ok) throw new Error("no confirm step");
    expect(several.offer.chosen).toBe("several");
    expect(several.offer.proposals.guardians).toEqual([{ guardianId: jo.id, who: "Jo Lee", customerQboId: "92", customerName: "Jo Lee" },
      { guardianId: kim.id, who: "Kim Lee", customerQboId: "91", customerName: "Kim Lee" }]);
    expect(picked.offer).toMatchObject({ chosen: "picked", proposals: { guardians: [{ guardianId: mina.id, customerQboId: "98" }], guardiansHeld: [] } });
    // The confirm step lists them, after the students: the Lees have none, on either side, and it says both.
    asStaff(linker);
    const html = await renderPage(AccountingLinksPage, { searchParams: { pick: String(lees), customer: "90" } });
    const at = html.indexOf('id="links-pick-h"');
    expect(textOf(html.slice(at, html.indexOf("</section>", at)))).toContain("No student would be linked with it."
      + "Guardians linked with it, by the sign-in address their Parent customer's email field holds:Jo Lee with Jo LeeKim Lee with Kim Lee");
    stub.calls.length = 0;
    for (const [familyId, customerId, offer] of [[lees, "90", several.offer], [kos, "97", picked.offer]] as const) {
      expect(await linkFamilyToCustomer({ familyId: String(familyId), customerId, chosen: offer.chosen, stamp: offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    }
    expect(await linkOfRow(kim.id)).toMatchObject({ customerId: "91", origin: "confirmed" });
    expect(await linkOfRow(jo.id)).toMatchObject({ customerId: "92", origin: "confirmed" });
    expect(await linkOfRow(mina.id)).toMatchObject({ customerId: "98", origin: "confirmed" });
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("who is never paired", () => {
  connected();
  it("pairs nobody where the address isn't on exactly one free Parent customer under it, and the press links no guardian", async () => {
    // Each family is Suggested by a key guardian's address on its family customer's own field; the subject's address is
    // where the case puts it. Each family customer is 100 + 10n, its customers under it 10n + 1 and on.
    const chen = await recordOfCustomer("20", "family");
    const cases: { family: string; customers: ReturnType<typeof qc>[]; seed: (f: AppFamilyId) => Promise<void> }[] = [];
    const add = (n: number, familyName: string, customers: (id: (k: number) => string) => ReturnType<typeof qc>[], seed: (f: AppFamilyId) => Promise<void>) => {
      const base = 100 + 10 * n;
      cases.push({ family: familyName, customers: [qc(String(base), `${familyName} Customer`, "1", mail(`key${n}@example.com`)), ...customers((k) => String(base + k))],
        seed: async (f) => { await rowIn(f, `Key ${familyName}`, `key${n}@example.com`); await seed(f); } });
    };
    const subject = (n: number) => `s${n}@example.com`;
    // An address on two Parent customers under it.
    add(0, "Two Holders", (id) => [qc(id(1), "Sub One", "2", { ...under(id(0)), ...mail(subject(0)) }), qc(id(2), "Sub Two", "2", { ...under(id(0)), ...mail(subject(0)) })],
      async (f) => { await rowIn(f, "Sub Zero", subject(0)); });
    // Two rows' addresses on one Parent customer.
    add(1, "One For Two", (id) => [qc(id(1), "Both Of Them", "2", { ...under(id(0)), ...mail(`${subject(1)}, other1@example.com`) })],
      async (f) => { await rowIn(f, "Sub One", subject(1)); await rowIn(f, "Other One", "other1@example.com"); });
    // A blocked person's row.
    add(2, "Blocked", (id) => [qc(id(1), "Sub Two", "2", { ...under(id(0)), ...mail(subject(2)) })], async (f) => { await rowIn(f, "Sub Two", subject(2), { blocked: true }); });
    // A closed row.
    add(3, "Closed", (id) => [qc(id(1), "Sub Three", "2", { ...under(id(0)), ...mail(subject(3)) })], async (f) => { await rowIn(f, "Sub Three", subject(3), { status: "disabled" }); });
    // A row already linked (to Mei Chen 21, a Parent customer elsewhere).
    add(4, "Linked Row", (id) => [qc(id(1), "Sub Four", "2", { ...under(id(0)), ...mail(subject(4)) })],
      async (f) => { await linkRowTo((await rowIn(f, "Sub Four", subject(4))).id, "21"); });
    // A customer another open row of the family is linked to; one a closed row of the family is; one another family's row is.
    add(5, "Own Other Row", (id) => [qc(id(1), "Sub Five", "2", { ...under(id(0)), ...mail(subject(5)) })],
      async (f) => { await rowIn(f, "Sub Five", subject(5)); await linkRowTo((await rowIn(f, "Other Five", "other5@example.com")).id, "151"); });
    add(6, "Closed Row Linked", (id) => [qc(id(1), "Sub Six", "2", { ...under(id(0)), ...mail(subject(6)) })],
      async (f) => { await rowIn(f, "Sub Six", subject(6)); await linkRowTo((await rowIn(f, "Gone Six", "gone6@example.com", { status: "disabled" })).id, "161"); });
    add(7, "Other Familys Row", (id) => [qc(id(1), "Sub Seven", "2", { ...under(id(0)), ...mail(subject(7)) })],
      async (f) => { await rowIn(f, "Sub Seven", subject(7)); await linkRowTo((await rowIn(chen, "Chen Seven", "chen7@example.com")).id, "171"); });
    // A student-type customer; an inactive Parent customer.
    add(8, "Student Type", (id) => [qc(id(1), "Sub Eight", "3", { ...under(id(0)), ...mail(subject(8)) })], async (f) => { await rowIn(f, "Sub Eight", subject(8)); });
    add(9, "Inactive", (id) => [qc(id(1), "Sub Nine", "2", { ...under(id(0)), ...mail(subject(9)), Active: false })], async (f) => { await rowIn(f, "Sub Nine", subject(9)); });
    // A Parent customer under another customer (the Chen Family 20).
    add(10, "Under Another", () => [qc("2001", "Sub Ten", "2", { ...under("20"), ...mail(subject(10)) })], async (f) => { await rowIn(f, "Sub Ten", subject(10)); });
    // A name alike, with no address.
    add(11, "Name Alike", (id) => [qc(id(1), "Nora Name", "2", under(id(0)))], async (f) => { await rowIn(f, "Nora Name", subject(11)); });

    await readAgain(...cases.flatMap((c) => c.customers));
    for (const c of cases) await c.seed(await unlinkedFamily(c.family));
    const view = await loadAccountingLinks();
    for (const c of cases) {
      const row = rowOf(view, c.family);
      expect(row.status.key, c.family).toBe("suggested");
      expect(row.confirm!.proposals, c.family).toMatchObject({ guardians: [], guardiansHeld: [] });
    }
    const before = await guardianLinks();
    expect(before).toHaveLength(4);
    const familyLinks = (await db.select().from(accountingLink).where(isNotNull(accountingLink.familyId))).length;
    stub.calls.length = 0;
    const bulk = view.bulk({ status: null, q: "" })!;
    expect(bulk.count).toBe(cases.length);
    const r = await confirmAllSuggested({ status: "", q: "", count: bulk.count, stamp: bulk.stamp! }, tag, linkOp());
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("No guardian was linked with them.") });
    expect(await guardianLinks()).toEqual(before);
    expect(await db.select().from(accountingLink).where(isNotNull(accountingLink.familyId))).toHaveLength(familyLinks + cases.length);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("never gives another guardian the Parent customer a removed guardian's ended link keeps for her (M3b2's hold), so her reinstate makes no second one", async () => {
    // The Rus: Bea, removed, was linked to Bea Ru 501 until the family's unlink; its email field holds Cal's address too.
    await readAgain(qc("500", "Ru Family", "1"), qc("501", "Bea Ru", "2", { ...under("500"), ...mail("bea@example.com; cal@example.com") }));
    const rus = await unlinkedFamily("The Rus");
    const bea = await rowIn(rus, "Bea Ru", "bea@example.com", { status: "disabled" });
    const cal = await rowIn(rus, "Cal Ru", "cal@example.com");
    // With no ended link, Cal alone takes part and 501 is his (a closed row takes no part).
    expect(rowOf(await loadAccountingLinks(), "The Rus").confirm!.proposals.guardians).toEqual([{ guardianId: cal.id, who: "Cal Ru", customerQboId: "501", customerName: "Bea Ru" }]);
    // Bea's link to 501, ended by an unlink; Cal's ended link to it in another company keeps nothing for him.
    await db.insert(accountingLinkEnded).values([
      { id: randomUUID(), system: "quickbooks", realmId: REALM, customerId: "501", guardianId: bea.id, origin: "confirmed", linkedAt: new Date("2026-11-01T12:00:00Z"),
        linkedBy: linker.id, endedAt: new Date("2026-11-10T12:00:00Z"), endedBy: linker.id, endedHow: "unlinked" },
      { id: randomUUID(), system: "quickbooks", realmId: "another-realm", customerId: "501", guardianId: cal.id, origin: "confirmed", linkedAt: new Date("2026-11-01T12:00:00Z"),
        linkedBy: linker.id, endedAt: new Date("2026-11-11T12:00:00Z"), endedBy: linker.id, endedHow: "unlinked" },
    ]);
    const row = rowOf(await loadAccountingLinks(), "The Rus");
    expect(row.status.key).toBe("suggested");
    expect(row.confirm!.proposals).toMatchObject({ guardians: [], guardiansHeld: [] });
    stub.calls.length = 0;
    expect(await linkFamilyToCustomer({ familyId: String(rus), customerId: "500", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await guardianLinks()).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("never pairs another family's guardian, and a stamp sealing one is refused (family A's Confirm with family B's address on its Parent customer)", async () => {
    // Al's address is on the Am Family 400's own field; Bo's, of the Bms, on Bo Bm 401 under it: both families match 400.
    await readAgain(qc("400", "Am Family", "1", mail("al@example.com")), qc("401", "Bo Bm", "2", { ...under("400"), ...mail("bo@example.com") }));
    const ams = await unlinkedFamily("The Ams");
    await rowIn(ams, "Al Am", "al@example.com");
    const bms = await unlinkedFamily("The Bms");
    const bo = await rowIn(bms, "Bo Bm", "bo@example.com");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Ams").status).toMatchObject({ key: "several", why: "shared" });
    const step = view.step(String(ams), "400");
    if (!step.ok) throw new Error("no confirm step");
    expect(step.offer.proposals).toMatchObject({ guardians: [], guardiansHeld: [] });
    // A stamp sealing Bo's pair under the Ams, as a forged page would send it: refused, keeping nothing.
    const forged = linkStamp(String(ams), "400", "several", [...pairKeys(step.offer.proposals), `g:${bo.id}=401`]);
    const before = await everything();
    asStaff(linker);
    expect(await confirmLinkAction(String(ams), "400", "several", tag, forged)).toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await everything()).toEqual(before);
    expect(await confirmLinkAction(String(ams), "400", "several", tag, step.offer.stamp)).toMatchObject({ ok: true });
    expect(await linkOfRow(bo.id)).toBeUndefined();
    expect(await guardianLinks()).toEqual([]);
    expect((await db.select().from(guardian).where(eq(guardian.id, bo.id)))[0]).toMatchObject({ familyId: bms, status: "invited" });
  });
});

describe("in books with no parent type, and flat books", () => {
  it("pairs no guardian and says nothing of guardians, with no parent type", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("74", "A. Patel", "2", { ...under("70"), ...mail("asha@example.com") }));
    const patels = await unlinkedFamily("The Patels");
    await rowIn(patels, "Asha Patel", "asha@example.com");
    const view = await loadAccountingLinks();
    expect(view.guardianLinks).toBe(false);
    const row = rowOf(view, "The Patels");
    expect(row.confirm!.proposals).toMatchObject({ guardians: [], guardiansHeld: [] });
    asStaff(linker);
    expect(await openingOf("The Patels")).not.toContain("A guardian linked with it has");
    const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp());
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).not.toContain("guardian");
    expect(await guardianLinks()).toEqual([]);
  });

  it("pairs no guardian and says nothing of guardians, in flat books", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("74", "A. Patel", "2", { ...under("70"), ...mail("asha@example.com") }));
    const patels = await unlinkedFamily("The Patels", [], "member");
    await rowIn(patels, "Asha Patel", "asha@example.com");
    const view = await loadAccountingLinks();
    expect(view.guardianLinks).toBe(false);
    const row = rowOf(view, "The Patels");
    expect(row.confirm!.proposals).toMatchObject({ guardians: [], guardiansHeld: [] });
    const r = await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp());
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).not.toContain("guardian");
    expect(await guardianLinks()).toEqual([]);
  });
});

describe("what the write queue holds back", () => {
  connected();
  it("shows a pair a kept change of the row's, a stuck create of it or a waiting rename of the customer holds, links the family and students but not the guardian, and Link this guardian then isn't drawn", async () => {
    await readAgain(qc("300", "Kept Family", "1"), qc("301", "Kay Kept", "2", { ...under("300"), ...mail("kay@example.com") }), qc("302", "Kit Kept", "3", under("300")),
      qc("310", "Stuck Family", "1"), qc("311", "Stu Stuck", "2", { ...under("310"), ...mail("stu@example.com") }),
      qc("320", "Waiting Family", "1"), qc("321", "Wes Waiting", "2", { ...under("320"), ...mail("wes@example.com") }));
    const kept = await unlinkedFamily("Kept Family", ["Kit Kept"]);
    const kay = await rowIn(kept, "Kay Kept", "kay@example.com");
    const stuck = await unlinkedFamily("Stuck Family");
    const stu = await rowIn(stuck, "Stu Stuck", "stu@example.com");
    const waiting = await unlinkedFamily("Waiting Family");
    const wes = await rowIn(waiting, "Wes Waiting", "wes@example.com");
    await seedQueued({ op: "contact", role: "parent", qboId: "301", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: kay.id }, { state: "refused", code: "validation", familyQboId: null, familyId: kept });
    await seedQueued({ op: "create", role: "parent", name: "Stu Stuck", typeQboId: "2", familyQboId: null, email: "stu@example.com", guardianId: stu.id }, { state: "stuck", familyQboId: null, familyId: stuck });
    await seedQueued({ op: "rename", role: "parent", qboId: "321", syncToken: "0", name: "Wes W. Waiting", was: "Wes Waiting" }, { state: "waiting", familyQboId: null, familyId: waiting });
    const queue = await db.select().from(writeQueue).orderBy(asc(writeQueue.id));
    const view = await loadAccountingLinks();
    stub.calls.length = 0;
    for (const [name, rowId, customerName] of [["Kept Family", kay.id, "Kay Kept"], ["Stuck Family", stu.id, "Stu Stuck"], ["Waiting Family", wes.id, "Wes Waiting"]] as const) {
      expect(rowOf(view, name).confirm!.proposals, name).toMatchObject({ guardians: [], guardiansHeld: [{ guardianId: rowId, customerName }] });
    }
    asStaff(linker);
    expect(await openingOf("Kept Family")).toContain("Not linked with it, though their Parent customer's email field holds their sign-in address:"
      + "Kay Kept with Kay Kept: a change for them or for their Parent customer is waiting, stuck or kept on the Reconciliation page, so they aren't linked with it."
      + " Once it has gone through or been given up there, they can be linked in the opening of the family's row on this page, with Link this guardian,"
      + " if the family is linked by then and that Parent customer is still free for them.");

    for (const [familyId, customerId, name] of [[kept, "300", "Kept Family"], [stuck, "310", "Stuck Family"], [waiting, "320", "Waiting Family"]] as const) {
      const r = await linkFamilyToCustomer({ familyId: String(familyId), customerId, chosen: "suggested", stamp: rowOf(view, name).confirm!.stamp }, tag, linkOp());
      expect(r, name).toMatchObject({ ok: true, message: expect.stringContaining("No guardian was linked with it. A guardian whose sign-in address a Parent customer under it holds wasn't linked,"
        + " as a change for that guardian or for that Parent customer is waiting, stuck or kept on the Reconciliation page.") });
      expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, familyId)))[0], name).toMatchObject({ customerId });
    }
    expect((await db.select().from(accountingLink).where(eq(accountingLink.studentId, await studentNamed(kept, "Kit Kept"))))[0]).toMatchObject({ customerId: "302" });
    expect(await guardianLinks()).toEqual([]);
    for (const [familyId, rowId] of [[kept, kay.id], [stuck, stu.id], [waiting, wes.id]] as const) {
      const [audit] = (await auditsOf("accounting.link.confirm")).filter((a) => a.targetId === String(familyId));
      expect(audit!.after).toMatchObject({ guardiansLinked: [], guardiansHeld: [rowId] });
    }
    // The queue as it was, nothing sent; and M3c's Link this guardian isn't drawn while the item holds it.
    expect(await db.select().from(writeQueue).orderBy(asc(writeQueue.id))).toEqual(queue);
    expect(stub.apiCalls()).toEqual([]);
    const now = await loadAccountingLinks();
    expect(rowOf(now, "Kept Family").guardians.find((g) => g.id === kay.id)).toMatchObject({ offer: null, linkHeld: { row: 1 } });
    expect(rowOf(now, "Stuck Family").guardians.find((g) => g.id === stu.id)).toMatchObject({ offer: null, linkHeld: { row: 1 } });
    expect(rowOf(now, "Waiting Family").guardians.find((g) => g.id === wes.id)).toMatchObject({ offer: null, linkHeld: { row: 0, customers: 1 } });
  });
});

describe("what the write queue holds back, through the bulk press", () => {
  connected();
  it("links one family's paired guardian and holds the other family's back, the families and students linked, and says so", async () => {
    await readAgain(...PATELS, qc("300", "Kept Family", "1"), qc("301", "Kay Kept", "2", { ...under("300"), ...mail("kay@example.com") }), qc("302", "Kit Kept", "3", under("300")));
    const patels = await unlinkedFamily("The Patels", ["Asha Jr"]);
    const asha = await rowIn(patels, "Asha Patel", "asha@example.com");
    const kept = await unlinkedFamily("Kept Family", ["Kit Kept"]);
    const kay = await rowIn(kept, "Kay Kept", "kay@example.com");
    await seedQueued({ op: "contact", role: "parent", qboId: "301", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: kay.id }, { state: "refused", code: "validation", familyQboId: null, familyId: kept });
    const queue = await db.select().from(writeQueue).orderBy(asc(writeQueue.id));
    const bulk = (await loadAccountingLinks()).bulk({ status: null, q: "" })!;
    expect(bulk.count).toBe(2);
    stub.calls.length = 0;
    const r = await confirmAllSuggested({ status: "", q: "", count: bulk.count, stamp: bulk.stamp! }, tag, linkOp());
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("1 guardian linked with them in all, each to the Parent customer under their family's customer whose email field holds their sign-in address."
      + " A guardian whose sign-in address a Parent customer under them holds wasn't linked, as a change for that guardian or for that Parent customer is waiting, stuck or kept on the Reconciliation page.") });
    expect(await linkOfRow(asha.id)).toMatchObject({ customerId: "74", origin: "confirmed" });
    expect(await linkOfRow(kay.id)).toBeUndefined();
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, kept)))[0]).toMatchObject({ customerId: "300", origin: "confirmed" });
    expect((await db.select().from(accountingLink).where(eq(accountingLink.studentId, await studentNamed(kept, "Kit Kept"))))[0]).toMatchObject({ customerId: "302" });
    const [press] = await auditsOf("accounting.link.bulk");
    const pressId = (press!.after as { pressId: string }).pressId;
    const confirms = await auditsOf("accounting.link.confirm");
    expect(confirms.find((a) => a.targetId === String(patels))!.after).toMatchObject({ bulk: pressId, guardiansLinked: [{ guardianId: asha.id, customerQboId: "74" }], guardiansHeld: [] });
    expect(confirms.find((a) => a.targetId === String(kept))!.after).toMatchObject({ bulk: pressId, guardiansLinked: [], guardiansHeld: [kay.id] });
    expect(await db.select().from(writeQueue).orderBy(asc(writeQueue.id))).toEqual(queue);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("says more than one held guardian in the plural, each by their own row or Parent customer", () => {
    const words = confirmedWords({ family: "The Patels", customer: "Patel Family", linked: [], recordsLeft: [], customersLeft: [], keptMoves: 0, guardians: { linked: [], held: 2 } });
    expect(words).toContain("No guardian was linked with it. 2 guardians whose sign-in addresses Parent customers under it hold weren't linked,"
      + " as a change for each of them or for their Parent customer is waiting, stuck or kept on the Reconciliation page.");
    expect(words).not.toContain("that Parent customer");
  });
});

describe("the stamp and the lock", () => {
  connected();
  let patels: AppFamilyId, asha: { id: string; parentId: string };
  beforeEach(async () => {
    await readAgain(...PATELS);
    patels = await unlinkedFamily("The Patels");
    asha = await rowIn(patels, "Asha Patel", "asha@example.com");
    stub.calls.length = 0;
  });

  it("refuses a press whose pairs an item made since the page holds back, single and bulk, keeping nothing", async () => {
    const view = await loadAccountingLinks();
    const row = rowOf(view, "The Patels");
    const bulk = view.bulk({ status: null, q: "" })!;
    expect(row.confirm!.proposals.guardians).toHaveLength(1);
    await seedQueued({ op: "contact", role: "parent", qboId: "74", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: asha.id }, { state: "waiting", familyQboId: null, familyId: patels });
    const before = await everything();
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp()))
      .toEqual({ ok: false, errors: [LINK_COPY.rowChanged] });
    expect(await confirmAllSuggested({ status: "", q: "", count: bulk.count, stamp: bulk.stamp! }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.listChanged] });
    expect(await everything()).toEqual(before);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("refuses while the row's \"being sent\" lock is held in another connection, in words of its own, single and bulk, keeping nothing", async () => {
    const view = await loadAccountingLinks();
    const row = rowOf(view, "The Patels");
    const bulk = view.bulk({ status: null, q: "" })!;
    const before = await everything();
    const release = await holdLock(SENDING_LOCK, asha.id);
    try {
      expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp()))
        .toEqual({ ok: false, errors: [LINK_COPY.guardianSending] });
      expect(await confirmAllSuggested({ status: "", q: "", count: bulk.count, stamp: bulk.stamp! }, tag, linkOp()))
        .toEqual({ ok: false, errors: [LINK_COPY.bulkGuardianSending("The Patels")] });
    } finally {
      await release();
    }
    expect(await everything()).toEqual(before);
    // Once it is let go, the same press goes through.
    expect(await linkFamilyToCustomer({ familyId: String(patels), customerId: "70", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await linkOfRow(asha.id)).toMatchObject({ customerId: "74" });
  });
});
