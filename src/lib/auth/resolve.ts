import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffUser, staffAuthUser, staffAuthAccount, parentAuthUser, parent, parentAuthSession } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { endParentSessions, enterableGuardianRows, parentActor } from "@/lib/parents/sessions";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import type { AppFamilyId } from "@/lib/families/ids";

export type StaffIdentity = { door: "staff"; staffUserId: string; name: string; email: string };
/** One family the person may enter: their open guardian row in it, and the app's own family record that row names. */
export type ParentFamily = { guardianId: string; familyId: AppFamilyId };
/**
 * A signed-in parent with a family chosen: `familyId` is the app's own family record, the only family every parent
 * read and write is for (AGENTS.md, Privacy). No QuickBooks id of the family is in it.
 */
export type ParentIdentity = {
  door: "parent"; parentId: string; sessionId: string; guardianId: string; familyId: AppFamilyId; name: string; email: string; families: ParentFamily[];
};
export type ParentSessionState =
  | { status: "ok"; identity: ParentIdentity }
  | { status: "choose"; parentId: string; sessionId: string; name: string; families: ParentFamily[] }
  | { status: "none" };

/** Hook for the first-admin claim (Task 7). Returns a newly created admin staff user id, or null. */
export type BootstrapHook = (email: string) => Promise<string | null>;
let bootstrapHook: BootstrapHook = async () => null;
export function setBootstrapHook(h: BootstrapHook) { bootstrapHook = h; }

const norm = (e: string) => e.trim().toLowerCase();

/** `ip` is the request's address, for the audit rows a first sign-in writes (v1 spec §13: who, what, when and from where). */
export async function resolveStaff(authUserId: string, ip: string | null = null): Promise<StaffIdentity | null> {
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
    if (!row) return null;
    await writeAudit({ actor: { door: "staff", id: row.id, label: row.email }, action: "staff.bind", targetType: "staff_user", targetId: row.id,
      before: { status: invite.status, authUserId: null }, after: { status: "active", authUserId }, ip });
    return toStaff(row);
  }

  const createdId = await bootstrapHook(email);
  if (!createdId) {
    await writeAudit({ actor: { door: "staff", id: null, label: email }, action: "signin.refused", targetType: "staff_auth_user", targetId: authUserId, ip });
    return null;
  }
  const [row] = await db.update(staffUser).set({ authUserId, updatedAt: new Date() })
    .where(eq(staffUser.id, createdId)).returning();
  return row ? toStaff(row) : null;
}

function toStaff(s: typeof staffUser.$inferSelect): StaffIdentity {
  return { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
}

/**
 * Spec §2 and invariant 1: every parent request re-checks the person and the chosen family. A blocked person, or one with
 * no row that counts, is signed out everywhere; a chosen family that doesn't count any more sends the parent back to
 * choose. A row counts when it is open and names an active app family record (enterableGuardianRows(); app-owned
 * families spec §6).
 *
 * This is the one place the session's family becomes the app's: the session still stores the family's QuickBooks id
 * (`parent_auth_session.family_qbo_id`, until stage 3's fifth slice moves the column), which is matched here to the
 * person's own rows by each row's `family_qbo_id`, and the identity carries that row's `family_id`. Nothing after the
 * gate sees the QuickBooks id.
 */
export async function resolveParentSession(s: { id: string; userId: string; familyQboId: string | null }, ip: string | null = null): Promise<ParentSessionState> {
  const [row] = await db.select({ p: parent }).from(parentAuthUser).innerJoin(parent, eq(parent.id, parentAuthUser.parentId)).where(eq(parentAuthUser.id, s.userId));
  if (!row) return { status: "none" };
  const p = row.p;
  const actor = parentActor(p);
  // A code that passed just before an Admin switched sign-ins off can still have made a session: it ends here.
  if (parentDoorClosed(await getParentSettings())) {
    await endParentSessions(p.id);
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "signins_off" }, ip });
    return { status: "none" };
  }
  const rows = p.blocked ? [] : await enterableGuardianRows(p.id);
  if (rows.length === 0) {
    await endParentSessions(p.id);
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: p.blocked ? "blocked" : "no_enabled_guardian" }, ip });
    return { status: "none" };
  }
  const families = rows.map((r) => ({ guardianId: r.id, familyId: r.familyId }));
  const chosen = s.familyQboId ? rows.find((r) => r.familyQboId === s.familyQboId) : undefined;
  if (!chosen) {
    if (s.familyQboId) {
      await db.update(parentAuthSession).set({ familyQboId: null, updatedAt: new Date() }).where(eq(parentAuthSession.id, s.id));
      await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "family_not_enabled", familyQboId: s.familyQboId }, ip });
    }
    return { status: "choose", parentId: p.id, sessionId: s.id, name: p.name, families };
  }
  return { status: "ok", identity: { door: "parent", parentId: p.id, sessionId: s.id, guardianId: chosen.id, familyId: chosen.familyId, name: p.name, email: p.email, families } };
}
