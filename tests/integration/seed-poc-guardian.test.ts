import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, auditLog } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const TEST_URL = "postgres://booster:booster@localhost:5433/booster_test";
const run = (appUrl: string, args: string[]) => spawnSync("node", ["scripts/seed-poc-guardian.mjs", ...args],
  { env: { ...process.env, DATABASE_URL: TEST_URL, APP_URL: appUrl }, encoding: "utf8" });
const ARGS = ["--name", "Test Parent", "--email", "Test.Parent@Example.com", "--family", "POC-FAMILY-1"];

describe("scripts/seed-poc-guardian.mjs", () => {
  beforeEach(resetDb);

  it("inserts one invited guardian and a guardian.seed audit row", async () => {
    const r = run("https://portaltest.rhinoautomator.com", ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/seeded guardian [0-9a-f-]{36}/);
    const people = await db.select().from(parent);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ name: "Test Parent", email: "test.parent@example.com" });
    const rows = await db.select().from(guardian);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ familyQboId: "POC-FAMILY-1", status: "invited", isPrimary: true, parentId: people[0]!.id });
    const users = await db.select().from(parentAuthUser);
    expect(users).toHaveLength(1);
    expect(users[0]!.parentId).toBe(people[0]!.id);
    const audits = await db.select().from(auditLog).orderBy(auditLog.id);
    expect(audits.map((a) => a.action)).toEqual(["parent.seed", "guardian.seed"]);
  });

  it("refuses outside the POC address and changes nothing", async () => {
    const r = run("https://portal.fznband.org", ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only runs against the portaltest proof of concept");
    expect(await db.select().from(guardian)).toHaveLength(0);
  });

  it("refuses a second row for the same person and family, plainly, and writes no audit row", async () => {
    expect(run("https://portaltest.rhinoautomator.com", ARGS).status).toBe(0);
    const again = run("https://portaltest.rhinoautomator.com", ARGS);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("That person is already a guardian in that family");
    expect(again.stderr).not.toMatch(/\bat \S+\.(m?js|ts):\d+/); // no stack trace
    expect(await db.select().from(auditLog)).toHaveLength(2);
  });

  it("links the same person into a second family without a second person", async () => {
    expect(run("https://portaltest.rhinoautomator.com", ARGS).status).toBe(0);
    expect(run("https://portaltest.rhinoautomator.com", [...ARGS.slice(0, 4), "--family", "POC-FAMILY-2"]).status).toBe(0);
    expect(await db.select().from(parent)).toHaveLength(1);
    expect((await db.select().from(guardian)).map((g) => g.familyQboId).sort()).toEqual(["POC-FAMILY-1", "POC-FAMILY-2"]);
  });

  it("refuses missing arguments", () => {
    const r = run("https://portaltest.rhinoautomator.com", ["--name", "X"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage:");
  });
});
