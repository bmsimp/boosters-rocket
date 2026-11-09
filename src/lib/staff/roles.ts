import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/lib/db/client";
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

/** True when this person holds the Admin role and is counted by adminCount (status active). */
async function isCountedAdmin(tx: Tx, staffUserId: string): Promise<boolean> {
  const rows = await tx.execute(sql`SELECT 1 FROM role_assignment ra JOIN role r ON r.id = ra.role_id
    JOIN staff_user s ON s.id = ra.staff_user_id
    WHERE r.key='admin' AND ra.staff_user_id=${staffUserId} AND s.status = 'active'`);
  return Array.from(rows as ArrayLike<unknown>).length > 0;
}

/** True when this person holds the Admin role, whatever their status. */
async function holdsAdminRole(tx: Tx, staffUserId: string): Promise<boolean> {
  const rows = await tx.execute(sql`SELECT 1 FROM role_assignment ra JOIN role r ON r.id = ra.role_id
    WHERE r.key='admin' AND ra.staff_user_id=${staffUserId}`);
  return Array.from(rows as ArrayLike<unknown>).length > 0;
}

const STAFF_PERM = "Staff.Users.ReadWrite";
const ADMIN_ROLE_REFUSAL = "Only an admin can give or remove the Admin role.";
const OWN_ROLES_REFUSAL = "Only an admin can change their own roles.";

export type RoleOpts = { actor: Actor; actorStaffUserId: string; actorIsAdmin: boolean; ip: string | null };

/** Sets exactly which roles a person holds. Works out the changes, applies the rules (own roles, the Admin role,
 *  the last admin) and writes the changes and their audit rows in one transaction. A refusal is audited and committed. */
export async function setStaffRoles(staffUserId: string, roleIds: string[], opts: RoleOpts):
  Promise<{ ok: true } | { ok: false; error: string }> {
  const wanted = [...new Set(roleIds)];
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.admins'))`);
    const [person] = await tx.select().from(staffUser).where(eq(staffUser.id, staffUserId));
    if (!person) return { ok: false as const, error: "That person is no longer on the staff list." };
    const known = wanted.length ? await tx.select().from(role).where(inArray(role.id, wanted)) : [];
    if (known.length !== wanted.length) return { ok: false as const, error: "One of those roles no longer exists." };
    const current = await tx.select({ id: roleAssignment.roleId, key: role.key }).from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId)).where(eq(roleAssignment.staffUserId, staffUserId));
    const add = known.filter((r) => !current.some((c) => c.id === r.id));
    const remove = current.filter((c) => !wanted.includes(c.id));
    if (!add.length && !remove.length) return { ok: true as const };

    const refuse = async (reason: string, error: string, unassign: boolean) => {
      await writeAudit({ actor: opts.actor, action: unassign ? "role.unassign.refused" : "role.assign.refused", permission: STAFF_PERM,
        targetType: "staff_user", targetId: staffUserId, after: { reason }, ip: opts.ip }, tx);
      return { ok: false as const, error };
    };
    if (!opts.actorIsAdmin && opts.actorStaffUserId === staffUserId) return refuse("own_roles", OWN_ROLES_REFUSAL, !add.length);
    const touchesAdmin = add.some((r) => r.key === "admin") || remove.some((c) => c.key === "admin");
    if (!opts.actorIsAdmin && touchesAdmin) return refuse("admin_role_requires_admin", ADMIN_ROLE_REFUSAL, !add.some((r) => r.key === "admin"));
    if (remove.some((c) => c.key === "admin") && (await isCountedAdmin(tx, staffUserId)) && (await adminCount(tx)) <= 1) {
      return refuse("last_admin", LAST_ADMIN, true);
    }

    for (const r of add) {
      await tx.insert(roleAssignment).values({ roleId: r.id, staffUserId });
      await writeAudit({ actor: opts.actor, action: "role.assign", permission: STAFF_PERM, targetType: "staff_user", targetId: staffUserId, after: { roleId: r.id }, ip: opts.ip }, tx);
    }
    for (const c of remove) {
      await tx.delete(roleAssignment).where(and(eq(roleAssignment.roleId, c.id), eq(roleAssignment.staffUserId, staffUserId)));
      await writeAudit({ actor: opts.actor, action: "role.unassign", permission: STAFF_PERM, targetType: "staff_user", targetId: staffUserId, before: { roleId: c.id }, ip: opts.ip }, tx);
    }
    return { ok: true as const };
  });
}

