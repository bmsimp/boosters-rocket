import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment } from "@/lib/db/schema";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { PERMISSIONS } from "@/lib/permissions/registry";
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
    expect(can(e, "Staff.Users.ReadWrite")).toBe(true);
    expect(can(e, "Audit.Log.Read")).toBe(true);
    expect(can(e, "Admin.Roles.ReadWrite")).toBe(false);
  });

  it("gives a staff user with no roles nothing", async () => {
    const s = await seedStaff({ email: "n@club.org" });
    expect((await effectivePermissions(s.id)).permissions.size).toBe(0);
  });
});
