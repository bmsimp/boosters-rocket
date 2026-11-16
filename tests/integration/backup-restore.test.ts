import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { BACKUP_KEY, lastBackup } from "@/lib/health/backup";
import { adminDatabaseUrl, databaseName, scratchDatabase } from "../setup/database-url";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";
import { seedTwoFamilies } from "../helpers/parent";
import { seedRosterRead } from "../helpers/roster-cache";

/**
 * The restore that has been carried out (v1 spec §14): scripts/backup.sh really dumps this run's database, and
 * scripts/restore.sh really loads the dump into a scratch database, which is then compared with the original table
 * by table and row by row.
 *
 * The scripts reach Postgres the way an operator's would: through the database's container when this run's database
 * lives in one (the development machine), or with the pg_dump on this machine and PGHOST and its friends (CI, where
 * Postgres is a service). With neither, the test fails; it is never skipped.
 */
const RUN_URL = process.env.DATABASE_URL!;
const SOURCE = databaseName(RUN_URL);
const { name: SCRATCH, url: SCRATCH_URL } = scratchDatabase("restore");
const BACKUP = path.resolve("scripts/backup.sh"), RESTORE = path.resolve("scripts/restore.sh");
const DUMP_NAME = /^booster-rocket-\d{8}T\d{6}Z\.dump$/;

function reach(): Record<string, string> {
  const u = new URL(RUN_URL);
  const user = decodeURIComponent(u.username);
  const container = process.env.BR_TEST_DB_CONTAINER ?? "booster-rocket-db-1";
  const inContainer = spawnSync("docker", ["exec", container, "psql", "-U", user, "--no-password", "-d", SOURCE, "-Atqc", "select 1"], { encoding: "utf8" });
  if (inContainer.status === 0 && inContainer.stdout.trim() === "1") return { BR_DB_CONTAINER: container, BR_DB_USER: user };
  if (spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).status === 0) {
    return { BR_DB_CONTAINER: "", PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: user, PGPASSWORD: decodeURIComponent(u.password) };
  }
  throw new Error(`The backup test can't reach Postgres's own tools: the container "${container}" doesn't hold the database "${SOURCE}", and pg_dump isn't installed here. Install the PostgreSQL client tools (16 or newer), or set BR_TEST_DB_CONTAINER.`);
}

let via: Record<string, string>;
let dir: string;
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...via, BR_DB_NAME: SOURCE, BR_DB_WAIT: "20", ...env } });
const dumps = () => readdirSync(dir).filter((f) => DUMP_NAME.test(f)).sort();

/** Everything a database holds, as text: its tables, columns, indexes, constraints and sequences, and every row. */
async function everythingIn(url: string) {
  const pg = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const mine = pg`n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_%'`;
    const tables = await pg<{ s: string; t: string }[]>`select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and ${mine} order by 1, 2`;
    const columns = await pg`select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema not in ('pg_catalog', 'information_schema') order by 1, 2, ordinal_position`;
    const indexes = await pg`select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2, 3`;
    const constraints = await pg`select n.nspname, c.conrelid::regclass::text as on_table, c.conname, pg_get_constraintdef(c.oid) as def
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace where ${mine} order by 1, 2, 3`;
    const sequences = await pg`select schemaname, sequencename, last_value from pg_sequences where schemaname not in ('pg_catalog', 'information_schema') order by 1, 2`;
    const rows: Record<string, { count: number; rows: string[] }> = {};
    for (const { s, t } of tables) {
      const all = await pg<{ r: string }[]>`select x::text as r from ${pg(s)}.${pg(t)} x order by 1`;
      rows[`${s}.${t}`] = { count: all.length, rows: all.map((x) => x.r) };
    }
    return { tables: tables.map((x) => `${x.s}.${x.t}`), columns: [...columns], indexes: [...indexes], constraints: [...constraints], sequences: [...sequences], rows };
  } finally { await pg.end({ timeout: 5 }); }
}

