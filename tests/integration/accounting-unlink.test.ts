import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, auditLog, family, familyMoney, guardian, qboConnection, setting, student, writeQueue, type RosterWrite } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { customerAimedAt, linkSuggestedEach, leaveUnlinked, LINK_COPY, linkFamilyToCustomer, unlinkedWords, unlinkFamily } from "@/lib/accounting/link-writes";
import { writeAudit } from "@/lib/audit/log";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { runWriteQueue } from "@/lib/roster/queue";
import { SOURCE_KEY } from "@/lib/roster/source";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily, MAKING_LOCK, SENDING_LOCK } from "@/lib/roster/writes";
import { familyFromCustomer } from "@/lib/roster/no-family";
import { addGuardian, reinstateGuardian } from "@/lib/parents/guardians";
import { ROSTER_LOCK, SHAPE_KEY } from "@/lib/roster/shape";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { unlinkAction } from "@/app/staff/(app)/links/actions";
import { resetDb, seedParent, untilALockIsAwaited } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, connectRoster, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { takeInDone } from "../helpers/contact";

/**
 * Unlink from the books (stage 4's slice M3b of the app-owned families spec; section 4, "Every link, unlink, import and
 * alignment is audited"; open question 13; src/lib/accounting/link-writes.ts, unlinkFamily()): a linked family's link,
 * its student records' links and its guardian rows' links move to accounting_link_ended as they were, and its stored
 * figures are forgotten, sending nothing and touching no guardian row; and a relink is an unlink, then a link as
 * Confirm or Pick a different customer makes it, restoring nothing. The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Rivera Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12 (Student), Chen Family
 * 20 with Mei Chen 21 (Parent). Every helper that runs the whole import (syncAppRecords()) is called before an unlink,
 * never after it: the import would make a second family, carried over, for the old customer.
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
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
/** The press as the page binds it, from the row's own offer. */
const press = (row: LinkRow, t = tag) => unlinkFamily({ familyId: String(row.familyId), linkId: row.unlink!.linkId, stamp: row.unlink!.stamp }, t, linkOp());
const unlinkRow = async (name: string) => press(rowOf(await loadAccountingLinks(), name));

/** Every link, ended link, guardian row, money row and audit row, each in one order: what a refusal must leave as it was. */
const everything = async () => ({
  links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
  ended: await db.select().from(accountingLinkEnded).orderBy(asc(accountingLinkEnded.id)),
  guardians: await db.select().from(guardian).orderBy(asc(guardian.id)),
  money: await db.select().from(familyMoney).orderBy(asc(familyMoney.familyId)),
  audits: (await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "accounting.link.remove"))).length,
});
/** The links that name a family's own record, its student records or its guardian rows. */
async function linksOfFamily(familyId: AppFamilyId) {
  const students = (await db.select({ id: student.id }).from(student).where(eq(student.familyId, familyId))).map((s) => s.id);
  const rows = (await db.select({ id: guardian.id }).from(guardian).where(eq(guardian.familyId, familyId))).map((g) => g.id);
  return db.select().from(accountingLink).where(or(eq(accountingLink.familyId, familyId), students.length ? inArray(accountingLink.studentId, students) : undefined,
    rows.length ? inArray(accountingLink.guardianId, rows) : undefined));
}

