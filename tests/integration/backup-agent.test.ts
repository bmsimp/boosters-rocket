import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { backupFile, backupRequest, setting } from "@/lib/db/schema";
import { databaseName, scratchDatabase } from "../setup/database-url";
import { dropScratchDatabase, makeScratchDatabase, markScratchDatabase } from "../setup/worker-databases";
import { resetDb, seedStaff } from "../helpers/db";
import { seedTwoFamilies } from "../helpers/parent";

/**
 * The backup service's agent (scripts/backup-agent.sh), really run: one look at a time (--once), against this run's
 * database, or for a restore against a scratch copy of it with a stand-in for Documenso's, reaching Postgres the way
 * backup-restore.test.ts does (through the database's container, or this machine's tools).
 */
const RUN_URL = process.env.DATABASE_URL!;
const SOURCE = databaseName(RUN_URL);
const REAL_AGENT = path.resolve("scripts/backup-agent.sh"), BACKUP = path.resolve("scripts/backup.sh");
const LIVE = scratchDatabase("agent"), DOC = scratchDatabase("agent_doc");
const DUMP = /^booster-rocket-(\d{8}T\d{6}Z)\.dump$/;

function reach(): Record<string, string> {
  const u = new URL(RUN_URL);
  const user = decodeURIComponent(u.username);
  const container = process.env.BR_TEST_DB_CONTAINER ?? "booster-rocket-db-1";
  const inContainer = spawnSync("docker", ["exec", container, "psql", "-U", user, "--no-password", "-d", SOURCE, "-Atqc", "select 1"], { encoding: "utf8" });
  if (inContainer.status === 0 && inContainer.stdout.trim() === "1") return { BR_DB_CONTAINER: container, BR_DB_USER: user };
  if (spawnSync("pg_dump", ["--version"], { encoding: "utf8" }).status === 0) {
    return { BR_DB_CONTAINER: "", PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: user, PGPASSWORD: decodeURIComponent(u.password) };
  }
  throw new Error("The agent's test can't reach Postgres's own tools: install the PostgreSQL client tools (18), or set BR_TEST_DB_CONTAINER.");
}

let via: Record<string, string>;
let dir: string, outbox: string;
const envFor = (extra: Record<string, string>) => ({ ...process.env, ...via, BR_DB_NAME: SOURCE, BR_DB_WAIT: "20", BR_DOCUMENSO_DB_NAME: "",
  BR_OUTBOX: outbox, BR_BACKUP_AT: "off", BR_BACKUP_KEEP: "14", TZ: "UTC", ...extra });
const once = (extra: Record<string, string> = {}) => spawnSync("bash", [REAL_AGENT, dir, "--once"], { encoding: "utf8", env: envFor(extra) });
const onceAsync = (extra: Record<string, string> = {}) => new Promise<number | null>((done) => {
  const p = spawn("bash", [REAL_AGENT, dir, "--once"], { env: envFor(extra), stdio: "ignore" });
  p.on("close", done);
});
const stampsIn = (folder: string) => readdirSync(folder).map((f) => DUMP.exec(f)?.[1]).filter((s): s is string => !!s).sort();
const ask = async (kind: "backup" | "download" | "restore" | "upload", backupAt: string | null = null) =>
  (await db.insert(backupRequest).values({ kind, backupAt, requestedBy: "staff-1", requestedLabel: "admin@club.org" }).returning())[0]!;
const reread = async (id: string) => (await db.select().from(backupRequest).where(eq(backupRequest.id, id)))[0]!;

