import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, renderPage, pageOutcome, asParent } from "../helpers/signed-in";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { effectivePermissions } from "@/lib/permissions/effective";
import { listRoles } from "@/lib/staff/roles";
import RolesPage from "@/app/staff/(app)/settings/roles/page";
import { saveRoleChecklistAction, deleteRoleAction } from "@/app/staff/(app)/settings/roles/actions";
import { resetDb, seedStaff, adminRoleId } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";

const asAdmin = async () => { const a = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }); asStaff(a); return a; };
async function roleWith(name: string, include: string[], exclude: string[] = []) {
  const [r] = await db.insert(role).values({ key: name.toLowerCase().replace(/\W+/g, "-"), name }).returning();
  await db.insert(roleRule).values([...include.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })), ...exclude.map((pattern) => ({ roleId: r!.id, kind: "exclude" as const, pattern }))]);
  return r!;
}
const hold = async (roleId: string, email: string) => { const s = await seedStaff({ email }); await db.insert(roleAssignment).values({ roleId, staffUserId: s.id }); return s; };
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
/** The ticked boxes of one role's box on the Roles page, as their words. */
function ticked(html: string, roleName: string): string[] {
  const box = new RegExp(`<h2 id="role-[^"]+">${roleName}</h2>(.*?)</section>`).exec(html)![1]!;
  return [...box.matchAll(/<input[^>]*type="checkbox"[^>]*>\s*<span>([^<]*)/g)].filter((m) => m[0].includes('checked=""')).map((m) => m[1]!);
}

