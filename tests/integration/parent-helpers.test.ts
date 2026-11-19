import { describe, it, expect, beforeEach } from "vitest";
import { asParent, asParentChoosing, asRefusedParent, asStaff, fromIp, pageOutcome, redirectOf, renderPage, revalidatedPaths } from "../helpers/signed-in";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parentAuthSession, qboCustomer } from "@/lib/db/schema";
import { resolveParentSession } from "@/lib/auth/resolve";
import { AccessDenied, parentAction, requireStaffPage } from "@/lib/guards";
import ParentHome from "@/app/(parent)/page";
import { resetDb, seedStaff } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { runReconcile } from "../helpers/reconcile";
import { recordOfCustomer } from "../helpers/app-records";

describe("the signed-in parent helpers", () => {
  beforeEach(resetDb);

  it("seeds a family the portal signs the parent in to, with the link pointing at its QuickBooks record", async () => {
    const ana = await seedSignedInParent();
    // The identity carries the app's own family, the record linked to the family's customer, and no QuickBooks id.
    const familyId = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    expect(ana.identity).toMatchObject({ door: "parent", familyId, name: "Ansgar Alderquist", email: "ansgar.alderquist@family-a.example" });
    expect(JSON.stringify(ana.identity)).not.toContain(FAMILY_A.family.qboId);
    expect(ana.identity.families).toEqual([{ guardianId: ana.identity.guardianId, familyId }]);
    const [link] = await db.select().from(guardian).where(eq(guardian.id, ana.identity.guardianId));
    expect(link).toMatchObject({ status: "active", isPrimary: true, sourceQboId: FAMILY_A.parent.qboId, parentId: ana.identity.parentId, familyQboId: FAMILY_A.family.qboId, familyId });
    const [session] = await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, ana.identity.sessionId));
    expect(session).toMatchObject({ token: ana.session.token, familyId });
    const cached = await db.select().from(qboCustomer).where(eq(qboCustomer.parentQboId, FAMILY_A.family.qboId));
    expect(cached.map((c) => c.displayName).sort()).toEqual(["Ansgar Alderquist", "Aurelio Alderquist", "Azalea Alderquist"]);
  });

  it("seeds two families with nothing in common, and markers that can't be mistaken for each other", async () => {
    const { a, b } = await seedTwoFamilies();
    expect(String(a.identity.familyId)).toBe(String(await recordOfCustomer(FAMILY_A.family.qboId, "family")));
    expect(String(b.identity.familyId)).toBe(String(await recordOfCustomer(FAMILY_B.family.qboId, "family")));
    expect(a.identity.parentId).not.toBe(b.identity.parentId);
    expect(a.spec.students).toHaveLength(2);
    expect(b.spec.students).toHaveLength(2);
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      // Names, QuickBooks ids, the address, the number, and the portal's own ids are all there to be searched for.
      for (const s of [mine.spec.family.name, mine.spec.family.qboId, mine.spec.parent.qboId, mine.spec.parent.name, mine.spec.parent.name.split(" ")[0]!,
        mine.spec.parent.email, mine.spec.parent.phone, ...mine.spec.students.flatMap((x) => [x.qboId, x.name]), mine.identity.parentId, mine.session.token]) {
        expect(mine.markers).toContain(s);
      }
      for (const m of mine.markers) {
        expect(m.length, `"${m}" is too short to search a page for`).toBeGreaterThanOrEqual(6);
        // No marker of one family is part of anything the other family is allowed to see.
        for (const other of theirs.markers) expect(other.toLowerCase()).not.toContain(m.toLowerCase());
      }
    }
  });

  it("seeds what sign-ins from QuickBooks would keep: a reconcile changes neither family's link", async () => {
    const { a, b } = await seedTwoFamilies();
    await runReconcile({ cause: "test" });
    for (const p of [a, b]) {
      const [link] = await db.select().from(guardian).where(eq(guardian.id, p.identity.guardianId));
      expect(link).toMatchObject({ status: "active", disabledReason: null, sourceQboId: p.spec.parent.qboId });
      const [session] = await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, p.identity.sessionId));
      const state = await resolveParentSession({ id: session!.id, userId: session!.userId, familyId: session!.familyId });
      expect(state).toEqual({ status: "ok", identity: p.identity });
    }
    expect(await db.select().from(guardian)).toHaveLength(2);
  });

  it("runs a page and an action as the parent, with the family from the session", async () => {
    const { a, b } = await seedTwoFamilies();
    const whoAmI = parentAction(async (ctx) => ({ family: String(ctx.familyId), ip: ctx.ip }));
    asParent(a.identity);
    expect(await renderPage(ParentHome)).toContain("Hi, Ansgar");
    expect(await whoAmI()).toEqual({ family: String(a.identity.familyId), ip: "203.0.113.50" });
    asParent(b.identity);
    fromIp("198.51.100.7");
    expect(await renderPage(ParentHome)).toContain("Hi, Bettina");
    expect(await whoAmI()).toEqual({ family: String(b.identity.familyId), ip: "198.51.100.7" });
  });

  it("starts every test signed out: the test before this one signed a parent in", async () => {
    expect(await pageOutcome(ParentHome)).toEqual({ redirect: "/sign-in" });
    await expect(parentAction(async () => "reached")()).rejects.toBeInstanceOf(AccessDenied);
    await expect(renderPage(ParentHome)).rejects.toThrow("The page redirected to /sign-in instead of rendering");
    expect(revalidatedPaths()).toEqual([]);
  });

  it("gives the other session states a page can meet", async () => {
    const ana = await seedSignedInParent();
    asParentChoosing(ana.identity);
    expect(await pageOutcome(ParentHome)).toEqual({ redirect: "/choose-family" });
    asRefusedParent();
    expect(await pageOutcome(ParentHome)).toEqual({ redirect: "/refused" });
  });

  it("runs as a staff member, with permissions read from the database", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Min", admin: true });
    const plain = await seedStaff({ email: "plain@club.org", name: "Pla In" });
    asStaff(admin);
    expect(await requireStaffPage("Roster.Read")).toMatchObject({ door: "staff", staffUserId: admin.id, email: "admin@club.org", ip: "203.0.113.50" });
    asStaff(plain);
    expect(await redirectOf(requireStaffPage("Roster.Read"))).toBe("/refused");
    expect((await db.select().from(auditLog)).filter((r) => r.action === "access.refused")).toMatchObject([{ actorId: plain.id, permission: "Roster.Read", ip: "203.0.113.50" }]);
  });

  it("records the paths a server action revalidates", () => {
    revalidatePath("/staff/roster");
    revalidatePath("/");
    expect(revalidatedPaths()).toEqual(["/staff/roster", "/"]);
  });
});
