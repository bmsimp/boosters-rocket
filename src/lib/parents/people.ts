import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/setup/state";
import { env } from "@/env";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { welcomeMessage, emailChangeNoticeMessage } from "@/lib/mail/messages";
import { endParentSessions, enabledGuardianRows, deleteUnusedSigninCodes, lockEmail } from "./sessions";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };
export type GuardianInput = { familyQboId: string; familyLabel: string; name: string; email: string; phone?: string | null; isPrimary?: boolean };
export type AddGuardianResult =
  | { ok: true; outcome: "created" | "linked" | "reenabled"; parentId: string; guardianId: string; welcomeSent: boolean }
  | { ok: false; reason: "confirm_link"; parentId: string; name: string; familyQboIds: string[] }
  | { ok: false; reason: "blocked"; parentId: string; name: string }
  | { ok: false; reason: "already_in_family"; parentId: string; guardianId: string }
  | { ok: false; reason: "invalid"; errors: string[] };

const appUrl = () => env.APP_URL.replace(/\/+$/, "");

const inputSchema = z.object({
  familyQboId: z.string().trim().min(1, "Choose the family."),
  familyLabel: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1, "Enter the guardian's name.").max(120, "That name is too long."),
  email: z.string().transform((v, ctx) => {
    const e = normalizeEmail(v);
    if (!e) { ctx.addIssue({ code: "custom", message: "Enter a valid email address." }); return z.NEVER; }
    return e;
  }),
  phone: z.string().trim().max(40, "That phone number is too long.").nullish().transform((v) => (v ? v : null)),
  isPrimary: z.boolean().optional(),
});

async function welcome(parentId: string, guardianId: string, familyLabel: string | null, o: StaffOp): Promise<boolean> {
  const [p] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!p) return false;
  const r = await sendMail(welcomeMessage(await currentBrand(), p.email, { appUrl: appUrl(), familyLabel }), { purpose: "welcome", actor: o.actor, ip: o.ip });
  if (r.ok) await writeAudit({ actor: o.actor, action: "guardian.welcome_sent", permission: o.permission, targetType: "guardian", targetId: guardianId,
    after: { parentId, to: p.email }, ip: o.ip });
  return r.ok;
}

/**
 * Spec §2 Adding a guardian. A new email makes the person and an invited row. An existing person's email returns
 * `confirm_link` and writes nothing; the caller shows "This person is already a guardian in … Link them to this family
 * too?" and calls again with `confirmLinkParentId` set to that person's id. A removed row for the same family is
 * re-enabled instead of duplicated. The welcome email goes out after the change is committed.
 */
export async function createOrLinkGuardian(raw: GuardianInput, o: StaffOp & { confirmLinkParentId?: string }): Promise<AddGuardianResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid", errors: parsed.error.issues.map((i) => i.message) };
  const g = parsed.data;
  const base = { actor: o.actor, permission: o.permission, ip: o.ip };
  const r = await db.transaction(async (tx) => {
    await lockEmail(tx, g.email);
    const [existing] = await tx.select().from(parent).where(eq(parent.email, g.email));
    if (!existing) {
      const [p] = await tx.insert(parent).values({ name: g.name, email: g.email, phone: g.phone }).returning();
      await tx.insert(parentAuthUser).values({ id: randomUUID(), name: g.name, email: g.email, emailVerified: true, parentId: p!.id });
      const [row] = await tx.insert(guardian).values({ familyQboId: g.familyQboId, parentId: p!.id, isPrimary: g.isPrimary ?? false, status: "invited" }).returning();
      await writeAudit({ ...base, action: "parent.create", targetType: "parent", targetId: p!.id, after: { name: g.name, email: g.email, phone: g.phone } }, tx);
      await writeAudit({ ...base, action: "guardian.create", targetType: "guardian", targetId: row!.id,
        after: { parentId: p!.id, familyQboId: g.familyQboId, isPrimary: row!.isPrimary, status: "invited" } }, tx);
      return { ok: true as const, outcome: "created" as const, parentId: p!.id, guardianId: row!.id };
    }
    if (existing.blocked) return { ok: false as const, reason: "blocked" as const, parentId: existing.id, name: existing.name };
    const rows = await tx.select().from(guardian).where(eq(guardian.parentId, existing.id)).orderBy(guardian.familyQboId);
    const here = rows.find((x) => x.familyQboId === g.familyQboId);
    if (here && !(here.status === "disabled" && here.disabledReason === "removed")) {
      return { ok: false as const, reason: "already_in_family" as const, parentId: existing.id, guardianId: here.id };
    }
    if (o.confirmLinkParentId !== existing.id) {
      return { ok: false as const, reason: "confirm_link" as const, parentId: existing.id, name: existing.name,
        familyQboIds: rows.filter((x) => x.status !== "disabled").map((x) => x.familyQboId) };
    }
    if (here) {
      const status = here.statusBeforeDisable ?? "invited";
      await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, isPrimary: g.isPrimary ?? here.isPrimary, updatedAt: new Date() })
        .where(eq(guardian.id, here.id));
      await writeAudit({ ...base, action: "guardian.reenable", targetType: "guardian", targetId: here.id,
        before: { status: "disabled", disabledReason: "removed" }, after: { status } }, tx);
      return { ok: true as const, outcome: "reenabled" as const, parentId: existing.id, guardianId: here.id };
    }
    const [row] = await tx.insert(guardian).values({ familyQboId: g.familyQboId, parentId: existing.id, isPrimary: g.isPrimary ?? false, status: "invited" }).returning();
    await writeAudit({ ...base, action: "guardian.create", targetType: "guardian", targetId: row!.id,
      after: { parentId: existing.id, familyQboId: g.familyQboId, isPrimary: row!.isPrimary, status: "invited", linked: true } }, tx);
    return { ok: true as const, outcome: "linked" as const, parentId: existing.id, guardianId: row!.id };
  });
  if (!r.ok) return r;
  // A new person's welcome doesn't name the family; an existing person's names the one they were added to (spec §2).
  const welcomeSent = await welcome(r.parentId, r.guardianId, r.outcome === "created" ? null : g.familyLabel, o);
  return { ...r, welcomeSent };
}

