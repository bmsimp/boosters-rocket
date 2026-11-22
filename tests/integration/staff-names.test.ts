import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, asParent, renderPage, pageOutcome } from "../helpers/signed-in";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, role, roleAssignment, roleRule, staffUser } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import PeoplePage from "@/app/staff/(app)/settings/staff/page";
import { renameStaffAction, renameMyselfAction } from "@/app/staff/(app)/settings/staff/actions";
import { parseStaffName } from "@/lib/staff/names";
import { resetDb, seedStaff } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";

const nameOf = async (id: string) => (await db.select().from(staffUser).where(eq(staffUser.id, id)))[0]!.name;
const audits = async () => db.select().from(auditLog).where(eq(auditLog.action, "staff.name.save"));
async function staffWith(email: string, ...patterns: string[]) {
  const s = await seedStaff({ email, name: email });
  if (patterns.length) {
    const [r] = await db.insert(role).values({ key: `r-${email}`, name: `Role ${email}` }).returning();
    await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  }
  return s;
}

describe("staff names", () => {
  beforeEach(resetDb);

  it("takes a name trimmed, 1 to 100 characters, on one line", () => {
    expect(parseStaffName("  Ana Rivera ")).toEqual({ ok: true, name: "Ana Rivera" });
    expect(parseStaffName("a".repeat(100))).toEqual({ ok: true, name: "a".repeat(100) });
    expect(parseStaffName("a".repeat(101)).ok).toBe(false);
    expect(parseStaffName("   ")).toEqual({ ok: false, errors: ["Enter a name."] });
    expect(parseStaffName("Ana\nRivera").ok).toBe(false);
    expect(parseStaffName(42).ok).toBe(false);
  });

  it("lets an Admin change anyone's name, audited with before and after", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "admin@club.org", admin: true });
    const other = await seedStaff({ email: "ben@club.org", name: "ben@club.org" });
    asStaff(admin);
    expect(await renameStaffAction(other.id, "  Ben Okafor ")).toEqual({ ok: true, message: "Saved." });
    expect(await nameOf(other.id)).toBe("Ben Okafor");
    const [row] = await audits();
    expect(row).toMatchObject({ actorId: admin.id, permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: other.id,
      before: { name: "ben@club.org" }, after: { name: "Ben Okafor" } });
    expect(await renameStaffAction(other.id, "")).toEqual({ ok: false, errors: ["Enter a name."] });
    expect(await renameStaffAction("not-an-id", "X")).toMatchObject({ ok: false });
    expect(await nameOf(other.id)).toBe("Ben Okafor");
    expect(await audits()).toHaveLength(1);
  });

  it("lets each staff member change their own name, and only their own, whatever else they may do", async () => {
    const me = await staffWith("cam@club.org");
    const other = await staffWith("dee@club.org");
    asStaff(me);
    expect(await renameMyselfAction("Cam Lee")).toEqual({ ok: true, message: "Saved." });
    expect(await nameOf(me.id)).toBe("Cam Lee");
    expect(await nameOf(other.id)).toBe("dee@club.org");
    const [row] = await audits();
    expect(row).toMatchObject({ actorId: me.id, permission: null, targetId: me.id, before: { name: "cam@club.org" }, after: { name: "Cam Lee" } });
    // Someone who may only read the staff list can't change another person's name.
    await expect(renameStaffAction(other.id, "Nope")).rejects.toBeInstanceOf(AccessDenied);
    expect(await nameOf(other.id)).toBe("dee@club.org");
  });

  it("refuses a name change from a parent session or with no session, and changes nothing", async () => {
    const s = await seedStaff({ email: "eve@club.org", name: "Eve" });
    await expect(renameMyselfAction("X")).rejects.toBeInstanceOf(AccessDenied);
    asParent((await seedSignedInParent()).identity);
    await expect(renameMyselfAction("X")).rejects.toBeInstanceOf(AccessDenied);
    await expect(renameStaffAction(s.id, "X")).rejects.toBeInstanceOf(AccessDenied);
    expect(await pageOutcome(PeoplePage)).toEqual({ redirect: "/staff/sign-in" });
    expect(await nameOf(s.id)).toBe("Eve");
  });

  it("shows each person's roles as ticks with their own Save, and a quieter Turn off sign-in, to an Admin", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    await seedStaff({ email: "ben@club.org", name: "Ben Okafor" });
    asStaff(admin);
    const html = await renderPage(PeoplePage);
    expect(html).not.toContain("<details");
    expect(html).toContain("<legend>Roles for Ben Okafor</legend>");
    expect(html).toMatch(/<button class="btn btn-line"[^>]*>Save roles<span class="visually-hidden"> for Ben Okafor/);
    expect(html).toMatch(/<button type="button" class="btn btn-quiet"[^>]*>Turn off sign-in/);
    expect(html).toContain("Change my name");
    expect(html).toContain("Change name<span class=\"visually-hidden\"> for Ben Okafor");
  });

  it("shows someone who may only read the list each person's roles in words, and a way to change their own name only", async () => {
    const me = await staffWith("reader@club.org", "Staff.Users.Read");
    await seedStaff({ email: "ben@club.org", name: "Ben Okafor" });
    asStaff(me);
    const html = await renderPage(PeoplePage);
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Turn off sign-in");
    expect(html).toContain("Change my name");
    expect(html).not.toContain("Change name<");
  });
});
