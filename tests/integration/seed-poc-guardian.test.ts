import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db/client";
import { guardian, auditLog } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const TEST_URL = "postgres://booster:booster@localhost:5433/booster_test";
const run = (appUrl: string, args: string[]) => spawnSync("node", ["scripts/seed-poc-guardian.mjs", ...args],
  { env: { ...process.env, DATABASE_URL: TEST_URL, APP_URL: appUrl }, encoding: "utf8" });
const ARGS = ["--name", "Test Parent", "--email", "Test.Parent@Example.com", "--object-id", "11111111-2222-3333-4444-555555555555", "--family", "POC-FAMILY-1"];

describe("scripts/seed-poc-guardian.mjs", () => {
  beforeEach(resetDb);

  it("inserts one invited guardian and a guardian.seed audit row", async () => {
    const r = run("https://portaltest.rhinoautomator.com", ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/seeded guardian [0-9a-f-]{36}/);
    const rows = await db.select().from(guardian);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Test Parent", email: "test.parent@example.com", familyQboId: "POC-FAMILY-1",
      identityObjectId: "11111111-2222-3333-4444-555555555555", status: "invited", isPrimary: true });
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ door: "system", action: "guardian.seed", targetType: "guardian", targetId: rows[0]!.id });
  });

  it("refuses outside the POC address and changes nothing", async () => {
    const r = run("https://portal.fznband.org", ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only runs against the portaltest proof of concept");
    expect(await db.select().from(guardian)).toHaveLength(0);
  });

  it("refuses a second guardian with the same object id, plainly, and writes no audit row", async () => {
    expect(run("https://portaltest.rhinoautomator.com", ARGS).status).toBe(0);
    const again = run("https://portaltest.rhinoautomator.com", ARGS);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("A guardian with that object id already exists");
    expect(again.stderr).not.toMatch(/\bat \S+\.(m?js|ts):\d+/); // no stack trace
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("refuses missing arguments", () => {
    const r = run("https://portaltest.rhinoautomator.com", ["--name", "X"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage:");
  });
});
