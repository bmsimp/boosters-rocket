import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// The take-in reads the roster cache and asks QuickBooks nothing: the stub is only what a connection row needs, and
// would see any request that was sent.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
// The worker's wake (runDueJobs()) reaches modules that read request headers; it has none.
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, jobRun, parent, qboCustomer, setting } from "@/lib/db/schema";
import { TAKE_IN_ASK_EVERY_MS, TAKE_IN_JOB, TAKE_IN_KEY, noteAddressesKept, planContactTakeIn, takeInContactDetails, writeContactTakeIn } from "@/lib/parents/contact-take-in";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { ROSTER_JOB } from "@/lib/roster/source";
import { runDueJobs } from "@/lib/jobs/runner";
import type { ContactValues } from "@/lib/parents/contact-fields";
import { NO_DETAILS, familyDetails, personDetails, setPersonDetails } from "../helpers/contact";
import { resetDb, seedGuardian } from "../helpers/db";
import { FAMILY_A, FAMILY_B, MONEY_REALM, seedParentIn, seedSignedInParent } from "../helpers/parent";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, fam, par, seedRosterRead, seedShape, storeShape, stu } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { connectRoster, seedAnaRivera, WORKER } from "../helpers/roster-writes";
import { FZN_SHAPE } from "../helpers/qbo-stub";
import { SOURCE_KEY } from "@/lib/roster/source";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const ADDRESS = { line1: "12 Heron Lane", line2: "Unit 4", city: "Austin", region: "TX", postalCode: "78745", country: "USA" };
type Address = Omit<ContactValues, "phone">;
/** A cached customer's phone and billing address, as a roster read since migration 0044 keeps them. */
async function cacheHolds(qboId: string, o: { phone?: string | null; address?: Address | null }) {
  await db.update(qboCustomer).set({
    ...(o.phone !== undefined ? { phone: o.phone } : {}),
    ...(o.address !== undefined ? { addressLine1: o.address?.line1 || null, addressLine2: o.address?.line2 || null, addressCity: o.address?.city || null,
      addressRegion: o.address?.region || null, addressPostalCode: o.address?.postalCode || null, addressCountry: o.address?.country || null } : {}),
  }).where(eq(qboCustomer.qboId, qboId));
}
/**
 * A successful roster read by this build, which keeps the billing addresses: the run, and the mark its savepoint
 * leaves for the take-in (noteAddressesKept(), as refreshRoster() writes it; tests/integration/roster-refresh.test.ts).
 */
async function thisBuildRead(at?: Date) {
  const startedAt = await seedRosterRead({ finishedAt: at });
  await db.transaction((tx) => noteAddressesKept(tx, startedAt));
}
/**
 * The database as migration 0044 leaves it, with the take-in waiting: every person's phone cleared, and the take-in's
 * time a minute ago. `read` then records a successful roster read by this build that started after it (or `readAt`).
 */
async function asMigrated(o: { read?: boolean; readAt?: Date } = {}) {
  await db.update(parent).set({ phone: null });
  await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after: new Date(Date.now() - 60_000).toISOString() } });
  if (o.read ?? true) await thisBuildRead(o.readAt);
}
const takeIns = async () => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((a) => a.action === "parent.details.taken_in");
const takeInSetting = async () => (await db.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY)))[0]!.value as { after: string; doneAt?: string };
/** A second family for this person, with their own record in it, which the cache holds as `o` says. */
async function secondFamily(parentId: string, email: string, o: { phone?: string | null; address?: Address | null; status?: "active" | "disabled" }) {
  await addToCache([fam("CEDAR-FAM", "Cedarholm Family"), par("CEDAR-P1", "Ansgar Alderquist", "CEDAR-FAM", email), stu("CEDAR-S1", "Cosima Cedarholm", "CEDAR-FAM")]);
  await seedGuardian({ parentId, familyQboId: "CEDAR-FAM", status: o.status ?? "active", sourceQboId: "CEDAR-P1",
    ...(o.status === "disabled" ? { disabledReason: "removed" as const, statusBeforeDisable: "active" as const } : {}) });
  await syncAppRecords();
  await cacheHolds("CEDAR-P1", o);
}

