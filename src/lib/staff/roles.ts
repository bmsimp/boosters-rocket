import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment, staffUser } from "@/lib/db/schema";
import { validateRules } from "@/lib/permissions/rules";
import { adminCount } from "@/lib/auth/bootstrap";
import { writeAudit, type Actor } from "@/lib/audit/log";

const PERM = "Admin.Roles.ReadWrite";
const LAST_ADMIN = "There must always be at least one admin.";

export async function listRoles() {
  const roles = await db.select().from(role).orderBy(sql`${role.builtin} DESC, ${role.name}`);
  const rules = await db.select().from(roleRule);
  const counts = await db.select({ roleId: roleAssignment.roleId, n: sql<number>`count(*)::int` }).from(roleAssignment).groupBy(roleAssignment.roleId);
  return roles.map((r) => ({
    id: r.id, key: r.key, name: r.name, builtin: r.builtin,
    include: rules.filter((x) => x.roleId === r.id && x.kind === "include").map((x) => x.pattern),
    exclude: rules.filter((x) => x.roleId === r.id && x.kind === "exclude").map((x) => x.pattern),
    members: counts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "role";

export async function saveRole(input: { id?: string; name: string; include: string[]; exclude: string[] }, actor: Actor, ip: string | null):
  Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const name = input.name.trim();
  const errors = [...(name ? [] : ["A role needs a name."]), ...validateRules({ include: input.include, exclude: input.exclude })];
  if (input.id) {
    const [existing] = await db.select().from(role).where(eq(role.id, input.id));
    if (!existing) errors.push("That role no longer exists.");
    else if (existing.builtin) errors.push("The Admin role can't be changed.");
  }
  if (errors.length) return { ok: false, errors };

  const before = input.id ? (await listRoles()).find((r) => r.id === input.id) ?? null : null;
  const id = await db.transaction(async (tx) => {
    const [r] = input.id
      ? await tx.update(role).set({ name, updatedAt: new Date() }).where(eq(role.id, input.id)).returning()
      : await tx.insert(role).values({ name, key: `${slug(name)}-${crypto.randomUUID().slice(0, 6)}` }).returning();
    await tx.delete(roleRule).where(eq(roleRule.roleId, r!.id));
    const rows = [
      ...input.include.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })),
      ...input.exclude.map((pattern) => ({ roleId: r!.id, kind: "exclude" as const, pattern })),
    ];
    if (rows.length) await tx.insert(roleRule).values(rows);
    await writeAudit({ actor, action: "role.save", permission: PERM, targetType: "role", targetId: r!.id,
      before, after: { name, include: input.include, exclude: input.exclude }, ip }, tx);
    return r!.id;
  });
  return { ok: true, id };
}

export async function deleteRole(id: string, actor: Actor, ip: string | null) {
  const [r] = await db.select().from(role).where(eq(role.id, id));
  if (!r) return { ok: false, error: "That role no longer exists." };
  if (r.builtin) return { ok: false, error: "The Admin role can't be deleted." };
  await db.transaction(async (tx) => {
    await tx.delete(role).where(eq(role.id, id));
    await writeAudit({ actor, action: "role.delete", permission: PERM, targetType: "role", targetId: id, before: { name: r.name }, ip }, tx);
  });
  return { ok: true };
}

export async function assignRole(roleId: string, staffUserId: string, actor: Actor, ip: string | null) {
  await db.transaction(async (tx) => {
    await tx.insert(roleAssignment).values({ roleId, staffUserId }).onConflictDoNothing();
    await writeAudit({ actor, action: "role.assign", permission: PERM, targetType: "staff_user", targetId: staffUserId, after: { roleId }, ip }, tx);
  });
  return { ok: true };
}

export async function unassignRole(roleId: string, staffUserId: string, actor: Actor, ip: string | null) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.admins'))`);
    const [r] = await tx.select().from(role).where(eq(role.id, roleId));
    if (r?.key === "admin" && (await adminCount(tx)) <= 1) return { ok: false, error: LAST_ADMIN };
    await tx.delete(roleAssignment).where(and(eq(roleAssignment.roleId, roleId), eq(roleAssignment.staffUserId, staffUserId)));
    await writeAudit({ actor, action: "role.unassign", permission: PERM, targetType: "staff_user", targetId: staffUserId, before: { roleId }, ip }, tx);
    return { ok: true };
  });
}

export async function listStaff() {
  const people = await db.select().from(staffUser).orderBy(staffUser.name);
  const links = await db.select({ staffUserId: roleAssignment.staffUserId, name: role.name })
    .from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId));
  return people.map((p) => ({ id: p.id, name: p.name, email: p.email, status: p.status,
    roles: links.filter((l) => l.staffUserId === p.id).map((l) => l.name) }));
}

const inviteInput = z.object({
  name: z.string().trim().min(1, "Enter their name."),
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
});

export async function inviteStaff(raw: { name: string; email: string }, actor: Actor, ip: string | null):
  Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const p = inviteInput.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => i.message) };
  const [exists] = await db.select().from(staffUser).where(eq(staffUser.email, p.data.email));
  if (exists) return { ok: false, errors: ["Someone with that email is already on the staff list."] };
  const [s] = await db.insert(staffUser).values({ ...p.data, status: "invited" }).returning();
  await writeAudit({ actor, action: "staff.invite", permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: s!.id, after: p.data, ip });
  return { ok: true, id: s!.id };
}

export async function setStaffStatus(id: string, status: "active" | "disabled", actor: Actor, ip: string | null) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.admins'))`);
    const [s] = await tx.select().from(staffUser).where(eq(staffUser.id, id));
    if (!s) return { ok: false, error: "That person is no longer on the staff list." };
    if (status === "disabled") {
      const isAdmin = (await tx.execute(sql`SELECT 1 FROM role_assignment ra JOIN role r ON r.id = ra.role_id WHERE r.key='admin' AND ra.staff_user_id=${id}`)).length > 0;
      if (isAdmin && (await adminCount(tx)) <= 1) return { ok: false, error: LAST_ADMIN };
    }
    await tx.update(staffUser).set({ status, updatedAt: new Date() }).where(eq(staffUser.id, id));
    await writeAudit({ actor, action: "staff.status", permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: id,
      before: { status: s.status }, after: { status }, ip }, tx);
    return { ok: true };
  });
}
