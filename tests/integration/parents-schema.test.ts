import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { parent, guardian, setting } from "@/lib/db/schema";
import { getParentSettings, putParentSettings, DEFAULT_PARENT_SETTINGS, PARENTS_KEY } from "@/lib/parents/settings";
import { ADMIN_ONLY, GRANTABLE, isPermission } from "@/lib/permissions/registry";
import { resetDb, seedParent, seedGuardian } from "../helpers/db";

describe("the parents-from-QuickBooks schema", () => {
  beforeEach(resetDb);

  it("gives a person welcome and block fields with safe defaults", async () => {
    const [p] = await db.insert(parent).values({ name: "Ana Rivera", email: "ana@example.com" }).returning();
    const [row] = await db.select().from(parent);
    expect(row).toMatchObject({ id: p!.id, blocked: false, blockedAt: null, blockedBy: null, blockedReason: null, welcomedAt: null, welcomeOwed: false, welcomeTriedAt: null });
  });

  it("lets a guardian row remember why it closed, and keeps every row in a family but one a change of company closed", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "10" });
    expect(g.familyId).not.toBeNull();
    await db.update(guardian).set({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect((await db.select().from(guardian))[0]).toMatchObject({ familyId: g.familyId, disabledReason: "company_changed" });
    // A previous company's row may be in no family, as a change of company before stage 4's slice M7a left one.
    await db.update(guardian).set({ familyId: null });
    // Any other row in no family is refused by the database (migration 0049's check), and changes nothing.
    const refused = await db.update(guardian).set({ status: "active", disabledReason: null, statusBeforeDisable: null }).then(() => null, (e: unknown) => e as Error);
    expect(`${refused?.message} ${(refused as { cause?: { message?: string } } | null)?.cause?.message ?? ""}`).toMatch(/guardian_family_unless_company_changed/);
    expect((await db.select().from(guardian))[0]).toMatchObject({ familyId: null, status: "disabled", disabledReason: "company_changed" });
  });

  it("stores and reads the parents setting, defaulting when no row is stored", async () => {
    expect(await getParentSettings()).toEqual(DEFAULT_PARENT_SETTINGS);
    await db.transaction((tx) => putParentSettings(tx, { ...DEFAULT_PARENT_SETTINGS, signin: true }));
    expect(await getParentSettings()).toMatchObject({ signin: true });
    expect(await db.select().from(setting)).toEqual([expect.objectContaining({ key: PARENTS_KEY })]);
  });

  it("reads a stored parents setting it can't parse as closed, not as the defaults", async () => {
    await db.insert(setting).values({ key: PARENTS_KEY, value: { signin: "yes" } });
    expect(await getParentSettings()).toEqual({ signin: false, welcome: false, requireActiveStudents: false, level: "standard" });
  });

  it("adds an Admin-only settings permission and a grantable parents permission", () => {
    expect(isPermission("Settings.Parents.ReadWrite")).toBe(true);
    expect(isPermission("Parents.ReadWrite")).toBe(true);
    expect(ADMIN_ONLY).toContain("Settings.Parents.ReadWrite");
    expect(GRANTABLE).toContain("Parents.ReadWrite");
    expect(GRANTABLE).not.toContain("Settings.Parents.ReadWrite");
  });
});
