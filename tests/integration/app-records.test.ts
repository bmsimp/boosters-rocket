import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parent, qboConnection, student } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { askRosterWrite } from "@/lib/roster/writes";
import { saveShape, ROSTER_LOCK } from "@/lib/roster/shape";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { reconcileAccess } from "@/lib/parents/reconcile";
import { customerOfFamily, familyLinkedTo, studentLinkedTo } from "@/lib/families/links";
import { resetDb } from "../helpers/db";
import { FZN_SHAPE, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, connectRoster, REALM, staffWith, WORKER } from "../helpers/roster-writes";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { NO_CHANGES, appRecordRows, appRecordsByCustomer, whatAFreshRunWouldChange } from "../helpers/app-records";

/**
 * The app's own families, students and links (stage 1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md):
 * filled from the roster cache and kept in step with it by keepAppRecordsInStep() (src/lib/families/in-step.ts), in the
 * same transaction as every change to the cache. "In step" is that function's answer, so after each change here a
 * fresh run of it must find nothing to change (whatAFreshRunWouldChange()).
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); stub.quirks.balances = true; });

const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const anasLink = async () => (await db.select().from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(parent.email, "ana@example.com")))[0]!.guardian;
/** The record id of each customer's family or student, by customer. */
const recordIds = async () => Object.fromEntries((await db.select().from(accountingLink)).filter((l) => l.guardianId === null)
  .map((l) => [l.customerId, String(l.familyId ?? l.studentId)]));
