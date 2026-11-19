import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthSession } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { enabledGuardianRows, parentActor } from "./sessions";

/**
 * After a correct code: the person's invited rows become active (spec §2 Status changes), and with exactly one enabled
 * family that family is entered now and the sign-in is audited with it. With two or more, the sign-in is audited when
 * the parent chooses (chooseFamily).
 *
 * `sessionId` is the session just made for this sign-in (parent-code-plugin.ts): the family is entered on it. If that
 * session has been ended in the meantime (a block, a change of address, the person's last link closing), nobody
 * signed in: nothing is activated or audited as a sign-in, and `sessionEnded` says so.
 */
export async function completeParentSignin(parentId: string, ip: string | null, sessionId?: string): Promise<{ familyQboId: string | null; sessionEnded?: true }> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return { familyQboId: null };
  const actor = parentActor(p);
  const ENDED = { familyQboId: null, sessionEnded: true } as const;
  const sessionLives = async (q: Pick<typeof db, "select">) =>
    !sessionId || (await q.select({ id: parentAuthSession.id }).from(parentAuthSession).where(eq(parentAuthSession.id, sessionId))).length > 0;
  // The person's rows are locked in id order first, the order the reconcile locks every row in, so the two never deadlock.
  const activated = await db.transaction(async (tx) => {
    const mine = await tx.select({ id: guardian.id, status: guardian.status }).from(guardian).where(eq(guardian.parentId, parentId)).orderBy(guardian.id).for("update");
    // A reconcile that held these rows has finished by now, and whatever it ended is ended.
    if (!(await sessionLives(tx))) return false;
    const invited = mine.filter((g) => g.status === "invited").map((g) => g.id);
    if (!invited.length) return true;
    await tx.update(guardian).set({ status: "active", updatedAt: new Date() }).where(inArray(guardian.id, invited));
    for (const id of invited) {
      await writeAudit({ actor, action: "guardian.activate", targetType: "guardian", targetId: id, before: { status: "invited" }, after: { status: "active" }, ip }, tx);
    }
    return true;
  });
  if (!activated) return ENDED;
  const rows = await enabledGuardianRows(parentId);
  if (rows.length !== 1) return (await sessionLives(db)) ? { familyQboId: null } : ENDED;
  const familyQboId = rows[0]!.familyQboId;
  const entered = await db.transaction(async (tx) => {
    if (sessionId) {
      const session = await tx.update(parentAuthSession).set({ familyQboId, updatedAt: new Date() }).where(eq(parentAuthSession.id, sessionId)).returning({ id: parentAuthSession.id });
      if (!session.length) return false;
    }
    await writeAudit({ actor, action: "signin", targetType: "parent", targetId: parentId, after: { familyQboId }, ip }, tx);
    return true;
  });
  return entered ? { familyQboId } : ENDED;
}

/**
 * The chooser and **Switch family**, given one of the person's own guardian rows by its id: the chooser binds the row,
 * never a family's QuickBooks id. Refuses (and audits, with the id sent) a row that isn't one of the person's own
 * enabled rows, the same way whatever the reason. `guardianId: null` is an argument the caller couldn't use as a row's
 * id: refused the same way, and not recorded. The session is then given that row's family, as the sign-in gives it.
 */
export async function chooseFamily(o: { sessionId: string; parentId: string; guardianId: string | null; ip: string | null }): Promise<boolean> {
  const [p] = await db.select().from(parent).where(eq(parent.id, o.parentId));
  if (!p) return false;
  const actor = parentActor(p);
  const row = o.guardianId === null ? undefined : (await enabledGuardianRows(o.parentId)).find((r) => r.id === o.guardianId);
  if (!row || p.blocked) {
    const after = o.guardianId === null ? { reason: "family_not_enabled" } : { reason: "family_not_enabled", guardianId: o.guardianId };
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: p.id, after, ip: o.ip });
    return false;
  }
  const familyQboId = row.familyQboId;
  const [s] = await db.select({ familyQboId: parentAuthSession.familyQboId }).from(parentAuthSession).where(eq(parentAuthSession.id, o.sessionId));
  if (!s) return false;
  if (s.familyQboId === familyQboId) return true;
  await db.update(parentAuthSession).set({ familyQboId, updatedAt: new Date() }).where(eq(parentAuthSession.id, o.sessionId));
  await writeAudit(s.familyQboId === null
    ? { actor, action: "signin", targetType: "parent", targetId: p.id, after: { familyQboId }, ip: o.ip }
    : { actor, action: "signin.family_switch", targetType: "parent", targetId: p.id, after: { from: s.familyQboId, to: familyQboId }, ip: o.ip });
  return true;
}
