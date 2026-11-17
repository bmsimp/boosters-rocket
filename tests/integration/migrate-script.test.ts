import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

/**
 * deploy/compose.yml's migrate step runs `migrate.mjs --backup-check` (scripts/backup-check.mjs): before it changes a
 * database that already holds data, the last good backup (backup.last_success, which scripts/backup.sh records) must
 * be less than 26 hours old. Each case on the scratch database: empty, nothing to apply, a fresh backup, an old one,
 * none, and the override.
 */
describe("scripts/migrate.mjs --backup-check", { timeout: 120_000 }, () => {
  const HOUR = 3_600_000;
  let folder: string, earlier: string;
  const journal = (dir: string) => JSON.parse(readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries: { when: number; tag: string }[] };
  const ALL = journal(path.resolve("drizzle")).entries.length;
  beforeAll(() => {
    // The migrations as an earlier version shipped them: all but the last two. The real folder then has two to apply.
    folder = mkdtempSync(path.join(tmpdir(), "br-backup-check-"));
    earlier = path.join(folder, "drizzle");
    cpSync(path.resolve("drizzle"), earlier, { recursive: true });
    const j = journal(earlier);
    writeFileSync(path.join(earlier, "meta", "_journal.json"), JSON.stringify({ ...j, entries: j.entries.slice(0, -2) }));
  });
  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await admin(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`);
  }, DATABASE_WORK);

  const admin = async (sql: string) => { const pg = postgres(ADMIN_URL, { max: 1, onnotice: () => {} }); try { await pg.unsafe(sql); } finally { await pg.end(); } };
  const fresh = async () => { await admin(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`); await admin(`CREATE DATABASE ${FRESH}`); };
  const migrate = (o: { dir?: string; check?: boolean; env?: Record<string, string> } = {}) => spawnSync("node", ["scripts/migrate.mjs", ...(o.check === false ? [] : ["--backup-check"])],
    { env: { ...process.env, DATABASE_URL: FRESH_URL, MIGRATE_WITHOUT_RECENT_BACKUP: "", ...(o.dir ? { MIGRATIONS_DIR: o.dir } : {}), ...o.env }, encoding: "utf8" });
  const db = async <T>(f: (pg: postgres.Sql) => Promise<T>) => { const pg = postgres(FRESH_URL, { max: 1, onnotice: () => {} }); try { return await f(pg); } finally { await pg.end(); } };
  const applied = () => db(async (pg) => Number((await pg`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n));
  const backupAt = (at: Date) => db((pg) => pg`insert into setting (key, value) values ('backup.last_success', ${pg.json({ at: at.toISOString(), file: "/backups/booster-rocket-x.dump", bytes: 1 })})
    on conflict (key) do update set value = excluded.value`);
  /** A database an earlier version left: data in it, two migrations of this version still to apply. */
  const earlierVersion = async () => { await fresh(); expect(migrate({ dir: earlier, check: false }).status).toBe(0); expect(await applied()).toBe(ALL - 2); };

  it("never stops a first installation: an empty database has nothing to back up", async () => {
    await fresh();
    const r = migrate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backup check: an empty database (a first installation), so there is nothing to back up yet");
    expect(r.stdout).toContain("migrated");
    expect(await applied()).toBe(ALL);
  }, DATABASE_WORK);

  it("never stops a start with nothing to apply, backup or not", async () => {
    const r = migrate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backup check: nothing to apply");
  });

  it("refuses with no backup recorded, changing nothing, and says the one command that makes one", async () => {
    await earlierVersion();
    const r = migrate();
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("migrated");
    expect(r.stderr).toContain("This version of the portal has 2 changes to make to its database, and no backup of it has been recorded yet.");
    expect(r.stderr).toContain("nothing has been changed and the portal has not started");
    expect(r.stderr).toContain("\n     docker compose run --rm backup --now\n");
    expect(r.stderr).toContain("2. Then start the portal again the way you started it");
    expect(r.stderr).toContain("MIGRATE_WITHOUT_RECENT_BACKUP=yes docker compose up -d");
    expect(r.stderr).not.toMatch(/https?:\/\/|@/); // names no host or address
    expect(await applied()).toBe(ALL - 2);
  }, DATABASE_WORK);

  it("refuses when the last good backup is 26 hours old or more, and says how old", async () => {
    await backupAt(new Date(Date.now() - 27 * HOUR));
    let r = migrate();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/and the last good backup was made 27 hours ago \(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)\./);
    await backupAt(new Date(Date.now() - 26 * HOUR));
    expect(migrate().status).toBe(1);
    // A recorded time well ahead of this clock is not believed.
    await backupAt(new Date(Date.now() + 3 * HOUR));
    r = migrate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is later than this machine's clock");
    expect(await applied()).toBe(ALL - 2);
  });

  it("lets one start through with MIGRATE_WITHOUT_RECENT_BACKUP=yes, and nothing else", async () => {
    await backupAt(new Date(Date.now() - 27 * HOUR));
    for (const value of ["1", "true", "YES", "no"]) expect(migrate({ env: { MIGRATE_WITHOUT_RECENT_BACKUP: value } }).status, value).toBe(1);
    const r = migrate({ env: { MIGRATE_WITHOUT_RECENT_BACKUP: "yes" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backup check: going ahead without a recent backup, as MIGRATE_WITHOUT_RECENT_BACKUP=yes asks");
    expect(r.stdout).toContain("migrated");
    expect(await applied()).toBe(ALL);
  });

  it("goes ahead when the last good backup is less than 26 hours old", async () => {
    await earlierVersion();
    await backupAt(new Date(Date.now() - 25 * HOUR));
    const r = migrate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("backup check: the last good backup was made 25 hours ago");
    expect(r.stdout).toContain("migrated");
    expect(await applied()).toBe(ALL);
  }, DATABASE_WORK);

  it("is not run without --backup-check: the proof of concept backs up first itself", async () => {
    await earlierVersion();
    const r = migrate({ check: false });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("backup check");
    expect(await applied()).toBe(ALL);
  }, DATABASE_WORK);
});
