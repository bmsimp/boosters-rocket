import { describe, it, expect, beforeEach, vi } from "vitest";
import { claimBootstrapAdmin } from "@/lib/auth/bootstrap";
import { db } from "@/lib/db/client";
import { roleAssignment, auditLog } from "@/lib/db/schema";
import { resetDb, seedStaff } from "../helpers/db";

vi.mock("@/env", async (orig) => {
  const real = await orig<typeof import("@/env")>();
  return { ...real, env: { ...real.env, BOOTSTRAP_ADMIN_EMAIL: "First.Admin@Club.org" } };
});

describe("claimBootstrapAdmin", () => {
  beforeEach(resetDb);

  it("makes the matching first sign-in Admin and audits it", async () => {
    const id = await claimBootstrapAdmin("first.admin@club.org");
    expect(id).not.toBeNull();
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
    expect((await db.select().from(auditLog))[0]).toMatchObject({ action: "admin.bootstrap", door: "system" });
  });

  it("refuses any other email", async () => {
    expect(await claimBootstrapAdmin("someone@club.org")).toBeNull();
  });

  it("is ignored once an admin exists", async () => {
    await seedStaff({ email: "existing@club.org", admin: true });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
  });

  it("is ignored once an admin exists, even when the email already belongs to a staff user", async () => {
    await seedStaff({ email: "existing@club.org", admin: true });
    await seedStaff({ email: "first.admin@club.org" });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
  });

  it("lets exactly one of two racing sign-ins win", async () => {
    const results = await Promise.all([claimBootstrapAdmin("first.admin@club.org"), claimBootstrapAdmin("first.admin@club.org")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
  });
});