describe("the take-in of a guardian's phone and mailing address, once", () => {
  it("gives a person the phone and address their own record holds, and records that it ran, once", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    await asMigrated();
    const result = await takeInContactDetails();
    expect(result).toMatchObject({ ran: true, counts: { peopleGivenPhone: 2, peopleGivenAddress: 1, peopleDisagreeing: 0, peopleWithNoRecord: 0 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 1 });
    expect(await personDetails(b.identity.parentId)).toEqual({ values: { ...NO_DETAILS, phone: FAMILY_B.parent.phone }, version: 1 });
    // In books with a parent type, the families are given nothing.
    for (const s of [a, b]) expect(await familyDetails(s.identity.familyId)).toEqual({ values: NO_DETAILS, version: 0 });
    // One counts-only audit row: no name, number or address in it.
    const rows = await takeIns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "system", targetType: "setting", targetId: TAKE_IN_KEY });
    for (const secret of [FAMILY_A.parent.phone, FAMILY_A.parent.name, ADDRESS.line1, ADDRESS.city, FAMILY_A.parent.email]) expect(JSON.stringify(rows[0]), secret).not.toContain(secret);
    expect(Date.parse((await takeInSetting()).doneAt!)).toBeGreaterThan(Date.now() - 60_000);

    // A second wake runs nothing, whatever the cache holds now.
    await cacheHolds(FAMILY_A.parent.qboId, { phone: "512-555-0999", address: null });
    await db.update(parent).set({ contactVersion: 0 }).where(eq(parent.id, a.identity.parentId));
    expect(await takeInContactDetails()).toEqual({ ran: false });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 0 });
    expect(await takeIns()).toHaveLength(1);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("takes a detail when every record of the person's agrees, and leaves it empty, counted, when two disagree", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    // The second record agrees on the address and not on the phone.
    await secondFamily(a.identity.parentId, FAMILY_A.parent.email, { phone: "512-555-0333", address: ADDRESS });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 0, peopleGivenAddress: 1, peopleDisagreeing: 1 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { ...ADDRESS, phone: "" }, version: 1 });
  });

  it("takes both when the person's two records agree", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    await secondFamily(a.identity.parentId, FAMILY_A.parent.email, { phone: FAMILY_A.parent.phone, address: ADDRESS });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 1, peopleGivenAddress: 1, peopleDisagreeing: 0 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 1 });
  });

  it("a record that holds none beside one that holds one is a disagreement: that detail is left empty, and counted", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    // The club left the address out of the second record, perhaps on purpose; the phone the two agree on.
    await secondFamily(a.identity.parentId, FAMILY_A.parent.email, { phone: FAMILY_A.parent.phone, address: null });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 1, peopleGivenAddress: 0, peopleDisagreeing: 1 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { ...NO_DETAILS, phone: FAMILY_A.parent.phone }, version: 1 });
  });

  it("reads only the person's open rows in active families: a closed row's record, and one in an inactive family, give nothing and disagree with nothing", async () => {
    for (const closedBy of ["row", "family"] as const) {
      await resetDb();
      const a = await seedSignedInParent(FAMILY_A);
      await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
      // A record of the person's own in a family they are no longer a guardian of, or one whose record is inactive, holding other details.
      await secondFamily(a.identity.parentId, FAMILY_A.parent.email, { phone: "512-555-0777", address: { ...ADDRESS, line1: "99 Elsewhere Row" },
        status: closedBy === "row" ? "disabled" : "active" });
      await asMigrated();
      // After the read the helper records, which brings the records into step with the cache (syncAppRecords()).
      if (closedBy === "family") await db.update(family).set({ active: false }).where(eq(family.id, await recordOfCustomer("CEDAR-FAM", "family")));
      expect(await takeInContactDetails(), closedBy).toMatchObject({ ran: true, counts: { peopleGivenPhone: 1, peopleGivenAddress: 1, peopleDisagreeing: 0 } });
      expect(await personDetails(a.identity.parentId), closedBy).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 1 });
    }
  });

  it("never overwrites a save made between its read and its write, and counts it", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    await asMigrated();
    const planned = await planContactTakeIn();
    expect(planned!.people.map((p) => p.id)).toContain(a.identity.parentId);
    // The parent saves their phone after the take-in read the cache and before it writes.
    await setPersonDetails(a.identity.parentId, { phone: "512-555-0444" }, 1);
    expect(await writeContactTakeIn(planned!)).toMatchObject({ ran: true, counts: { peopleSavedMeanwhile: 1, peopleGivenPhone: 0, peopleGivenAddress: 0 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { ...NO_DETAILS, phone: "512-555-0444" }, version: 1 });
  });

  it("in books with no parent type, never overwrites a family's details saved between its read and its write", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await storeShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await cacheHolds(FAMILY_A.family.qboId, { phone: "512-555-0199", address: ADDRESS });
    await asMigrated();
    const planned = await planContactTakeIn();
    await db.update(family).set({ phone: "512-555-0555", contactVersion: 1 }).where(eq(family.id, a.identity.familyId));
    expect(await writeContactTakeIn(planned!)).toMatchObject({ ran: true, counts: { familiesSavedMeanwhile: 1, familiesGivenDetails: 0 } });
    expect(await familyDetails(a.identity.familyId)).toEqual({ values: { ...NO_DETAILS, phone: "512-555-0555" }, version: 1 });
  });

  it("is run by the worker's wake, before the connection is looked at, on the one wake it runs", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    await asMigrated();
    // QuickBooks is not connected: the wake stops at the connection check, after the take-in.
    const takeInsOf = (r: Awaited<ReturnType<typeof runDueJobs>>) => r.ran.filter((x) => x.job === TAKE_IN_JOB);
    expect(takeInsOf(await runDueJobs())).toEqual([{ job: TAKE_IN_JOB, ok: true }]);
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 1 });
    expect(takeInsOf(await runDueJobs())).toEqual([]);
    expect(await takeIns()).toHaveLength(1);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("never gives a person another person's details: a record whose email field holds another address, and a row staff added, give nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    // The club has given the record another person's address since the row was made.
    await db.update(qboCustomer).set({ email: "someone.else@family-a.example" }).where(eq(qboCustomer.qboId, FAMILY_A.parent.qboId));
    // A guardian staff added in the portal, with no record of their own.
    const added = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Hollis Handmade", email: "hollis.handmade@family-a.example" });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 0, peopleGivenAddress: 0, peopleWithNoRecord: 2 } });
    for (const id of [a.identity.parentId, added.identity.parentId]) expect(await personDetails(id)).toEqual({ values: NO_DETAILS, version: 0 });
    expect(Date.parse((await takeInSetting()).doneAt!)).not.toBeNaN();
  });

  it("leaves alone a person who saved their details before it ran", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    await asMigrated();
    await setPersonDetails(a.identity.parentId, { phone: "512-555-0444" }, 1);
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 0, peopleGivenAddress: 0 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { ...NO_DETAILS, phone: "512-555-0444" }, version: 1 });
  });

  it("in books with no parent type, gives each linked family its own customer's details, and no person anything", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await storeShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await cacheHolds(FAMILY_A.family.qboId, { phone: "512-555-0199", address: ADDRESS });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { familiesGivenDetails: 1, peopleGivenPhone: 0 } });
    expect(await familyDetails(a.identity.familyId)).toEqual({ values: { phone: "512-555-0199", ...ADDRESS }, version: 1 });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: NO_DETAILS, version: 0 });
  });

  it("in flat books, gives each member's family the member's own details", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([{ qboId: "FLAT-M1", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "FLAT-M2", displayName: "Other Member", typeQboId: "M", email: "other@flat.example" }]);
    const m = await seedParentIn({ familyQboId: "FLAT-M1", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "FLAT-M1" });
    const other = await seedParentIn({ familyQboId: "FLAT-M2", name: "Other Member", email: "other@flat.example", sourceQboId: "FLAT-M2" });
    await cacheHolds("FLAT-M1", { address: ADDRESS });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { familiesGivenDetails: 1 } });
    expect(await familyDetails(m.identity.familyId)).toEqual({ values: { phone: "512-555-0144", ...ADDRESS }, version: 1 });
    // A member whose record holds nothing is given nothing.
    expect(await familyDetails(other.identity.familyId)).toEqual({ values: NO_DETAILS, version: 0 });
  });
});