export async function listStaff() {
  const people = await db.select().from(staffUser).orderBy(staffUser.name);
  const links = await db.select({ staffUserId: roleAssignment.staffUserId, roleId: role.id, name: role.name })
    .from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId));
  return people.map((p) => ({ id: p.id, name: p.name, email: p.email, status: p.status,
    roles: links.filter((l) => l.staffUserId === p.id).map((l) => ({ id: l.roleId, name: l.name })) }));
}

const inviteInput = z.object({
  name: z.string().trim().min(1, "Enter their name."),
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
});

export type InviteOpts = { actor: Actor; actorIsAdmin: boolean; ip: string | null };

export async function inviteStaff(raw: { name: string; email: string }, roleIds: string[], opts: InviteOpts):
  Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const p = inviteInput.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => i.message) };
  const wanted = [...new Set(roleIds)];
  return db.transaction(async (tx) => {
    const known = wanted.length ? await tx.select().from(role).where(inArray(role.id, wanted)) : [];
    if (known.length !== wanted.length) return { ok: false as const, errors: ["One of those roles no longer exists."] };
    const [exists] = await tx.select().from(staffUser).where(eq(staffUser.email, p.data.email));
    if (exists) return { ok: false as const, errors: ["Someone with that email is already on the staff list."] };
    if (!opts.actorIsAdmin && known.some((r) => r.key === "admin")) {
      await writeAudit({ actor: opts.actor, action: "staff.invite.refused", permission: STAFF_PERM, targetType: "staff_user",
        after: { reason: "admin_role_requires_admin", email: p.data.email }, ip: opts.ip }, tx);
      return { ok: false as const, errors: [ADMIN_ROLE_REFUSAL] };
    }
    const [s] = await tx.insert(staffUser).values({ ...p.data, status: "invited" }).returning();
    await writeAudit({ actor: opts.actor, action: "staff.invite", permission: STAFF_PERM, targetType: "staff_user", targetId: s!.id, after: p.data, ip: opts.ip }, tx);
    for (const r of known) {
      await tx.insert(roleAssignment).values({ roleId: r.id, staffUserId: s!.id });
      await writeAudit({ actor: opts.actor, action: "role.assign", permission: STAFF_PERM, targetType: "staff_user", targetId: s!.id, after: { roleId: r.id }, ip: opts.ip }, tx);
    }
    return { ok: true as const, id: s!.id };
  });
}

const statusInput = z.enum(["active", "disabled"]);

const ADMIN_ONLY = "Only an admin can turn sign-in on or off for another admin.";

/** `actorIsAdmin` is the signed-in actor's own Admin standing: only admins may change an admin's status. */
export async function setStaffStatus(id: string, rawStatus: "active" | "disabled", actor: Actor, actorIsAdmin: boolean, ip: string | null) {
  const parsed = statusInput.safeParse(rawStatus);
  if (!parsed.success) return { ok: false, error: "That status isn't allowed." };
  const status = parsed.data;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.admins'))`);
    const [s] = await tx.select().from(staffUser).where(eq(staffUser.id, id));
    if (!s) return { ok: false, error: "That person is no longer on the staff list." };
    if (!actorIsAdmin && (await holdsAdminRole(tx, id))) return { ok: false, error: ADMIN_ONLY };
    if (status !== "active" && (await isCountedAdmin(tx, id)) && (await adminCount(tx)) <= 1) return { ok: false, error: LAST_ADMIN };
    await tx.update(staffUser).set({ status, updatedAt: new Date() }).where(eq(staffUser.id, id));
    await writeAudit({ actor, action: "staff.status", permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: id,
      before: { status: s.status }, after: { status }, ip }, tx);
    return { ok: true };
  });
}
