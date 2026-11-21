import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { scratchDatabase } from "../setup/database-url";
import { dropScratchDatabase, makeScratchDatabase } from "../setup/worker-databases";

/**
 * Migration 0049 (stage 3's slice 12b2): a guardian row's old copies of its customers (`family_qbo_id`, `source_qbo_id`)
 * go, with the two indexes on `family_qbo_id`, and a row must have its family record unless a change of company closed
 * it (`guardian_family_unless_company_changed`). It refuses, changing nothing, while a row is in no family record and
 * not closed by a change of company, or while a row holds a record of its own that 0048 would link now; else it keeps
 * every row and link, and writes one counts-only audit row, on an empty database too.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_columns");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-columns-"));
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
const DROP = "_guardian_columns_dropped";
async function migrateWith(folder: string) {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { await migrate(drizzle(pg), { migrationsFolder: folder }); } finally { await pg.end(); }
}
const q = async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { return await f(pg); } finally { await pg.end(); }
};
/** A fresh scratch database, migrated up to the migration before `tag` (by default the one before 0049). */
async function freshBefore(tag = DROP) {
  await makeScratchDatabase("migrate_columns"); // marked as this run's: a database of that name the run didn't make is refused
  await migrateWith(migrationsUpTo(indexOf(tag) - 1));
}
const throughTheDrop = () => migrationsUpTo(indexOf(DROP));
const failureOf = async (run: Promise<unknown>) => {
  const failure = await run.then(() => null, (e: unknown) => e as Error);
  expect(failure).not.toBeNull();
  return failure!;
};
/** The database's own words, which drizzle carries as the error's cause, or postgres's own message. */
const saidBy = (e: Error) => `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""} ${(e as { constraint_name?: string }).constraint_name ?? ""}`;

const dropped = () => q((pg) => pg`SELECT door, actor_label, actor_id, target_type, target_id, ip, before, after FROM audit_log WHERE action = 'parents.guardian_columns.dropped'`);
const guardians = () => q((pg) => pg`SELECT * FROM guardian ORDER BY id`);
const links = () => q((pg) => pg`SELECT * FROM accounting_link ORDER BY id`);
const ended = () => q((pg) => pg`SELECT * FROM accounting_link_ended ORDER BY id`);
const columns = () => q(async (pg) => (await pg`SELECT column_name FROM information_schema.columns WHERE table_name = 'guardian' AND column_name IN ('family_qbo_id', 'source_qbo_id')
  ORDER BY column_name COLLATE "C"`).map((r) => r.column_name as string));
const indexes = () => q(async (pg) => (await pg`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'guardian' ORDER BY indexname COLLATE "C"`)
  .map((r) => ({ name: r.indexname as string, def: r.indexdef as string })));
const checkThere = () => q(async (pg) => (await pg`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'guardian_family_unless_company_changed'`)[0]!.n as number);
const applied = () => q(async (pg) => Number((await pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n));
/** Each row without the two columns 0049 drops. */
const withoutCopies = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "family_qbo_id" && k !== "source_qbo_id")));

const REALM = "9130000000000050";
const ids: Record<string, string> = {};

/** The roster's company, and the family records with their links: Rivera to 10, Elm to 40, Oak with none. */
async function seedFamilies(pg: postgres.Sql) {
  await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })})`;
  for (const key of ["rivera", "elm", "oak"] as const) {
    const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${key} Family`}, true) RETURNING id`;
    ids[key] = f!.id as string;
  }
  await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${REALM}, '10', ${ids.rivera!}, 'carried_over')`;
  await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${REALM}, '40', ${ids.elm!}, 'carried_over')`;
}
async function seedRow(pg: postgres.Sql, key: string, o: { family: string | null; copy: string | null; source: string | null; closedByAChange?: boolean }) {
  const [p] = await pg`INSERT INTO parent (name, email) VALUES (${key}, ${`${key}@columns.example`}) RETURNING id`;
  ids[`${key}Parent`] = p!.id as string;
  const [g] = await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status, source_qbo_id, disabled_reason, status_before_disable)
    VALUES (${o.copy}, ${o.family}, ${p!.id as string}, ${o.closedByAChange ? "disabled" : "active"}, ${o.source}, ${o.closedByAChange ? "company_changed" : null}, ${o.closedByAChange ? "active" : null}) RETURNING id`;
  ids[key] = g!.id as string;
}

