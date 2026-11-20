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
 * Migration 0044 (stage 3's slice 11a): a guardian's phone and mailing address become the portal's own. `parent` gains
 * the address beside its phone and a `contact_version`, `family` the same with a phone of its own (books with no parent
 * type), and `qbo_customer` QuickBooks' billing address. It fills nothing; it clears every phone migration 0004 copied
 * (the take-in fills them from each person's own record), asks for a roster read and records the time the take-in must
 * start after, with one counts-only audit row. It refuses nothing.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_contact");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-contact-"));
  folders.push(folder);
  cpSync("drizzle", folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number }[] };
  j.entries = j.entries.filter((e) => e.idx <= last);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}
async function migrateWith(folder: string) {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { await migrate(drizzle(pg), { migrationsFolder: folder }); } finally { await pg.end(); }
}
const q = async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { return await f(pg); } finally { await pg.end(); }
};

const ADDRESS = ["address_line1", "address_line2", "address_city", "address_region", "address_postal_code", "address_country"];
const NEW_COLUMNS = { parent: [...ADDRESS, "contact_version"], family: ["phone", ...ADDRESS, "contact_version"], qbo_customer: ADDRESS } as const;
type Table = keyof typeof NEW_COLUMNS;
type Row = Record<string, unknown>;
const without = (row: Row, columns: readonly string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !columns.includes(k)));
// Ordered by a column every one of the three has a text form of, by byte, so the order never depends on the collation.
const rowsOf = async (table: Table): Promise<Row[]> =>
  [...await q((pg) => pg.unsafe(`SELECT * FROM ${table} ORDER BY ${table === "qbo_customer" ? "qbo_id" : "id::text"} COLLATE "C"`))].map((r) => ({ ...r }));
const columnsOf = (table: Table) => q(async (pg) =>
  (await pg`SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_name = ${table}`).map((r) => ({ ...r })) as
    { column_name: string; is_nullable: string; data_type: string; column_default: string | null }[]);
const settingsBut = async (): Promise<Row[]> =>
  [...await q((pg) => pg`SELECT * FROM setting WHERE key NOT IN ('roster.refresh_asked', 'parents.contact_take_in') ORDER BY key COLLATE "C"`)].map((r) => ({ ...r }));
const audit = async (): Promise<Row[]> => [...await q((pg) => pg`SELECT * FROM audit_log ORDER BY id`)].map((r) => ({ ...r }));

const before: Partial<Record<Table, Row[]>> = {};
let otherSettings: Row[] = [];
let auditBefore: Row[] = [];
let startedAt = 0;

describe("migration 0044: a guardian's phone and mailing address are the portal's own", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_contact"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(43));
    await q(async (pg) => {
      await pg`INSERT INTO parent (name, email, phone) VALUES ('Ash Parent', 'ash@contact.example', '512-555-0101')`;
      await pg`INSERT INTO parent (name, email, phone) VALUES ('Birch Parent', 'birch@contact.example', '512-555-0102')`;
      await pg`INSERT INTO parent (name, email) VALUES ('Cedar Parent', 'cedar@contact.example')`;
      await pg`INSERT INTO family (name, active) VALUES ('Ash Family', true)`;
      await pg`INSERT INTO family (name, active) VALUES ('Old Family', false)`;
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, type_qbo_id, sync_token) VALUES ('10', 'Ash Family', true, 'T1', '3')`;
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, email, phone, sync_token)
        VALUES ('11', 'Ash Parent', true, '10', 'T2', 'ash@contact.example', '512-555-0101', '1')`;
      // An ask from before, which the migration moves on, and a setting it leaves alone.
      await pg`INSERT INTO setting (key, value) VALUES ('roster.refresh_asked', ${pg.json({ at: "2026-11-01T00:00:00.000Z" })})`;
      await pg`INSERT INTO setting (key, value) VALUES ('club.settings', ${pg.json({ name: "Contact Club" })})`;
      await pg`INSERT INTO audit_log (door, actor_label, action) VALUES ('system', 'test', 'test.before')`;
    });
    for (const t of Object.keys(NEW_COLUMNS) as Table[]) before[t] = await rowsOf(t);
    otherSettings = await settingsBut();
    auditBefore = await audit();
    startedAt = Date.now();
    await migrateWith(migrationsUpTo(44)); // through 0044 only: later migrations add their own columns (0045 two to family)
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("adds the columns, each empty, and every person's and family's contact_version is 0", async () => {
    for (const t of Object.keys(NEW_COLUMNS) as Table[]) {
      const columns = await columnsOf(t);
      for (const name of NEW_COLUMNS[t]) {
        const c = columns.find((x) => x.column_name === name);
        expect(c, `${t}.${name}`).toBeDefined();
        if (name === "contact_version") expect(c, `${t}.${name}`).toMatchObject({ is_nullable: "NO", data_type: "integer", column_default: "0" });
        else expect(c, `${t}.${name}`).toMatchObject({ is_nullable: "YES", data_type: "text" });
      }
      for (const row of await rowsOf(t)) {
        for (const name of ADDRESS) expect(row[name], `${t}.${name}`).toBeNull();
        if (t !== "qbo_customer") expect(row.contact_version, `${t}.contact_version`).toBe(0);
        if (t === "family") expect(row.phone).toBeNull();
      }
    }
  });

  it("clears every person's phone, and changes nothing else of a person, a family or a cached customer", async () => {
    const people = await rowsOf("parent");
    expect(people.map((p) => p.phone)).toEqual([null, null, null]);
    expect(people.map((p) => without(p, [...NEW_COLUMNS.parent, "phone"]))).toEqual(before.parent!.map((p) => without(p, ["phone"])));
    expect((await rowsOf("family")).map((f) => without(f, NEW_COLUMNS.family))).toEqual(before.family);
    // The cache keeps its phone and email: it is QuickBooks' copy, and only the person's own copy was stale.
    expect((await rowsOf("qbo_customer")).map((c) => without(c, NEW_COLUMNS.qbo_customer))).toEqual(before.qbo_customer);
  });

  it("asks for a roster read, and records the time the take-in starts after", async () => {
    const [asked] = await q((pg) => pg`SELECT value FROM setting WHERE key = 'roster.refresh_asked'`);
    const [takeIn] = await q((pg) => pg`SELECT value FROM setting WHERE key = 'parents.contact_take_in'`);
    const askedAt = (asked!.value as { at: string }).at;
    // The migration's own time, as an ISO string the worker reads back (rosterRefreshAsked(), the take-in).
    expect(askedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Math.abs(Date.parse(askedAt) - startedAt)).toBeLessThan(5 * 60_000);
    expect(takeIn!.value).toEqual({ after: askedAt });
    expect(await settingsBut()).toEqual(otherSettings);
  });

  it("writes one counts-only audit row, and no other", async () => {
    const all = await audit();
    expect(all.slice(0, auditBefore.length)).toEqual(auditBefore);
    const added = all.slice(auditBefore.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ door: "system", actor_label: "migration", action: "parent.details.migrated", target_type: "parent",
      after: { cause: "migration 0044_contact_details_additive", phonesCleared: 2 } });
  });
});
