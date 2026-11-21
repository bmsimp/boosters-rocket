import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

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
import { askRosterWrite, deactivateLinked, moveStudent, WRITE_COPY } from "@/lib/roster/writes";
import { saveShape, ROSTER_LOCK } from "@/lib/roster/shape";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { importRecordsFromRoster } from "@/lib/families/roster-import";
import { customerOfFamily, customerOfStudent, familyLinkedTo, studentLinkedTo } from "@/lib/families/links";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { FZN_SHAPE, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, connectRoster, REALM, seedAnaRivera, staffWith, WORKER } from "../helpers/roster-writes";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { NO_CHANGES, appRecordRows, appRecordsByCustomer, recordIds, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";

/**
 * The app's own families, students and links (stage 1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md).
 * Migration 0023 made them from the roster cache, by the rules of the import (importRecordsFromRoster(),
 * src/lib/families/roster-import.ts), which a mirror ran after every change of the cache until stage 3's slice 9c. Since
 * then they stand alone: no roster read, read-again or shape save changes one, and a staff write changes its own record
 * (changeOwnRecord(), src/lib/roster/writes.ts), the way the import would have, so after each a fresh import still finds
 * nothing to change (whatAFreshRunWouldChange()). The test helpers run the import after writing the cache
 * (connectRoster(), syncAppRecords()), so the families and students here are those 0023 made of the same roster; a
 * guardian row is given its family and its own link by whoever makes it (seedGuardian(), as staff's add does), never by
 * the import (stage 3's slice 12b1). Outside a change of company nothing is deleted, so a record keeps its id.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); stub.quirks.balances = true; });
afterEach(() => vi.restoreAllMocks());

const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const anasLink = async () => (await db.select().from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(parent.email, "ana@example.com")))[0]!.guardian;
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const withTheRosterLock = <T>(f: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
  db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`); return f(tx); });
/** Every id that was there before is still there, for the same kind and customer. */
const keptEvery = (before: Record<string, string>, now: Record<string, string>) => { for (const [key, id] of Object.entries(before)) expect(now[key], key).toBe(id); };

describe("the import, as migration 0023 made the records", () => {
  it("each family and student of the cache has one record and one link, and a sign-in seeded after it is in its family, linked to its own record", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    const ana = await anasLink();
    // The row stands on its family record and its own link: neither old copy is written.
    expect(ana).toMatchObject({ familyQboId: null, sourceQboId: null, status: "invited" });

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
    // The read itself made none of them: its audit row says nothing of records.
    expect((await audits("roster.refresh")).at(-1)!.after).not.toHaveProperty("appRecords");
  });

  it("run again, it changes nothing", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    const before = await appRecordRows();
    expect(await withTheRosterLock((tx) => importRecordsFromRoster(tx))).toEqual(NO_CHANGES);
    expect(await appRecordRows()).toEqual(before);
  });

  it("touches no guardian row: a row's family and own link are its own, and a row's old copies are read by nothing", async () => {
    await connectRoster(stub);
    expect((await appRecordsByCustomer()).families.map((f) => f.customer)).toEqual(["10", "20", "40"]);
    expect(await db.select().from(guardian)).toEqual([]);
    // Nothing makes a sign-in from QuickBooks: Ana is written as the portal holds her, in her family with her own link.
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const row = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    const got = await appRecordsByCustomer();
    expect(got.memberships).toEqual([{ guardianId: row.id, family: "10" }]);
    expect(got.links.filter((l) => l.kind === "membership")).toMatchObject([{ customer: "11", guardianId: row.id, origin: "carried_over" }]);
    // A row that holds only the old copies (as one made before stage 3's slice 12b1 might), with no family record: the
    // import neither puts it in the family its copy names nor links it to the record its copy names.
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com" });
    const [old] = await db.insert(guardian).values({ parentId: mei.id, familyQboId: "20", sourceQboId: "21", status: "invited" }).returning();
    const before = await appRecordRows();
    expect(await withTheRosterLock((tx) => importRecordsFromRoster(tx))).toEqual(NO_CHANGES);
    expect(await appRecordRows()).toEqual(before);
    expect((await db.select().from(guardian).where(eq(guardian.id, old!.id)))[0]!.familyId).toBeNull();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, old!.id))).toEqual([]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("a guardian row that names no customer (made while its family had no link, slice 9d) keeps its family, and is linked to nothing", async () => {
    await connectRoster(stub);
    // Inactive, as a whole run of the import leaves a family with no link (its own rule, which stage 4 takes up): the
    // row's family is what is under test.
    const [byHand] = await db.insert(family).values({ name: "Oak Family", active: false }).returning({ id: family.id });
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const [row] = await db.insert(guardian).values({ parentId: ana.id, familyQboId: null, familyId: byHand!.id, status: "invited", sourceQboId: null }).returning();
    const before = await appRecordRows();
    expect(await withTheRosterLock((tx) => importRecordsFromRoster(tx))).toEqual(NO_CHANGES);
    expect(await appRecordRows()).toEqual(before);
    const [now] = await db.select().from(guardian).where(eq(guardian.id, row!.id));
    expect(now!.familyId).toBe(byHand!.id);
    expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, row!.id))).toEqual([]);
  });

  it("keeps the records, inactive and named from what the portal last knew, of customers the cache no longer returns", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    const ids = await recordIds();
    // Leo has a place on a shift; then his family's customers leave the roster QuickBooks sends.
    const { shifts: [shift] } = await seedEvent({ inDays: 20 });
    const ana = await anasLink();
    await seedSignup({ shiftId: shift!.id, familyQboId: "10", signedUpBy: ana.parentId, student: { qboId: "12", name: "Leo Rivera" } });
    stub.customers = stub.customers.filter((c) => !["10", "11", "12"].includes(c.Id as string));
    const before = await appRecordRows();
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    // The read leaves every record as it was (stage 3's slice 9c); an import of what it stored is what changes them.
    expect(await appRecordRows()).toEqual(before);
    expect(await syncAppRecords()).toMatchObject({ families: { made: 0, changed: 1 }, students: { made: 0, changed: 1 } });

    const got = await appRecordsByCustomer();
    expect(got.families).toEqual([
      { customer: "10", name: "Rivera Family", active: false },
      { customer: "20", name: "Chen Family", active: true },
      { customer: "40", name: "Old Family", active: false },
    ]);
    // Leo is inactive and stays under the family he was last in.
    expect(got.students).toEqual([{ customer: "12", name: "Leo Rivera", active: false, family: "10" }]);
    keptEvery(ids, await recordIds());
    expect(got.memberships).toEqual([{ guardianId: ana.id, family: "10" }]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });
});

