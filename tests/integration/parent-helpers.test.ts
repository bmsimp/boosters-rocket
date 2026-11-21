import { describe, it, expect, beforeEach } from "vitest";
import { asParent, asParentChoosing, asRefusedParent, asStaff, fromIp, pageOutcome, redirectOf, renderPage, revalidatedPaths } from "../helpers/signed-in";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parentAuthSession, qboCustomer } from "@/lib/db/schema";
import { setRosterSource } from "@/lib/roster/source";
import { resolveParentSession } from "@/lib/auth/resolve";
import { AccessDenied, parentAction, requireStaffPage } from "@/lib/guards";
import ParentHome from "@/app/(parent)/page";
import { familyOfSession, resetDb, seedGuardian, seedGuardianInFamily, seedParent, seedStaff } from "../helpers/db";
import { addToCache, fam, par, seedShape } from "../helpers/roster-cache";
import { FAMILY_A, FAMILY_B, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { NO_CHANGES, recordOfCustomer, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";

describe("the signed-in parent helpers", () => {
  beforeEach(resetDb);

  it("seeds a family the portal signs the parent in to, with the row's own link pointing at its QuickBooks record", async () => {
    const ana = await seedSignedInParent();
    // The identity carries the app's own family, the record linked to the family's customer, and no QuickBooks id.
    const familyId = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    expect(ana.identity).toMatchObject({ door: "parent", familyId, name: "Ansgar Alderquist", email: "ansgar.alderquist@family-a.example" });
    expect(JSON.stringify(ana.identity)).not.toContain(FAMILY_A.family.qboId);
    expect(ana.identity.families).toEqual([{ guardianId: ana.identity.guardianId, familyId }]);
    const [link] = await db.select().from(guardian).where(eq(guardian.id, ana.identity.guardianId));
    // The row stands on its family record and its own link (stage 3's slice 12b1): neither old copy is written.
    expect(link).toMatchObject({ status: "active", isPrimary: true, parentId: ana.identity.parentId, familyId, familyQboId: null, sourceQboId: null });
    const [own] = await db.select().from(accountingLink).where(eq(accountingLink.guardianId, ana.identity.guardianId));
    expect(own).toMatchObject({ customerId: FAMILY_A.parent.qboId, origin: "carried_over", linkedBy: null });
    expect(own!.syncedToken).not.toBeNull(); // the cache's version of the parent's record, as the import aligned one
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

  it("seeds links the app's own records keep: bringing the records into step again changes neither family's link", async () => {
    const { a, b } = await seedTwoFamilies();
    await syncAppRecords();
    for (const p of [a, b]) {
      const [link] = await db.select().from(guardian).where(eq(guardian.id, p.identity.guardianId));
      expect(link).toMatchObject({ status: "active", disabledReason: null, familyId: p.identity.familyId });
      expect((await db.select().from(accountingLink).where(eq(accountingLink.guardianId, link!.id)))[0]).toMatchObject({ customerId: p.spec.parent.qboId });
      const [session] = await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, p.identity.sessionId));
      const state = await resolveParentSession({ id: session!.id, userId: session!.userId, familyId: session!.familyId });
      expect(state).toEqual({ status: "ok", identity: p.identity });
    }
    expect(await db.select().from(guardian)).toHaveLength(2);
    // And an import of the cache would change nothing they seeded.
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("seedGuardian(), with a roster company: the row in its family's record, linked to its own record, with no import run", async () => {
    await db.transaction((tx) => setRosterSource(tx, "4620000000000009"));
    await seedShape();
    await addToCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com")]);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const rivera = await recordOfCustomer("10", "family");
    const linksBefore = (await db.select().from(accountingLink)).length;
    const row = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    expect(row).toMatchObject({ familyId: rivera, familyQboId: null, sourceQboId: null });
    const [own] = await db.select().from(accountingLink).where(eq(accountingLink.guardianId, row.id));
    expect(own).toMatchObject({ realmId: "4620000000000009", customerId: "11", origin: "carried_over" });
    expect((await db.select().from(accountingLink)).length).toBe(linksBefore + 1);
    // One whose record is its family's own (books with no parent type, a flat member) gets no link of its own.
    const sam = await seedParent({ name: "Sam Rivera", email: "sam@example.com" });
    const samRow = await seedGuardian({ parentId: sam.id, familyQboId: "10", sourceQboId: "10" });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, samRow.id))).toEqual([]);
    // A customer the import hasn't made a record of yet: an inactive one with its link, which a later import makes active.
    const bea = await seedParent({ name: "Bea Birch", email: "bea@example.com" });
    const beaRow = await seedGuardian({ parentId: bea.id, familyQboId: "30" });
    const birch = await recordOfCustomer("30", "family");
    expect(beaRow.familyId).toBe(birch);
    expect((await db.select().from(family).where(eq(family.id, birch)))[0]).toMatchObject({ active: false });
    await addToCache([fam("30", "Birch Family")]);
    expect((await db.select().from(family).where(eq(family.id, birch)))[0]).toMatchObject({ active: true, name: "Birch Family" });
    // A row a change of company closed is in no family, and linked to nothing.
    const old = await seedGuardian({ parentId: ana.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect(old.familyId).toBeNull();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, old.id))).toEqual([]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("seedGuardian(), with no roster company: rows of one familyQboId share one active family record with no link, made again after a reset", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" }), ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    const a1 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" }), b1 = await seedGuardian({ parentId: ben.id, familyQboId: "F1" });
    const a2 = await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F2" });
    expect(a1.familyId).not.toBeNull();
    expect(b1.familyId).toBe(a1.familyId);
    expect(a2.familyId).not.toBe(a1.familyId);
    expect((await db.select().from(family).where(eq(family.id, a1.familyId!)))[0]).toMatchObject({ active: true, name: null });
    expect(await db.select().from(accountingLink)).toEqual([]);
    // A session in F1 names that record.
    expect(await familyOfSession(ana.authUserId, "F1")).toBe(a1.familyId);
    // A row in no family, when asked for.
    const bare = await seedGuardian({ parentId: ben.id, familyId: null });
    expect(bare.familyId).toBeNull();
    // After a reset the record remembered for F1 is gone: a new one is made, active.
    await resetDb();
    const cy = await seedParent({ name: "Cy", email: "cy@example.com" });
    const c1 = await seedGuardian({ parentId: cy.id, familyQboId: "F1" });
    expect(c1.familyId).not.toBe(a1.familyId);
    expect((await db.select().from(family).where(eq(family.id, c1.familyId!)))[0]).toMatchObject({ active: true });
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
