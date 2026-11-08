import { describe, it, expect, beforeEach } from "vitest";
import { saveRole, deleteRole, unassignRole, listRoles, inviteStaff, setStaffStatus } from "@/lib/staff/roles";
import { resetDb, seedStaff, adminRoleId } from "../helpers/db";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, staffUser } from "@/lib/db/schema";

const actor = { door: "staff" as const, id: "a1", label: "Admin" };

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
    const r = await unassignRole(await adminRoleId(), a.id, actor, null);
    expect(r).toEqual({ ok: false, error: "There must always be at least one admin." });
  });

  it("allows removing an admin when another remains", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    expect((await unassignRole(await adminRoleId(), a.id, actor, null)).ok).toBe(true);
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
    expect((await unassignRole(await adminRoleId(), d.id, actor, null)).ok).toBe(true);
  });

  it("does not count an invited admin as the other admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    await seedStaff({ email: "invited@club.org", admin: true, status: "invited" });
    expect(await setStaffStatus(a.id, "disabled", actor, true, null)).toEqual({ ok: false, error: "There must always be at least one admin." });
    expect(await unassignRole(await adminRoleId(), a.id, actor, null)).toEqual({ ok: false, error: "There must always be at least one admin." });
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

  it("does not audit an unassign that removed nothing", async () => {
    await seedStaff({ email: "a@club.org", admin: true });
    const p = await seedStaff({ email: "p@club.org" });
    await unassignRole(await adminRoleId(), p.id, actor, null);
    expect((await db.select().from(auditLog)).map((x) => x.action)).not.toContain("role.unassign");
  });
});

describe("staff invites", () => {
  beforeEach(resetDb);

  it("normalises email and refuses duplicates", async () => {
    expect((await inviteStaff({ name: "Pat", email: " Pat@Club.org" }, actor, null)).ok).toBe(true);
    const dup = await inviteStaff({ name: "Pat 2", email: "pat@club.org" }, actor, null);
    expect(dup).toEqual({ ok: false, errors: ["Someone with that email is already on the staff list."] });
  });
});