/** Staff remove a guardian from one family. The person and their other families aren't touched. */
export async function removeGuardian(guardianId: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(guardian).where(eq(guardian.id, guardianId)).for("update");
    if (!row) return { ok: false as const, reason: "not_found" as const };
    // Serialize per person, so two disables racing over their last rows can't each count one row left.
    await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, row.parentId)).for("update");
    if (row.status === "disabled" && row.disabledReason === "removed") return { ok: true as const, sessionsEnded: 0 };
    const statusBeforeDisable = row.status === "disabled" ? row.statusBeforeDisable : row.status;
    await tx.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable, updatedAt: new Date() }).where(eq(guardian.id, row.id));
    const sessionsEnded = (await enabledGuardianRows(row.parentId, tx)).length === 0 ? await endParentSessions(row.parentId, tx) : 0;
    await writeAudit({ actor: o.actor, action: "guardian.remove", permission: o.permission, targetType: "guardian", targetId: row.id,
      before: { status: row.status, disabledReason: row.disabledReason }, after: { status: "disabled", disabledReason: "removed", sessionsEnded }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

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

/**
 * Spec §2 Status changes. The roster plan calls this whenever a family's students change. No active students: the
 * family's enabled rows become disabled (`no_active_students`). Students again: those rows go back to the status they
 * had. Rows disabled as `removed` stay disabled either way.
 */
export async function onFamilyStudentsChanged(familyQboId: string, hasActiveStudents: boolean, o: StaffOp): Promise<{ changed: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(guardian).where(eq(guardian.familyQboId, familyQboId)).for("update");
    // Lock each person once, in a fixed order, so racing calls over shared people can't deadlock or miscount.
    for (const id of [...new Set(rows.map((r) => r.parentId))].sort()) {
      await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, id)).for("update");
    }
    let changed = 0;
    for (const row of rows) {
      if (!hasActiveStudents && row.status !== "disabled") {
        await tx.update(guardian).set({ status: "disabled", disabledReason: "no_active_students", statusBeforeDisable: row.status, updatedAt: new Date() }).where(eq(guardian.id, row.id));
        const sessionsEnded = (await enabledGuardianRows(row.parentId, tx)).length === 0 ? await endParentSessions(row.parentId, tx) : 0;
        await writeAudit({ actor: o.actor, action: "guardian.disable", permission: o.permission, targetType: "guardian", targetId: row.id,
          before: { status: row.status }, after: { status: "disabled", disabledReason: "no_active_students", sessionsEnded }, ip: o.ip }, tx);
        changed++;
      } else if (hasActiveStudents && row.status === "disabled" && row.disabledReason === "no_active_students") {
        const status = row.statusBeforeDisable ?? "invited";
        await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, updatedAt: new Date() }).where(eq(guardian.id, row.id));
        await writeAudit({ actor: o.actor, action: "guardian.reenable", permission: o.permission, targetType: "guardian", targetId: row.id,
          before: { status: "disabled", disabledReason: "no_active_students" }, after: { status }, ip: o.ip }, tx);
        changed++;
      }
    }
    return { changed };
  });
}

/** **Resend welcome** on a guardian. */
export async function resendWelcome(guardianId: string, familyLabel: string | null, o: StaffOp):
  Promise<{ ok: true } | { ok: false; reason: "not_found" | "disabled" | "blocked" | "mail_failed"; error?: string }> {
  const [row] = await db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(guardian.id, guardianId));
  if (!row) return { ok: false, reason: "not_found" };
  if (row.g.status === "disabled") return { ok: false, reason: "disabled" };
  if (row.p.blocked) return { ok: false, reason: "blocked" };
  return (await welcome(row.p.id, row.g.id, familyLabel, o)) ? { ok: true } : { ok: false, reason: "mail_failed" };
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