describe("the records stand alone: what QuickBooks holds changes none of them (stage 3's slice 9c)", () => {
  it("a roster read takes no rename, move, inactive flag, new customer or vanished customer into them", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    const before = await appRecordRows();
    Object.assign(inStub("12"), { DisplayName: "Leonardo Rivera", ParentRef: { value: "20" }, SyncToken: "4" }); // renamed and moved in QuickBooks
    Object.assign(inStub("20"), { Active: false, SyncToken: "2" });                                               // made inactive there
    stub.customers.push({ Id: "70", DisplayName: "Patel Family", Active: true, SyncToken: "0", CustomerTypeRef: { value: "1" }, MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" } });
    stub.customers = stub.customers.filter((c) => c.Id !== "40");                                                 // gone from QuickBooks' answer
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true, customers: 9 });
    expect(await appRecordRows()).toEqual(before);
    expect(await familyLinkedTo("70")).toBeNull();
    expect((await audits("roster.refresh")).at(-1)!.after).not.toHaveProperty("appRecords");
    // An import would take each of those in: the records differ from QuickBooks now, for stage 4 to show.
    expect(await whatAFreshRunWouldChange()).not.toEqual(NO_CHANGES);
  });

  it("a staff write changes its own record as the import would: a new student, a rename, a move and making a student inactive", async () => {
    await seedParentSettings(SIGNINS_ON);
    const tag = await connectRoster(stub);
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const leo = (await recordIds())["student:12"];
    const studentOf = async (customer: string) => (await appRecordsByCustomer()).students.find((s) => s.customer === customer);

    expect((await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op)).ok).toBe(true);
    const rosa = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!.Id as string;
    expect(await studentOf(rosa)).toEqual({ customer: rosa, name: "Rosa Rivera", active: true, family: "10" });
    expect((await audits("roster.customer.create")).at(-1)!.after).toMatchObject({ appRecord: { kind: "student", made: true } });
    expect((await appRecordsByCustomer()).links.find((l) => l.customer === rosa)).toMatchObject({ kind: "student", origin: "created", linkedBy: op.staffUserId });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);

    expect((await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).ok).toBe(true);
    expect(await studentOf("12")).toEqual({ customer: "12", name: "Leon Rivera", active: true, family: "10" });
    expect((await audits("roster.customer.rename")).at(-1)!.after).toMatchObject({ appRecord: { kind: "student", studentId: leo, set: { name: "Leon Rivera" } } });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);

    // A move is saved in the portal first since slice 9f, by the app's ids, and sent with the link's version.
    expect((await moveStudent(leo!, (await recordIds())["family:20"]!, tag, op)).ok).toBe(true);
    expect(await studentOf("12")).toEqual({ customer: "12", name: "Leon Rivera", active: true, family: "20" });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);

    // A make-inactive goes by the record too since slice 9g, QuickBooks first, with the link's own version.
    expect((await deactivateLinked({ kind: "student", recordId: leo! }, tag, op)).ok).toBe(true);
    expect(await studentOf("12")).toEqual({ customer: "12", name: "Leon Rivera", active: false, family: "20" });
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    expect((await recordIds())["student:12"]).toBe(leo);
  });

  it("a record read again after it changed in QuickBooks is stored in the cache and audited, and its app record is left as it was", async () => {
    const tag = await connectRoster(stub);
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    Object.assign(inStub("12"), { DisplayName: "Leonardo Rivera", SyncToken: "3" }); // changed in QuickBooks since the roster was read
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: false, errors: [WRITE_COPY.changed] });
    expect((await appRecordsByCustomer()).students).toEqual([{ customer: "12", name: "Leo Rivera", active: true, family: "10" }]);
    const [row] = await audits("roster.customer.read_again");
    expect(row).toMatchObject({ door: "staff", actorLabel: "registrar@club.org", targetId: "12", after: { cached: true, syncToken: "3" } });
    expect(row!.after).not.toHaveProperty("appRecords");
    expect((await whatAFreshRunWouldChange()).students.changed).toBe(1); // QuickBooks' name, which only stage 4 takes in
  });

  it("a new membership shape changes no record, and neither does changing it back", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    const before = await appRecordRows();
    // The family and student types swapped, as an Admin might by mistake, and then swapped back.
    await saveShape({ kind: "layered", familyTypeId: "3", studentTypeId: "1", parentTypeId: "2" }, { actor: WORKER.actor, ip: null });
    expect(await appRecordRows()).toEqual(before);
    expect((await audits("settings.membership.save")).at(-1)!.after).not.toHaveProperty("appRecords");
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    expect(await appRecordRows()).toEqual(before);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });
});