const withTheRosterLock = <T>(f: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
  db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`); return f(tx); });

describe("after a roster read", () => {
  it("each family and student of the cache has one record and one link, each open sign-in is in its family, and its own record is linked", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    const ana = await anasLink();
    expect(ana).toMatchObject({ familyQboId: "10", sourceQboId: "11", status: "invited" });

    const got = await appRecordsByCustomer();
    expect(got.families).toEqual([
      { customer: "10", name: "Rivera Family", active: true },
      { customer: "20", name: "Chen Family", active: true },
      { customer: "40", name: "Old Family", active: false },
    ]);
    // Not the stray student, the school, the parents or the customer with no type: they are no family's student.
    expect(got.students).toEqual([{ customer: "12", name: "Leo Rivera", active: true, family: "10" }]);
    expect(got.memberships).toEqual([{ guardianId: ana.id, family: "10" }]);
    expect(got.links.map((l) => [l.customer, l.kind])).toEqual([["10", "family"], ["11", "membership"], ["12", "student"], ["20", "family"], ["40", "family"]]);
    expect(got.links.find((l) => l.kind === "membership")).toMatchObject({ guardianId: ana.id });
    // Carried over from the roster, in the company the cache came from, by nobody.
    for (const l of got.links) expect(l).toMatchObject({ system: "quickbooks", realmId: REALM, origin: "carried_over", linkedBy: null });
    expect(await db.select().from(family)).toHaveLength(3);
    expect(await db.select().from(student)).toHaveLength(1);
    // With no audit row of its own: the roster read's covers it.
    expect((await db.select().from(auditLog)).map((r) => r.action).filter((a) => a.startsWith("accounting."))).toEqual([]);
  });

  it("a second read changes nothing", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    const before = await appRecordRows();
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await appRecordRows()).toEqual(before);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("is made whether or not parent sign-ins are on, and the reconcile that opens a sign-in puts it in its family", async () => {
    await connectRoster(stub);
    expect((await appRecordsByCustomer()).families.map((f) => f.customer)).toEqual(["10", "20", "40"]);
    expect(await db.select().from(guardian)).toEqual([]);
    await seedParentSettings(SIGNINS_ON);
    await withTheRosterLock((tx) => reconcileAccess(tx, { cause: "test" }));
    const ana = await anasLink();
    const got = await appRecordsByCustomer();
    expect(got.memberships).toEqual([{ guardianId: ana.id, family: "10" }]);
    expect(got.links.filter((l) => l.kind === "membership")).toMatchObject([{ customer: "11", guardianId: ana.id }]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("a sign-in that closes loses its record's link and stays in its family", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    Object.assign(inStub("11"), { Active: false, SyncToken: "1" });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    const ana = await anasLink();
    expect(ana).toMatchObject({ status: "disabled", disabledReason: "inactive" });
    const got = await appRecordsByCustomer();
    expect(got.memberships).toEqual([{ guardianId: ana.id, family: "10" }]);
    expect(got.links.filter((l) => l.kind === "membership")).toEqual([]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("keeps an inactive record, named from what the portal last knew, for a customer the cache no longer returns that a record still names", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    const ids = await recordIds();
    // Leo has a place on a shift; then his family's customers leave the roster QuickBooks sends.
    const { shifts: [shift] } = await seedEvent({ inDays: 20 });
    const ana = await anasLink();
    await seedSignup({ shiftId: shift!.id, familyQboId: "10", signedUpBy: ana.parentId, student: { qboId: "12", name: "Leo Rivera" } });
    stub.customers = stub.customers.filter((c) => !["10", "11", "12"].includes(c.Id as string));
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });

    const got = await appRecordsByCustomer();
    expect(got.families).toEqual([
      { customer: "10", name: "Rivera Family", active: false },     // the closed sign-in and the place still name it
      { customer: "20", name: "Chen Family", active: true },
      { customer: "40", name: "Old Family", active: false },
    ]);
    expect(got.students).toEqual([{ customer: "12", name: "Leo Rivera", active: false, family: null }]);
    // The same records as before: their ids don't change.
    const now = await recordIds();
    for (const customer of ["10", "12", "20", "40"]) expect(now[customer], customer).toBe(ids[customer]);
    expect(got.memberships).toEqual([{ guardianId: ana.id, family: "10" }]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });
});

describe("a staff roster write keeps them in step, in its own transaction", () => {
  it("a new student, a rename, a move and making a student inactive, each keeping the student's record", async () => {
    await seedParentSettings(SIGNINS_ON);
    const tag = await connectRoster(stub);
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const leo = (await recordIds())["12"];
    const studentOf = async (customer: string) => (await appRecordsByCustomer()).students.find((s) => s.customer === customer);

    expect((await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op)).ok).toBe(true);
    const rosa = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!.Id as string;
    expect(await studentOf(rosa)).toEqual({ customer: rosa, name: "Rosa Rivera", active: true, family: "10" });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);

    expect((await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).ok).toBe(true);
    expect(await studentOf("12")).toEqual({ customer: "12", name: "Leon Rivera", active: true, family: "10" });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);

    expect((await askRosterWrite({ op: "move", qboId: "12", syncToken: "1", toFamilyQboId: "20" }, tag, op)).ok).toBe(true);
    expect(await studentOf("12")).toEqual({ customer: "12", name: "Leon Rivera", active: true, family: "20" });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);

    expect((await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "2" }, tag, op)).ok).toBe(true);
    expect(await studentOf("12")).toEqual({ customer: "12", name: "Leon Rivera", active: false, family: "20" });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    expect((await recordIds())["12"]).toBe(leo);
  });

  it("a new membership shape is followed in the transaction that saves it", async () => {
    await connectRoster(stub);
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" }, { actor: WORKER.actor, ip: null });
    const got = await appRecordsByCustomer();
    expect(got.families.map((f) => f.customer)).toEqual(["10", "20", "40"]);
    expect(got.students).toEqual([]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    expect((await appRecordsByCustomer()).students.map((s) => s.customer)).toEqual(["12"]);
  });
});

describe("another company", () => {
  it("a roster read of a different company clears the old records and links and makes the new company's, in the same transaction", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    const before = await appRecordRows();
    const ana = await anasLink();
    const OTHER = "9130000000000002";
    // The same customers in another company, as QuickBooks would send them after an Admin connected it.
    await db.update(qboConnection).set({ realmId: OTHER });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });

    const after = await appRecordRows();
    // Nothing of the old company's is left: no link of it, and no record it made.
    expect(after.links.every((l) => l.realmId === OTHER)).toBe(true);
    const oldIds = new Set([...before.families.map((f) => String(f.id)), ...before.students.map((s) => String(s.id))]);
    for (const r of [...after.families, ...after.students]) expect(oldIds.has(String(r.id))).toBe(false);
    // The closed sign-in holds the old company's ids: it is in no family. The shape went with the old company, so the
    // new one has no roster families yet, only what its records name (nothing).
    expect(after.memberships).toEqual([{ id: ana.id, familyId: null }]);
    expect(after.families).toEqual([]);
    const [cleared] = (await db.select().from(auditLog)).filter((r) => r.action === "accounting.links.cleared");
    expect(cleared!.after).toMatchObject({ reason: "different_company", realmId: OTHER, families: 3, students: 1, links: 5, memberships: 1 });
  });

  it("connecting a different company leaves the new tables empty and every sign-in in no family", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    expect(await clearRosterOfOtherCompany("9130000000000002", { actor: WORKER.actor, ip: null })).toBe(true);
    expect(await db.select().from(family)).toEqual([]);
    expect(await db.select().from(student)).toEqual([]);
    expect(await db.select().from(accountingLink)).toEqual([]);
    expect((await db.select().from(guardian)).map((g) => g.familyId)).toEqual([null]);
  });

  it("a lookup through a link names the connected company: another company's link never answers", async () => {
    await connectRoster(stub);
    const ids = await recordIds();
    expect(String(await familyLinkedTo("10"))).toBe(ids["10"]);
    expect(String(await studentLinkedTo("12"))).toBe(ids["12"]);
    expect(await customerOfFamily((await familyLinkedTo("20"))!)).toBe("20");
    expect(await familyLinkedTo("12")).toBeNull();                        // a student's customer is no family's
    const rivera = (await familyLinkedTo("10"))!;
    await db.update(qboConnection).set({ realmId: "9130000000000002" });
    expect(await familyLinkedTo("10")).toBeNull();
    expect(await studentLinkedTo("12")).toBeNull();
    expect(await customerOfFamily(rivera)).toBeNull();
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null });
    expect(await familyLinkedTo("10")).toBeNull();
  });
});
