import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffUser, staffAuthUser, staffAuthAccount, parentAuthUser, parent, parentAuthSession } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { endParentSessions, enterableGuardianRows, parentActor } from "@/lib/parents/sessions";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { hasSecondFactor } from "@/lib/parents/passkeys";
import { sessionStanding } from "@/lib/parents/enrolment-rule";
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
/**
 * What the gate makes of a parent session: a family chosen (`ok`), a family still to choose (`choose`), Strict's
 * enrolment (`enrol`, since the sign-in release's slice SI-10a: a session a password alone made under Strict for a person
 * with no second factor, which reaches /one-more-step and nothing else; it carries no name and no family, whatever
 * family the session holds), or nobody (`none`).
 */
export type ParentSessionState =
  | { status: "ok"; identity: ParentIdentity }
  | { status: "choose"; parentId: string; sessionId: string; name: string; families: ParentFamily[] }
  | { status: "enrol"; parentId: string; sessionId: string; email: string }
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
 * The session stores the app's own family record it chose (`parent_auth_session.family_id`, since stage 3's fifth
 * slice), which is matched here to the person's own rows that count by each row's `family_id`, and the identity carries
 * that row and its family. No QuickBooks id takes part: nothing on the parent side turns one into a family.
 *
 * Since the sign-in release's slice SI-10a, after those checks and before the family, the session's standing
 * (sessionStanding(), src/lib/parents/enrolment-rule.ts): its `enrol_until` (read by its own id, the one column read on
 * every request) and, under Strict or with `enrol_until` set, whether the person has a second factor in force
 * (hasSecondFactor(); never read at Standard for a session with none). A session that has ended (an enrolment's window
 * passed, the club back at Standard or a factor added through another session, `enrol_ended`; or under Strict a session
 * of a person with no factor that is not enrolling, `strict_no_factor`, however it was made) is ended alone, not every
 * session of the person (a second enrolling browser must not sign the first out), with `signin.refused` and its reason
 * in the same transaction; an enrolling one answers `enrol`, whatever family it holds.
 */
export async function resolveParentSession(s: { id: string; userId: string; familyId: AppFamilyId | null }, ip: string | null = null,
  now = new Date()): Promise<ParentSessionState> {
  const [row] = await db.select({ p: parent }).from(parentAuthUser).innerJoin(parent, eq(parent.id, parentAuthUser.parentId)).where(eq(parentAuthUser.id, s.userId));
  if (!row) return { status: "none" };
  const p = row.p;
  const actor = parentActor(p);
  const settings = await getParentSettings();
  // A code that passed just before an Admin switched sign-ins off can still have made a session: it ends here.
  if (parentDoorClosed(settings)) {
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
  const [held] = await db.select({ enrolUntil: sql<Date | null>`${parentAuthSession.enrolUntil}`.mapWith(parentAuthSession.enrolUntil) }).from(parentAuthSession)
    .where(and(eq(parentAuthSession.id, s.id), eq(parentAuthSession.userId, s.userId)));
  const enrolUntil = held?.enrolUntil ?? null;
  if (settings.level === "strict" || enrolUntil !== null) {
    const standing = sessionStanding({ level: settings.level, enrolUntil, hasSecondFactor: await hasSecondFactor(p.id), now });
    if (standing.standing === "ended") {
      await db.transaction(async (tx) => {
        await tx.delete(parentAuthSession).where(eq(parentAuthSession.id, s.id));
        await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: standing.reason }, ip }, tx);
      });
      return { status: "none" };
    }
    if (standing.standing === "enrolling") return { status: "enrol", parentId: p.id, sessionId: s.id, email: p.email };
  }
  const families = rows.map((r) => ({ guardianId: r.id, familyId: r.familyId }));
  const chosen = s.familyId ? rows.find((r) => r.familyId === s.familyId) : undefined;
  if (!chosen) {
    if (s.familyId) {
      await db.update(parentAuthSession).set({ familyId: null, updatedAt: new Date() }).where(eq(parentAuthSession.id, s.id));
      await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "family_not_enabled", familyId: String(s.familyId) }, ip });
    }
    return { status: "choose", parentId: p.id, sessionId: s.id, name: p.name, families };
  }
  return { status: "ok", identity: { door: "parent", parentId: p.id, sessionId: s.id, guardianId: chosen.id, familyId: chosen.familyId, name: p.name, email: p.email, families } };
}
