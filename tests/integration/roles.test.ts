import { describe, it, expect, beforeEach } from "vitest";
import { saveRole, deleteRole, setStaffRoles, listRoles, inviteStaff, setStaffStatus } from "@/lib/staff/roles";
import { resetDb, seedStaff, adminRoleId } from "../helpers/db";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, staffUser, roleAssignment } from "@/lib/db/schema";

const actor = { door: "staff" as const, id: "a1", label: "Admin" };
const LAST_ADMIN = { ok: false, error: "There must always be at least one admin." };

/** Sets a person's roles as `by` would (an admin unless stated). */
async function setRoles(target: string, roleIds: string[], by?: { id: string; admin?: boolean }) {
  const a = { door: "staff" as const, id: by?.id ?? "a1", label: "Actor" };
  return setStaffRoles(target, roleIds, { actor: a, actorStaffUserId: a.id, actorIsAdmin: by?.admin ?? true, ip: null });
}
const held = async (id: string) => (await db.select().from(roleAssignment).where(eq(roleAssignment.staffUserId, id))).map((r) => r.roleId);
const audits = async () => (await db.select().from(auditLog)).map((a) => a.action);
const customRole = async (name: string) => {
  const r = await saveRole({ name, include: ["Staff.*"], exclude: [] }, actor, null);
  if (!r.ok) throw new Error("role");
  return r.id;
};

