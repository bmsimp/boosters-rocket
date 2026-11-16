import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { db } from "@/lib/db/client";
import { auditLog, staffAuthUser } from "@/lib/db/schema";
import { recordSignin, recordSignout } from "@/lib/auth/signin-audit";
import { getStaffAuth } from "@/lib/auth/staff-auth";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { resetDb, seedParent } from "../helpers/db";
import { env } from "@/env";

let staffAuth: Awaited<ReturnType<typeof getStaffAuth>>;
let parentAuth: Awaited<ReturnType<typeof getParentAuth>>;
beforeAll(async () => { staffAuth = await getStaffAuth(); parentAuth = await getParentAuth(); });
type Door = typeof staffAuth | typeof parentAuth;

/** Signs a real session in the door's database and POSTs to its /sign-out endpoint with the signed cookie. */
async function signOutThroughBetterAuth(door: Door, userId: string, ip: string) {
  const ctx = await door.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(session.token).digest("base64");
  const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${sig}`)}`;
  const res = await door.handler(new Request(`${env.APP_URL}${ctx.options.basePath}/sign-out`, {
    method: "POST",
    headers: { cookie, origin: env.APP_URL, "content-type": "application/json", "cf-connecting-ip": ip },
    body: "{}",
  }));
  expect(res.status).toBe(200);
}

describe("sign-in audit", () => {
  beforeEach(resetDb);

  it("records a staff sign-in with the email, auth user and Cloudflare client IP", async () => {
    await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true });
    await recordSignin("staff", { userId: "s1", ipAddress: "" },
      { headers: new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 10.0.0.2" }) });
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({ door: "staff", action: "signin", actorLabel: "sam@club.org", targetType: "staff_auth_user", targetId: "s1", ip: "203.0.113.7" });
  });

  it("is wired to staff session creation, and takes the address from the portal's own reading of it", () => {
    for (const a of [staffAuth]) {
      expect(typeof a.options.databaseHooks?.session?.create?.after).toBe("function");
      // Never a header a deployment or a client names: the one the portal writes itself (tests/integration/client-address.test.ts).
      expect(a.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(["x-booster-client-ip"]);
    }
  });

  it("records a sign-out with the email, auth user and IP, and ignores deletions that are not a sign-out", async () => {
    await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true });
    await recordSignout("staff", { userId: "s1" }, { path: "/get-session", headers: new Headers({ "cf-connecting-ip": "203.0.113.7" }) });
    expect(await db.select().from(auditLog)).toHaveLength(0);
    await recordSignout("staff", { userId: "s1" }, { path: "/sign-out", headers: new Headers({ "cf-connecting-ip": "203.0.113.7" }) });
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({ door: "staff", action: "signout", actorLabel: "sam@club.org", targetType: "staff_auth_user", targetId: "s1", ip: "203.0.113.7" });
  });

  it("is wired to session deletion on both doors", () => {
    for (const a of [staffAuth, parentAuth]) expect(typeof a.options.databaseHooks?.session?.delete?.after).toBe("function");
  });

  it("records a sign-out through the real staff /sign-out endpoint", async () => {
    await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true });
    await signOutThroughBetterAuth(staffAuth, "s1", "203.0.113.9");
    const rows = (await db.select().from(auditLog)).filter((r) => r.action === "signout");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "staff", actorLabel: "sam@club.org", targetId: "s1", ip: "203.0.113.9" });
  });

  it("records a sign-out through the real parent /sign-out endpoint", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await signOutThroughBetterAuth(parentAuth, p.authUserId, "198.51.100.8");
    const rows = (await db.select().from(auditLog)).filter((r) => r.action === "signout");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "parent", actorId: p.id, actorLabel: "ana@example.com", targetType: "parent", targetId: p.id, ip: "198.51.100.8" });
  });
});
