import { describe, it, expect, beforeEach } from "vitest";
import { saveRole, deleteRole, setStaffRoles, listRoles, inviteStaff, setStaffStatus } from "@/lib/staff/roles";
import { resetDb, seedStaff, adminRoleId } from "../helpers/db";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, staffUser, roleAssignment } from "@/lib/db/schema";

const actor = { door: "staff" as const, id: "a1", label: "Admin" };
/** The audit actor for a seeded staff member. */
const as = (s: { id: string }) => ({ door: "staff" as const, id: s.id, label: "Actor" });
const LAST_ADMIN = { ok: false, error: "There must always be at least one admin." };

/** Sets a person's roles as the staff member `by` (the person themself unless stated). */
async function setRoles(target: string, roleIds: string[], by: string = target) {
  return setStaffRoles(target, roleIds, { actor: { door: "staff" as const, id: by, label: "Actor" }, actorStaffUserId: by, ip: null });
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
    expect((await setStaffStatus(a.id, "disabled", as(a), null)).ok).toBe(false);
  });

  it("refuses a status other than active or disabled and leaves the row unchanged", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    const r = await setStaffStatus(a.id, "invited" as "active", as(a), null);
    expect(r).toEqual({ ok: false, error: "That status isn't allowed." });
    const [row] = await db.select().from(staffUser).where(eq(staffUser.id, a.id));
    expect(row!.status).toBe("active");
  });

  it("allows disabling one of two active admins", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    expect((await setStaffStatus(a.id, "disabled", as(a), null)).ok).toBe(true);
  });

  it("allows removing Admin from a disabled admin while one active admin remains", async () => {
    await seedStaff({ email: "a@club.org", admin: true });
    const d = await seedStaff({ email: "d@club.org", admin: true, status: "disabled" });
    expect((await setRoles(d.id, [], (await db.select().from(staffUser).where(eq(staffUser.email, "a@club.org")))[0]!.id)).ok).toBe(true);
  });

  it("does not count an invited admin as the other admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    await seedStaff({ email: "invited@club.org", admin: true, status: "invited" });
    expect(await setStaffStatus(a.id, "disabled", as(a), null)).toEqual(LAST_ADMIN);
    expect(await setRoles(a.id, [])).toEqual(LAST_ADMIN);
  });

  it("refuses a non-admin who tries to turn sign-in off or on, audited, nothing changed", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    const d = await seedStaff({ email: "d@club.org", status: "disabled" });
    const msg = { ok: false, error: "Only an admin can turn sign-in on or off." };
    expect(await setStaffStatus(a.id, "disabled", as(p), null)).toEqual(msg);
    expect(await setStaffStatus(d.id, "active", as(p), null)).toEqual(msg);
    const rows = await db.select().from(staffUser);
    expect(rows.find((r) => r.id === a.id)!.status).toBe("active");
    expect(rows.find((r) => r.id === d.id)!.status).toBe("disabled");
    const audit = await db.select().from(auditLog);
    expect(audit.map((x) => x.action)).toEqual(["staff.status.refused", "staff.status.refused"]);
    expect(audit[0]).toMatchObject({ actorId: p.id, targetId: a.id, after: { reason: "not_admin" } });
  });

  it("lets an admin turn another admin off and back on", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    const b = await seedStaff({ email: "b@club.org", admin: true });
    expect((await setStaffStatus(a.id, "disabled", as(b), null)).ok).toBe(true);
    expect((await setStaffStatus(a.id, "active", as(b), null)).ok).toBe(true);
  });

  it("lets an admin turn a non-admin off", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    expect((await setStaffStatus(p.id, "disabled", as(a), null)).ok).toBe(true);
  });

  it("writes no audit rows when saving with no changes", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    expect((await setRoles(p.id, [], a.id)).ok).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe("staff invites", () => {
  beforeEach(resetDb);
  let boss: { id: string };
  beforeEach(async () => { boss = await seedStaff({ email: "boss@club.org", admin: true }); });
  const inv = (raw: { name: string; email: string }, roleIds: string[] = [], by: { id: string } = boss) =>
    inviteStaff(raw, roleIds, { actor: as(by), ip: null });

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
    expect(await db.select().from(staffUser)).toHaveLength(2);
    expect(await audits()).toEqual(["staff.invite", "role.assign", "role.assign"]);
  });

  it("writes nothing when a role id is not real", async () => {
    const t = await customRole("Treasurer");
    const before = (await db.select().from(auditLog)).length;
    const r = await inv({ name: "Pat", email: "pat@club.org" }, [t, crypto.randomUUID()]);
    expect(r.ok).toBe(false);
    expect(await db.select().from(staffUser)).toHaveLength(1);
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("refuses a non-admin invite, with or without roles, audited, nothing created", async () => {
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    await db.delete(auditLog);
    for (const roleIds of [[], [t], [await adminRoleId()]]) {
      const r = await inv({ name: "Pat", email: "pat@club.org" }, roleIds, p);
      expect(r).toEqual({ ok: false, errors: ["Only an admin can add staff."] });
    }
    expect((await db.select().from(staffUser)).map((x) => x.email).sort()).toEqual(["boss@club.org", "p@club.org"]);
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ action: "staff.invite.refused", permission: "Staff.Users.ReadWrite", actorId: p.id, after: { reason: "not_admin" } });
  });

  it("audits the refusal even when the email is taken or the role is unknown", async () => {
    const p = await seedStaff({ email: "pat@club.org" });
    await db.delete(auditLog);
    await inv({ name: "Pat", email: "pat@club.org" }, [crypto.randomUUID()], p);
    expect((await db.select().from(auditLog)).map((x) => x.action)).toEqual(["staff.invite.refused"]);
  });

  it("lets an admin invite without roles", async () => {
    expect((await inv({ name: "Pat", email: "pat@club.org" })).ok).toBe(true);
  });

  it("lets an admin invite someone as Admin", async () => {
    expect((await inv({ name: "Pat", email: "pat@club.org" }, [await adminRoleId()])).ok).toBe(true);
  });
});

