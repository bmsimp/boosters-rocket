import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { emailChangeNoticeMessage } from "@/lib/mail/messages";
import { getParentSettings } from "./settings";
import { endParentSessions, deleteUnusedSigninCodes, lockEmail } from "./sessions";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };

/** No codes, every session ends. Family links keep their status, so unblocking restores the same access. The reason is for staff only. */
export async function blockPerson(parentId: string, rawReason: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" | "invalid" }> {
  const reason = rawReason.trim();
  if (!reason || reason.length > 500) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: true, blockedAt: new Date(), blockedBy: o.actor.id, blockedReason: reason, welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor: o.actor, action: "parent.block", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked, reason: p.blockedReason }, after: { blocked: true, reason, sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

/** Puts back what blocking cleared: a person never welcomed, with an open link, is owed the welcome again when welcomes are on. */
export async function unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (!p.blocked) return { ok: true as const };
    const open = (await tx.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, p.id), ne(guardian.status, "disabled"))).limit(1)).length > 0;
    const owed = !p.welcomedAt && open && (await getParentSettings(tx)).welcome;
    await tx.update(parent).set({ blocked: false, blockedAt: null, blockedBy: null, blockedReason: null, ...(owed ? { welcomeOwed: true } : {}), updatedAt: new Date() }).where(eq(parent.id, p.id));
    await writeAudit({ actor: o.actor, action: "parent.unblock", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked, reason: p.blockedReason }, after: { blocked: false, ...(owed ? { welcomeOwed: true } : {}) }, ip: o.ip }, tx);
    return { ok: true as const };
  });
}

/** Staff change a parent's email directly (spec §2). Audited; the old address gets a notice; every session ends. */
export async function changeParentEmailByStaff(parentId: string, rawEmail: string, o: StaffOp):
  Promise<{ ok: true; changed: boolean } | { ok: false; reason: "invalid" | "not_found" } | { ok: false; reason: "in_use"; heldBy: { parentId: string; name: string } }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid" };
  const r = await db.transaction(async (tx) => {
    await lockEmail(tx, email);
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (p.email === email) return { ok: true as const, changed: false, oldEmail: p.email };
    const [other] = await tx.select().from(parent).where(and(eq(parent.email, email), ne(parent.id, p.id)));
    if (other) return { ok: false as const, reason: "in_use" as const, heldBy: { parentId: other.id, name: other.name } };
    await tx.update(parent).set({ email, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await tx.update(parentAuthUser).set({ email, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor: o.actor, action: "parent.email_change", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { email: p.email }, after: { email, by: "staff", sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, changed: true, oldEmail: p.email };
  });
  if (!r.ok) return r;
  if (r.changed) await sendMail(emailChangeNoticeMessage(await currentBrand(), r.oldEmail, { byStaff: true }), { purpose: "email_change_notice", actor: o.actor, ip: o.ip });
  return { ok: true, changed: r.changed };
}
