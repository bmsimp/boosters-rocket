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
 * Migration 0047 (stage 4's slice M3b): the history of ended links, `accounting_link_ended`, which Unlink from the books
 * fills. Additive: one table with its checks, foreign keys and indexes. It fills nothing and changes no row of
 * `accounting_link`, `family`, `student`, `guardian` or `family_money`.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_ended");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-ended-"));
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

/** Every row of the tables the migration must not change, each in one order. */
const everything = () => q(async (pg) => ({
  links: await pg`SELECT * FROM accounting_link ORDER BY id`,
  // Without the columns a later migration adds (0050's sign-in hold, stage 4's slice M4b), which this one never sees.
  families: (await pg`SELECT * FROM family ORDER BY id`).map((f) => Object.fromEntries(Object.entries(f).filter(([column]) => column !== "signin_held_at" && column !== "signin_held_by"))),
  students: await pg`SELECT * FROM student ORDER BY id`,
  guardians: await pg`SELECT * FROM guardian ORDER BY id`,
  money: await pg`SELECT * FROM family_money ORDER BY family_id`,
}));
const tableThere = () => q(async (pg) => (await pg`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'accounting_link_ended'`)[0]!.n as number);

const ids: Record<string, string> = {};
const STAFF = "00000000-0000-4000-8000-0000000000aa";

describe("migration 0047: the history of ended links", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_ended"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(indexOf("_link_history") - 1));
    await q(async (pg) => {
      for (const key of ["linked", "alone"] as const) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${key} Family`}, true) RETURNING id`;
        ids[key] = f!.id as string;
      }
      const [s] = await pg`INSERT INTO student (family_id, name, active) VALUES (${ids.linked!}, 'Sam', true) RETURNING id`;
      ids.student = s!.id as string;
      const [p] = await pg`INSERT INTO parent (name, email) VALUES ('Pat', 'pat@example.com') RETURNING id`;
      const [g] = await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES ('10', ${ids.linked!}, ${p!.id as string}, 'active') RETURNING id`;
      ids.guardian = g!.id as string;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', 'R1', '10', ${ids.linked!}, 'carried_over')`;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, student_id, origin, linked_by) VALUES ('quickbooks', 'R1', '11', ${ids.student!}, 'confirmed', ${STAFF})`;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, guardian_id, origin) VALUES ('quickbooks', 'R1', '12', ${ids.guardian!}, 'carried_over')`;
      await pg`INSERT INTO family_money (family_id, realm_id, total_cents) VALUES (${ids.linked!}, 'R1', 1200)`;
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("adds the table, empty, changing no link, family, student, guardian row or money row", async () => {
    expect(await tableThere()).toBe(0);
    const before = await everything();
    expect(before.links).toHaveLength(3);
    // To 0047 itself: a later migration (0049) drops guardian columns this compares row by row.
    await migrateWith(migrationsUpTo(indexOf("_link_history")));
    expect(await tableThere()).toBe(1);
    expect(await q(async (pg) => (await pg`SELECT count(*)::int AS n FROM accounting_link_ended`)[0]!.n)).toBe(0);
    expect(await everything()).toEqual(before);
  });

  it("refuses two records or none, and a carried-over row with a person; takes one of each kind", async () => {
    const insert = (cols: { family?: string; student?: string; guardian?: string; origin?: string; by?: string | null }) => q((pg) => pg`
      INSERT INTO accounting_link_ended (id, system, realm_id, customer_id, family_id, student_id, guardian_id, origin, linked_at, linked_by, ended_at, ended_by, ended_how)
      VALUES (gen_random_uuid(), 'quickbooks', 'R1', '10', ${cols.family ?? null}, ${cols.student ?? null}, ${cols.guardian ?? null}, ${cols.origin ?? "confirmed"}, now(), ${cols.by === undefined ? STAFF : cols.by}, now(), ${STAFF}, 'unlinked')`)
      .then(() => null, (e: unknown) => e as Error);
    const two = await insert({ family: ids.linked!, student: ids.student! });
    expect(saidBy(two!)).toMatch(/accounting_link_ended_one_record/);
    const none = await insert({});
    expect(saidBy(none!)).toMatch(/accounting_link_ended_one_record/);
    const carried = await insert({ family: ids.linked!, origin: "carried_over" });
    expect(saidBy(carried!)).toMatch(/accounting_link_ended_carried_over_by_nobody/);
    expect(await insert({ family: ids.linked!, origin: "carried_over", by: null })).toBeNull();
    expect(await insert({ student: ids.student! })).toBeNull();
    expect(await insert({ guardian: ids.guardian! })).toBeNull();
    // No unique index: one customer, ended twice for one record.
    expect(await insert({ family: ids.linked! })).toBeNull();
    expect(await q(async (pg) => (await pg`SELECT count(*)::int AS n FROM accounting_link_ended`)[0]!.n)).toBe(4);
  });

  it("goes with the family it names (on delete cascade)", async () => {
    await q(async (pg) => {
      await pg`INSERT INTO accounting_link_ended (id, system, realm_id, customer_id, family_id, origin, linked_at, ended_at, ended_by, ended_how)
        VALUES (gen_random_uuid(), 'quickbooks', 'R1', '30', ${ids.alone!}, 'carried_over', now(), now(), ${STAFF}, 'unlinked')`;
      await pg`DELETE FROM family WHERE id = ${ids.alone!}`;
    });
    expect(await q(async (pg) => (await pg`SELECT count(*)::int AS n FROM accounting_link_ended WHERE customer_id = '30'`)[0]!.n)).toBe(0);
  });
});