describe("setStaffRoles", () => {
  beforeEach(resetDb);

  it("lets an admin add and remove roles on someone else, including another admin's", async () => {
    const boss = await seedStaff({ email: "boss@club.org", admin: true });
    const other = await seedStaff({ email: "o@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    const v = await customRole("Volunteer");
    expect((await setRoles(p.id, [t, v], boss.id)).ok).toBe(true);
    expect((await held(p.id)).sort()).toEqual([t, v].sort());
    expect((await setRoles(p.id, [v], boss.id)).ok).toBe(true);
    expect(await held(p.id)).toEqual([v]);
    expect((await setRoles(other.id, [t], boss.id)).ok).toBe(true);
    expect(await held(other.id)).toEqual([t]);
    expect(await audits()).toEqual(expect.arrayContaining(["role.assign", "role.unassign"]));
  });

  it("audits each change with the role and the person", async () => {
    const boss = await seedStaff({ email: "boss@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    await setRoles(p.id, [t], boss.id);
    const [row] = (await db.select().from(auditLog)).filter((x) => x.action === "role.assign");
    expect(row).toMatchObject({ permission: "Staff.Users.ReadWrite", actorId: boss.id, targetType: "staff_user", targetId: p.id, after: { roleId: t } });
  });

  it("refuses an actor who no longer holds Admin, audited, nothing changed", async () => {
    await seedStaff({ email: "boss@club.org", admin: true });
    const former = await seedStaff({ email: "former@club.org" });
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    const r = await setRoles(p.id, [t], former.id);
    expect(r).toEqual({ ok: false, error: "Only an admin can change roles." });
    expect(await held(p.id)).toEqual([]);
    const [row] = (await db.select().from(auditLog)).filter((x) => x.action.endsWith(".refused"));
    expect(row).toMatchObject({ action: "role.assign.refused", actorId: former.id, targetId: p.id, after: { reason: "not_admin" } });
  });

  it("lets an admin change their own roles but not drop Admin as the last admin", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    const t = await customRole("Treasurer");
    const adminId = await adminRoleId();
    expect((await setRoles(a.id, [adminId, t])).ok).toBe(true);
    expect(await setRoles(a.id, [t])).toEqual(LAST_ADMIN);
    expect((await held(a.id)).sort()).toEqual([adminId, t].sort());
    const refused = (await db.select().from(auditLog)).filter((x) => x.action === "role.unassign.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ after: { reason: "last_admin" } });
  });

  it("writes nothing for a role that does not exist", async () => {
    const boss = await seedStaff({ email: "boss@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    const t = await customRole("Treasurer");
    const n = (await db.select().from(auditLog)).length;
    const r = await setRoles(p.id, [t, crypto.randomUUID()], boss.id);
    expect(r.ok).toBe(false);
    expect(await held(p.id)).toEqual([]);
    expect((await db.select().from(auditLog)).length).toBe(n);
  });

  it("refuses a person who is not on the staff list", async () => {
    const boss = await seedStaff({ email: "boss@club.org", admin: true });
    expect((await setRoles(crypto.randomUUID(), [], boss.id)).ok).toBe(false);
  });
});