describe("roles by checklist", () => {
  beforeEach(resetDb);

  it("saves a role from ticks as the exact names ticked, and its holder gets exactly those", async () => {
    await asAdmin();
    expect(await saveRoleChecklistAction(null, "Season helper", ["Season.Progress.ReadWrite", "Roster.Read"])).toEqual({ ok: true, message: "Role made." });
    const made = (await listRoles()).find((r) => r.name === "Season helper")!;
    expect(made.include.sort()).toEqual(["Roster.Read", "Season.Progress.Read", "Season.Progress.ReadWrite"]);
    expect(made.exclude).toEqual([]);
    const holder = await hold(made.id, "helper@club.org");
    expect([...(await effectivePermissions(holder.id)).permissions].sort()).toEqual(["Roster.Read", "Season.Progress.Read", "Season.Progress.ReadWrite"]);
    const [row] = await audits("role.save");
    expect(row).toMatchObject({ permission: "Admin.Roles.ReadWrite", targetId: made.id, before: null,
      after: { name: "Season helper", include: ["Roster.Read", "Season.Progress.Read", "Season.Progress.ReadWrite"], exclude: [] } });
  });

  it("changes a role's ticks and name, auditing the before and after", async () => {
    await asAdmin();
    const r = await roleWith("Treasurer", ["Finance.Balance.Read"]);
    expect((await saveRoleChecklistAction(r.id, "Money team", ["Finance.Balance.Read", "Roster.Read"])).ok).toBe(true);
    expect((await listRoles()).find((x) => x.id === r.id)).toMatchObject({ name: "Money team", include: ["Roster.Read", "Finance.Balance.Read"] });
    const [row] = await audits("role.save");
    expect(row!.before).toMatchObject({ name: "Treasurer", include: ["Finance.Balance.Read"], exclude: [] });
    expect(row!.after).toEqual({ name: "Money team", include: ["Roster.Read", "Finance.Balance.Read"], exclude: [] });
  });

  it("shows the checklist ticked with what each role gives, in words, and never offers an Admin-only permission", async () => {
    await asAdmin();
    await roleWith("Treasurer", ["Finance.Balance.Read", "Roster.Read"]);
    const html = await renderPage(RolesPage);
    expect(ticked(html, "Treasurer")).toEqual(["See the roster: families, students and parents", "See what every family owes, and ask for a fresh read from QuickBooks"]);
    expect(html).not.toContain("textarea");
    for (const w of ["See the audit log", "See the Health page", "Change outgoing mail"]) expect(html).not.toMatch(new RegExp(`<span>${w}`));
    expect(html).toContain("What only an Admin can do");
  });

  it("shows a role with a wildcard or an exclude as what it grants today, and says a save ends its patterns", async () => {
    await asAdmin();
    await roleWith("Season lead", ["Season.*"], ["Season.Steps.ReadWrite"]);
    const html = await renderPage(RolesPage);
    expect(ticked(html, "Season lead")).toEqual(["See the seasons, their steps and requirements", "See which families have met each requirement", "Tick checklist items off and waive a requirement"]);
    expect(html).toContain("This role was written with patterns, so it also takes up new permissions by itself");
    expect(html).toContain("the role will then no longer take up new permissions by itself");
    // A role of plain names says nothing of patterns.
    await resetDb(); await asAdmin(); await roleWith("Plain", ["Roster.Read"]);
    expect(await renderPage(RolesPage)).not.toContain("written with patterns");
  });

  it("deletes a role after saying how many hold it, keeps their other roles, and audits what it was", async () => {
    await asAdmin();
    const r = await roleWith("Uniforms", ["Roster.Read"]);
    const other = await roleWith("Seasons", ["Season.Steps.Read"]);
    const a = await hold(r.id, "a@club.org"), b = await hold(r.id, "b@club.org");
    await db.insert(roleAssignment).values({ roleId: other.id, staffUserId: a.id });
    expect(await renderPage(RolesPage)).toContain("2 people hold this role.");
    expect(await deleteRoleAction(r.id)).toEqual({ ok: true, message: "Deleted." });
    expect((await listRoles()).map((x) => x.name)).not.toContain("Uniforms");
    expect((await db.select().from(roleAssignment).where(eq(roleAssignment.staffUserId, a.id))).map((x) => x.roleId)).toEqual([other.id]);
    const [row] = await audits("role.delete");
    expect(row!.before).toEqual({ name: "Uniforms", include: ["Roster.Read"], exclude: [], members: 2, heldBy: expect.arrayContaining([a.id, b.id]) });
  });

  it("never deletes or changes the built-in Admin role", async () => {
    await asAdmin();
    const id = await adminRoleId();
    expect(await deleteRoleAction(id)).toEqual({ ok: false, errors: ["The Admin role can't be deleted."] });
    expect((await saveRoleChecklistAction(id, "Boss", ["Roster.Read"])).ok).toBe(false);
    expect((await listRoles()).find((x) => x.id === id)?.name).toBe("Admin");
    expect(await renderPage(RolesPage)).not.toContain(`Delete Admin`);
  });

  it("refuses an Admin-only permission, a pattern and values no page sends, and stores nothing", async () => {
    await asAdmin();
    for (const bad of [["Audit.Log.Read"], ["Settings.*"], ["*"], [{}]]) expect((await saveRoleChecklistAction(null, "Sneaky", bad)).ok, JSON.stringify(bad)).toBe(false);
    for (const [id, name, list] of [["not-a-uuid", "X", ["Roster.Read"]], [null, 7, ["Roster.Read"]], [null, "X", "Roster.Read"], [null, "x".repeat(300), ["Roster.Read"]]] as const) {
      expect((await saveRoleChecklistAction(id, name, list)).ok).toBe(false);
    }
    expect(await deleteRoleAction("../../etc")).toEqual({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
    expect((await listRoles()).map((x) => x.name)).toEqual(["Admin"]);
    expect(await audits("role.save")).toEqual([]);
  });

  it("is Admin only: a custom role that holds every permission it can is refused, page and actions alike", async () => {
    const r = await roleWith("Everything", ["*"]);
    asStaff(await hold(r.id, "wide@club.org"));
    expect(await pageOutcome(RolesPage)).toEqual({ redirect: "/refused" });
    await expect(saveRoleChecklistAction(null, "Mine", ["Roster.Read"])).rejects.toBeInstanceOf(AccessDenied);
    await expect(deleteRoleAction(r.id)).rejects.toBeInstanceOf(AccessDenied);
    expect((await listRoles()).map((x) => x.name).sort()).toEqual(["Admin", "Everything"]);
  });

  it("refuses a parent session", async () => {
    asParent((await seedSignedInParent()).identity);
    expect(await pageOutcome(RolesPage)).toEqual({ redirect: "/staff/sign-in" });
    await expect(saveRoleChecklistAction(null, "Mine", ["Roster.Read"])).rejects.toBeInstanceOf(AccessDenied);
  });
});
