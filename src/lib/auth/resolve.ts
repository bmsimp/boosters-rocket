import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffUser, staffAuthUser, staffAuthAccount, guardian, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";

export type StaffIdentity = { door: "staff"; staffUserId: string; name: string; email: string };
export type ParentIdentity = { door: "parent"; guardianId: string; familyQboId: string; name: string };

/** Hook for the first-admin claim (Task 7). Returns a newly created admin staff user id, or null. */
export type BootstrapHook = (email: string) => Promise<string | null>;
let bootstrapHook: BootstrapHook = async () => null;
export function setBootstrapHook(h: BootstrapHook) { bootstrapHook = h; }

const norm = (e: string) => e.trim().toLowerCase();

export async function resolveStaff(authUserId: string): Promise<StaffIdentity | null> {
  const bound = await db.select().from(staffUser).where(eq(staffUser.authUserId, authUserId));
  if (bound[0]) return bound[0].status === "active" ? toStaff(bound[0]) : null;

  const [au] = await db.select().from(staffAuthUser).where(eq(staffAuthUser.id, authUserId));
  if (!au) return null;
  const accounts = await db.select().from(staffAuthAccount).where(eq(staffAuthAccount.userId, authUserId));
  // Microsoft is single-tenant (club directory), so its email is trusted; Google must say verified.
  const trusted = au.emailVerified || accounts.some((a) => a.providerId === "microsoft");
  if (!trusted) return null;
  const email = norm(au.email);

  const [invite] = await db.select().from(staffUser).where(and(
    eq(staffUser.email, email), isNull(staffUser.authUserId), inArray(staffUser.status, ["invited", "active"])));
  if (invite) {
    const [row] = await db.update(staffUser).set({ authUserId, status: "active", updatedAt: new Date() })
      .where(and(eq(staffUser.id, invite.id), isNull(staffUser.authUserId))).returning();
    return row ? toStaff(row) : null;
  }

  const createdId = await bootstrapHook(email);
  if (!createdId) {
    await writeAudit({ actor: { door: "staff", id: null, label: email }, action: "signin.refused", targetType: "staff_auth_user", targetId: authUserId });
    return null;
  }
  const [row] = await db.update(staffUser).set({ authUserId, updatedAt: new Date() })
    .where(eq(staffUser.id, createdId)).returning();
  return row ? toStaff(row) : null;
}

function toStaff(s: typeof staffUser.$inferSelect): StaffIdentity {
  return { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
}

export async function resolveGuardian(authUserId: string): Promise<ParentIdentity | null> {
  const [au] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, authUserId));
  if (!au) return null;
  const [g] = au.objectId ? await db.select().from(guardian).where(eq(guardian.identityObjectId, au.objectId)) : [];
  if (!g || g.status === "disabled") {
    await writeAudit({ actor: { door: "parent", id: null, label: au.email }, action: "signin.refused", targetType: "parent_auth_user", targetId: authUserId });
    return null;
  }
  if (g.status === "invited") await db.update(guardian).set({ status: "active", updatedAt: new Date() }).where(eq(guardian.id, g.id));
  return { door: "parent", guardianId: g.id, familyQboId: g.familyQboId, name: g.name };
}