describe("the take-in waits, and does nothing, until it can be trusted", () => {
  const ready = async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    return a;
  };
  /** It didn't run: nothing given, nothing recorded, and it is still waiting. */
  const waited = async (parentId: string) => {
    expect(await takeInContactDetails()).toEqual({ ran: false });
    expect(await personDetails(parentId)).toEqual({ values: NO_DETAILS, version: 0 });
    expect(await takeIns()).toEqual([]);
    expect((await takeInSetting()).doneAt).toBeUndefined();
  };

  it("until a successful roster read has started after the migration", async () => {
    const a = await ready();
    // A read that started before the migration's time.
    await asMigrated({ readAt: new Date(Date.now() - 10 * 60_000) });
    await waited(a.identity.parentId);
    await thisBuildRead();
    expect(await takeInContactDetails()).toMatchObject({ ran: true });
    expect((await personDetails(a.identity.parentId)).version).toBe(1);
  });

  it("until this build has read the roster: a successful read since the migration by the build before it, which keeps no address, is not enough", async () => {
    const a = await ready();
    await asMigrated({ read: false });
    // The build before 0044 answers the roster read the migration asks for, while it still runs beside the migrated
    // database: a successful run after the migration's time, over a cache it leaves with no address.
    await seedRosterRead();
    await waited(a.identity.parentId);
    await thisBuildRead();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenAddress: 1 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 1 });
  });

  it("while the roster cache names no company", async () => {
    const a = await ready();
    await asMigrated();
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    await waited(a.identity.parentId);
  });

  it("while QuickBooks is connected to another company than the roster's", async () => {
    const a = await ready();
    await asMigrated();
    await seedConnected(stub, { realmId: "9130000000000002" });
    expect(MONEY_REALM).not.toBe("9130000000000002");
    await waited(a.identity.parentId);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("while the membership shape doesn't hold", async () => {
    const a = await ready();
    await asMigrated();
    await storeShape({ kind: "layered", familyTypeId: "F", studentTypeId: "GONE", parentTypeId: "P" });
    await waited(a.identity.parentId);
    await db.delete(setting).where(eq(setting.key, "membership.shape"));
    await waited(a.identity.parentId);
  });

  it("with no setting at all (a database the migration never wrote it into), never", async () => {
    await ready();
    await seedRosterRead();
    expect(await takeInContactDetails()).toEqual({ ran: false });
    expect(await takeIns()).toEqual([]);
  });
});

