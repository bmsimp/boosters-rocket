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
 * Migration 0045 (stage 4's slice M3a): the accounting links screen's "Left unlinked" mark, two nullable columns on
 * `family` (`accounting_left_unlinked_at`, `accounting_left_unlinked_by`) with a check that the staff member is named
 * only while the time is. Additive: it fills nothing and changes no row of any family, linked or not, active or not,
 * nor any link.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_unlinked");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-unlinked-"));
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
/** The database's own words, which drizzle carries as the error's cause, or postgres's own message. */
const saidBy = (e: Error) => `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""} ${(e as { constraint_name?: string }).constraint_name ?? ""}`;

/** Each family as 0044 holds it, by the columns it had then; and every link. */
const OLD_COLUMNS = "id, name, active, phone, address_line1, address_line2, address_city, address_region, address_postal_code, address_country, contact_version, created_at, updated_at";
const families = () => q((pg) => pg.unsafe(`SELECT ${OLD_COLUMNS} FROM family ORDER BY id`));
const links = () => q((pg) => pg`SELECT * FROM accounting_link ORDER BY id`);
const newColumns = () => q(async (pg) => (await pg`SELECT column_name, is_nullable, data_type FROM information_schema.columns
  WHERE table_name = 'family' AND column_name IN ('accounting_left_unlinked_at', 'accounting_left_unlinked_by') ORDER BY column_name COLLATE "C"`)
  .map((r) => ({ column: r.column_name as string, nullable: r.is_nullable as string, type: r.data_type as string })));

const ids: Record<string, string> = {};

describe("migration 0045: a family's Left unlinked mark", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_unlinked"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(44));
    await q(async (pg) => {
      // Linked and active, linked and inactive, with no link and active, with no link and inactive.
      for (const [key, active] of [["linked", true], ["linkedGone", false], ["alone", true], ["aloneGone", false]] as const) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${key} Family`}, ${active}) RETURNING id`;
        ids[key] = f!.id as string;
      }
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', 'R1', '10', ${ids.linked!}, 'carried_over')`;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin, linked_by) VALUES ('quickbooks', 'R1', '20', ${ids.linkedGone!}, 'confirmed', ${"00000000-0000-4000-8000-0000000000aa"})`;
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("adds the two columns, null on every row, changing no family and no link", async () => {
    expect(await newColumns()).toEqual([]);
    const beforeFamilies = await families();
    const beforeLinks = await links();
    expect(beforeFamilies).toHaveLength(4);
    await migrateWith(path.resolve("drizzle"));
    expect(await newColumns()).toEqual([
      { column: "accounting_left_unlinked_at", nullable: "YES", type: "timestamp with time zone" },
      { column: "accounting_left_unlinked_by", nullable: "YES", type: "uuid" },
    ]);
    expect(await families()).toEqual(beforeFamilies);
    expect(await links()).toEqual(beforeLinks);
    const marks = await q((pg) => pg`SELECT accounting_left_unlinked_at AS at, accounting_left_unlinked_by AS by FROM family`);
    expect(marks.map((m) => ({ at: m.at, by: m.by }))).toEqual(Array.from({ length: 4 }, () => ({ at: null, by: null })));
  });

  it("refuses a staff member named without the time; takes the time alone, both, and both cleared", async () => {
    const staff = "00000000-0000-4000-8000-0000000000bb";
    const failure = await q((pg) => pg`UPDATE family SET accounting_left_unlinked_by = ${staff} WHERE id = ${ids.alone!}`).then(() => null, (e: unknown) => e as Error);
    expect(failure).not.toBeNull();
    expect(saidBy(failure!)).toMatch(/family_left_unlinked_by_with_at/);
    await q((pg) => pg`UPDATE family SET accounting_left_unlinked_at = now() WHERE id = ${ids.alone!}`);
    await q((pg) => pg`UPDATE family SET accounting_left_unlinked_by = ${staff} WHERE id = ${ids.alone!}`);
    const [set] = await q((pg) => pg`SELECT accounting_left_unlinked_at AS at, accounting_left_unlinked_by AS by FROM family WHERE id = ${ids.alone!}`);
    expect(set!.at).not.toBeNull();
    expect(set!.by).toBe(staff);
    await q((pg) => pg`UPDATE family SET accounting_left_unlinked_at = null, accounting_left_unlinked_by = null WHERE id = ${ids.alone!}`);
    // Clearing the time while the staff member is named is refused too.
    await q((pg) => pg`UPDATE family SET accounting_left_unlinked_at = now(), accounting_left_unlinked_by = ${staff} WHERE id = ${ids.alone!}`);
    const clearing = await q((pg) => pg`UPDATE family SET accounting_left_unlinked_at = null WHERE id = ${ids.alone!}`).then(() => null, (e: unknown) => e as Error);
    expect(clearing).not.toBeNull();
    expect(saidBy(clearing!)).toMatch(/family_left_unlinked_by_with_at/);
  });
});