describe("roles", () => {
  beforeEach(resetDb);

  it("saves a valid role and audits it", async () => {
    const r = await saveRole({ name: "Roster volunteer", include: ["Staff.*"], exclude: [] }, actor, null);
    expect(r.ok).toBe(true);
    expect((await listRoles()).map((x) => x.name)).toContain("Roster volunteer");
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("role.save");
  });

  it("rejects bad patterns with plain messages", async () => {
    const r = await saveRole({ name: "Bad", include: ["Roster..Read"], exclude: [] }, actor, null);
    expect(r.ok).toBe(false);
  });

  it("refuses to edit, delete or rename the built-in Admin role", async () => {
    const id = await adminRoleId();
    expect((await saveRole({ id, name: "Boss", include: ["*"], exclude: [] }, actor, null)).ok).toBe(false);
    expect((await deleteRole(id, actor, null)).ok).toBe(false);
  });

  it("refuses to remove the last active admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    expect(await setRoles(a.id, [])).toEqual(LAST_ADMIN);
  });

  it("allows removing an admin when another remains", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    expect((await setRoles(a.id, [])).ok).toBe(true);
  });

  it("refuses to disable the last active admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    expect((await setStaffStatus(a.id, "disabled", actor, true, null)).ok).toBe(false);
  });

  it("refuses a status other than active or disabled and leaves the row unchanged", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    const r = await setStaffStatus(a.id, "invited" as "active", actor, true, null);
    expect(r).toEqual({ ok: false, error: "That status isn't allowed." });
    const [row] = await db.select().from(staffUser).where(eq(staffUser.id, a.id));
    expect(row!.status).toBe("active");
  });

  it("allows disabling one of two active admins", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    expect((await setStaffStatus(a.id, "disabled", actor, true, null)).ok).toBe(true);
  });

  it("allows removing Admin from a disabled admin while one active admin remains", async () => {
    await seedStaff({ email: "a@club.org", admin: true });
    const d = await seedStaff({ email: "d@club.org", admin: true, status: "disabled" });
    expect((await setRoles(d.id, [])).ok).toBe(true);
  });

  it("does not count an invited admin as the other admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    await seedStaff({ email: "invited@club.org", admin: true, status: "invited" });
    expect(await setStaffStatus(a.id, "disabled", actor, true, null)).toEqual(LAST_ADMIN);
    expect(await setRoles(a.id, [])).toEqual(LAST_ADMIN);
  });

  it("refuses a non-admin with Staff.Users.ReadWrite who tries to turn an admin off or back on", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    const d = await seedStaff({ email: "d@club.org", admin: true, status: "disabled" });
    const msg = { ok: false, error: "Only an admin can turn sign-in on or off for another admin." };
    expect(await setStaffStatus(a.id, "disabled", actor, false, null)).toEqual(msg);
    expect(await setStaffStatus(d.id, "active", actor, false, null)).toEqual(msg);
    const rows = await db.select().from(staffUser);
    expect(rows.find((r) => r.id === a.id)!.status).toBe("active");
    expect(rows.find((r) => r.id === d.id)!.status).toBe("disabled");
    expect((await db.select().from(auditLog)).map((x) => x.action)).not.toContain("staff.status");
  });

  it("lets an admin turn another admin off and back on", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    expect((await setStaffStatus(a.id, "disabled", actor, true, null)).ok).toBe(true);
    expect((await setStaffStatus(a.id, "active", actor, true, null)).ok).toBe(true);
  });

  it("lets a non-admin with Staff.Users.ReadWrite change a person who is not an admin", async () => {
    await seedStaff({ email: "a@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    expect((await setStaffStatus(p.id, "disabled", actor, false, null)).ok).toBe(true);
  });

  it("writes no audit rows when saving with no changes", async () => {
    await seedStaff({ email: "a@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    expect((await setRoles(p.id, [])).ok).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("staff invites", () => {
  beforeEach(resetDb);
  const inv = (raw: { name: string; email: string }, roleIds: string[] = [], admin = true) =>
    inviteStaff(raw, roleIds, { actor, actorIsAdmin: admin, ip: null });

  it("normalizes email and refuses duplicates", async () => {
    expect((await inv({ name: "Pat", email: " Pat@Club.org" })).ok).toBe(true);
    const dup = await inv({ name: "Pat 2", email: "pat@club.org" });
    expect(dup).toEqual({ ok: false, errors: ["Someone with that email is already on the staff list."] });
  });

  it("invites with two roles in one go and audits the invite and each role", async () => {
    const t = await customRole("Treasurer");
    const v = await customRole("Volunteer");
    await db.delete(auditLog);
    const r = await inv({ name: "Pat", email: "pat@club.org" }, [t, v]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await held(r.id)).sort()).toEqual([t, v].sort());
    expect(await db.select().from(staffUser)).toHaveLength(1);
    expect(await audits()).toEqual(["staff.invite", "role.assign", "role.assign"]);
  });

  it("writes nothing when a role id is not real", async () => {
    const t = await customRole("Treasurer");
    const before = (await db.select().from(auditLog)).length;
    const r = await inv({ name: "Pat", email: "pat@club.org" }, [t, crypto.randomUUID()]);
    expect(r.ok).toBe(false);
    expect(await db.select().from(staffUser)).toHaveLength(0);
    expect(await db.select().from(roleAssignment)).toHaveLength(0);
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("refuses a non-admin who invites someone as Admin, audited, nothing created", async () => {
    const r = await inv({ name: "Pat", email: "pat@club.org" }, [await adminRoleId()], false);
    expect(r).toEqual({ ok: false, errors: ["Only an admin can give or remove the Admin role."] });
    expect(await db.select().from(staffUser)).toHaveLength(0);
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({ action: "staff.invite.refused", permission: "Staff.Users.ReadWrite", actorId: "a1", after: { reason: "admin_role_requires_admin" } });
  });

  it("lets an admin invite someone as Admin", async () => {
    expect((await inv({ name: "Pat", email: "pat@club.org" }, [await adminRoleId()])).ok).toBe(true);
  });
});

describe("setStaffRoles", () => {
  beforeEach(resetDb);

  it("lets a non-admin add and remove a custom role on someone else", async () => {
    await seedStaff({ email: "boss@club.org", admin: true });
    const me = await seedStaff({ email: "me@club.org" });
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    const v = await customRole("Volunteer");
    const by = { id: me.id, admin: false };
    expect((await setRoles(p.id, [t, v], by)).ok).toBe(true);
    expect((await held(p.id)).sort()).toEqual([t, v].sort());
    expect((await setRoles(p.id, [v], by)).ok).toBe(true);
    expect(await held(p.id)).toEqual([v]);
    expect(await audits()).toEqual(expect.arrayContaining(["role.assign", "role.unassign"]));
  });

  it("audits each change with the role and the person", async () => {
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    await setRoles(p.id, [t]);
    const [row] = (await db.select().from(auditLog)).filter((x) => x.action === "role.assign");
    expect(row).toMatchObject({ permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: p.id, after: { roleId: t } });
  });

  it("refuses a non-admin who gives or removes Admin, audited, nothing changed", async () => {
    const adminId = await adminRoleId();
    const me = await seedStaff({ email: "me@club.org" });
    const other = await seedStaff({ email: "o@club.org" });
    const boss = await seedStaff({ email: "boss@club.org", admin: true });
    const by = { id: me.id, admin: false };
    const msg = { ok: false, error: "Only an admin can give or remove the Admin role." };
    expect(await setRoles(other.id, [adminId], by)).toEqual(msg);
    expect(await setRoles(boss.id, [], by)).toEqual(msg);
    expect(await held(other.id)).toEqual([]);
    expect(await held(boss.id)).toEqual([adminId]);
    const refused = (await db.select().from(auditLog)).filter((x) => x.action.endsWith(".refused"));
    expect(refused.map((x) => x.action)).toEqual(["role.assign.refused", "role.unassign.refused"]);
    expect(refused[0]).toMatchObject({ actorId: me.id, targetId: other.id, after: { reason: "admin_role_requires_admin" } });
    expect(await audits()).not.toContain("role.assign");
  });

  it("refuses a non-admin who changes their own roles, audited", async () => {
    const me = await seedStaff({ email: "me@club.org" });
    const t = await customRole("Treasurer");
    const r = await setRoles(me.id, [t], { id: me.id, admin: false });
    expect(r).toEqual({ ok: false, error: "Only an admin can change their own roles." });
    expect(await held(me.id)).toEqual([]);
    const [row] = (await db.select().from(auditLog)).filter((x) => x.action.endsWith(".refused"));
    expect(row).toMatchObject({ action: "role.assign.refused", actorId: me.id, targetId: me.id, after: { reason: "own_roles" } });
  });

  it("lets an admin change their own roles but not drop Admin as the last admin", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    const t = await customRole("Treasurer");
    const adminId = await adminRoleId();
    const by = { id: a.id, admin: true };
    expect((await setRoles(a.id, [adminId, t], by)).ok).toBe(true);
    expect(await setRoles(a.id, [t], by)).toEqual(LAST_ADMIN);
    expect((await held(a.id)).sort()).toEqual([adminId, t].sort());
    const refused = (await db.select().from(auditLog)).filter((x) => x.action === "role.unassign.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ after: { reason: "last_admin" } });
  });

  it("writes nothing for a role that does not exist", async () => {
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    const n = (await db.select().from(auditLog)).length;
    const r = await setRoles(p.id, [t, crypto.randomUUID()]);
    expect(r.ok).toBe(false);
    expect(await held(p.id)).toEqual([]);
    expect((await db.select().from(auditLog)).length).toBe(n);
  });

  it("refuses a person who is not on the staff list", async () => {
    expect((await setRoles(crypto.randomUUID(), [])).ok).toBe(false);
  });
});