async function dropScratch() {
  const admin = postgres(adminDatabaseUrl(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH}_restoring"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${SCRATCH}"`);
  } finally { await admin.end({ timeout: 5 }); }
}

describe("backup and restore, really done", { timeout: 180_000 }, () => {
  let before: Awaited<ReturnType<typeof everythingIn>>;
  let dump: string;

  beforeAll(async () => {
    via = reach();
    dir = mkdtempSync(path.join(tmpdir(), "br-backup-"));
    await dropScratch();
    await resetDb();
    // A portal with something in every kind of table: two families with sessions and money, staff, mail with a sealed
    // password's worth of settings, a roster read and audit rows.
    await seedTwoFamilies();
    await seedStaff({ email: "admin@club.org", admin: true });
    await seedWorkingMail();
    await seedRosterRead({ realmId: "9130000000000001" });
    await db.insert(auditLog).values({ door: "staff", actorLabel: "admin@club.org", action: "parent.block", targetType: "parent", targetId: "p1", after: { reason: "a note staff wrote" }, ip: "203.0.113.7" });
  }, 120_000);
  afterAll(async () => { await dropScratch(); rmSync(dir, { recursive: true, force: true }); }, 60_000);

  it("backs up the database into the folder, says what else to keep, and prints no secret", async () => {
    before = await everythingIn(RUN_URL);
    expect(before.tables.length).toBeGreaterThan(20);
    expect(before.rows["public.parent"]!.count).toBeGreaterThanOrEqual(2);
    const r = run(BACKUP, [dir]);
    expect(r.status, r.stderr).toBe(0);
    expect(dumps()).toHaveLength(1);
    dump = path.join(dir, dumps()[0]!);
    expect(statSync(dump).size).toBeGreaterThan(1000);
    expect(readdirSync(dir).filter((f) => f.includes("partial"))).toEqual([]);
    const out = r.stdout + r.stderr;
    expect(out).toContain(`Backup written: ${dir}/${dumps()[0]}`);
    expect(out).toMatch(/SETTINGS_ENCRYPTION_KEY/);
    expect(out).toMatch(/somewhere other than this server/);
    for (const secret of [process.env.BETTER_AUTH_SECRET!, process.env.SETTINGS_ENCRYPTION_KEY!, "postgres://", "PGPASSWORD"]) expect(out).not.toContain(secret);
  });

  it("records when it succeeded, where the health page reads it", async () => {
    const [row] = await db.select().from(setting).where(eq(setting.key, BACKUP_KEY));
    expect(row?.value).toMatchObject({ file: path.basename(dump), bytes: statSync(dump).size });
    const last = await lastBackup();
    expect(last).toMatchObject({ file: path.basename(dump), bytes: statSync(dump).size });
    expect(Math.abs(Date.now() - Date.parse(last!.at))).toBeLessThan(120_000);
  });

  it("restores into a database that doesn't exist yet, and everything in it is the same", async () => {
    const r = run(RESTORE, [dump, SCRATCH]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`into the database ${SCRATCH} (${before.tables.length} tables)`);
    expect(r.stdout).toMatch(/open Health/);
    const after = await everythingIn(SCRATCH_URL);
    expect(after.tables).toEqual(before.tables);
    expect(after.columns).toEqual(before.columns);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.constraints).toEqual(before.constraints);
    expect(after.sequences).toEqual(before.sequences);
    for (const t of before.tables) expect(after.rows[t], t).toEqual(before.rows[t]);
    // The sealed settings and the audit row with a staff note came across byte for byte (they are in the rows above);
    // and the drizzle schema with them, so a later migrate starts from the right place.
    expect(before.tables).toContain("drizzle.__drizzle_migrations");
    expect(JSON.stringify(after.rows["public.audit_log"])).toContain("a note staff wrote");
  });

  it("refuses a database that already holds tables, and changes nothing in it", async () => {
    const scratch = postgres(SCRATCH_URL, { max: 1 });
    try { await scratch`insert into setting (key, value) values ('made.after.restore', '"still here"'::jsonb)`; } finally { await scratch.end({ timeout: 5 }); }
    const r = run(RESTORE, [dump, SCRATCH]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`The database ${SCRATCH} already holds ${before.tables.length} tables. Nothing was changed.`);
    expect(r.stderr).toContain("--replace");
    const after = await everythingIn(SCRATCH_URL);
    expect(JSON.stringify(after.rows["public.setting"])).toContain("made.after.restore");
  });

  it("refuses to replace a database that is in use", async () => {
    const held = postgres(SCRATCH_URL, { max: 1 });
    try {
      await held`select 1`;
      const r = run(RESTORE, [dump, SCRATCH, "--replace"]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/is in use \(\d+ connections?\)\. Stop the portal first/);
      expect((await held`select count(*)::int as n from setting where key = 'made.after.restore'`)[0]!.n).toBe(1);
    } finally { await held.end({ timeout: 5 }); }
  });

  it("refuses a file that isn't a backup, and a database name it can't use", async () => {
    const junk = path.join(dir, "not-a-backup.dump");
    writeFileSync(junk, "this is not a database dump\n");
    const bad = run(RESTORE, [junk, SCRATCH, "--replace"]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/isn't a backup made by scripts\/backup\.sh, or it is damaged\. Nothing was changed\./);
    for (const name of ["postgres", "Robert'); drop table parent;--", "has space", "", "x".repeat(51)]) {
      const r = run(RESTORE, [dump, name]);
      expect(r.status, name).toBe(2);
    }
    expect(run(RESTORE, [path.join(dir, "missing.dump"), SCRATCH]).status).toBe(2);
    expect(run(RESTORE, []).status).toBe(2);
    const after = await everythingIn(SCRATCH_URL);
    expect(JSON.stringify(after.rows["public.setting"])).toContain("made.after.restore");
    rmSync(junk);
  });

  it("replaces the database when told to, leaving exactly the backup", async () => {
    const r = run(RESTORE, [dump, SCRATCH, "--replace"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("replacing what was there");
    const after = await everythingIn(SCRATCH_URL);
    expect(after.tables).toEqual(before.tables);
    for (const t of before.tables) expect(after.rows[t], t).toEqual(before.rows[t]);
    expect(JSON.stringify(after.rows["public.setting"])).not.toContain("made.after.restore");
  });

  it("keeps the newest N backups and removes only older ones it named itself", () => {
    for (const f of ["booster-rocket-20200101T000000Z.dump", "booster-rocket-20210101T000000Z.dump", "booster-rocket-20220101T000000Z.dump",
      "booster-rocket-before-the-big-change.dump", "notes.txt"]) writeFileSync(path.join(dir, f), "kept by hand");
    const first = dumps().at(-1)!;
    const r = run(BACKUP, [dir, "--keep", "3"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Keeping the newest 3 backups in .*; removed 2 older\./);
    const left = dumps();
    expect(left).toHaveLength(3);
    expect(left[0]).toBe("booster-rocket-20220101T000000Z.dump");
    expect(left).toContain(first);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(["booster-rocket-before-the-big-change.dump", "notes.txt"]));
  });

  it("a dump that comes out cut short is not kept, and no older backup is removed for it", async () => {
    // The tool the script dumps with (docker, or pg_dump on this machine) is stood in for by one that does the same,
    // except that a dump loses its last 100 bytes and still reports success: a disk that filled, or a pipe that broke,
    // with nothing to say so. The table of contents at the start of the file is whole; the last table's data is not.
    const tool = via.BR_DB_CONTAINER ? "docker" : "pg_dump";
    const real = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    expect(real, `${tool} is not on the PATH`).not.toBe("");
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, tool), [
      "#!/usr/bin/env bash",
      `real=${JSON.stringify(real)}`,
      'case "$(basename "$0") $*" in',
      '  *pg_dump*) whole="$(mktemp)"; "$real" "$@" > "$whole" || exit $?; head -c "$(( $(wc -c < "$whole") - 100 ))" "$whole"; echo cut >> "$BR_TEST_CUTS"; rm -f "$whole" ;;',
      '  *) exec "$real" "$@" ;;',
      "esac", ""].join("\n"));
    chmodSync(path.join(bin, tool), 0o755);
    const cuts = path.join(dir, "cuts.log");
    const had = readdirSync(dir).filter((f) => f !== "bin").sort();
    expect(dumps().length).toBeGreaterThanOrEqual(3);
    const [recorded] = await db.select().from(setting).where(eq(setting.key, BACKUP_KEY));

    const r = run(BACKUP, [dir, "--keep", "1"], { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, BR_TEST_CUTS: cuts });
    expect(readFileSync(cuts, "utf8"), "the stand-in tool was not the one the script ran").toBe("cut\n");
    expect(r.status, r.stdout + r.stderr).toBe(4);
    expect(r.stderr).toContain("The backup that was written can't be read back. It was not kept, and no older backup was removed.");
    expect(r.stdout).not.toContain("Backup written");
    // Nothing new in the folder, nothing left half-written, and every backup that was there is still there, though
    // only one was to be kept. The Health page still names the last backup that was good.
    expect(readdirSync(dir).filter((f) => f !== "bin" && f !== "cuts.log").sort()).toEqual(had);
    expect((await db.select().from(setting).where(eq(setting.key, BACKUP_KEY)))[0]?.value).toEqual(recorded?.value);
    rmSync(bin, { recursive: true }); rmSync(cuts);
  });

  it("a backup that fails keeps nothing, removes nothing, and says so with its own exit code", () => {
    const had = readdirSync(dir).sort();
    const unreachable = run(BACKUP, [dir, "--keep", "1"], { BR_DB_NAME: "no_such_database_test", BR_DB_WAIT: "1" });
    expect(unreachable.status).toBe(3);
    expect(unreachable.stderr).toMatch(/didn't answer within 1s\. Nothing was backed up\./);
    expect(readdirSync(dir).sort()).toEqual(had);
    for (const args of [[], [dir, "--keep", "0"], [dir, "--keep", "many"], [dir, "extra"], ["--what"]]) expect(run(BACKUP, args).status, args.join(" ")).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(had);
  });
});
