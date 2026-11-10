import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { emailChangeConfirmMessage, emailChangeNoticeMessage } from "@/lib/mail/messages";
import { endParentSessions, deleteUnusedSigninCodes, parentActor, lockEmail } from "./sessions";

export const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;
export const PARENT_EMAIL_IN_USE = "That address is already in use. Ask the club to help.";

export type PrimaryEmailHook = (o: { parentId: string; email: string; familyQboIds: string[] }) => Promise<void>;
let primaryEmailHook: PrimaryEmailHook = async () => {};
/**
 * The QuickBooks seam (v1 §6.2 step 3). The roster/QuickBooks plan sets this to update the primary email on each of these
 * families' QuickBooks customers, putting a failed write on the write queue. Until then it does nothing.
 */
export function setPrimaryGuardianEmailHook(h: PrimaryEmailHook): void { primaryEmailHook = h; }

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const emailChangeLink = (token: string) => `${env.APP_URL.replace(/\/+$/, "")}/email-change/confirm?token=${token}`;

/** Step 1 and 2 of a parent's own change: a single-use, hashed, expiring link to the new address, and a notice to the old one. */
export async function requestParentEmailChange(parentId: string, rawEmail: string, o: { ip: string | null }):
  Promise<{ ok: true } | { ok: false; reason: "invalid" | "same" | "not_found" | "in_use" }> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, reason: "invalid" };
  const token = randomBytes(32).toString("base64url");
  const r = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (p.email === email) return { ok: false as const, reason: "same" as const };
    const actor = parentActor(p);
    const [other] = await tx.select({ id: parent.id }).from(parent).where(and(eq(parent.email, email), ne(parent.id, p.id)));
    if (other) {
      await writeAudit({ actor, action: "parent.email_change_refused", targetType: "parent", targetId: p.id, after: { email, reason: "in_use" }, ip: o.ip }, tx);
      return { ok: false as const, reason: "in_use" as const };
    }
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    await tx.insert(parentEmailChange).values({ parentId: p.id, newEmail: email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS) });
    await writeAudit({ actor, action: "parent.email_change_request", targetType: "parent", targetId: p.id, after: { email }, ip: o.ip }, tx);
    return { ok: true as const, actor, oldEmail: p.email };
  });
  if (!r.ok) return r;
  const brand = await currentBrand();
  await sendMail(emailChangeConfirmMessage(brand, email, { link: emailChangeLink(token) }), { purpose: "email_change_confirm", actor: r.actor, ip: o.ip });
  await sendMail(emailChangeNoticeMessage(brand, r.oldEmail, { byStaff: false }), { purpose: "email_change_notice", actor: r.actor, ip: o.ip });
  return { ok: true };
}

/** Step 3: the new address works for sign-in as soon as this commits; QuickBooks follows through the hook. */
export async function confirmParentEmailChange(token: string, o: { ip: string | null }): Promise<{ ok: true; parentId: string } | { ok: false; reason: "invalid" | "in_use" }> {
  const r = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(parentEmailChange)
      .where(and(eq(parentEmailChange.tokenHash, hashToken(token)), isNull(parentEmailChange.usedAt))).for("update");
    if (!row || row.expiresAt.getTime() <= Date.now()) return { ok: false as const, reason: "invalid" as const };
    await lockEmail(tx, row.newEmail);
    const [p] = await tx.select().from(parent).where(eq(parent.id, row.parentId)).for("update");
    if (!p) return { ok: false as const, reason: "invalid" as const };
    const actor = parentActor(p);
    await tx.update(parentEmailChange).set({ usedAt: new Date() }).where(eq(parentEmailChange.id, row.id));
    const [other] = await tx.select({ id: parent.id }).from(parent).where(and(eq(parent.email, row.newEmail), ne(parent.id, p.id)));
    if (other) {
      await writeAudit({ actor, action: "parent.email_change_refused", targetType: "parent", targetId: p.id, after: { email: row.newEmail, reason: "in_use" }, ip: o.ip }, tx);
      return { ok: false as const, reason: "in_use" as const };
    }
    await tx.update(parent).set({ email: row.newEmail, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await tx.update(parentAuthUser).set({ email: row.newEmail, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, p.id));
    await deleteUnusedSigninCodes(p.id, tx);
    const sessionsEnded = await endParentSessions(p.id, tx);
    await writeAudit({ actor, action: "parent.email_change", targetType: "parent", targetId: p.id,
      before: { email: p.email }, after: { email: row.newEmail, by: "parent", sessionsEnded }, ip: o.ip }, tx);
    const primaries = await tx.select({ f: guardian.familyQboId }).from(guardian)
      .where(and(eq(guardian.parentId, p.id), eq(guardian.isPrimary, true), ne(guardian.status, "disabled"))).orderBy(guardian.familyQboId);
    return { ok: true as const, parentId: p.id, email: row.newEmail, familyQboIds: primaries.map((x) => x.f), actor };
  });
  if (!r.ok) return r;
  if (r.familyQboIds.length) {
    try {
      await primaryEmailHook({ parentId: r.parentId, email: r.email, familyQboIds: r.familyQboIds });
    } catch {
      // The hook owns retries (the write queue); a failure here must not undo the change, which already took effect.
      await writeAudit({ actor: r.actor, action: "parent.email_change.quickbooks_failed", targetType: "parent", targetId: r.parentId,
        after: { familyQboIds: r.familyQboIds }, ip: o.ip });
    }
  }
  return { ok: true, parentId: r.parentId };
}
