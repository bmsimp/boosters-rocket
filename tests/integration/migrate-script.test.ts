import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import postgres from "postgres";
import { adminDatabaseUrl, scratchDatabase } from "../setup/database-url";

// On the run's own server, named after this file's database (the run's, or its worker's), so two runs, or two workers
// of one run, never drop each other's scratch database.
const ADMIN_URL = adminDatabaseUrl();
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: with
// other runs and workers busy, that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: FRESH, url: FRESH_URL } = scratchDatabase("migrate_script");

describe("scripts/migrate.mjs", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH}`);
    await admin.unsafe(`CREATE DATABASE ${FRESH}`);
    await admin.end();
  }, DATABASE_WORK);
  afterAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`);
    await admin.end();
  }, DATABASE_WORK);

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
