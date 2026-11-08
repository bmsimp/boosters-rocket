import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog, staffAuthUser, parentAuthUser } from "@/lib/db/schema";
import { recordSignin } from "@/lib/auth/signin-audit";
import { staffAuth } from "@/lib/auth/staff-auth";
import { parentAuth } from "@/lib/auth/parent-auth";
import { resetDb } from "../helpers/db";

describe("sign-in audit", () => {
  beforeEach(resetDb);

  it("records a staff sign-in with the email, auth user and Cloudflare client IP", async () => {
    await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true });
    await recordSignin("staff", { userId: "s1", ipAddress: "" },
      { headers: new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 10.0.0.2" }) });
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({ door: "staff", action: "signin", actorLabel: "sam@club.org", targetType: "staff_auth_user", targetId: "s1", ip: "203.0.113.7" });
  });

  it("records a parent sign-in, falling back to the session's IP when there are no headers", async () => {
    await db.insert(parentAuthUser).values({ id: "p1", name: "Ana", email: "ana@example.com", emailVerified: true });
    await recordSignin("parent", { userId: "p1", ipAddress: "198.51.100.4" }, null);
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({ door: "parent", action: "signin", actorLabel: "ana@example.com", targetType: "parent_auth_user", targetId: "p1", ip: "198.51.100.4" });
  });

  it("is wired to session creation on both doors, trusting only cf-connecting-ip for the IP", () => {
    for (const a of [staffAuth, parentAuth]) {
      expect(typeof a.options.databaseHooks?.session?.create?.after).toBe("function");
      expect(a.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(["cf-connecting-ip"]);
    }
  });
});