/** An advisory lock held by another session until released, as a send or a make in progress holds it. */
async function holdLock(first: number, id: string) {
  let release!: () => void, locked!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const taken = new Promise<void>((r) => { locked = r; });
  const holder = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(first))}, hashtext(${id}::text))`); locked(); await held; });
  await taken;
  return async () => { release(); await holder; };
}

let rivera: AppFamilyId, chen: AppFamilyId, anaRowId: string;
beforeEach(async () => {
  await resetDb(); stub.reset();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
  tag = await connectRoster(stub);
  anaRowId = (await seedAnaRivera()).row.id;
  rivera = await recordOfCustomer("10", "family");
  chen = await recordOfCustomer("20", "family");
});

describe("the press, in the rows of a linked family", () => {
  it("is offered in the openings of exactly the five statuses of a family with a link, in the listed state only", async () => {
    // Oak 80 (linked, confirmed), Elm 85 (a family now, then of another type), Ash 90 (then gone from the books), Pine 95
    // (carried over, as it was). Rivera is renamed in the books, so it has a difference.
    await readAgain(qc("80", "Oak Family", "1"), qc("85", "Elm Family", "1"), qc("90", "Ash Family", "1"), qc("95", "Pine Family", "1"));
    await syncAppRecords();
    await db.update(accountingLink).set({ origin: "confirmed", linkedBy: linker.id }).where(eq(accountingLink.familyId, await recordOfCustomer("80", "family")));
    changeInBooks("10", { DisplayName: "Riveras" });
    changeInBooks("85", { CustomerTypeRef: { value: "4" } });
    stub.customers = stub.customers.filter((c) => c.Id !== "90");
    await readAgain();
    const hand = asOp(await staffWith("adder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await addFamily({ role: "family", name: "Birch Family", typeQboId: null }, tag, { ...hand, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
    const view = await loadAccountingLinks();
    const statusOf = (name: string) => rowOf(view, name).status.key;
    expect(["Rivera Family", "Pine Family", "Oak Family", "Elm Family", "Ash Family", "Birch Family"].map(statusOf))
      .toEqual(["with_differences", "carried_over", "linked", "not_a_family", "customer_gone", "no_match"]);
    for (const name of ["Rivera Family", "Chen Family", "Pine Family", "Oak Family", "Elm Family", "Ash Family"]) expect(rowOf(view, name).unlink).not.toBeNull();
    expect(rowOf(view, "Birch Family").unlink).toBeNull();
    const riveraLink = (await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera)))[0]!;
    const leo = await recordOfCustomer("12", "student");
    expect(rowOf(view, "Rivera Family").unlink).toEqual({ linkId: riveraLink.id, customerId: "10", customer: "Riveras",
      students: [{ linkId: expect.any(String), studentId: leo, name: "Leo Rivera" }], guardianLinks: 1, stamp: expect.any(String) });
    expect(rowOf(view, "Ash Family").unlink).toMatchObject({ customerId: "90", customer: null });
    // Not listed (no shape): no row offers it.
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect((await loadAccountingLinks()).rows.every((r) => r.unlink === null)).toBe(true);
  });
});

describe("an unlink", () => {
  it("moves the family's, its students' (active and inactive) and its guardian rows' (open and closed) links to the history, as they were, and nothing else", async () => {
    const leo = await recordOfCustomer("12", "student");
    // An inactive student record of the Riveras, linked to a customer the books' copy doesn't hold.
    const [oldLeo] = await db.insert(student).values({ familyId: rivera, name: "Old Leo", active: false }).returning();
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "13", studentId: oldLeo!.id, origin: "carried_over" });
    // A removed guardian of the Riveras, with a link of their own.
    const bea = await seedParent({ name: "Bea Rivera", email: "bea@example.com" });
    const [beaRow] = await db.insert(guardian).values({ parentId: bea.id, familyId: rivera, status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" }).returning();
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "14", guardianId: beaRow!.id, origin: "carried_over" });
    // A student record of the Chens linked to a customer under the Riveras' customer: another family's, never touched.
    const [chenKid] = await db.insert(student).values({ familyId: chen, name: "Kim Chen", active: true }).returning();
    const [chenKidLink] = await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "15", studentId: chenKid!.id, origin: "carried_over" }).returning();
    await db.insert(familyMoney).values({ familyId: rivera, realmId: REALM, readAt: new Date(), invoices: [], totalCents: 0, currency: "USD" });
    const before = await linksOfFamily(rivera);
    expect(before).toHaveLength(5); // the family, Leo, Old Leo, Ana's row, Bea's row
    const chenBefore = await linksOfFamily(chen);
    const rowsBefore = await db.select().from(guardian).where(eq(guardian.familyId, rivera)).orderBy(asc(guardian.id));
    expect(rowsBefore.map((g) => g.id).sort()).toEqual([anaRowId, beaRow!.id].sort());
    stub.calls.length = 0;
    const pressedAt = new Date();

    const r = await unlinkRow("Rivera Family");
    expect(r.ok).toBe(true);
    const message = (r as { message: string }).message;
    expect(message).toContain("Rivera Family is no longer linked to “Rivera Family” in the books.");
    expect(message).toContain("Its students' links ended with it: Leo Rivera and Old Leo.");
    expect(message).toContain("2 guardians' own links to Parent customers ended with it too.");
    expect(message).toContain("Its stored figures were forgotten");
    expect(message).toContain("Nothing was sent to the books, and the customer stays there as it is.");
    expect(message).toContain("This page now lists the customer under Customers with no family");
    expect(stub.apiCalls()).toEqual([]);

    expect(await linksOfFamily(rivera)).toEqual([]);
    const ended = await db.select().from(accountingLinkEnded);
    expect(ended).toHaveLength(5);
    for (const l of before) {
      const e = ended.find((x) => x.id === l.id)!;
      expect(e).toMatchObject({ system: l.system, realmId: l.realmId, customerId: l.customerId, familyId: l.familyId, studentId: l.studentId, guardianId: l.guardianId,
        origin: l.origin, linkedAt: l.linkedAt, linkedBy: l.linkedBy, endedBy: linker.id, endedHow: "unlinked" });
      expect(e.endedAt.getTime()).toBeGreaterThanOrEqual(pressedAt.getTime() - 1000);
    }
    // Another family's student link, under the same customer, is as it was; and so is every Chen link.
    expect(await db.select().from(accountingLink).where(eq(accountingLink.id, chenKidLink!.id))).toEqual([chenKidLink]);
    expect(await linksOfFamily(chen)).toEqual(chenBefore);
    // The guardian rows are exactly as they were: an unlink touches none (stage 3's slice 12b2).
    expect(await db.select().from(guardian).where(eq(guardian.familyId, rivera)).orderBy(asc(guardian.id))).toEqual(rowsBefore);
    expect(await db.select().from(familyMoney).where(eq(familyMoney.familyId, rivera))).toEqual([]);
    // The records stand as they were.
    expect(await db.select().from(family).where(eq(family.id, rivera))).toMatchObject([{ active: true, name: "Rivera Family" }]);
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ familyId: rivera, active: true });

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "accounting.link.remove"));
    const familyLink = before.find((l) => l.familyId !== null)!;
    expect(audit).toMatchObject({ targetType: "family", targetId: String(rivera), actorId: linker.id, permission: "Accounting.Link.ReadWrite" });
    expect(audit!.before).toMatchObject({ link: { id: familyLink.id, customerQboId: "10", realmId: REALM, origin: "carried_over", linkedBy: null } });
    expect((audit!.before as { studentLinks: unknown[] }).studentLinks).toHaveLength(2);
    expect((audit!.before as { guardianLinks: unknown[] }).guardianLinks).toHaveLength(2);
    expect(audit!.after).toMatchObject({ familyId: String(rivera), customerQboId: "10", realmId: REALM, guardianLinksEnded: 2, moneyForgotten: true, paidBuyoutsKept: 0 });
    expect(audit!.after).not.toHaveProperty("guardianRowsCleared");
    expect((audit!.after as { studentLinksEnded: { studentId: string }[] }).studentLinksEnded.map((s) => s.studentId).sort()).toEqual([String(leo), String(oldLeo!.id)].sort());

    // The row now reads as a family with no link: Ana's sign-in address is on the Parent customer under 10 again.
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.status.key).toBe("suggested");
    expect(row.unlink).toBeNull();
    expect(row.confirm).toMatchObject({ customerId: "10" });
  });

  it("goes through for a Linked, a with-differences, a Customer gone and a Not a family now family as for a Carried over one", async () => {
    await readAgain(qc("80", "Oak Family", "1"), qc("85", "Elm Family", "1"), qc("90", "Ash Family", "1"));
    await syncAppRecords();
    await db.update(accountingLink).set({ origin: "confirmed", linkedBy: linker.id }).where(eq(accountingLink.familyId, await recordOfCustomer("80", "family")));
    changeInBooks("20", { DisplayName: "The Chens" });
    changeInBooks("85", { CustomerTypeRef: { value: "4" } });
    stub.customers = stub.customers.filter((c) => c.Id !== "90");
    await readAgain();
    // The roster's reads above asked the stub; the unlinks after this must ask it nothing.
    stub.calls.length = 0;
    for (const name of ["Oak Family", "Chen Family", "Ash Family", "Elm Family"]) {
      const row = rowOf(await loadAccountingLinks(), name);
      expect(await press(row)).toMatchObject({ ok: true });
      expect(await linksOfFamily(row.familyId)).toEqual([]);
      expect(await db.select().from(accountingLinkEnded).where(eq(accountingLinkEnded.id, row.unlink!.linkId))).toHaveLength(1);
    }
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("refused, keeping nothing", () => {
  it("in any state but listed, for an inactive family, a family with no link, a forged link, another family's stamp, and a student's link made or ended since the page", async () => {
    const view = await loadAccountingLinks();
    const r = rowOf(view, "Rivera Family"), c = rowOf(view, "Chen Family");
    const was = await everything();
    const refusedWith = async (p: Promise<unknown>, words: string) => { expect(await p).toEqual({ ok: false, errors: [words] }); expect(await everything()).toEqual(was); };
    await refusedWith(press(r, "another tag"), ROSTER_MOVED);
    await refusedWith(unlinkFamily({ familyId: String(rivera), linkId: r.unlink!.linkId, stamp: 42 }, tag, linkOp()), LINK_COPY.notFromPage);
    await refusedWith(unlinkFamily({ familyId: String(rivera), linkId: c.unlink!.linkId, stamp: r.unlink!.stamp }, tag, linkOp()), LINK_COPY.unlinkChanged);
    await refusedWith(unlinkFamily({ familyId: String(rivera), linkId: r.unlink!.linkId, stamp: c.unlink!.stamp }, tag, linkOp()), LINK_COPY.unlinkChanged);
    // A family with no link.
    const hand = asOp(await staffWith("adder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const made = await addFamily({ role: "family", name: "Birch Family", typeQboId: null }, tag, { ...hand, mayLink: false });
    expect(made).toMatchObject({ ok: true });
    const birch = rowOf(await loadAccountingLinks(), "Birch Family");
    const was2 = await everything();
    expect(await unlinkFamily({ familyId: String(birch.familyId), linkId: r.unlink!.linkId, stamp: r.unlink!.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.notLinkedNow] });
    expect(await everything()).toEqual(was2);
    // A student's link made, then one ended, since the page.
    const [newKid] = await db.insert(student).values({ familyId: rivera, name: "Nia Rivera", active: true }).returning();
    const [newLink] = await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "16", studentId: newKid!.id, origin: "carried_over" }).returning();
    let now = await everything();
    expect(await press(r)).toEqual({ ok: false, errors: [LINK_COPY.unlinkChanged] });
    expect(await everything()).toEqual(now);
    await db.delete(accountingLink).where(eq(accountingLink.id, newLink!.id));
    await db.delete(accountingLink).where(eq(accountingLink.studentId, await recordOfCustomer("12", "student")));
    now = await everything();
    expect(await press(r)).toEqual({ ok: false, errors: [LINK_COPY.unlinkChanged] });
    expect(await everything()).toEqual(now);
    // An inactive family.
    const fresh = rowOf(await loadAccountingLinks(), "Chen Family");
    await db.update(family).set({ active: false }).where(eq(family.id, chen));
    now = await everything();
    expect(await press(fresh)).toEqual({ ok: false, errors: [LINK_COPY.familyGone] });
    expect(await everything()).toEqual(now);
    await db.update(family).set({ active: true }).where(eq(family.id, chen));
    // Not listed: the books connected to another company, offering no press.
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    expect((await loadAccountingLinks()).rows.every((x) => x.unlink === null)).toBe(true);
    now = await everything();
    expect(await press(fresh)).toEqual({ ok: false, errors: [LINK_COPY.other_company] });
    expect(await everything()).toEqual(now);
    await db.update(qboConnection).set({ realmId: REALM });
    // Not listed: no shape.
    const shape = (await db.select().from(setting).where(eq(setting.key, SHAPE_KEY)))[0]!;
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    now = await everything();
    expect(await press(fresh)).toEqual({ ok: false, errors: [LINK_COPY.no_shape] });
    expect(await everything()).toEqual(now);
    await db.insert(setting).values({ key: SHAPE_KEY, value: shape.value });
    // Not listed: the roster names no company, offering no press; a page then carries the tag "none".
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect((await loadAccountingLinks()).rows.every((x) => x.unlink === null)).toBe(true);
    now = await everything();
    expect(await press(fresh, "none")).toEqual({ ok: false, errors: [LINK_COPY.no_company] });
    expect(await everything()).toEqual(now);
  });

  it("while a blocking change for the family, a student record or a guardian row of it, or naming one of its customers, waits, is stuck or is kept; and while a move into or out of it does", async () => {
    // Max Chen 22, a student of the Chens, for a move into the Riveras.
    await readAgain(qc("22", "Max Chen", "3", under("20")));
    await syncAppRecords();
    const leo = await recordOfCustomer("12", "student");
    const anaRow = (await db.select().from(guardian).where(eq(guardian.familyId, rivera)))[0]!;
    const kinds: { what: string; seed: (state: "waiting" | "stuck" | "refused") => Promise<{ id: string }>; words: string }[] = [
      { what: "filed under the family", words: LINK_COPY.unlinkWaiting(1),
        seed: (state) => seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" }, { state }) },
      { what: "filed under a student record only", words: LINK_COPY.unlinkWaiting(1), seed: async (state) => {
        const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state, familyQboId: null });
        expect(item.studentId).toBe(leo);
        return item;
      } },
      { what: "naming a guardian row", words: LINK_COPY.unlinkWaiting(1),
        seed: (state) => seedQueued({ op: "create", role: "parent", name: "Ana Rivera", typeQboId: "2", familyQboId: null, email: "ana@example.com", guardianId: anaRow.id }, { state }) },
      { what: "targeting a student's customer", words: LINK_COPY.unlinkWaiting(1), seed: async (state) => {
        const item = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" }, { state, familyQboId: null });
        await db.update(writeQueue).set({ studentId: null }).where(eq(writeQueue.id, item.id));
        return item;
      } },
      { what: "a move into the family", words: LINK_COPY.unlinkMoving(1),
        seed: (state) => seedQueued({ op: "move", role: "student", qboId: "22", syncToken: "0", fromFamilyQboId: "20", toFamilyQboId: "10", fromFamilyId: chen, toFamilyId: rivera }, { state }) },
      { what: "a move out of the family", words: LINK_COPY.unlinkMoving(1),
        seed: (state) => seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen }, { state }) },
    ];
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    for (const k of kinds) {
      for (const state of ["waiting", "stuck", "refused"] as const) {
        const item = await k.seed(state);
        const was = await everything();
        expect(await press(row), `${k.what}, ${state}`).toEqual({ ok: false, errors: [k.words] });
        expect(await everything()).toEqual(was);
        await db.delete(writeQueue).where(eq(writeQueue.id, item.id));
      }
    }
    // Done or given up, an item refuses nothing.
    await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" }, { state: "given_up" });
    expect(await press(row)).toMatchObject({ ok: true });
  });

  it("while the family's being-made or being-sent lock, or a student record's or guardian row's being-sent lock, is held", async () => {
    const leo = await recordOfCustomer("12", "student");
    const anaRow = (await db.select().from(guardian).where(eq(guardian.familyId, rivera)))[0]!;
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    for (const [first, id] of [[MAKING_LOCK, String(rivera)], [SENDING_LOCK, String(rivera)], [SENDING_LOCK, String(leo)], [SENDING_LOCK, anaRow.id]] as const) {
      const release = await holdLock(first, id);
      try {
        const was = await everything();
        expect(await press(row)).toEqual({ ok: false, errors: [LINK_COPY.unlinkBusy] });
        expect(await everything()).toEqual(was);
      } finally { await release(); }
    }
    expect(await press(row)).toMatchObject({ ok: true });
  });

  it("waits for the roster lock behind another press, then is refused when what it was drawn on changed", async () => {
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const taken = new Promise<void>((r) => { locked = r; });
    // Another press holds the roster lock, and ends Leo's link while it does.
    const other = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      locked();
      await held;
      await tx.delete(accountingLink).where(eq(accountingLink.studentId, await recordOfCustomer("12", "student")));
    });
    await taken;
    const waiting = press(row);
    await untilALockIsAwaited();
    release();
    await other;
    expect(await waiting).toEqual({ ok: false, errors: [LINK_COPY.unlinkChanged] });
    expect(await db.select().from(accountingLinkEnded)).toEqual([]);
  });

  it("a parent's change of their details on its way refuses nothing; the unlink leaves it as it was, and its next try gives it up unsent", async () => {
    // The take-in has run, so the worker may try a parent's change at all (contactSendsMayGo()).
    await takeInDone();
    const anaRow = (await db.select().from(guardian).where(eq(guardian.familyId, rivera)))[0]!;
    const contact: RosterWrite = { op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: anaRow.id };
    const item = await seedQueued(contact, { state: "waiting", familyId: rivera });
    const r = await unlinkRow("Rivera Family");
    expect(r).toMatchObject({ ok: true });
    const message = (r as { message: string }).message;
    expect(message).toContain("A guardian's change of their details on its way to the books is given up unsent at its next try, as the family is no longer linked.");
    expect(message).not.toContain("where it can be given up");
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, item.id)))[0]).toMatchObject({ state: "waiting", request: contact });
    // The worker's next wake: given up, as the guardian's family is no longer linked, and nothing sent.
    stub.calls.length = 0;
    await runWriteQueue(new Date(Date.now() + 2 * 60_000));
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, item.id)))[0]).toMatchObject({ state: "given_up" });
    const givenUp = await db.select().from(auditLog).where(eq(auditLog.action, "roster.write.given_up"));
    expect(givenUp.map((a) => (a.after as { why?: string }).why)).toEqual(["family_off"]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a stuck or kept change of details refuses nothing either, and the answer says it waits on Reconciliation, never that it is tried again", async () => {
    const anaRow = (await db.select().from(guardian).where(eq(guardian.familyId, rivera)))[0]!;
    const contact: RosterWrite = { op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: "555-0102" }, was: { phone: "555-0101" }, guardianId: anaRow.id };
    await seedQueued(contact, { state: "refused", familyId: rivera });
    const r = await unlinkRow("Rivera Family");
    expect(r).toMatchObject({ ok: true });
    const message = (r as { message: string }).message;
    expect(message).toContain("A guardian's change of their details that is stuck or kept stays on the Reconciliation page, where it can be given up: nothing is sent from it while the family has no link.");
    expect(message).not.toContain("next try");
  });
});

describe("the answer's words", () => {
  const base = { family: "Ash Family", students: [], guardianLinks: 0, paidKept: 0, listedWithNoFamily: false, details: { waiting: 0, held: 0 } };
  it("never says a customer the books' copy doesn't hold stays there", () => {
    const gone = unlinkedWords({ ...base, customer: null });
    expect(gone).toContain("Ash Family is no longer linked to its customer in the books, which the books' copy doesn't hold now.");
    expect(gone).toContain("Nothing was sent to the books.");
    expect(gone).not.toContain("stays there");
    expect(unlinkedWords({ ...base, customer: "Ash Family" })).toContain("Nothing was sent to the books, and the customer stays there as it is.");
  });
  it("offers Pick a different customer only once the row offers it, as a Suggested row offers it once left unlinked", () => {
    expect(unlinkedWords({ ...base, customer: "Ash Family" }))
      .toContain("link it again there, with Confirm link, or with Pick a customer once the row offers it (a Suggested row offers it once it is left unlinked).");
  });
});

describe("who may press", () => {
  it("both permissions; either alone is refused as the guard refuses, naming the one missing", async () => {
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    const onlyLink = await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]);
    const onlyRead = await staffWith("onlyread@club.org", ["Roster.Read"]);
    for (const who of [onlyLink, onlyRead]) {
      asStaff(who);
      await expect(unlinkAction(String(rivera), row.unlink!.linkId, tag, row.unlink!.stamp)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === onlyLink.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    expect(refusals.filter((a) => a.actorId === onlyRead.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    expect(await db.select().from(accountingLinkEnded)).toEqual([]);
    asStaff(linker);
    expect(await unlinkAction(String(rivera), null as never, tag, row.unlink!.stamp)).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    expect(await unlinkAction(String(rivera), row.unlink!.linkId, tag, row.unlink!.stamp)).toMatchObject({ ok: true });
    expect(await linksOfFamily(rivera)).toEqual([]);
  });
});

describe("a relink: an unlink, then a link as Confirm or Pick a different customer makes it, restoring nothing", () => {
  it("to the same customer: a new link, the ended one kept, the students and the guardian paired again", async () => {
    const leo = await recordOfCustomer("12", "student");
    const before = await linksOfFamily(rivera);
    expect(await unlinkRow("Rivera Family")).toMatchObject({ ok: true });
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.status.key).toBe("suggested");
    expect(await linkFamilyToCustomer({ familyId: String(rivera), customerId: "10", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    const [familyLink] = await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera));
    expect(familyLink).toMatchObject({ customerId: "10", origin: "confirmed", linkedBy: linker.id });
    expect(before.map((l) => l.id)).not.toContain(familyLink!.id);
    const [leoLink] = await db.select().from(accountingLink).where(eq(accountingLink.studentId, leo));
    expect(leoLink).toMatchObject({ customerId: "12", origin: "confirmed" });
    // Nothing restored: Ana's row is linked again to Ana Rivera 11 because its email field holds her sign-in address
    // (slice M3c2's pairing, a new link, not the ended one), no money row; the history kept.
    const anaRow = (await db.select().from(guardian).where(eq(guardian.familyId, rivera)))[0]!;
    const guardianLinks = await db.select().from(accountingLink).where(inArray(accountingLink.guardianId, (await db.select().from(guardian)).map((g) => g.id)));
    expect(guardianLinks).toEqual([expect.objectContaining({ guardianId: anaRow.id, customerId: "11", origin: "confirmed", linkedBy: linker.id })]);
    expect(before.map((l) => l.id)).not.toContain(guardianLinks[0]!.id);
    expect(await db.select().from(familyMoney).where(eq(familyMoney.familyId, rivera))).toEqual([]);
    expect((await db.select().from(accountingLinkEnded)).map((e) => e.id).sort()).toEqual(before.map((l) => l.id).sort());
  });

  it("to another customer, then that customer's turn for another family; a removed guardian reinstated after the unlink and after the relink; a former guardian added to the other family", async () => {
    await readAgain(qc("70", "Patel Family", "1"));
    const staff = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    // Two removed guardians of the Riveras, as a removal leaves them.
    const bea = await seedParent({ name: "Bea Rivera", email: "bea@example.com" });
    const cal = await seedParent({ name: "Cal Rivera", email: "cal@example.com" });
    const removed = (parentId: string) => db.insert(guardian).values({ parentId, familyId: rivera, status: "disabled", disabledReason: "removed", statusBeforeDisable: "invited" }).returning();
    const [beaRow] = await removed(bea.id);
    const [calRow] = await removed(cal.id);
    expect(await unlinkRow("Rivera Family")).toMatchObject({ ok: true });
    expect(await reinstateGuardian(beaRow!.id, staff)).toMatchObject({ ok: true });
    // Rivera to Patel 70: left unlinked first, as a Suggested row offers no pick, then picked.
    expect(await leaveUnlinked(String(rivera), tag, linkOp())).toMatchObject({ ok: true });
    const step = (await loadAccountingLinks()).step(String(rivera), "70");
    expect(step.ok).toBe(true);
    const offer = (step as Extract<typeof step, { ok: true }>).offer;
    expect(await linkFamilyToCustomer({ familyId: String(rivera), customerId: "70", chosen: offer.chosen, stamp: offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera)))[0]).toMatchObject({ customerId: "70" });
    expect(await reinstateGuardian(calRow!.id, staff)).toMatchObject({ ok: true });
    // Birch, a family added by hand, linked to Rivera's old customer 10.
    const hand = asOp(await staffWith("adder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await addFamily({ role: "family", name: "Birch Family", typeQboId: null }, tag, { ...hand, mayLink: false })).toMatchObject({ ok: true });
    const birch = rowOf(await loadAccountingLinks(), "Birch Family").familyId;
    const birchStep = (await loadAccountingLinks()).step(String(birch), "10");
    expect(birchStep.ok).toBe(true);
    const birchOffer = (birchStep as Extract<typeof birchStep, { ok: true }>).offer;
    expect(await linkFamilyToCustomer({ familyId: String(birch), customerId: "10", chosen: birchOffer.chosen, stamp: birchOffer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    // Ana, a guardian of the Riveras, added to Birch: a new row of Birch's, never her row of the Riveras.
    const ana = (await db.select().from(guardian).where(eq(guardian.id, anaRowId)))[0]!;
    const added = await addGuardian(birch, { name: "Ana Rivera", email: "ana@example.com", samePerson: ana.parentId }, staff);
    expect(added).toMatchObject({ ok: true });
    const anaRows = await db.select().from(guardian).where(eq(guardian.parentId, ana.parentId));
    expect(anaRows).toHaveLength(2);
    expect(anaRows.find((g) => g.id === ana.id)).toMatchObject({ familyId: rivera, status: ana.status });
    // The new row's family is its record, linked to customer 10.
    expect(anaRows.find((g) => g.id !== ana.id)).toMatchObject({ familyId: birch });
  });

  it("a swap of two families' customers is four presses: unlink both, then link each to the other's", async () => {
    await readAgain(qc("80", "Oak Family", "1"));
    await syncAppRecords();
    const oak = await recordOfCustomer("80", "family");
    expect(await unlinkRow("Chen Family")).toMatchObject({ ok: true });
    expect(await unlinkRow("Oak Family")).toMatchObject({ ok: true });
    const view = await loadAccountingLinks();
    for (const [familyId, customerId] of [[chen, "80"], [oak, "20"]] as const) {
      const step = view.step(String(familyId), customerId);
      expect(step.ok).toBe(true);
      const offer = (step as Extract<typeof step, { ok: true }>).offer;
      expect(await linkFamilyToCustomer({ familyId: String(familyId), customerId, chosen: offer.chosen, stamp: offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    }
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, chen)))[0]).toMatchObject({ customerId: "80" });
    expect((await db.select().from(accountingLink).where(eq(accountingLink.familyId, oak)))[0]).toMatchObject({ customerId: "20" });
    expect(await db.select().from(accountingLinkEnded).where(eq(accountingLinkEnded.familyId, chen))).toMatchObject([{ customerId: "20" }]);
  });

  it("by Link to their suggested families: the bulk press links the unlinked family again, as M3a links it", async () => {
    const before = await linksOfFamily(rivera);
    expect(await unlinkRow("Rivera Family")).toMatchObject({ ok: true });
    const view = await loadAccountingLinks();
    expect(rowOf(view, "Rivera Family").status.key).toBe("suggested");
    const confirm = rowOf(view, "Rivera Family").confirm!;
    expect((await linkSuggestedEach([{ familyId: String(rivera), customerId: confirm.customerId, stamp: confirm.stamp }], tag, linkOp())).rows).toEqual([{ id: String(rivera), outcome: "done" }]);
    const [familyLink] = await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera));
    expect(familyLink).toMatchObject({ customerId: "10", origin: "confirmed", linkedBy: linker.id });
    expect(before.map((l) => l.id)).not.toContain(familyLink!.id);
    expect((await db.select().from(accountingLinkEnded)).map((e) => e.id).sort()).toEqual(before.map((l) => l.id).sort());
  });

  it("\"Create a family from this\" for the old customer: refused while this page aims it at the family, a second family once it doesn't", async () => {
    expect(await unlinkRow("Rivera Family")).toMatchObject({ ok: true });
    const op = { ...linkOp(), mayChangeFamilies: false };
    const was = (await db.select().from(family)).length;
    expect(await familyFromCustomer("10", op, customerAimedAt)).toMatchObject({ ok: false });
    expect((await db.select().from(family)).length).toBe(was);
    expect(await leaveUnlinked(String(rivera), tag, linkOp())).toMatchObject({ ok: true });
    expect(await familyFromCustomer("10", op, customerAimedAt)).toMatchObject({ ok: true });
    expect((await db.select().from(family)).length).toBe(was + 1);
    // The Riveras keep no link; the new family has the customer's.
    expect(await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera))).toEqual([]);
  });
});

/**
 * The audit page's record filter (src/lib/audit/query.ts, customersOfRecord()) over the times the presses themselves
 * store: the unlink's ended_at (the database's statement_timestamp(), past its locks) and a link's linked_at, against
 * audit_log.at, all from the database's clock. A row naming the old customer is the family's while it was linked to it,
 * and the next family's from the unlink on; a family relinked to the same customer finds every row naming it.
 */
describe("the audit page's record filter, through a real unlink and link", () => {
  const note = (tagged: string) => writeAudit({ actor: linkOp().actor, action: "season.progress.family.read", targetType: "qbo_customer", targetId: "10", after: { tag: tagged } });
  const tagsOf = async (familyId: AppFamilyId) => (await auditPage(parseAuditFilters({ record: `family:${String(familyId)}` }))).rows
    .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();

  it("a row naming the old customer is the unlinked family's before its unlink, and the next family's after it", async () => {
    await note("while-rivera");
    expect(await unlinkRow("Rivera Family")).toMatchObject({ ok: true });
    await note("between");
    const hand = asOp(await staffWith("adder@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await addFamily({ role: "family", name: "Birch Family", typeQboId: null }, tag, { ...hand, mayLink: false })).toMatchObject({ ok: true });
    // The Riveras' row suggests 10 for them (Ana's address): left unlinked, so the customer may go to Birch.
    expect(await leaveUnlinked(String(rivera), tag, linkOp())).toMatchObject({ ok: true });
    const birch = rowOf(await loadAccountingLinks(), "Birch Family").familyId;
    const step = (await loadAccountingLinks()).step(String(birch), "10");
    expect(step.ok).toBe(true);
    const offer = (step as Extract<typeof step, { ok: true }>).offer;
    expect(await linkFamilyToCustomer({ familyId: String(birch), customerId: "10", chosen: offer.chosen, stamp: offer.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    await note("while-birch");
    expect(await tagsOf(rivera)).toEqual(["while-rivera"]);
    expect(await tagsOf(birch)).toEqual(["between", "while-birch"]);
  });

  it("a family relinked to the same customer finds every row naming it, before, between and after", async () => {
    await note("before");
    expect(await unlinkRow("Rivera Family")).toMatchObject({ ok: true });
    await note("between");
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(await linkFamilyToCustomer({ familyId: String(rivera), customerId: "10", chosen: "suggested", stamp: row.confirm!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    await note("after");
    expect(await tagsOf(rivera)).toEqual(["after", "before", "between"]);
  });
});
