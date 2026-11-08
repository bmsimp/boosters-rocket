import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import postgres from "postgres";

const ADMIN_URL = "postgres://booster:booster@localhost:5433/booster";
const FRESH = "booster_migrate_script_test";
const FRESH_URL = `postgres://booster:booster@localhost:5433/${FRESH}`;

describe("scripts/migrate.mjs", () => {
  beforeAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH}`);
    await admin.unsafe(`CREATE DATABASE ${FRESH}`);
    await admin.end();
  });
  afterAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`);
    await admin.end();
  });

  it("migrates an empty database, including the built-in Admin role", async () => {
    const out = execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: FRESH_URL }, encoding: "utf8" });
    expect(out).toContain("migrated");
    const pg = postgres(FRESH_URL, { max: 1, onnotice: () => {} });
    const [r] = await pg`select key, builtin from role where key = 'admin'`;
    await pg.end();
    expect(r).toEqual({ key: "admin", builtin: true });
  });

  it("is safe to run again", () => {
    const out = execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: FRESH_URL }, encoding: "utf8" });
    expect(out).toContain("migrated");
  });

  it("exits non-zero when the database can't be reached", () => {
    const r = spawnSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: "postgres://nobody:nope@localhost:1/none" }, encoding: "utf8" });
    expect(r.status).toBe(1);
  });
});
