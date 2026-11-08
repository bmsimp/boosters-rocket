import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { staffAuthUser, staffAuthAccount, parentAuthUser, staffUser, auditLog } from "@/lib/db/schema";
import { resolveStaff, resolveGuardian } from "@/lib/auth/resolve";
import { resetDb, seedStaff, seedGuardian } from "../helpers/db";
import { eq } from "drizzle-orm";

async function staffAuthRow(id: string, email: string, provider: "microsoft" | "google", verified = true) {
  await db.insert(staffAuthUser).values({ id, name: email, email, emailVerified: verified });
  await db.insert(staffAuthAccount).values({ id: `acc-${id}`, accountId: `sub-${id}`, providerId: provider, userId: id });
}

describe("resolveStaff", () => {
  beforeEach(resetDb);

  it("binds an invited staff user on first sign-in, matching email case- and space-insensitively", async () => {
    const s = await seedStaff({ email: "Pat@Club.org ", status: "invited" });
    await staffAuthRow("u1", "pat@club.org", "google");
    const id = await resolveStaff("u1");
    expect(id).toMatchObject({ door: "staff", staffUserId: s.id });
    const [row] = await db.select().from(staffUser).where(eq(staffUser.id, s.id));
    expect(row).toMatchObject({ authUserId: "u1", status: "active" });
  });

  it("refuses an unknown email", async () => {
    await staffAuthRow("u2", "stranger@example.com", "google");
    expect(await resolveStaff("u2")).toBeNull();
  });

  it("refuses an unverified Google email", async () => {
    await seedStaff({ email: "pat@club.org", status: "invited" });
    await staffAuthRow("u3", "pat@club.org", "google", false);
    expect(await resolveStaff("u3")).toBeNull();
  });

  it("refuses a disabled staff user on their next request", async () => {
    const s = await seedStaff({ email: "pat@club.org", status: "active" });
    await staffAuthRow("u4", "pat@club.org", "microsoft");
    expect(await resolveStaff("u4")).not.toBeNull();
    await db.update(staffUser).set({ status: "disabled" }).where(eq(staffUser.id, s.id));
    expect(await resolveStaff("u4")).toBeNull();
  });

  it("does not rebind a staff user already bound to another auth user", async () => {
    await seedStaff({ email: "pat@club.org", status: "invited" });
    await staffAuthRow("u5", "pat@club.org", "google");
    await resolveStaff("u5");
    await db.insert(staffAuthUser).values({ id: "u6", name: "x", email: "pat@club.org", emailVerified: true });
    await db.insert(staffAuthAccount).values({ id: "acc-u6", accountId: "sub-u6", providerId: "microsoft", userId: "u6" });
    expect(await resolveStaff("u6")).toBeNull();
  });

  it("audits a refused staff sign-in", async () => {
    await staffAuthRow("u9", "stranger@example.com", "google");
    await resolveStaff("u9");
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("signin.refused");
  });
});

describe("resolveGuardian", () => {
  beforeEach(resetDb);

  it("resolves by the External ID object id and activates an invited guardian", async () => {
    const g = await seedGuardian({ name: "Ana Ramirez", familyQboId: "123", objectId: "oid-1", status: "invited" });
    await db.insert(parentAuthUser).values({ id: "p1", name: "Ana", email: "ana@example.com", emailVerified: true, objectId: "oid-1" });
    expect(await resolveGuardian("p1")).toMatchObject({ door: "parent", guardianId: g.id, familyQboId: "123" });
  });

  it("refuses a parent auth user with no matching guardian, or a disabled one", async () => {
    await db.insert(parentAuthUser).values({ id: "p2", name: "X", email: "x@example.com", emailVerified: true, objectId: "oid-unknown" });
    expect(await resolveGuardian("p2")).toBeNull();
    await seedGuardian({ name: "Leo Dad", familyQboId: "9", objectId: "oid-3", status: "disabled" });
    await db.insert(parentAuthUser).values({ id: "p3", name: "L", email: "l@example.com", emailVerified: true, objectId: "oid-3" });
    expect(await resolveGuardian("p3")).toBeNull();
  });

  it("never resolves a parent identity from an email match alone", async () => {
    await seedGuardian({ name: "Ana Ramirez", familyQboId: "123", objectId: "oid-1" });
    await db.insert(parentAuthUser).values({ id: "p4", name: "Ana", email: "ana.ramirez@example.com", emailVerified: true, objectId: null });
    expect(await resolveGuardian("p4")).toBeNull();
  });
});
