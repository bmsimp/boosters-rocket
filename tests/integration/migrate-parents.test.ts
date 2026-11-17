import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { scratchDatabase } from "../setup/database-url";
import { dropScratchDatabase, makeScratchDatabase } from "../setup/worker-databases";

// On the run's own server, named after this file's database (the run's, or its worker's), so two runs, or two workers
// of one run, never drop each other's scratch database.
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: with
// other runs and workers busy, that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_parents");
let oldFolder = "";

async function migrateWith(folder: string) {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await migrate(drizzle(pg), { migrationsFolder: folder });
  await pg.end();
}

describe("migration to person records", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_parents"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before this plan: migrations up to 0003 only.
    oldFolder = mkdtempSync(path.join(tmpdir(), "br-migrate-"));
    cpSync("drizzle", oldFolder, { recursive: true });
    const journal = path.join(oldFolder, "meta", "_journal.json");
    const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number }[] };
    j.entries = j.entries.filter((e) => e.idx <= 3);
    writeFileSync(journal, JSON.stringify(j));
    await migrateWith(oldFolder);

    const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
    await pg`INSERT INTO guardian (id, family_qbo_id, name, email, phone, is_primary, identity_object_id, status, created_at) VALUES
      ('00000000-0000-0000-0000-000000000001', 'F1', 'Ana Ramirez', ' Ana@Example.com ', '555-0100', true,  'oid-a',  'active',   '2026-11-01T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000002', 'F2', 'Ana R',       'ana@example.com',   null,       false, 'oid-a2', 'invited',  '2026-11-02T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000003', 'F1', 'Ana Again',   'ANA@example.com',   null,       false, null,     'invited',  '2026-11-03T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000004', 'F3', 'Ben Lee',     'ben@example.com',   null,       true,  null,     'disabled', '2026-11-01T00:00:00Z')`;
    await pg`INSERT INTO parent_auth_user (id, name, email, email_verified, object_id) VALUES ('old-1', 'Ana', 'ana@example.com', true, 'oid-a')`;
    await pg`INSERT INTO auth_provider (key, config) VALUES ('parent-oidc', ${pg.json({ tenantSubdomain: "x", tenantId: "t", clientId: "c" })})`;
    await pg`INSERT INTO setting (key, value) VALUES ('setup.state', ${pg.json({ status: "open", step: "parent", adminEmail: null, finishedAt: null })})`;
    await pg.end();

    await migrateWith(path.resolve("drizzle"));
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    rmSync(oldFolder, { recursive: true, force: true });
  }, DATABASE_WORK);

  const q = async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
    const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
    try { return await f(pg); } finally { await pg.end(); }
  };

  it("makes one person per normalized email, from that email's earliest row", async () => {
    const rows = await q((pg) => pg`SELECT name, email, phone, blocked FROM parent ORDER BY email`);
    expect(rows).toEqual([
      { name: "Ana Ramirez", email: "ana@example.com", phone: "555-0100", blocked: false },
      { name: "Ben Lee", email: "ben@example.com", phone: null, blocked: false },
    ]);
  });

  it("keeps one guardian row per family and person, all pointing at the same person", async () => {
    const rows = await q((pg) => pg`SELECT g.id, g.family_qbo_id, g.status, g.is_primary, p.email
      FROM guardian g JOIN parent p ON p.id = g.parent_id ORDER BY p.email, g.family_qbo_id`);
    expect(rows.map((r) => [r.email, r.family_qbo_id, r.status, r.is_primary])).toEqual([
      ["ana@example.com", "F1", "active", true],
      ["ana@example.com", "F2", "invited", false],
      ["ben@example.com", "F3", "disabled", true],
    ]);
    expect(rows[0]!.id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("gives an old disabled row a reason, so adding the guardian back restores it", async () => {
    const [r] = await q((pg) => pg`SELECT disabled_reason, status_before_disable FROM guardian WHERE id = '00000000-0000-0000-0000-000000000004'`);
    expect(r).toEqual({ disabled_reason: "removed", status_before_disable: "invited" });
  });

  it("drops External ID data and gives each person exactly one sign-in user", async () => {
    const users = await q((pg) => pg`SELECT u.id, u.email, u.parent_id, p.email AS parent_email FROM parent_auth_user u JOIN parent p ON p.id = u.parent_id`);
    expect(users.map((u) => u.email).sort()).toEqual(["ana@example.com", "ben@example.com"]);
    expect(users.every((u) => u.email === u.parent_email)).toBe(true);
    expect(users.some((u) => u.id === "old-1")).toBe(false);
    const cols = await q((pg) => pg`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('guardian', 'parent_auth_user')`);
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    for (const gone of ["guardian.name", "guardian.email", "guardian.phone", "guardian.identity_object_id", "parent_auth_user.object_id"]) expect(names).not.toContain(gone);
    expect(await q((pg) => pg`SELECT key FROM auth_provider WHERE key = 'parent-oidc'`)).toHaveLength(0);
  });

  it("moves an open setup from the old parent step to the mail step", async () => {
    const [s] = await q((pg) => pg`SELECT value->>'step' AS step FROM setting WHERE key = 'setup.state'`);
    expect(s!.step).toBe("mail");
  });

  it("refuses a second row for the same person in the same family", async () => {
    await expect(q((pg) => pg`INSERT INTO guardian (family_qbo_id, parent_id, status)
      SELECT 'F1', parent_id, 'invited' FROM guardian WHERE id = '00000000-0000-0000-0000-000000000001'`)).rejects.toThrow(/guardian_family_parent_uq/);
  });
});
