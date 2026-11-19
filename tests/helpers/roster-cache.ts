import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { SHAPE_KEY, type MembershipShape } from "@/lib/roster/shape";
import { ROSTER_JOB, SOURCE_KEY } from "@/lib/roster/source";
import { DEFAULT_PARENT_SETTINGS, PARENTS_KEY, getParentSettings, type ParentSettings } from "@/lib/parents/settings";
import { syncAppRecords } from "./app-records";

export type CacheCustomer = { qboId: string; displayName: string; typeQboId: string; active?: boolean; parentQboId?: string | null; email?: string | null; phone?: string | null };
export const P_SHAPE: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" };
export const P_TYPES = [{ qboId: "F", name: "Family" }, { qboId: "S", name: "Student" }, { qboId: "P", name: "Parent" }, { qboId: "M", name: "Member" }];

export const fam = (qboId: string, displayName: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "F", ...o });
export const par = (qboId: string, displayName: string, family: string, email: string | null, o: Partial<CacheCustomer> = {}): CacheCustomer =>
  ({ qboId, displayName, typeQboId: "P", parentQboId: family, email, ...o });
export const stu = (qboId: string, displayName: string, family: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "S", parentQboId: family, ...o });

/** Replaces the roster cache with these rows, as a refresh would have left it. */
export async function seedCache(customers: CacheCustomer[], types = P_TYPES): Promise<void> {
  await db.delete(qboCustomer); await db.delete(qboCustomerType);
  await addToCache(customers, types);
}

/**
 * Adds rows to the roster cache and keeps what is there (tests/helpers/parent.ts seeds one family at a time with it).
 * The app's own records are imported from the cache afterward (syncAppRecords(), tests/helpers/app-records.ts), as
 * migration 0023 made them for a club's roster: while the cache names no company that makes none. Since stage 3's slice
 * 9c no roster read does this in the portal: a test of what a read changes reads the stub (refreshRoster()).
 */
export async function addToCache(customers: CacheCustomer[], types = P_TYPES): Promise<void> {
  await db.insert(qboCustomerType).values(types.map((t) => ({ ...t, active: true }))).onConflictDoNothing();
  if (customers.length) await db.insert(qboCustomer).values(customers.map((c) => ({
    qboId: c.qboId, displayName: c.displayName, active: c.active ?? true, parentQboId: c.parentQboId ?? null, typeQboId: c.typeQboId,
    email: c.email ?? null, phone: c.phone ?? null, syncToken: "0" })));
  await syncAppRecords();
}

/**
 * Moves students to another family both in the cache and in the app's own records, as a move staff made from the
 * portal leaves them once QuickBooks took it (the student's record is in the new family, by the import's rules): a test
 * that means "the student is now in the other family". It follows nothing of the student's forms or places: a test
 * that wants those calls the follow-ups itself (afterStudentMoved()). For a move made in QuickBooks alone, which since
 * stage 3's slice 9c changes no record, use moveInQuickBooksOnly().
 */
export async function moveInCache(studentQboIds: string[], toFamilyQboId: string): Promise<void> {
  await db.update(qboCustomer).set({ parentQboId: toFamilyQboId }).where(inArray(qboCustomer.qboId, studentQboIds));
  await syncAppRecords();
}

/**
 * Moves students to another family in the roster cache alone, as a roster read leaves a move someone made in
 * QuickBooks: the app's own records, and so the student's forms, places and buy-outs, stay where they were.
 */
export async function moveInQuickBooksOnly(studentQboIds: string[], toFamilyQboId: string): Promise<void> {
  await db.update(qboCustomer).set({ parentQboId: toFamilyQboId }).where(inArray(qboCustomer.qboId, studentQboIds));
}
/** Every student the cache holds under one family, moved to another (moveInCache()). */
export async function moveFamilyInCache(fromFamilyQboId: string, toFamilyQboId: string): Promise<void> {
  const under = await db.select({ qboId: qboCustomer.qboId }).from(qboCustomer).where(eq(qboCustomer.parentQboId, fromFamilyQboId));
  await moveInCache(under.map((c) => c.qboId), toFamilyQboId);
}

/**
 * Stores the membership shape as an Admin would have saved it, and imports the app's own records from the cache by it
 * (syncAppRecords()), as migration 0023 made them for a club with that shape. saveShape() itself changes no record since
 * stage 3's slice 9c; storeShape() stores the shape alone.
 */
export async function seedShape(shape: MembershipShape = P_SHAPE): Promise<void> {
  await db.insert(setting).values({ key: SHAPE_KEY, value: shape }).onConflictDoUpdate({ target: setting.key, set: { value: shape } });
  await syncAppRecords();
}

/**
 * Stores the shape setting alone, bringing nothing into step: for a test of the door that seeds its families by hand
 * with no roster company (seedGuardianInFamily()), where "Families with no active student" still needs a shape that
 * names students to be switched on (setRequireStudents()).
 */
export async function storeShape(shape: MembershipShape = P_SHAPE): Promise<void> {
  await db.insert(setting).values({ key: SHAPE_KEY, value: shape }).onConflictDoUpdate({ target: setting.key, set: { value: shape } });
}

export async function seedParentSettings(patch: Partial<ParentSettings>): Promise<void> {
  const value = { ...DEFAULT_PARENT_SETTINGS, ...(await getParentSettings()), ...patch };
  await db.insert(setting).values({ key: PARENTS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
}
/** Parent sign-ins switched on: the parent door is closed until they are (parentDoorClosed()). */
export const SIGNINS_ON = { signin: true } as const;

/**
 * What a successful refresh leaves beside the cache: the company it was read from (leave `realmId` out for a cache
 * that doesn't say) and a finished roster run, which is the roster's "as of" time. The app's own records are brought
 * into step with it, as the read would have left them.
 */
export async function seedRosterRead(o: { realmId?: string; finishedAt?: Date } = {}): Promise<Date> {
  const finishedAt = o.finishedAt ?? new Date();
  if (o.realmId) {
    const value = { realmId: o.realmId };
    await db.insert(setting).values({ key: SOURCE_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
  }
  await db.insert(jobRun).values({ job: ROSTER_JOB, startedAt: finishedAt, finishedAt, outcome: "ok", detail: "seeded", startedBy: "worker" });
  await syncAppRecords();
  return finishedAt;
}