describe("the backup service's agent", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    via = reach();
    dir = mkdtempSync(path.join(tmpdir(), "br-agent-"));
    outbox = mkdtempSync(path.join(tmpdir(), "br-outbox-"));
    await resetDb();
    await seedTwoFamilies();
    await seedStaff({ email: "admin@club.org", admin: true });
  }, 300_000);
  afterAll(async () => {
    await dropScratchDatabase(LIVE.name); await dropScratchDatabase(DOC.name);
    rmSync(dir, { recursive: true, force: true }); rmSync(outbox, { recursive: true, force: true });
  }, 300_000);

  it("writes its heartbeat on each look, with the free space and the schedule it read", async () => {
    const r = once();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const [row] = await db.select().from(setting).where(eq(setting.key, "backup.agent"));
    const v = row!.value as Record<string, unknown>;
    expect(Math.abs(Date.now() - Date.parse(String(v.at)))).toBeLessThan(120_000);
    expect(v).toMatchObject({ version: 1, schedule: "off", keep: 14, nextAt: null });
    expect(typeof v.freeBytes).toBe("number");
    expect(await db.select().from(backupFile)).toEqual([]);
  });

  it("claims a request to back up, backs up, and lists the folder with each backup's schema", async () => {
    const req = await ask("backup");
    const r = once();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const done = await reread(req.id);
    expect(done).toMatchObject({ outcome: "ok", words: "Backed up." });
    expect(done.finishedAt).not.toBeNull();
    const stamps = stampsIn(dir);
    expect(stamps).toHaveLength(1);
    expect(done.result).toEqual({ backupAt: stamps[0] });
    const files = await db.select().from(backupFile);
    const pg = postgres(RUN_URL, { max: 1 });
    try {
      const m = (await pg<{ m: string }[]>`select max(created_at)::text as m from drizzle.__drizzle_migrations`)[0]!.m;
      expect(files).toEqual([expect.objectContaining({ backupAt: stamps[0], portalBytes: statSync(path.join(dir, `booster-rocket-${stamps[0]}.dump`)).size, documensoBytes: null, schemaAt: Number(m) })]);
    } finally { await pg.end({ timeout: 5 }); }
    expect(r.stdout).toContain(`Backup request ${req.id} (backup): ok.`);
  });

  it("gives a request to one agent only, when two look at once", async () => {
    const before = stampsIn(dir).length;
    const req = await ask("backup");
    const codes = await Promise.all([onceAsync(), onceAsync()]);
    expect(codes).toEqual([0, 0]);
    expect((await reread(req.id)).outcome).toBe("ok");
    expect(stampsIn(dir)).toHaveLength(before + 1);
  });

  it("keeps the number the saved schedule says, over the environment's", async () => {
    await db.insert(setting).values({ key: "backup.schedule", value: { at: "off", keep: 2 } });
    const req = await ask("backup");
    const r = once({ BR_BACKUP_KEEP: "14" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect((await reread(req.id)).outcome).toBe("ok");
    expect(stampsIn(dir)).toHaveLength(2);
    expect((await db.select().from(backupFile)).map((f) => f.backupAt).sort()).toEqual(stampsIn(dir));
    const [hb] = await db.select().from(setting).where(eq(setting.key, "backup.agent"));
    expect(hb!.value).toMatchObject({ keep: 2 });
  });

  it("prepares a download: one tar of the pair with what else to keep, in the outbox", async () => {
    const stamp = stampsIn(dir).at(-1)!;
    const req = await ask("download", stamp);
    const r = once();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const done = await reread(req.id);
    expect(done).toMatchObject({ outcome: "ok", words: "Ready to download." });
    const file = path.join(outbox, `${req.id}.tar`);
    expect(done.result).toEqual({ file: `${req.id}.tar`, bytes: statSync(file).size });
    const listed = spawnSync("tar", ["--force-local", "-tf", file], { encoding: "utf8" }).stdout.trim().split("\n").sort();
    expect(listed).toEqual(["KEEP-THESE-TOO.txt", `booster-rocket-${stamp}.dump`]);
    expect(readdirSync(outbox).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });

  it("refuses a time it didn't list, and a kind it doesn't know, touching nothing", async () => {
    const had = readdirSync(dir).sort(), outHad = readdirSync(outbox).sort();
    const missing = await ask("download", "20200101T000000Z");
    expect(once().status).toBe(0);
    expect(await reread(missing.id)).toMatchObject({ outcome: "refused", words: "There is no backup from that time on the server any more." });
    const pg = postgres(RUN_URL, { max: 1 });
    try {
      const [odd] = await pg<{ id: string }[]>`insert into backup_request (kind, backup_at) values ('rm -rf /', null) returning id`;
      expect(once().status).toBe(0);
      expect(await reread(odd!.id)).toMatchObject({ outcome: "refused", words: "The backup service doesn't know that kind of request." });
    } finally { await pg.end({ timeout: 5 }); }
    expect(readdirSync(dir).sort()).toEqual(had);
    expect(readdirSync(outbox).sort()).toEqual(outHad);
  });

  it("while off-site copies are on, stages each new backup for the worker to copy", async () => {
    await db.insert(setting).values({ key: "backup.offsite", value: { on: true } });
    try {
    const req = await ask("backup");
    expect(once().status).toBe(0);
    const stamp = ((await reread(req.id)).result as { backupAt: string }).backupAt;
    const [upload] = await db.select().from(backupRequest).where(eq(backupRequest.kind, "upload"));
    expect(upload).toMatchObject({ backupAt: stamp, requestedBy: null, finishedAt: null });
    expect(once().status).toBe(0);
    expect(await reread(upload!.id)).toMatchObject({ outcome: "ok", result: { file: `upload-${stamp}.tar`, bytes: statSync(path.join(outbox, `upload-${stamp}.tar`)).size } });
    } finally { await db.delete(setting).where(eq(setting.key, "backup.offsite")); }
  });

  describe("a restore", () => {
    const live = () => postgres(LIVE.url, { max: 1, onnotice: () => {} });
    const restoreDir = () => path.join(dir, "restore");
    const agentOnLive = () => spawnSync("bash", [REAL_AGENT, restoreDir(), "--once"], { encoding: "utf8",
      env: envFor({ BR_DB_NAME: LIVE.name, BR_DOCUMENSO_DB_NAME: DOC.name }) });

    beforeAll(async () => {
      // A copy of this run's database to be the live portal, and a stand-in for Documenso's beside it.
      const seedDir = mkdtempSync(path.join(tmpdir(), "br-agent-seed-"));
      try {
        const b = spawnSync("bash", [BACKUP, seedDir], { encoding: "utf8", env: { ...process.env, ...via, BR_DB_NAME: SOURCE, BR_DOCUMENSO_DB_NAME: "" } });
        expect(b.status, b.stderr).toBe(0);
        await makeScratchDatabase("agent");
        const dump = readdirSync(seedDir).find((f) => DUMP.test(f))!;
        const r = spawnSync("bash", [path.resolve("scripts/restore.sh"), path.join(seedDir, dump), LIVE.name, "--replace"], { encoding: "utf8", env: { ...process.env, ...via } });
        expect(r.status, r.stderr).toBe(0);
        await markScratchDatabase(LIVE.name);
      } finally { rmSync(seedDir, { recursive: true, force: true }); }
      await makeScratchDatabase("agent_doc");
      const doc = postgres(DOC.url, { max: 1, onnotice: () => {} });
      try { await doc.unsafe(`create table "Envelope" (id text primary key, status text not null); insert into "Envelope" values ('e1', 'COMPLETED');`); } finally { await doc.end({ timeout: 5 }); }
      const pg = live();
      try {
        await pg`delete from backup_request`; await pg`delete from backup_file`;
        await pg`insert into setting (key, value) values ('made.before', '"yes"'::jsonb)`;
      } finally { await pg.end({ timeout: 5 }); }
    }, 300_000);

    it("makes a backup of how things are now first, puts both databases back, and audits it in the restored one", async () => {
      let pg = live();
      let stamp: string;
      try {
        const [b] = await pg<{ id: string }[]>`insert into backup_request (kind) values ('backup') returning id`;
        expect(agentOnLive().status).toBe(0);
        stamp = stampsIn(restoreDir())[0]!;
        expect(readdirSync(restoreDir())).toContain(`documenso-${stamp}.dump`);
        expect((await pg`select outcome from backup_request where id = ${b!.id}`)[0]!.outcome).toBe("ok");
        // Done after the backup: this is what the restore loses.
        await pg`insert into setting (key, value) values ('made.after', '"yes"'::jsonb)`;
        await pg`insert into backup_request (kind, backup_at, requested_by, requested_label) values ('restore', ${stamp}, 'staff-1', 'admin@club.org')`;
      } finally { await pg.end({ timeout: 5 }); }
      const doc = postgres(DOC.url, { max: 1, onnotice: () => {} });
      try { await doc`insert into "Envelope" values ('e2', 'PENDING')`; } finally { await doc.end({ timeout: 5 }); }
      // The app, connected while it happens: its connection is ended, and a new one reaches the restored database.
      const app = live();
      await app`select 1`;
      await new Promise((r) => setTimeout(r, 1100)); // the fresh backup gets a later second than the one restored
      const r = agentOnLive();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain(`Put back the backup from ${stamp!}.`);
      await markScratchDatabase(LIVE.name); await markScratchDatabase(DOC.name);
      await app.end({ timeout: 5 });
      const stamps = stampsIn(restoreDir());
      expect(stamps).toHaveLength(2);
      const fresh = stamps[1]!;
      pg = live();
      try {
        const keys = (await pg<{ key: string }[]>`select key from setting where key like 'made.%' order by key`).map((x) => x.key);
        expect(keys).toEqual(["made.before"]);
        const [req] = await pg`select outcome, requested_label, result from backup_request where kind = 'restore'`;
        expect(req).toMatchObject({ outcome: "ok", requested_label: "admin@club.org", result: { backupMadeFirst: fresh, documenso: true } });
        const [audit] = await pg`select door, actor_id, actor_label, permission, target_id, before, after from audit_log where action = 'backup.restore.done'`;
        expect(audit).toMatchObject({ door: "staff", actor_id: "staff-1", actor_label: "admin@club.org", permission: "Admin.Backups.ReadWrite", target_id: stamp!,
          before: { backupMadeFirst: fresh }, after: { restored: stamp!, documenso: true } });
        const [last] = await pg`select value from setting where key = 'backup.last_success'`;
        expect(last!.value).toMatchObject({ file: `booster-rocket-${fresh}.dump` });
      } finally { await pg.end({ timeout: 5 }); }
      const doc2 = postgres(DOC.url, { max: 1, onnotice: () => {} });
      try { expect((await doc2`select id from "Envelope" order by id`).map((x) => x.id)).toEqual(["e1"]); } finally { await doc2.end({ timeout: 5 }); }
    });

    it("refuses a backup made by another version of the portal, and changes nothing", async () => {
      const pg = live();
      try {
        await pg`insert into drizzle.__drizzle_migrations (hash, created_at) values ('a-later-version', 99999999999999)`;
        await pg`insert into setting (key, value) values ('made.later', '"yes"'::jsonb)`;
        const stamp = stampsIn(restoreDir())[0]!;
        const [req] = await pg<{ id: string }[]>`insert into backup_request (kind, backup_at) values ('restore', ${stamp}) returning id`;
        const had = readdirSync(restoreDir()).sort();
        expect(agentOnLive().status).toBe(0);
        const [after] = await pg`select outcome, words from backup_request where id = ${req!.id}`;
        expect(after).toMatchObject({ outcome: "refused" });
        expect(String(after!.words)).toContain("made by another version of the portal");
        expect((await pg`select count(*)::int as n from setting where key = 'made.later'`)[0]!.n).toBe(1);
        expect(readdirSync(restoreDir()).sort()).toEqual(had);
      } finally { await pg.end({ timeout: 5 }); }
    });
  });

  it("never prints a secret", () => {
    writeFileSync(path.join(dir, "notes.txt"), "kept by hand");
    const r = once();
    for (const secret of [process.env.BETTER_AUTH_SECRET!, process.env.SETTINGS_ENCRYPTION_KEY!, "postgres://", "PGPASSWORD"]) expect(r.stdout + r.stderr).not.toContain(secret);
  });
});
