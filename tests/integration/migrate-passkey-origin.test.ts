import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { scratchDatabase } from "../setup/database-url";
import { dropScratchDatabase, makeScratchDatabase } from "../setup/worker-databases";

/**
 * Migration 0055 (the sign-in release's slice SI-9b; numbered after SI-10a's 0054, and found here by its tag, so a
 * renumbering at a merge doesn't break it): the origin each passkey was made for. One nullable `origin` column on
 * `parent_auth_passkey`, the portal's own beside the library's model. Additive: it fills nothing, and changes no other
 * row or column of the table, nor the person's sign-in account.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_origin");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-origin-"));
  folders.push(folder);
  cpSync("drizzle", folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number; tag: string }[] };
  j.entries = j.entries.filter((e) => e.idx <= last);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}
/** The journal's index of a migration, by its tag: so a migration renumbered at a merge is still found. */
const indexOf = (tag: string) => {
  const j = JSON.parse(readFileSync(path.join("drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const e = j.entries.find((x) => x.tag.endsWith(tag));
  if (!e) throw new Error(`no migration ${tag}`);
  return e.idx;
};
async function migrateWith(folder: string) {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { await migrate(drizzle(pg), { migrationsFolder: folder }); } finally { await pg.end(); }
}
const q = async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { return await f(pg); } finally { await pg.end(); }
};

/** Every passkey by the columns it had before, and every sign-in account. */
const OLD_COLUMNS = "id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, created_at, aaguid, last_used_at";
const everything = () => q(async (pg) => ({
  passkeys: await pg.unsafe(`SELECT ${OLD_COLUMNS} FROM parent_auth_passkey ORDER BY id COLLATE "C"`),
  users: await pg`SELECT * FROM parent_auth_user ORDER BY id COLLATE "C"`,
}));
const newColumns = () => q(async (pg) => (await pg`SELECT column_name, is_nullable, data_type FROM information_schema.columns
  WHERE table_name = 'parent_auth_passkey' AND column_name = 'origin'`)
  .map((r) => ({ column: r.column_name as string, nullable: r.is_nullable as string, type: r.data_type as string })));

describe("migration 0055: the origin each passkey was made for", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_origin"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(indexOf("_passkey_origin") - 1));
    await q(async (pg) => {
      // A person with a sign-in account and two passkeys, one used and named, one neither, as 0054 holds them.
      const [p] = await pg`INSERT INTO parent (name, email) VALUES ('Pat', 'pat@example.com') RETURNING id`;
      await pg`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id) VALUES ('user-pat', 'Pat', 'pat@example.com', true, ${p!.id as string})`;
      await pg`INSERT INTO parent_auth_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, aaguid, last_used_at)
        VALUES ('pk-1', 'Pat''s phone', 'pQECAyYgASFYIA', 'user-pat', 'cred-1', 4, 'multiDevice', true, 'internal,hybrid', 'aaguid-1', now())`;
      await pg`INSERT INTO parent_auth_passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
        VALUES ('pk-2', 'pQECAyYgASFYIB', 'user-pat', 'cred-2', 0, 'singleDevice', false)`;
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("adds the column, nullable text, null on every row, changing no other row or column", async () => {
    expect(await newColumns()).toEqual([]);
    const before = await everything();
    expect(before.passkeys).toHaveLength(2);
    await migrateWith(path.resolve("drizzle"));
    expect(await newColumns()).toEqual([{ column: "origin", nullable: "YES", type: "text" }]);
    expect(await everything()).toEqual(before);
    const origins = await q((pg) => pg`SELECT origin FROM parent_auth_passkey ORDER BY id COLLATE "C"`);
    expect(origins.map((r) => r.origin)).toEqual([null, null]);
  });

  it("takes an origin on a row, and a new row the library inserts without one is null", async () => {
    await q((pg) => pg`UPDATE parent_auth_passkey SET origin = 'https://portal.example.org' WHERE id = 'pk-1'`);
    await q((pg) => pg`INSERT INTO parent_auth_passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
      VALUES ('pk-3', 'pQECAyYgASFYIC', 'user-pat', 'cred-3', 0, 'multiDevice', true)`);
    const rows = await q((pg) => pg`SELECT id, origin FROM parent_auth_passkey ORDER BY id COLLATE "C"`);
    expect(rows.map((r) => [r.id, r.origin])).toEqual([["pk-1", "https://portal.example.org"], ["pk-2", null], ["pk-3", null]]);
  });
});
