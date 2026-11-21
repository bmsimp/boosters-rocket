import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, auditLog, family, guardian, student, writeQueue, type RosterWrite } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, type GuardianShown, type LinksView } from "@/lib/accounting/mapping";
import { GUARDIAN_LINK_COPY, guardianLinkedWords, guardianUnlinkedWords, linkGuardian, unlinkGuardian } from "@/lib/accounting/guardian-links";
import { LINK_COPY } from "@/lib/accounting/link-writes";
import { guardianLinkStamp } from "@/lib/accounting/stamp";
import { addGuardian, reinstateGuardian, removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { guardianStandings, SENDING_LOCK } from "@/lib/roster/writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { linkGuardianAction, unlinkGuardianAction } from "@/app/staff/(app)/links/actions";
import { familyPage } from "@/app/staff/(app)/family-pages";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { resetDb, seedParent } from "../helpers/db";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Link this guardian and Unlink this guardian (stage 4's slice M3c of the app-owned families spec; section 3, "each
 * student and parent to their own record under it. Each link records ... who confirmed it and when"; section 4, "It
 * opens to show the students and guardians and their own links", "Every link, unlink, import and alignment is audited";
 * src/lib/accounting/guardian-links.ts): an open guardian row of a linked family is tied to an existing Parent customer
 * directly under the family's customer, one no guardian row is linked to, and one row's link is ended alone, each
 * sending nothing and queueing nothing. The company is fznCompany()'s (tests/helpers/qbo-stub.ts) with four more
 * customers: May Chen 22 (Parent, under the Chen Family 20, with an address), Old Chen 23 (Parent, under 20, inactive),
 * Kim Chen 24 (Student, under 20) and Luz Rivera 13 (Parent, under the Rivera Family 10); Mei Chen 21 is the Chen
 * family's Parent customer of fznCompany(), and Ana Rivera 11 the Riveras'. Everything is seeded before a press: no
 * helper that runs the whole import (syncAppRecords()) is called after one, as the import can make or move links.
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
const company = () => {
  const c = fznCompany();
  c.customers.push(qc("22", "May Chen", "2", { ...under("20"), PrimaryEmailAddr: { Address: "may@example.com" } }), qc("23", "Old Chen", "2", { ...under("20"), Active: false }),
    qc("24", "Kim Chen", "3", under("20")), qc("13", "Luz Rivera", "2", under("10")));
  return c;
};
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
let reg: ReturnType<typeof asOp>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
let rivera: AppFamilyId, chen: AppFamilyId;
let meiRow: string, meiParent: string, anaRow: string;

/** An open guardian in a family's row of Accounting links, by the family's and the person's names. */
const guardianIn = (view: LinksView, familyName: string, person: string): GuardianShown => {
  const row = view.rows.find((r) => r.name === familyName);
  const g = row?.guardians.find((x) => x.name === person);
  if (!g) throw new Error(`no guardian ${person} in ${familyName}: ${row ? row.guardians.map((x) => x.name).join(", ") : "no row"}`);
  return g;
};
const shown = async (familyName: string, person: string) => guardianIn(await loadAccountingLinks(), familyName, person);
const chenLinkId = async () => (await db.select().from(accountingLink).where(eq(accountingLink.familyId, chen)))[0]!.id;
const linkOfRow = async (id: string) => (await db.select().from(accountingLink).where(eq(accountingLink.guardianId, id)))[0];
/** The press for Mei Chen, with a stamp sealed as her row would seal it for this customer and way of choosing. */
const pressMei = async (customerId: string, chosen: "suggested" | "picked", o: { stamp?: string; tag?: string } = {}) =>
  linkGuardian({ guardianId: meiRow, customerId, chosen, stamp: o.stamp ?? guardianLinkStamp(meiRow, await chenLinkId(), customerId, chosen) }, o.tag ?? tag, linkOp());
/** An open guardian row, written directly with no link of its own and nothing queued. */
async function rowIn(familyId: AppFamilyId, name: string, email: string, status: "invited" | "disabled" = "invited") {
  const p = await seedParent({ name, email });
  const [row] = await db.insert(guardian).values({ parentId: p.id, familyId, status, disabledReason: status === "disabled" ? "removed" : null,
    statusBeforeDisable: status === "disabled" ? "invited" : null }).returning({ id: guardian.id });
  return row!.id;
}
const linkRowTo = (guardianId: string, customerId: string) =>
  db.insert(accountingLink).values({ system: QUICKBOOKS, realmId: REALM, customerId, guardianId, origin: "confirmed", linkedBy: linker.id, syncedToken: "0", syncedAt: new Date() });

/** Every link, ended link, guardian row, queue item and guardian press's audit row: what a refusal must leave as it was. */
const everything = async () => ({
  links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
  ended: await db.select().from(accountingLinkEnded).orderBy(asc(accountingLinkEnded.id)),
  guardians: await db.select().from(guardian).orderBy(asc(guardian.id)),
  queue: await db.select().from(writeQueue).orderBy(asc(writeQueue.id)),
  audits: (await db.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.action} in ('accounting.link.guardian', 'accounting.link.guardian.remove')`)).length,
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

beforeEach(async () => {
  await resetDb(); stub.reset();
  tag = await connectRoster(stub, { company: company() });
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
  reg = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  ({ row: { id: anaRow } } = await seedAnaRivera());
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
  // Mei Chen added by staff: the Chen family has a customer of her name under it, so nothing is sent, kept or linked.
  const mei = await addGuardian(chen, { name: "Mei Chen", email: "mei@example.com" }, reg);
  if (!mei.ok) throw new Error("Mei Chen wasn't added");
  meiRow = mei.guardianId; meiParent = mei.parentId;
  expect(await db.select().from(writeQueue)).toEqual([]);
  stub.calls.length = 0;
});

describe("Link this guardian", () => {
  it("offers a row's Parent customers, fills in the one named like them, links it through the action, sends nothing, and what follows goes to it", async () => {
    const rowBefore = (await db.select().from(guardian).where(eq(guardian.id, meiRow)))[0];
    const g = await shown("Chen Family", "Mei Chen");
    // In the roster's order: May before Mei. Old Chen is inactive, Kim Chen a student: neither is offered.
    expect(g.offer).toEqual({ familyLinkId: await chenLinkId(), candidates: [{ qboId: "22", name: "May Chen", email: "may@example.com" }, expect.objectContaining({ qboId: "21", name: "Mei Chen" })],
      suggested: "21", stamps: { "22": expect.any(String), "21": expect.any(String) } });
    expect(g).toMatchObject({ standing: null, unlink: null, noOffer: null, link: { state: "none" } });
    asStaff(linker);
    const r = await linkGuardianAction(meiRow, "21", "suggested", tag, g.offer!.stamps["21"]!);
    expect(r).toEqual({ ok: true, message: guardianLinkedWords({ who: "Mei Chen", customer: "Mei Chen" }) });
    expect(r.ok && r.message).toBe("Mei Chen is linked to “Mei Chen” in the books, as their own Parent customer. Nothing was sent to the books, and their access in the portal is as it was."
      + " From now on, a rename of Mei Chen, their removal from this family, and a change of their phone, mailing address or sign-in email go to that Parent customer, by the portal's own rules, while it is theirs alone under this family."
      + " The details the portal holds for them now aren't sent by this.");
    expect(revalidatedPaths()).toEqual(expect.arrayContaining(["/staff/links", familyPage(chen)]));
    const link = await linkOfRow(meiRow);
    expect(link).toMatchObject({ system: QUICKBOOKS, realmId: REALM, customerId: "21", guardianId: meiRow, familyId: null, studentId: null, origin: "confirmed", linkedBy: linker.id, syncedToken: "0" });
    const [audit] = (await auditsOf("accounting.link.guardian")).filter((a) => a.targetId === meiRow);
    expect(audit).toMatchObject({ targetType: "guardian", actorId: linker.id, permission: "Accounting.Link.ReadWrite",
      after: { guardianId: meiRow, familyId: String(chen), customerQboId: "21", realmId: REALM, chosen: "suggested", linkId: link!.id } });
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    // The guardian row is as it was: no column of it is the link's.
    expect((await db.select().from(guardian).where(eq(guardian.id, meiRow)))[0]).toEqual(rowBefore);
    expect(rowBefore).toMatchObject({ status: "invited", familyId: chen, sourceQboId: null });
    // The family's page says it, and the row's opening now offers its Unlink.
    expect((await guardianStandings([{ guardianId: meiRow, familyId: chen, name: "Mei Chen", open: true }])).get(meiRow)).toBe("Linked to their own Parent customer “Mei Chen”.");
    expect(await shown("Chen Family", "Mei Chen")).toMatchObject({ standing: "own", offer: null, unlink: { linkId: link!.id } });

    // A rename of the person goes to that Parent customer, and then their removal makes it inactive.
    expect(await renamePerson(meiParent, "Mei L. Chen", reg)).toMatchObject({ ok: true, changed: true });
    expect((await db.select().from(writeQueue)).map((i) => i.request)).toEqual([expect.objectContaining({ op: "rename", role: "parent", qboId: "21", name: "Mei L. Chen", guardianId: meiRow })]);
    expect(bodies()).toEqual([expect.objectContaining({ Id: "21", DisplayName: "Mei L. Chen" })]);
    stub.calls.length = 0;
    expect(await removeGuardian(meiRow, "Moved away.", reg)).toMatchObject({ ok: true });
    expect((await db.select().from(writeQueue)).map((i) => i.request)).toContainEqual(expect.objectContaining({ op: "deactivate", role: "parent", qboId: "21", guardianId: meiRow }));
  });

  it("links one picked from the others, and refuses a stamp sealed for another way of choosing", async () => {
    const before = await everything();
    expect(await pressMei("22", "suggested")).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.rowChanged] });
    const g = await shown("Chen Family", "Mei Chen");
    expect(await linkGuardian({ guardianId: meiRow, customerId: "22", chosen: "picked", stamp: g.offer!.stamps["21"]! }, tag, linkOp())).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.rowChanged] });
    expect(await everything()).toEqual(before);
    expect(await linkGuardian({ guardianId: meiRow, customerId: "22", chosen: "picked", stamp: g.offer!.stamps["22"]! }, tag, linkOp()))
      .toEqual({ ok: true, message: guardianLinkedWords({ who: "Mei Chen", customer: "May Chen" }), familyId: chen });
    expect(await linkOfRow(meiRow)).toMatchObject({ customerId: "22", origin: "confirmed" });
    expect((await auditsOf("accounting.link.guardian"))[0]!.after).toMatchObject({ chosen: "picked", customerQboId: "22" });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("offers none where no Parent customer is free, saying why, and where their own record is under another family of theirs", async () => {
    await linkRowTo(await rowIn(chen, "Kai Chen", "kai@example.com"), "21");
    await linkRowTo(await rowIn(chen, "Pat Chen", "pat@example.com", "disabled"), "22");
    expect((await shown("Chen Family", "Mei Chen"))).toMatchObject({ offer: null, noOffer: { why: "none" } });
    // Mei is in the Riveras too, linked there to a Parent customer of her name: that is her own record, and none is offered here.
    const there = (await db.insert(guardian).values({ parentId: meiParent, familyId: rivera, status: "invited" }).returning({ id: guardian.id }))[0]!.id;
    await db.delete(accountingLink).where(eq(accountingLink.guardianId, anaRow));
    await linkRowTo(there, "11");
    // Her record there is named as she is: 11 renamed in the books, then read.
    stub.customers = stub.customers.map((c) => (c.Id === "11" ? { ...c, DisplayName: "Mei Chen" } : c));
    const read = await refreshRoster(WORKER);
    if (!read.ok) throw new Error("the roster couldn't be read");
    expect(await shown("Chen Family", "Mei Chen")).toMatchObject({ offer: null, noOffer: { why: "elsewhere", family: "Rivera Family" } });
  });
});

describe("what Link this guardian refuses, keeping nothing", () => {
  const refused = async (run: () => Promise<unknown>, words: string) => {
    const before = await everything();
    expect(await run()).toEqual({ ok: false, errors: [words] });
    expect(await everything()).toEqual(before);
    expect(stub.apiCalls()).toEqual([]);
  };

  it("a customer another guardian row is linked to, open or closed, of this family; one under another family; a student's; an inactive one", async () => {
    await linkRowTo(await rowIn(chen, "Kai Chen", "kai@example.com"), "22");
    await refused(() => pressMei("22", "picked"), GUARDIAN_LINK_COPY.notOffered);
    await db.delete(accountingLink).where(and(eq(accountingLink.customerId, "22"), sql`${accountingLink.guardianId} is not null`));
    await linkRowTo(await rowIn(chen, "Pat Chen", "pat@example.com", "disabled"), "22");
    await refused(() => pressMei("22", "picked"), GUARDIAN_LINK_COPY.notOffered);
    await refused(() => pressMei("13", "picked"), GUARDIAN_LINK_COPY.notOffered);
    await refused(() => pressMei("24", "picked"), GUARDIAN_LINK_COPY.notOffered);
    await refused(() => pressMei("23", "picked"), GUARDIAN_LINK_COPY.notOffered);
    // A Parent customer a student link names is no guardian's either.
    const [s] = await db.insert(student).values({ name: "Odd Link", familyId: chen, active: true }).returning({ id: student.id });
    await db.insert(accountingLink).values({ system: QUICKBOOKS, realmId: REALM, customerId: "21", studentId: s!.id, origin: "confirmed", linkedBy: linker.id });
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.notOffered);
  });

  it("a Parent customer a family record's link names (slice M3c's review)", async () => {
    // May Chen 22, free of every guardian and student link, linked to another family record (one retyped and moved
    // under the Chens' in the books keeps its family link until someone unlinks it): no longer offered to Mei Chen.
    const [odd] = await db.insert(family).values({ name: "Odd Family", active: true }).returning({ id: family.id });
    await db.insert(accountingLink).values({ system: QUICKBOOKS, realmId: REALM, customerId: "22", familyId: odd!.id, origin: "confirmed", linkedBy: linker.id });
    expect((await shown("Chen Family", "Mei Chen")).offer?.candidates.map((c) => c.qboId)).toEqual(["21"]);
    await refused(() => pressMei("22", "picked"), GUARDIAN_LINK_COPY.notOffered);
  });

  it("a row linked already, a closed row, and a family with no link, its customer gone or not a family now", async () => {
    await linkRowTo(meiRow, "22");
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.linkedAlready);
    await db.delete(accountingLink).where(eq(accountingLink.guardianId, meiRow));
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" }).where(eq(guardian.id, meiRow));
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.rowGone);
    await db.update(guardian).set({ status: "invited", disabledReason: null, statusBeforeDisable: null }).where(eq(guardian.id, meiRow));
    const stamp = guardianLinkStamp(meiRow, await chenLinkId(), "21", "suggested");
    stub.customers = stub.customers.map((c) => (c.Id === "20" ? { ...c, CustomerTypeRef: { value: "4" } } : c));
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    // The read's own requests are the roster's, not the press's.
    stub.calls.length = 0;
    await refused(() => pressMei("21", "suggested", { stamp }), GUARDIAN_LINK_COPY.familyNotStanding);
    stub.customers = stub.customers.filter((c) => c.Id !== "20");
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    stub.calls.length = 0;
    await refused(() => pressMei("21", "suggested", { stamp }), GUARDIAN_LINK_COPY.familyNotStanding);
    await db.delete(accountingLink).where(eq(accountingLink.familyId, chen));
    await refused(() => linkGuardian({ guardianId: meiRow, customerId: "21", chosen: "suggested", stamp }, tag, linkOp()), GUARDIAN_LINK_COPY.familyNotLinked);
  });

  it("books with no parent type", async () => {
    const stamp = guardianLinkStamp(meiRow, await chenLinkId(), "21", "suggested");
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, { actor: WORKER.actor, ip: null });
    expect((await shown("Chen Family", "Mei Chen"))).toMatchObject({ offer: null, noOffer: null });
    await refused(() => pressMei("21", "suggested", { stamp }), GUARDIAN_LINK_COPY.noParentType);
  });

  it("a create of the row waiting, stuck or kept, a change of their details waiting, and a rename of the customer waiting", async () => {
    const create: RosterWrite = { op: "create", role: "parent", name: "Mei Chen", typeQboId: "2", familyQboId: "20", email: "mei@example.com", guardianId: meiRow };
    for (const state of ["waiting", "stuck", "refused"] as const) {
      const item = await seedQueued(create, { state });
      // The row's opening draws no Link this guardian, and says why (slice M3c's review).
      expect(await shown("Chen Family", "Mei Chen")).toMatchObject({ offer: null, linkHeld: { row: 1, customers: 0 } });
      await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.rowWaiting(1));
      await db.delete(writeQueue).where(eq(writeQueue.id, item.id));
    }
    const contact = await seedQueued({ op: "contact", role: "parent", qboId: "21", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: meiRow }, { familyQboId: "20" });
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.rowWaiting(1));
    await db.delete(writeQueue).where(eq(writeQueue.id, contact.id));
    // A rename of the Parent customer asked from the family's page (QuickBooks first, naming no guardian).
    await seedQueued({ op: "rename", role: "parent", qboId: "21", syncToken: "0", name: "M. Chen", was: "Mei Chen" });
    // 21 isn't drawn, so none is filled in; May Chen 22 still is, picked, and its stamp is the one the press takes.
    const g = await shown("Chen Family", "Mei Chen");
    expect(g).toMatchObject({ offer: { candidates: [{ qboId: "22" }], suggested: null }, linkHeld: { row: 0, customers: 1 } });
    expect(g.offer!.stamps["22"]).toBe(guardianLinkStamp(meiRow, await chenLinkId(), "22", "picked"));
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.customerWaiting(1));
  });

  it("the row's or the family's \"being sent\" lock held", async () => {
    let release = await holdLock(SENDING_LOCK, meiRow);
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.busy);
    await release();
    release = await holdLock(SENDING_LOCK, String(chen));
    await refused(() => pressMei("21", "suggested"), GUARDIAN_LINK_COPY.busy);
    await release();
    expect(await pressMei("21", "suggested")).toMatchObject({ ok: true });
  });

  it("a stale stamp, another roster tag, and anything the page doesn't send", async () => {
    await refused(() => pressMei("21", "suggested", { stamp: "x".repeat(22) }), GUARDIAN_LINK_COPY.rowChanged);
    await refused(() => pressMei("21", "suggested", { tag: "another company" }), ROSTER_MOVED);
    await refused(() => linkGuardian({ guardianId: meiRow, customerId: "21", chosen: "several", stamp: "x" }, tag, linkOp()), LINK_COPY.notFromPage);
    await refused(() => linkGuardian({ guardianId: "not a uuid", customerId: "21", chosen: "suggested", stamp: "x" }, tag, linkOp()), LINK_COPY.notFromPage);
    asStaff(linker);
    await refused(() => linkGuardianAction(meiRow, "21", "suggested", tag, null as never), LINK_COPY.notFromPage);
    for (const customerId of ["not an id", "", "1".repeat(20), 21 as never]) await refused(() => linkGuardianAction(meiRow, customerId, "suggested", tag, "x"), LINK_COPY.notFromPage);
  });

  it("a holder of the linking permission without Roster.Read, and one without the linking permission, as the guard refuses", async () => {
    const g = await shown("Chen Family", "Mei Chen");
    const before = await everything();
    for (const who of [await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]), await staffWith("onlyread@club.org", ["Roster.Read", "Roster.Family.ReadWrite"])]) {
      asStaff(who);
      await expect(linkGuardianAction(meiRow, "21", "suggested", tag, g.offer!.stamps["21"]!)).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(await everything()).toEqual(before);
  });
});

describe("Unlink this guardian", () => {
  it("ends an own link alone into the ended links, leaves the row open with its sign-in, and sends nothing", async () => {
    const g = await shown("Rivera Family", "Ana Rivera");
    expect(g).toMatchObject({ standing: "own", offer: null });
    const link = (await linkOfRow(anaRow))!;
    const rowBefore = (await db.select().from(guardian).where(eq(guardian.id, anaRow)))[0];
    asStaff(linker);
    const r = await unlinkGuardianAction(anaRow, g.unlink!.linkId, tag, g.unlink!.stamp);
    expect(r).toEqual({ ok: true, message: guardianUnlinkedWords({ who: "Ana Rivera", customer: "Ana Rivera", details: { waiting: 0, held: 0 }, relink: true }) });
    expect(r.ok && r.message).toBe("Ana Rivera is no longer linked to “Ana Rivera” in the books. Nothing was sent to the books, the customer stays there as it is, and their access in the portal is as it was."
      + " Nothing is sent for them to a Parent customer now, and no Parent customer is made for them by this, or later by itself. They can be linked to a Parent customer again in the family's row on this page.");
    expect(revalidatedPaths()).toEqual(expect.arrayContaining(["/staff/links", familyPage(rivera)]));
    expect(await linkOfRow(anaRow)).toBeUndefined();
    const [ended] = await db.select().from(accountingLinkEnded);
    expect(ended).toMatchObject({ id: link.id, system: QUICKBOOKS, realmId: REALM, customerId: "11", guardianId: anaRow, familyId: null, studentId: null, origin: link.origin,
      linkedAt: link.linkedAt, linkedBy: link.linkedBy, endedBy: linker.id, endedHow: "unlinked" });
    expect(ended!.endedAt).toBeInstanceOf(Date);
    const [audit] = (await auditsOf("accounting.link.guardian.remove")).filter((a) => a.targetId === anaRow);
    expect(audit).toMatchObject({ targetType: "guardian", actorId: linker.id, before: { link: { id: link.id, customerQboId: "11" } },
      after: { guardianId: anaRow, customerQboId: "11", endedAt: ended!.endedAt.toISOString() } });
    expect((await db.select().from(guardian).where(eq(guardian.id, anaRow)))[0]).toEqual(rowBefore);
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    // The family's own link stands; the row is offered its old customer again.
    expect(await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera))).toHaveLength(1);
    expect((await shown("Rivera Family", "Ana Rivera")).offer?.candidates.map((c) => c.qboId)).toEqual(["11", "13"]);
  });

  it("splits a shared customer: one of two open rows unlinked, the other then their own", async () => {
    const rafa = await rowIn(rivera, "Rafa Rivera", "rafa@example.com");
    await linkRowTo(rafa, "11");
    const view = await loadAccountingLinks();
    expect(guardianIn(view, "Rivera Family", "Ana Rivera")).toMatchObject({ standing: "shared", sharedWith: [] });
    const shared = guardianIn(view, "Rivera Family", "Rafa Rivera");
    expect(shared).toMatchObject({ standing: "shared", sharedWith: [] });
    expect((await guardianStandings([{ guardianId: anaRow, familyId: rivera, name: "Ana Rivera", open: true }])).get(anaRow))
      .toBe("Linked to a customer that isn't their own Parent customer under this family, so nothing is sent for them.");
    expect(await unlinkGuardian({ guardianId: rafa, linkId: shared.unlink!.linkId, stamp: shared.unlink!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await shown("Rivera Family", "Ana Rivera")).toMatchObject({ standing: "own" });
    expect((await guardianStandings([{ guardianId: anaRow, familyId: rivera, name: "Ana Rivera", open: true }])).get(anaRow)).toBe("Linked to their own Parent customer “Ana Rivera”.");
    expect(stub.apiCalls()).toEqual([]);
  });

  it("is refused while a rename of the customer waits, or the row's lock is held; a change of their details refuses nothing and is said", async () => {
    const g = await shown("Rivera Family", "Ana Rivera");
    const press = () => unlinkGuardian({ guardianId: anaRow, linkId: g.unlink!.linkId, stamp: g.unlink!.stamp }, tag, linkOp());
    const before = await everything();
    const rename = await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "A. Rivera", was: "Ana Rivera" });
    const withRename = await everything();
    expect(await press()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.unlinkWaiting(1)] });
    expect(await everything()).toEqual(withRename);
    await db.delete(writeQueue).where(eq(writeQueue.id, rename.id));
    const release = await holdLock(SENDING_LOCK, anaRow);
    expect(await press()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.unlinkBusy] });
    await release();
    expect(await everything()).toEqual(before);
    await seedQueued({ op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: anaRow });
    const r = await press();
    expect(r).toEqual({ ok: true, message: guardianUnlinkedWords({ who: "Ana Rivera", customer: "Ana Rivera", details: { waiting: 1, held: 0 }, relink: true }), familyId: rivera });
    expect(r.ok && r.message).toContain("A change of their details on its way to the books is given up unsent at its next try, as that customer is no longer theirs.");
    expect((await db.select().from(writeQueue))).toEqual([expect.objectContaining({ state: "waiting" })]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("is refused while a change naming the row waits, the family's lock is held, with a stale stamp or another roster tag, keeping nothing", async () => {
    const g = await shown("Rivera Family", "Ana Rivera");
    const press = (o: { stamp?: string; tag?: string } = {}) => unlinkGuardian({ guardianId: anaRow, linkId: g.unlink!.linkId, stamp: o.stamp ?? g.unlink!.stamp }, o.tag ?? tag, linkOp());
    // A rename of her Parent customer through her row: one item naming the row and targeting 11, counted once.
    const rename = await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "A. Rivera", was: "Ana Rivera", guardianId: anaRow });
    expect(await shown("Rivera Family", "Ana Rivera")).toMatchObject({ unlink: null, unlinkHeld: 1 });
    let before = await everything();
    expect(await press()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.unlinkWaiting(1)] });
    expect(await everything()).toEqual(before);
    await db.delete(writeQueue).where(eq(writeQueue.id, rename.id));
    before = await everything();
    const release = await holdLock(SENDING_LOCK, String(rivera));
    expect(await press()).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.unlinkBusy] });
    await release();
    expect(await press({ stamp: "x".repeat(22) })).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.unlinkChanged] });
    expect(await press({ tag: "another company" })).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    expect(await unlinkGuardian({ guardianId: anaRow, linkId: "not a uuid", stamp: g.unlink!.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    expect(await everything()).toEqual(before);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("through the action, refuses anything the page doesn't send, and a reader the guard refuses", async () => {
    const g = await shown("Rivera Family", "Ana Rivera");
    const before = await everything();
    asStaff(linker);
    const call = unlinkGuardianAction as unknown as (...a: unknown[]) => Promise<unknown>;
    for (const args of [["not a uuid", g.unlink!.linkId, tag, g.unlink!.stamp], [anaRow, "not a uuid", tag, g.unlink!.stamp], [anaRow, g.unlink!.linkId, tag, 7], [anaRow, g.unlink!.linkId, null, g.unlink!.stamp]]) {
      expect(await call(...args)).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    }
    for (const who of [await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]), await staffWith("onlyread@club.org", ["Roster.Read", "Roster.Family.ReadWrite"])]) {
      asStaff(who);
      await expect(unlinkGuardianAction(anaRow, g.unlink!.linkId, tag, g.unlink!.stamp)).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(await everything()).toEqual(before);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("ends a link to a customer the books' copy doesn't hold, and one to a customer elsewhere in the books", async () => {
    const gone = await rowIn(chen, "Gus Chen", "gus@example.com");
    await linkRowTo(gone, "999");
    const elsewhere = await rowIn(chen, "Eli Chen", "eli@example.com");
    await linkRowTo(elsewhere, "24");
    const view = await loadAccountingLinks();
    const gus = guardianIn(view, "Chen Family", "Gus Chen"), eli = guardianIn(view, "Chen Family", "Eli Chen");
    expect(gus).toMatchObject({ standing: "gone", relink: true });
    expect(eli).toMatchObject({ standing: "elsewhere", link: { state: "linked", customer: "Kim Chen" } });
    asStaff(linker);
    expect(await unlinkGuardianAction(gone, gus.unlink!.linkId, tag, gus.unlink!.stamp))
      .toEqual({ ok: true, message: guardianUnlinkedWords({ who: "Gus Chen", customer: null, details: { waiting: 0, held: 0 }, relink: true }) });
    expect(await unlinkGuardianAction(elsewhere, eli.unlink!.linkId, tag, eli.unlink!.stamp))
      .toEqual({ ok: true, message: guardianUnlinkedWords({ who: "Eli Chen", customer: "Kim Chen", details: { waiting: 0, held: 0 }, relink: true }) });
    expect(await linkOfRow(gone)).toBeUndefined();
    expect(await linkOfRow(elsewhere)).toBeUndefined();
    expect((await db.select().from(accountingLinkEnded)).map((e) => e.customerId).sort()).toEqual(["24", "999"]);
    expect(stub.apiCalls()).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
  });

  it("where the family's link doesn't stand, doesn't say they can be linked again here", async () => {
    await linkRowTo(meiRow, "21");
    stub.customers = stub.customers.map((c) => (c.Id === "20" ? { ...c, CustomerTypeRef: { value: "4" } } : c));
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    // The read's own requests are the roster's, not the press's.
    stub.calls.length = 0;
    const linked = await shown("Chen Family", "Mei Chen");
    expect(linked).toMatchObject({ relink: false, unlink: { linkId: expect.any(String) } });
    const r = await unlinkGuardian({ guardianId: meiRow, linkId: linked.unlink!.linkId, stamp: linked.unlink!.stamp }, tag, linkOp());
    expect(r).toEqual({ ok: true, message: guardianUnlinkedWords({ who: "Mei Chen", customer: "Mei Chen", details: { waiting: 0, held: 0 }, relink: false }), familyId: chen });
    expect(r.ok && r.message).toContain("Linking them to a Parent customer again isn't offered on this page until their family is linked to a family customer that stands in the books and the membership shape has a parent type.");
    expect(r.ok && r.message).not.toContain("again in the family's row");
    expect(stub.apiCalls()).toEqual([]);
  });

  it("after it, a removal sends nothing, and the row reinstated is held back from a second Parent customer, in words of its own", async () => {
    const g = await shown("Rivera Family", "Ana Rivera");
    expect(await unlinkGuardian({ guardianId: anaRow, linkId: g.unlink!.linkId, stamp: g.unlink!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect(await removeGuardian(anaRow, "Moved away.", reg)).toMatchObject({ ok: true, quickbooks: ["Nothing was sent to QuickBooks for them: they have no Parent customer of their own there."] });
    expect(await reinstateGuardian(anaRow, reg)).toEqual({ ok: true, quickbooks: ["QuickBooks has the Parent customer “Ana Rivera” under Rivera Family that Ana Rivera was linked to until that link ended, so no second one was made for them."
      + " While it is active in QuickBooks, it can be linked to them again on Accounting links, in the opening of the family's row."] });
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
    expect((await guardianStandings([{ guardianId: anaRow, familyId: rivera, name: "Ana Rivera", open: true }])).get(anaRow))
      .toBe("QuickBooks has the Parent customer “Ana Rivera” under this family that they were linked to until that link ended, so no second one is made. No Parent customer in QuickBooks is linked to them, and none is being made: while it is active, it can be linked to them again on Accounting links, in the opening of the family's row.");
  });
});

describe("the family's page points at Accounting links only for a reader who may link (slice M3c)", () => {
  const sectionOf = (html: string, id: string) => { const at = html.indexOf(`id="${id}"`); return html.slice(at, html.indexOf("</section>", at)); };
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  it("a Parent customer two of the family's guardians share: how it is sorted out, with a link or in words", async () => {
    await linkRowTo(await rowIn(rivera, "Rafa Rivera", "rafa@example.com"), "11");
    const sortedOut = "unlink from it each guardian whose it isn't; once one guardian of this family alone is linked to it, it is theirs, and if none of this family's is left on it, one who isn't linked to a customer can be linked to it there";
    asStaff(await staffWith("both@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    let html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    let parents = sectionOf(html, "entry-parents-h"), changes = sectionOf(html, "family-changes-h");
    expect(text(parents)).toContain(`so the portal sends nothing for it: change it in QuickBooks, or on Accounting links ${sortedOut}`);
    expect(parents).toContain('href="/staff/links"');
    expect(text(changes)).toContain("so the portal sends nothing for it: change it in QuickBooks, or on Accounting links unlink from it each guardian whose it isn't. Once one guardian of this family alone is linked to it, it is theirs;");
    expect(changes).toContain('href="/staff/links"');
    asStaff(await staffWith("reader@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    html = await renderPage(RosterEntryPage, { params: { id: String(rivera) } });
    parents = sectionOf(html, "entry-parents-h"); changes = sectionOf(html, "family-changes-h");
    expect(text(parents)).toContain(`change it in QuickBooks, or on Accounting links, by someone who may link families to accounting, ${sortedOut}`);
    expect(text(changes)).toContain("change it in QuickBooks, or on Accounting links, by someone who may link families to accounting, unlink from it each guardian whose it isn't.");
    expect(parents).not.toContain('href="/staff/links"');
    expect(changes).not.toContain('href="/staff/links"');
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("ids from the form are untrusted", () => {
  it("one family's guardian with another's stamp or customer, and one row's link id for another row, are refused", async () => {
    const luz = await rowIn(rivera, "Luz Rivera", "luz@example.com");
    const view = await loadAccountingLinks();
    const mei = guardianIn(view, "Chen Family", "Mei Chen"), luzShown = guardianIn(view, "Rivera Family", "Luz Rivera"), ana = guardianIn(view, "Rivera Family", "Ana Rivera");
    expect(luzShown.offer).toMatchObject({ suggested: "13" });
    const before = await everything();
    // The Riveras' row with the Chens' stamp and customer.
    expect(await linkGuardian({ guardianId: luz, customerId: "21", chosen: "suggested", stamp: mei.offer!.stamps["21"]! }, tag, linkOp())).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.notOffered] });
    // The Chens' row with the Riveras' customer and stamp.
    expect(await linkGuardian({ guardianId: meiRow, customerId: "13", chosen: "suggested", stamp: luzShown.offer!.stamps["13"]! }, tag, linkOp())).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.notOffered] });
    // Mei's row, with Ana's link and stamp.
    expect(await unlinkGuardian({ guardianId: meiRow, linkId: ana.unlink!.linkId, stamp: ana.unlink!.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.notLinkedNow] });
    // Luz's row, with her own customer but the stamp Mei's row was given for hers.
    expect(await linkGuardian({ guardianId: luz, customerId: "13", chosen: "suggested", stamp: mei.offer!.stamps["21"]! }, tag, linkOp())).toEqual({ ok: false, errors: [GUARDIAN_LINK_COPY.rowChanged] });
    expect(await everything()).toEqual(before);
    expect(stub.apiCalls()).toEqual([]);
  });
});
