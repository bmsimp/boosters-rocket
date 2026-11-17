import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment } from "@/lib/db/schema";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS } from "@/lib/permissions/registry";
import { resetDb, seedStaff } from "../helpers/db";

describe("effectivePermissions", () => {
  beforeEach(resetDb);

  it("gives Admin every permission, including admin-only", async () => {
    const s = await seedStaff({ email: "a@club.org", admin: true });
    const e = await effectivePermissions(s.id);
    expect(e.isAdmin).toBe(true);
    for (const p of PERMISSIONS) expect(can(e, p)).toBe(true);
  });

  it("unions custom roles and never grants admin-only", async () => {
    const s = await seedStaff({ email: "v@club.org" });
    const [r1] = await db.insert(role).values({ key: "people", name: "People" }).returning();
    const [r2] = await db.insert(role).values({ key: "audit", name: "Audit" }).returning();
    await db.insert(roleRule).values([
      { roleId: r1!.id, kind: "include", pattern: "Staff.*" },
      { roleId: r2!.id, kind: "include", pattern: "*" },
      { roleId: r2!.id, kind: "exclude", pattern: "Staff.*" },
    ]);
    await db.insert(roleAssignment).values([{ roleId: r1!.id, staffUserId: s.id }, { roleId: r2!.id, staffUserId: s.id }]);
    const e = await effectivePermissions(s.id);
    expect(can(e, "Staff.Users.Read")).toBe(true);
    expect(can(e, "Staff.Users.ReadWrite")).toBe(false);
    expect(can(e, "Roster.Read")).toBe(true);
    expect(can(e, "Audit.Log.Read")).toBe(false);
    expect(can(e, "Admin.Roles.ReadWrite")).toBe(false);
  });

  it("gives a permission named exactly, and only that one", async () => {
    const s = await seedStaff({ email: "v@club.org" });
    const [r] = await db.insert(role).values({ key: "roster", name: "Roster" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "Roster.Read" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    expect([...(await effectivePermissions(s.id)).permissions]).toEqual(["Roster.Read"]);
  });

  it("gives no Admin-only permission to a role whose stored rules name every one of them", async () => {
    // Rules written straight into the table, past the check that saveRole() makes: what is stored is still not trusted.
    const s = await seedStaff({ email: "v@club.org" });
    const [r] = await db.insert(role).values({ key: "all", name: "All" }).returning();
    await db.insert(roleRule).values([...ADMIN_ONLY, "*", "Admin.*", "*.ReadWrite", "*.Read"].map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    const e = await effectivePermissions(s.id);
    expect(e.isAdmin).toBe(false);
    for (const p of ADMIN_ONLY) expect(can(e, p), p).toBe(false);
    expect(e.permissions.size).toBe(GRANTABLE.length);
  });

  it("never grants Staff.Users.ReadWrite through Staff.* or an exact pattern, but Staff.Users.Read works", async () => {
    for (const pattern of ["Staff.*", "Staff.Users.ReadWrite", "*", "Staff.Users.Read*"]) {
      await resetDb();
      const s = await seedStaff({ email: "v@club.org" });
      const [r] = await db.insert(role).values({ key: "people", name: "People" }).returning();
      await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern });
      await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
      const e = await effectivePermissions(s.id);
      expect(can(e, "Staff.Users.ReadWrite")).toBe(false);
      if (pattern !== "Staff.Users.ReadWrite") expect(can(e, "Staff.Users.Read")).toBe(true);
    }
  }, 30_000);

  it("gives a staff user with no roles nothing", async () => {
    const s = await seedStaff({ email: "n@club.org" });
    expect((await effectivePermissions(s.id)).permissions.size).toBe(0);
  });
});
