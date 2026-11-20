import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// The take-in reads the roster cache and asks QuickBooks nothing: the stub is only what a connection row needs, and
// would see any request that was sent.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, qboCustomer, setting } from "@/lib/db/schema";
import { TAKE_IN_KEY, takeInContactDetails } from "@/lib/parents/contact-take-in";
import type { ContactValues } from "@/lib/parents/contact-fields";
import { NO_DETAILS, familyDetails, personDetails, setPersonDetails } from "../helpers/contact";
import { resetDb, seedGuardian } from "../helpers/db";
import { FAMILY_A, FAMILY_B, MONEY_REALM, seedParentIn, seedSignedInParent } from "../helpers/parent";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, fam, par, seedRosterRead, seedShape, storeShape, stu } from "../helpers/roster-cache";
import { syncAppRecords } from "../helpers/app-records";
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
 * The database as migration 0044 leaves it, with the take-in waiting: every person's phone cleared, and the take-in's
 * time a minute ago. `read` then records a successful roster read that started after it (or `readAt`).
 */
async function asMigrated(o: { read?: boolean; readAt?: Date } = {}) {
  await db.update(parent).set({ phone: null });
  await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after: new Date(Date.now() - 60_000).toISOString() } });
  if (o.read ?? true) await seedRosterRead({ finishedAt: o.readAt });
}
const takeIns = async () => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((a) => a.action === "parent.details.taken_in");
const takeInSetting = async () => (await db.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY)))[0]!.value as { after: string; doneAt?: string };
/** A second family for this person, with their own record in it, which the cache holds as `o` says. */
async function secondFamily(parentId: string, email: string, o: { phone?: string | null; address?: Address | null }) {
  await addToCache([fam("CEDAR-FAM", "Cedarholm Family"), par("CEDAR-P1", "Ansgar Alderquist", "CEDAR-FAM", email), stu("CEDAR-S1", "Cosima Cedarholm", "CEDAR-FAM")]);
  await seedGuardian({ parentId, familyQboId: "CEDAR-FAM", status: "active", sourceQboId: "CEDAR-P1" });
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

  it("takes both when the person's two records agree, and a record with none does not count against the other", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await cacheHolds(FAMILY_A.parent.qboId, { address: ADDRESS });
    await secondFamily(a.identity.parentId, FAMILY_A.parent.email, { phone: FAMILY_A.parent.phone, address: null });
    await asMigrated();
    expect(await takeInContactDetails()).toMatchObject({ ran: true, counts: { peopleGivenPhone: 1, peopleGivenAddress: 1, peopleDisagreeing: 0 } });
    expect(await personDetails(a.identity.parentId)).toEqual({ values: { phone: FAMILY_A.parent.phone, ...ADDRESS }, version: 1 });
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
    await seedRosterRead();
    expect(await takeInContactDetails()).toMatchObject({ ran: true });
    expect((await personDetails(a.identity.parentId)).version).toBe(1);
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
