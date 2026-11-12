import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { emailChangeNoticeMessage } from "@/lib/mail/messages";
import { endParentSessions, deleteUnusedSigninCodes, lockEmail } from "./sessions";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };

/** No codes, every session ends. Guardian rows keep their status, so unblocking restores the same access. */
export async function blockPerson(parentId: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: true, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor: o.actor, action: "parent.block", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked }, after: { blocked: true, sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

export async function unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: false, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await writeAudit({ actor: o.actor, action: "parent.unblock", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked }, after: { blocked: false }, ip: o.ip }, tx);
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