describe("the roster read the take-in waits for", () => {
  const takeInValue = async () => (await db.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY)))[0]!.value as Record<string, unknown>;
  const rosterRuns = async () => db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(asc(jobRun.id));
  /** Connected to the FZN company, its roster read, then migration 0044's setting, and a successful read by the build before it: no mark. */
  async function afterTheOldBuildsRead() {
    await connectRoster(stub);
    await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after: new Date(Date.now() - 60_000).toISOString() } });
    // The build before 0044 answers the migration's ask: a successful run after the take-in's time, which marks nothing.
    await seedRosterRead();
    expect(Object.keys(await takeInValue())).toEqual(["after"]);
  }

  it("is read at the new build's first wake, whatever the build before it answered, and asked for no more once one kept the addresses", async () => {
    await afterTheOldBuildsRead();
    const before = (await rosterRuns()).length;
    // Nothing else asks for a read: the last one finished just now, and no parent's email change waits on one.
    await runDueJobs();
    const runs = await rosterRuns();
    expect(runs).toHaveLength(before + 1);
    expect(runs.at(-1)).toMatchObject({ outcome: "ok", startedBy: "worker" });
    expect((await takeInValue()).addressesReadAt).toBe(runs.at(-1)!.startedAt.toISOString());
    // Marked: the next wake reads nothing more for it (and the take-in runs).
    await runDueJobs();
    expect(await rosterRuns()).toHaveLength(before + 1);
  });

  it("when that read fails, is asked for again only once an hour has passed", async () => {
    await afterTheOldBuildsRead();
    const before = (await rosterRuns()).length;
    stub.oddRosterAnswer = { customers: { QueryResponse: "nothing" } };
    const start = new Date();
    await runDueJobs(start);
    expect((await rosterRuns()).map((r) => r.outcome).slice(before)).toEqual(["failed"]);
    // Inside the hour: no read.
    await runDueJobs(new Date(start.getTime() + TAKE_IN_ASK_EVERY_MS - 60_000));
    expect(await rosterRuns()).toHaveLength(before + 1);
    // Past it, with QuickBooks answering again: read, and marked.
    stub.oddRosterAnswer = null;
    await runDueJobs(new Date(start.getTime() + TAKE_IN_ASK_EVERY_MS + 60_000));
    const runs = await rosterRuns();
    expect(runs.map((r) => r.outcome).slice(before)).toEqual(["failed", "ok"]);
    expect((await takeInValue()).addressesReadAt).toBe(runs.at(-1)!.startedAt.toISOString());
  });

  it("after a shape save, is one made under the saved shape: the take-in then gives the newly named type's people their details", async () => {
    // Books with no parent type at first: the cache keeps no Parent customer's email or phone.
    await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    const { ana } = await seedAnaRivera();
    await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after: new Date(Date.now() - 60_000).toISOString() } });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect((await takeInValue()).addressesReadAt).toBeDefined();
    // An Admin names the Parent type: the save keeps no Parent customer's details yet, so the mark goes with it.
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    expect((await takeInValue()).addressesReadAt).toBeUndefined();
    expect(await takeInContactDetails()).toEqual({ ran: false });
    expect(await personDetails(ana.id)).toEqual({ values: NO_DETAILS, version: 0 });
    // The read under the saved shape keeps Ana's record's phone, and the take-in gives it to her.
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 1, peopleWithNoRecord: 0 } });
    expect(await personDetails(ana.id)).toEqual({ values: { ...NO_DETAILS, phone: "555-0101" }, version: 1 });
  });

  it("a shape save that commits after the take-in looked, or between its read and its write, makes it wait: it never marks itself done by the withdrawn note", async () => {
    await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    const { ana } = await seedAnaRivera();
    await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after: new Date(Date.now() - 60_000).toISOString() } });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    // The plan is made under the old shape, then an Admin names the Parent type before the write.
    const planned = await planContactTakeIn();
    expect(planned).not.toBeNull();
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    expect(await writeContactTakeIn(planned!)).toEqual({ ran: false });
    expect((await takeInValue()).doneAt).toBeUndefined();
    expect(await takeIns()).toEqual([]);
    // A plan asked for after the save (as one queued behind its lock) reads the note again under the lock: none.
    expect(await planContactTakeIn()).toBeNull();
    // The read under the saved shape lets it run, and gives Ana her record's phone.
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 1, peopleWithNoRecord: 0 } });
    expect(await personDetails(ana.id)).toEqual({ values: { ...NO_DETAILS, phone: "555-0101" }, version: 1 });
  });
});
