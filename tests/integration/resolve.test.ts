import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { staffAuthUser, staffAuthAccount, staffUser, auditLog } from "@/lib/db/schema";
import { resolveStaff } from "@/lib/auth/resolve";
import { resetDb, seedStaff } from "../helpers/db";
import { eq } from "drizzle-orm";

async function staffAuthRow(id: string, email: string, provider: "microsoft" | "google", verified = true) {
  await db.insert(staffAuthUser).values({ id, name: email, email, emailVerified: verified });
  await db.insert(staffAuthAccount).values({ id: `acc-${id}`, accountId: `sub-${id}`, providerId: provider, userId: id });
}

describe("resolveStaff", () => {
  beforeEach(resetDb);

  it("binds an invited staff user on first sign-in, matching email case- and space-insensitively", async () => {
    const s = await seedStaff({ email: "Pat@Club.org ", status: "invited" });
    await staffAuthRow("u1", " PAT@Club.org ", "google");
    const id = await resolveStaff("u1");
    expect(id).toMatchObject({ door: "staff", staffUserId: s.id });
    const [row] = await db.select().from(staffUser).where(eq(staffUser.id, s.id));
    expect(row).toMatchObject({ authUserId: "u1", status: "active" });
    const [bind] = (await db.select().from(auditLog)).filter((a) => a.action === "staff.bind");
    expect(bind).toMatchObject({ door: "staff", actorId: s.id, targetId: s.id, before: { status: "invited", authUserId: null }, after: { status: "active", authUserId: "u1" } });
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

  it("records the request's address on a refused sign-in and on a first sign-in's bind (v1 spec §13)", async () => {
    await staffAuthRow("u10", "stranger@example.com", "google");
    await resolveStaff("u10", "203.0.113.10");
    const s = await seedStaff({ email: "pat@club.org", status: "invited" });
    await staffAuthRow("u11", "pat@club.org", "microsoft");
    expect(await resolveStaff("u11", "203.0.113.11")).toMatchObject({ staffUserId: s.id });
    const rows = await db.select().from(auditLog);
    expect(rows.find((a) => a.action === "signin.refused")).toMatchObject({ targetId: "u10", ip: "203.0.113.10" });
    expect(rows.find((a) => a.action === "staff.bind")).toMatchObject({ targetId: s.id, ip: "203.0.113.11" });
  });
});
