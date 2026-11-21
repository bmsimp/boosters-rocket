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
 * Migration 0049 (stage 4's slice M4b; numbered after S12b1's 0048, and found here by its tag, so a renumbering at a
 * merge doesn't break it): a family's sign-ins held after a take from the books made it, or a student who opens it,
 * active again. Two nullable columns on `family` (`signin_held_at`, `signin_held_by`) with a check that the staff member
 * is named only while the time is. Additive: it fills nothing and changes no row of any family, active or not, nor
 * any student or guardian row.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_held");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-held-"));
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
/** The database's own words, which drizzle carries as the error's cause, or postgres's own message. */
const saidBy = (e: Error) => `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""} ${(e as { constraint_name?: string }).constraint_name ?? ""}`;

/** Each family by the columns it had before, and every student and guardian row. */
const OLD_COLUMNS = "id, name, active, phone, contact_version, accounting_left_unlinked_at, accounting_left_unlinked_by, created_at, updated_at";
const everything = () => q(async (pg) => ({
  families: await pg.unsafe(`SELECT ${OLD_COLUMNS} FROM family ORDER BY id`),
  students: await pg`SELECT * FROM student ORDER BY id`,
  guardians: await pg`SELECT * FROM guardian ORDER BY id`,
}));
const newColumns = () => q(async (pg) => (await pg`SELECT column_name, is_nullable, data_type FROM information_schema.columns
  WHERE table_name = 'family' AND column_name IN ('signin_held_at', 'signin_held_by') ORDER BY column_name COLLATE "C"`)
  .map((r) => ({ column: r.column_name as string, nullable: r.is_nullable as string, type: r.data_type as string })));

const ids: Record<string, string> = {};

describe("migration 0049: a family's sign-ins held", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_held"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(indexOf("_family_signin_hold") - 1));
    await q(async (pg) => {
      // An active family with a student and a guardian, and an inactive one.
      for (const [key, active] of [["open", true], ["gone", false]] as const) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${key} Family`}, ${active}) RETURNING id`;
        ids[key] = f!.id as string;
      }
      await pg`INSERT INTO student (family_id, name, active) VALUES (${ids.open!}, 'Sam', true)`;
      const [p] = await pg`INSERT INTO parent (name, email) VALUES ('Pat', 'pat@example.com') RETURNING id`;
      await pg`INSERT INTO guardian (family_id, parent_id, status) VALUES (${ids.open!}, ${p!.id as string}, 'active')`;
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("adds the two columns, null on every row, changing no family, student or guardian row", async () => {
    expect(await newColumns()).toEqual([]);
    const before = await everything();
    expect(before.families).toHaveLength(2);
    await migrateWith(path.resolve("drizzle"));
    expect(await newColumns()).toEqual([
      { column: "signin_held_at", nullable: "YES", type: "timestamp with time zone" },
      { column: "signin_held_by", nullable: "YES", type: "uuid" },
    ]);
    expect(await everything()).toEqual(before);
    const holds = await q((pg) => pg`SELECT signin_held_at AS at, signin_held_by AS by FROM family`);
    expect(holds.map((h) => ({ at: h.at, by: h.by }))).toEqual([{ at: null, by: null }, { at: null, by: null }]);
  });

  it("refuses a staff member named without the time; takes the time alone, both, and both cleared", async () => {
    const staff = "00000000-0000-4000-8000-0000000000bb";
    const failure = await q((pg) => pg`UPDATE family SET signin_held_by = ${staff} WHERE id = ${ids.gone!}`).then(() => null, (e: unknown) => e as Error);
    expect(failure).not.toBeNull();
    expect(saidBy(failure!)).toMatch(/family_signin_held_by_with_at/);
    await q((pg) => pg`UPDATE family SET signin_held_at = now() WHERE id = ${ids.gone!}`);
    await q((pg) => pg`UPDATE family SET signin_held_by = ${staff} WHERE id = ${ids.gone!}`);
    const [set] = await q((pg) => pg`SELECT signin_held_at AS at, signin_held_by AS by FROM family WHERE id = ${ids.gone!}`);
    expect(set!.at).not.toBeNull();
    expect(set!.by).toBe(staff);
    // Clearing the time while the staff member is named is refused too; both cleared at once is taken.
    const clearing = await q((pg) => pg`UPDATE family SET signin_held_at = null WHERE id = ${ids.gone!}`).then(() => null, (e: unknown) => e as Error);
    expect(clearing).not.toBeNull();
    expect(saidBy(clearing!)).toMatch(/family_signin_held_by_with_at/);
    await q((pg) => pg`UPDATE family SET signin_held_at = null, signin_held_by = null WHERE id = ${ids.gone!}`);
    const [cleared] = await q((pg) => pg`SELECT signin_held_at AS at, signin_held_by AS by FROM family WHERE id = ${ids.gone!}`);
    expect({ at: cleared!.at, by: cleared!.by }).toEqual({ at: null, by: null });
  });
});
