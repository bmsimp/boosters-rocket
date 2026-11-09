import { describe, it, expect, beforeEach } from "vitest";
import { claimBootstrapAdmin } from "@/lib/auth/bootstrap";
import { db } from "@/lib/db/client";
import { roleAssignment, auditLog } from "@/lib/db/schema";
import { updateSetupState } from "@/lib/setup/state";
import { resetDb, seedStaff } from "../helpers/db";

describe("claimBootstrapAdmin", () => {
  beforeEach(async () => {
    await resetDb();
    await updateSetupState({ status: "open", step: "admin", adminEmail: "first.admin@club.org" });
  });

  it("matches the Admin email whatever its case", async () => {
    expect(await claimBootstrapAdmin("  FIRST.Admin@Club.org ")).not.toBeNull();
  });

  it("does nothing once setup is finished", async () => {
    await updateSetupState({ status: "finished" });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
  });

  it("does nothing before the Admin step", async () => {
    await updateSetupState({ step: "parent" });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
  });

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

  it("still runs when the only Admin holder is an unredeemed invite", async () => {
    await seedStaff({ email: "invited@club.org", admin: true, status: "invited" });
    expect(await claimBootstrapAdmin("first.admin@club.org")).not.toBeNull();
  });

  it("lets exactly one of two racing sign-ins win", async () => {
    const results = await Promise.all([claimBootstrapAdmin("first.admin@club.org"), claimBootstrapAdmin("first.admin@club.org")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
  });
});
