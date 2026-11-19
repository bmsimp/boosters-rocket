import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { parent, guardian, heldAddress, familyMatch, setting } from "@/lib/db/schema";
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

  it("lets a family link remember its QuickBooks customer and why it closed", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "10" });
    expect(g.sourceQboId).toBeNull();
    await db.update(guardian).set({ sourceQboId: "11", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect((await db.select().from(guardian))[0]).toMatchObject({ sourceQboId: "11", disabledReason: "company_changed" });
  });

  it("keeps one row per held address, with three sets of family IDs", async () => {
    await db.insert(heldAddress).values({ email: "ana@example.com" });
    const [h] = await db.select().from(heldAddress);
    expect(h).toMatchObject({ email: "ana@example.com", approvedFamilyQboIds: [], rejectedFamilyQboIds: [], announcedFamilyQboIds: [], note: null, decidedBy: null, decidedAt: null });
    await expect(db.insert(heldAddress).values({ email: "ana@example.com" })).rejects.toThrow();
  });

  it("allows one match per old family", async () => {
    const m = { oldRealmId: "1", oldFamilyQboId: "12", newRealmId: "2", newFamilyQboId: "87" };
    await db.insert(familyMatch).values(m);
    await expect(db.insert(familyMatch).values({ ...m, newFamilyQboId: "88" })).rejects.toThrow();
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