describe("another company", () => {
  // From stage 2 until stage 4 of the app-owned families spec (open question 18), a different company's roster is
  // never read over this one's: the seasons keep their records against these families.
  it("a roster read of a different company is refused, and every record and link stays as it was", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    const before = await appRecordRows();
    const OTHER = "9130000000000002";
    // A connection to another company stored without a connect's refusal (from before it, or by hand).
    await db.update(qboConnection).set({ realmId: OTHER });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: false, reason: "failed", error: expect.stringContaining("(roster_company)") });
    expect(await appRecordRows()).toEqual(before);
    expect(await audits("accounting.links.cleared")).toEqual([]);
  });


  it("connecting a different company leaves the new tables empty and every sign-in in no family", async () => {
    await seedParentSettings(SIGNINS_ON);
    await connectRoster(stub);
    await seedAnaRivera();
    expect(await clearRosterOfOtherCompany("9130000000000002", { actor: WORKER.actor, ip: null })).toBe(true);
    expect(await db.select().from(family)).toEqual([]);
    expect(await db.select().from(student)).toEqual([]);
    expect(await db.select().from(accountingLink)).toEqual([]);
    expect((await db.select().from(guardian)).map((g) => g.familyId)).toEqual([null]);
  });

  it("a lookup asks for one kind, answers while QuickBooks is disconnected, and never while another company is connected", async () => {
    await connectRoster(stub);
    const ids = await recordIds();
    expect(String(await familyLinkedTo("10"))).toBe(ids["family:10"]);
    expect(String(await studentLinkedTo("12"))).toBe(ids["student:12"]);
    expect(await customerOfFamily((await familyLinkedTo("20"))!)).toBe("20");
    expect(await customerOfStudent((await studentLinkedTo("12"))!)).toBe("12");
    expect(await familyLinkedTo("12")).toBeNull();                        // a student's customer has no family record
    expect(await studentLinkedTo("10")).toBeNull();
    const rivera = (await familyLinkedTo("10"))!;
    // Disconnected: the records are still the roster's company's, and parent pages must keep working from them.
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null });
    expect(String(await familyLinkedTo("10"))).toBe(ids["family:10"]);
    expect(await customerOfFamily(rivera)).toBe("10");
    // Connected to another company: its customer 10 is somebody else, so nothing answers.
    await db.update(qboConnection).set({ realmId: "9130000000000002" });
    expect(await familyLinkedTo("10")).toBeNull();
    expect(await studentLinkedTo("12")).toBeNull();
    expect(await customerOfFamily(rivera)).toBeNull();
  });
});
