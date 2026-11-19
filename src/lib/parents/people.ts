import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getParentSettings } from "./settings";
import { endParentSessions, deleteUnusedSigninCodes, enterableGuardianRows } from "./sessions";
import { formsForGoneSigner } from "@/lib/forms/signer-gone";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };

/**
 * No codes, every session ends. Family links keep their status, so unblocking restores the same access. The reason is
 * for staff only. Every unfinished form still waiting for this person's signature is reset and its document withdrawn,
 * so a signing link the portal handed them earlier can't sign for a family any more (src/lib/forms/signer-gone.ts).
 */
export async function blockPerson(parentId: string, rawReason: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" | "invalid" }> {
  const reason = rawReason.trim();
  if (!reason || reason.length > 500) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: true, blockedAt: new Date(), blockedBy: o.actor.id, blockedReason: reason, welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.id, p.id));
    // What hangs on the person, in the order ./sessions.ts gives (lockedPerson()): requests, then codes, then sessions.
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    await deleteUnusedSigninCodes(p.id, tx);
    const sessionsEnded = await endParentSessions(p.id, tx);
    const formsReset = await formsForGoneSigner(tx, { parentId: p.id, family: "every family", reason: "blocked", actor: o.actor, ip: o.ip });
    await writeAudit({ actor: o.actor, action: "parent.block", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked, reason: p.blockedReason }, after: { blocked: true, reason, sessionsEnded, formsReset }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

/**
 * Puts back what blocking cleared: a person never welcomed, who can sign in by the gate's rule (a guardian row that
 * counts, ./sessions.ts), is owed the welcome again when welcomes are on.
 */
export async function unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (!p.blocked) return { ok: true as const, changed: false };
    const open = (await enterableGuardianRows(p.id, tx)).length > 0;
    const owed = !p.welcomedAt && open && (await getParentSettings(tx)).welcome;
    await tx.update(parent).set({ blocked: false, blockedAt: null, blockedBy: null, blockedReason: null, ...(owed ? { welcomeOwed: true } : {}), updatedAt: new Date() }).where(eq(parent.id, p.id));
    await writeAudit({ actor: o.actor, action: "parent.unblock", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked, reason: p.blockedReason }, after: { blocked: false, ...(owed ? { welcomeOwed: true } : {}) }, ip: o.ip }, tx);
    return { ok: true as const, changed: true };
  });
}

// Staff do not change a parent's address in the portal yet (the app-owned families spec's open question 8 is a later
// slice). A parent changes their own through src/lib/parents/email-change.ts.
