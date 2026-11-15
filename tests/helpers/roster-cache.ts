import { db } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { SHAPE_KEY, type MembershipShape } from "@/lib/roster/shape";
import { DEFAULT_PARENT_SETTINGS, PARENTS_KEY, getParentSettings, type ParentSettings } from "@/lib/parents/settings";

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

/** Adds rows to the roster cache and keeps what is there (tests/helpers/parent.ts seeds one family at a time with it). */
export async function addToCache(customers: CacheCustomer[], types = P_TYPES): Promise<void> {
  await db.insert(qboCustomerType).values(types.map((t) => ({ ...t, active: true }))).onConflictDoNothing();
  if (customers.length) await db.insert(qboCustomer).values(customers.map((c) => ({
    qboId: c.qboId, displayName: c.displayName, active: c.active ?? true, parentQboId: c.parentQboId ?? null, typeQboId: c.typeQboId,
    email: c.email ?? null, phone: c.phone ?? null, syncToken: "0" })));
}

export async function seedShape(shape: MembershipShape = P_SHAPE): Promise<void> {
  await db.insert(setting).values({ key: SHAPE_KEY, value: shape }).onConflictDoUpdate({ target: setting.key, set: { value: shape } });
}

export async function seedParentSettings(patch: Partial<ParentSettings>): Promise<void> {
  const value = { ...DEFAULT_PARENT_SETTINGS, ...(await getParentSettings()), ...patch };
  await db.insert(setting).values({ key: PARENTS_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
}
export const SIGNINS_ON = { signin: true, everEnabled: true } as const;