afterAll(async () => {
  await dropScratchDatabase(NAME);
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
}, DATABASE_WORK);

describe("migration 0049: a guardian row's old copies go, and every row has its family but a previous company's", { timeout: 60_000 }, () => {
  it("drops both columns and both old indexes, adds the check, and keeps every row and link, with one counts-only audit row", async () => {
    await freshBefore();
    await q(async (pg) => {
      await seedFamilies(pg);
      await seedRow(pg, "ana", { family: ids.rivera!, copy: "10", source: "11" });     // linked to its own record, as 0048 left it
      await seedRow(pg, "dee", { family: ids.rivera!, copy: "10", source: "10" });     // its record is the family's own: no link of its own
      await seedRow(pg, "old", { family: null, copy: "90", source: "91", closedByAChange: true }); // a previous company's, in no family
      await seedRow(pg, "ivy", { family: ids.elm!, copy: "40", source: "41" });       // its own link ended by an unlink
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, guardian_id, origin) VALUES ('quickbooks', ${REALM}, '11', ${ids.ana!}, 'carried_over')`;
      await pg`INSERT INTO accounting_link_ended (id, system, realm_id, customer_id, guardian_id, origin, linked_at, ended_at, ended_how)
        VALUES (gen_random_uuid(), 'quickbooks', ${REALM}, '41', ${ids.ivy!}, 'carried_over', now(), now(), 'unlinked')`;
    });
    const before = { guardians: await guardians(), links: await links(), ended: await ended() };
    expect(before.guardians).toHaveLength(4);
    expect(await columns()).toEqual(["family_qbo_id", "source_qbo_id"]);

    await migrateWith(throughTheDrop());

    // The columns and both old indexes gone; the partial unique by family record, and the others, kept.
    expect(await columns()).toEqual([]);
    const now = await indexes();
    expect(now.map((i) => i.name)).toEqual(["guardian_family_id_ix", "guardian_family_id_parent_uq", "guardian_parent_ix", "guardian_pkey"]);
    expect(now.find((i) => i.name === "guardian_family_id_parent_uq")!.def).toMatch(/WHERE \(family_id IS NOT NULL\)/);
    expect(await checkThere()).toBe(1);
    // Every row as it was but for the two columns, every link and ended link as it was.
    expect(await guardians()).toEqual(withoutCopies(before.guardians));
    expect(await links()).toEqual(before.links);
    expect(await ended()).toEqual(before.ended);

    // One audit row, counts only, read before the drop.
    const rows = await dropped();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "system", actor_label: "migration", actor_id: null, target_type: "guardian", target_id: null, ip: null, before: null });
    expect(rows[0]!.after).toEqual({ cause: "migration 0049_guardian_columns_dropped", rowsWithAFamilyCopy: 4, rowsWithASource: 4, previousCompanyRowsWithNoFamily: 1 });
    const said = JSON.stringify(rows[0]);
    for (const id of Object.values(ids)) expect(said).not.toContain(id);
    for (const customer of ["10", "11", "40", "41", "90", "91"]) expect(said).not.toContain(`"${customer}"`);

    // The check: an open row in no family is refused by its name; a previous company's row in none is taken.
    const [p] = await q((pg) => pg`INSERT INTO parent (name, email) VALUES ('Nobody', 'nobody@columns.example') RETURNING id`);
    const open = await failureOf(q((pg) => pg`INSERT INTO guardian (parent_id, status) VALUES (${p!.id as string}, 'active')`));
    expect(saidBy(open)).toMatch(/guardian_family_unless_company_changed/);
    const removed = await failureOf(q((pg) => pg`INSERT INTO guardian (parent_id, status, disabled_reason) VALUES (${p!.id as string}, 'disabled', 'removed')`));
    expect(saidBy(removed)).toMatch(/guardian_family_unless_company_changed/);
    await q((pg) => pg`INSERT INTO guardian (parent_id, status, disabled_reason) VALUES (${p!.id as string}, 'disabled', 'company_changed')`);
    // Two rows of one person in no family are held to no unique index; in one family record, still refused.
    await q((pg) => pg`INSERT INTO guardian (parent_id, status, disabled_reason) VALUES (${p!.id as string}, 'disabled', 'company_changed')`);
    const twice = await failureOf(q((pg) => pg`INSERT INTO guardian (family_id, parent_id, status) VALUES (${ids.rivera!}, ${ids.anaParent!}, 'invited')`));
    expect(saidBy(twice)).toMatch(/guardian_family_id_parent_uq/);
  }, DATABASE_WORK);

  it("refuses, changing nothing, while a row is in no family record and not closed by a change of company; the earlier migrations of the run with it", async () => {
    // Brought to the migration before 0048, so the run is 0048 and 0049 together.
    await freshBefore("_guardian_links_additive");
    await q(async (pg) => {
      await seedFamilies(pg);
      await seedRow(pg, "ana", { family: ids.rivera!, copy: "10", source: "11" });     // no link of its own: 0048 makes one, in this run
      await seedRow(pg, "kit", { family: null, copy: "10", source: null });           // open, in no family record
      await seedRow(pg, "old", { family: null, copy: "90", source: "91", closedByAChange: true });
    });
    const held = { guardians: await guardians(), links: await links(), applied: await applied() };
    const failure = await failureOf(migrateWith(throughTheDrop()));
    expect(saidBy(failure)).toMatch(/Migration 0049 stopped: 1 guardian row\(s\) are in no family record of the portal's and were not closed by a change of QuickBooks company\./);
    expect(saidBy(failure)).toMatch(/Nothing was changed\. Report it to the portal's maintainers, who will say which family record each row belongs in/);
    // The database as it was: both columns, no audit row of either migration, 0048's link not made.
    expect(await columns()).toEqual(["family_qbo_id", "source_qbo_id"]);
    expect(await checkThere()).toBe(0);
    expect(await guardians()).toEqual(held.guardians);
    expect(await links()).toEqual(held.links);
    expect(await applied()).toBe(held.applied);
    expect(await dropped()).toEqual([]);
    expect(await q((pg) => pg`SELECT id FROM audit_log WHERE action = 'parents.guardian_links.filled'`)).toEqual([]);
    // Its words name no row, person or customer.
    for (const id of Object.values(ids)) expect(saidBy(failure)).not.toContain(id);
  }, DATABASE_WORK);

  it("refuses, changing nothing, while a row holds a record of its own that 0048 would link now", async () => {
    await freshBefore();
    await q(async (pg) => {
      await seedFamilies(pg);
      // As the build before slice 12b1 might have made one beside a database 0048 had run on: copies, and no link.
      await seedRow(pg, "ana", { family: ids.rivera!, copy: "10", source: "11" });
    });
    const held = { guardians: await guardians(), links: await links(), applied: await applied() };
    const failure = await failureOf(migrateWith(throughTheDrop()));
    expect(saidBy(failure)).toMatch(/Migration 0049 stopped: 1 guardian row\(s\) hold the QuickBooks record their sign-in came from with no link to it, which migration 0048 would have made\./);
    expect(saidBy(failure)).toMatch(/Nothing was changed\. Report it to the portal's maintainers, who will make the links/);
    expect(await columns()).toEqual(["family_qbo_id", "source_qbo_id"]);
    expect(await guardians()).toEqual(held.guardians);
    expect(await links()).toEqual(held.links);
    expect(await applied()).toBe(held.applied);
    expect(await dropped()).toEqual([]);
    for (const id of Object.values(ids)) expect(saidBy(failure)).not.toContain(id);
  }, DATABASE_WORK);

  it("on an empty database: the columns go, and its audit row counts nothing", async () => {
    await freshBefore();
    await migrateWith(throughTheDrop());
    expect(await columns()).toEqual([]);
    expect(await checkThere()).toBe(1);
    expect((await dropped()).map((r) => r.after)).toEqual([{ cause: "migration 0049_guardian_columns_dropped", rowsWithAFamilyCopy: 0, rowsWithASource: 0, previousCompanyRowsWithNoFamily: 0 }]);
  }, DATABASE_WORK);
});
