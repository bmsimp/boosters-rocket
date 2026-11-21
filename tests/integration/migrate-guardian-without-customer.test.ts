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
 * Migration 0040 (stage 3's slice 9d): a membership may stand while its family has no link, so
 * `guardian.family_qbo_id` takes null, and a person is in a family record at most once (`guardian_family_id_parent_uq`,
 * beside the old index by customer, kept). It changes no row, and refuses, changing nothing, while two rows of one
 * person already name one family record.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_guardian");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-guardian-"));
  folders.push(folder);
  cpSync("drizzle", folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number }[] };
  j.entries = j.entries.filter((e) => e.idx <= last);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}
/**
 * Every migration before the one that drops `family_qbo_id` (0049, stage 3's slice 12b2, found by its tag so a renumbering
 * at a merge still finds it): this names the column and its index, so it stops there.
 */
function beforeTheDrop(): string {
  const j = JSON.parse(readFileSync(path.join("drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const drop = j.entries.find((e) => e.tag.endsWith("_guardian_columns_dropped"));
  if (!drop) throw new Error("no migration _guardian_columns_dropped");
  return migrationsUpTo(drop.idx - 1);
}
async function migrateWith(folder: string) {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { await migrate(drizzle(pg), { migrationsFolder: folder }); } finally { await pg.end(); }
}
const q = async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try { return await f(pg); } finally { await pg.end(); }
};
const failureOf = async (run: Promise<unknown>) => {
  const failure = await run.then(() => null, (e: unknown) => e as Error);
  expect(failure).not.toBeNull();
  return failure!;
};
/** The database's own words, which drizzle carries as the error's cause. */
const saidBy = (e: Error) => `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""}`;

const ids: Record<string, string> = {};
let before: Record<string, unknown>[] = [];
const rows = async () => [...await q((pg) => pg`SELECT * FROM guardian ORDER BY id`)];
const nullable = () => q(async (pg) => (await pg`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'guardian' AND column_name = 'family_qbo_id'`)[0]!.is_nullable);
const indexes = () => q(async (pg) => (await pg`SELECT indexname FROM pg_indexes WHERE tablename = 'guardian' ORDER BY indexname COLLATE "C"`).map((r) => r.indexname as string));
const applied = () => q(async (pg) => Number((await pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n));

describe("migration 0040: a guardian row may name no customer, and a person is in a family record once", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_guardian"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(39));
    await q(async (pg) => {
      for (const n of ["ash", "birch"]) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${n} Family`}, true) RETURNING id`;
        ids[n] = f!.id as string;
        const [p] = await pg`INSERT INTO parent (name, email) VALUES (${`${n} Parent`}, ${`${n}@guardian.example`}) RETURNING id`;
        ids[`${n}Parent`] = p!.id as string;
      }
      // Each person in their own family, and Ash's parent in Birch's too: as 0039 holds them, each naming a customer.
      await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES ('F1', ${ids.ash!}, ${ids.ashParent!}, 'active')`;
      await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES ('F2', ${ids.birch!}, ${ids.birchParent!}, 'invited')`;
      await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status, disabled_reason, status_before_disable) VALUES ('F2', ${ids.birch!}, ${ids.ashParent!}, 'disabled', 'removed', 'active')`;
      // A row a change of company closed: no family record.
      await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status, disabled_reason) VALUES ('F9', null, ${ids.birchParent!}, 'disabled', 'company_changed')`;
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("refuses, changing nothing, while two rows of one person name one family record", async () => {
    // Ash's parent twice in Ash's family, under another customer number: the old index lets it in.
    const [twice] = await q((pg) => pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES ('F1-old', ${ids.ash!}, ${ids.ashParent!}, 'invited') RETURNING id`);
    const held = await rows();
    const appliedBefore = await applied();
    const failure = await failureOf(migrateWith(beforeTheDrop()));
    expect(saidBy(failure)).toMatch(/Migration 0040 stopped: 1 family membership\(s\) are held by more than one guardian row \(one person, two or more rows naming the same family record\)/);
    // It says that a closed row counts too, so closing the extra row from the staff pages is never offered as the way out.
    expect(saidBy(failure)).toMatch(/a closed row counts as much as an open one\. Nothing was changed\. Report it to the portal's maintainers/);
    expect(saidBy(failure)).not.toMatch(/close and merge/);
    expect(await rows()).toEqual(held);
    expect(await nullable()).toBe("NO");
    expect(await indexes()).not.toContain("guardian_family_id_parent_uq");
    expect(await applied()).toBe(appliedBefore);
    await q((pg) => pg`DELETE FROM guardian WHERE id = ${twice!.id as string}`);
  });

  it("changes no row; then a row takes no customer, and a second row of one person in one family record is refused", async () => {
    before = await rows();
    await migrateWith(beforeTheDrop());
    expect(await rows()).toEqual(before);
    expect(await nullable()).toBe("YES");
    expect(await indexes()).toEqual(expect.arrayContaining(["guardian_family_parent_uq", "guardian_family_id_parent_uq", "guardian_family_ix", "guardian_family_id_ix", "guardian_parent_ix"]));

    // Birch's parent in Ash's family, made while Ash's family has no link: no customer.
    await q((pg) => pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES (null, ${ids.ash!}, ${ids.birchParent!}, 'invited')`);
    const [made] = await q((pg) => pg`SELECT family_qbo_id FROM guardian WHERE family_id = ${ids.ash!} AND parent_id = ${ids.birchParent!}`);
    expect(made!.family_qbo_id).toBeNull();
    // A second row of that person in that family, with or without a customer, is refused by the new index.
    for (const customer of [null, "F1"]) {
      const failure = await failureOf(q((pg) => pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES (${customer}, ${ids.ash!}, ${ids.birchParent!}, 'invited')`));
      expect(saidBy(failure)).toMatch(/guardian_family_id_parent_uq/);
    }
    // Rows with no family record are not held to it: two closed rows of one person, from a change of company.
    await q((pg) => pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status, disabled_reason) VALUES ('F8', null, ${ids.birchParent!}, 'disabled', 'company_changed')`);
  });
});
