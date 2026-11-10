import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthSession } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { enabledGuardianRows, parentActor } from "./sessions";

/**
 * After a correct code: the person's invited rows become active (spec §2 Status changes), and with exactly one enabled
 * family that family is entered now and the sign-in is audited with it. With two or more, the sign-in is audited when
 * the parent chooses (chooseFamily).
 */
export async function completeParentSignin(parentId: string, ip: string | null): Promise<{ familyQboId: string | null }> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return { familyQboId: null };
  const actor = parentActor(p);
  const activated = await db.update(guardian).set({ status: "active", updatedAt: new Date() })
    .where(and(eq(guardian.parentId, parentId), eq(guardian.status, "invited"))).returning({ id: guardian.id, familyQboId: guardian.familyQboId });
  for (const g of activated) {
    await writeAudit({ actor, action: "guardian.activate", targetType: "guardian", targetId: g.id, before: { status: "invited" }, after: { status: "active" }, ip });
  }
  const rows = await enabledGuardianRows(parentId);
  if (rows.length !== 1) return { familyQboId: null };
  await writeAudit({ actor, action: "signin", targetType: "parent", targetId: parentId, after: { familyQboId: rows[0]!.familyQboId }, ip });
  return { familyQboId: rows[0]!.familyQboId };
}

/** The chooser and **Switch family**. Refuses (and audits) a family that isn't one of the person's enabled rows. */
export async function chooseFamily(o: { sessionId: string; parentId: string; familyQboId: string; ip: string | null }): Promise<boolean> {
  const [p] = await db.select().from(parent).where(eq(parent.id, o.parentId));
  if (!p) return false;
  const actor = parentActor(p);
  const row = (await enabledGuardianRows(o.parentId)).find((r) => r.familyQboId === o.familyQboId);
  if (!row || p.blocked) {
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after: { reason: "family_not_enabled", familyQboId: o.familyQboId }, ip: o.ip });
    return false;
  }
  const [s] = await db.select({ familyQboId: parentAuthSession.familyQboId }).from(parentAuthSession).where(eq(parentAuthSession.id, o.sessionId));
  if (!s) return false;
  if (s.familyQboId === o.familyQboId) return true;
  await db.update(parentAuthSession).set({ familyQboId: o.familyQboId, updatedAt: new Date() }).where(eq(parentAuthSession.id, o.sessionId));
  await writeAudit(s.familyQboId === null
    ? { actor, action: "signin", targetType: "parent", targetId: p.id, after: { familyQboId: o.familyQboId }, ip: o.ip }
    : { actor, action: "signin.family_switch", targetType: "parent", targetId: p.id, after: { from: s.familyQboId, to: o.familyQboId }, ip: o.ip });
  return true;
}
