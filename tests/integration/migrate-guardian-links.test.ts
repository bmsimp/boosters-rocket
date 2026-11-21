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
 * Migration 0048 (stage 3's slice 12b1): a guardian row's own record is its `carried_over` membership link, read by the
 * take-in of contact details, and nothing reads the row's `source_qbo_id` any more. So for each row in the roster's
 * company, not closed by a change of company, whose family record's link names the row's `family_qbo_id`, whose source
 * is another customer, and which has no membership link of that company and none ended, it makes that link to the
 * source, with the cache's version of it. It changes no column, refuses nothing, and writes one counts-only audit row:
 * also on an empty database, and on one whose roster names no company (where it makes nothing).
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_member");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-member-"));
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
/** A fresh scratch database, migrated up to the migration before 0048. */
async function at0047() {
  await makeScratchDatabase("migrate_member"); // marked as this run's: a database of that name the run didn't make is refused
  await migrateWith(migrationsUpTo(indexOf("_guardian_links_additive") - 1));
}
const filled = () => q((pg) => pg`SELECT door, actor_label, actor_id, target_type, target_id, ip, before, after FROM audit_log WHERE action = 'parents.guardian_links.filled'`);
const links = () => q((pg) => pg`SELECT * FROM accounting_link ORDER BY id`);
const guardians = () => q((pg) => pg`SELECT * FROM guardian ORDER BY id`);

const REALM = "9130000000000048", OTHER = "9130000000000049";
const ids: Record<string, string> = {};

afterAll(async () => {
  await dropScratchDatabase(NAME);
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
}, DATABASE_WORK);

describe("migration 0048: each guardian row's own link, from the record its sign-in came from", { timeout: 60_000 }, () => {
  it("makes the links the import never made, and keeps every other row and link as it is", async () => {
    await at0047();
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })})`;
      // The cache's Rivera family and its parents; customer 17 is no longer in it.
      for (const [qboId, name, parentOf, token] of [["10", "Rivera Family", null, "3"], ["11", "Ana Rivera", "10", "5"], ["13", "Bea Rivera", "10", "7"],
        ["14", "Cal Rivera", "10", "2"], ["15", "Cal R.", "10", "4"]] as const) {
        await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES (${qboId}, ${name}, true, ${parentOf}, ${parentOf ? "P" : "F"}, ${token})`;
      }
      for (const key of ["rivera", "oak", "pine"] as const) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${key} Family`}, true) RETURNING id`;
        ids[key] = f!.id as string;
      }
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${REALM}, '10', ${ids.rivera!}, 'carried_over')`;
      // Pine is linked in another company only.
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${OTHER}, '30', ${ids.pine!}, 'carried_over')`;
      const row = async (key: string, o: { family: string | null; copy: string | null; source: string | null; closedByAChange?: boolean }) => {
        const [p] = await pg`INSERT INTO parent (name, email) VALUES (${key}, ${`${key}@links.example`}) RETURNING id`;
        const [g] = await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status, source_qbo_id, disabled_reason, status_before_disable)
          VALUES (${o.copy}, ${o.family}, ${p!.id as string}, ${o.closedByAChange ? "disabled" : "active"}, ${o.source}, ${o.closedByAChange ? "company_changed" : null}, ${o.closedByAChange ? "active" : null}) RETURNING id`;
        ids[key] = g!.id as string;
      };
      await row("ana", { family: ids.rivera!, copy: "10", source: "11" });     // no link: made, with the cache's version
      await row("eve", { family: ids.rivera!, copy: "10", source: "17" });     // no link, its record not in the cache: made, with none
      await row("bea", { family: ids.rivera!, copy: "10", source: "13" });     // linked already: kept, counted
      await row("cal", { family: ids.rivera!, copy: "10", source: "14" });     // its link names another customer: kept, counted
      await row("dee", { family: ids.rivera!, copy: "10", source: "10" });     // its record is the family's own: nothing
      await row("old", { family: null, copy: "10", source: "16", closedByAChange: true }); // a change of company closed it: nothing
      await row("gus", { family: ids.oak!, copy: null, source: "21" });        // its family unlinked, its link ended: nothing
      await row("hal", { family: ids.pine!, copy: "30", source: "31" });       // its family linked in another company only: nothing
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, guardian_id, origin, synced_token) VALUES ('quickbooks', ${REALM}, '13', ${ids.bea!}, 'carried_over', '7')`;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, guardian_id, origin) VALUES ('quickbooks', ${REALM}, '15', ${ids.cal!}, 'carried_over')`;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, guardian_id, origin) VALUES ('quickbooks', ${OTHER}, '31', ${ids.hal!}, 'carried_over')`;
      await pg`INSERT INTO accounting_link_ended (id, system, realm_id, customer_id, guardian_id, origin, linked_at, ended_at, ended_how)
        VALUES (gen_random_uuid(), 'quickbooks', ${REALM}, '21', ${ids.gus!}, 'carried_over', now(), now(), 'unlinked')`;
    });
    const before = { links: await links(), guardians: await guardians() };
    await migrateWith(path.resolve("drizzle"));

    // Every row as it was: no column changed.
    expect(await guardians()).toEqual(before.guardians);
    // Every link as it was, and two more: Ana's and Eve's, carried over by nobody.
    const now = await links();
    const kept = new Set(before.links.map((l) => l.id as string));
    expect(now.filter((l) => kept.has(l.id as string))).toEqual(before.links);
    const made = now.filter((l) => !kept.has(l.id as string));
    expect(made.map((l) => [l.guardian_id, l.customer_id]).sort()).toEqual([[ids.ana!, "11"], [ids.eve!, "17"]].sort());
    for (const l of made) expect(l).toMatchObject({ system: "quickbooks", realm_id: REALM, origin: "carried_over", linked_by: null, family_id: null, student_id: null });
    expect(made.find((l) => l.guardian_id === ids.ana)).toMatchObject({ synced_token: "5" });
    expect(made.find((l) => l.guardian_id === ids.ana)!.synced_at).not.toBeNull();
    expect(made.find((l) => l.guardian_id === ids.eve)).toMatchObject({ synced_token: null, synced_at: null });

    // One audit row, counts only.
    const rows = await filled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "system", actor_label: "migration", actor_id: null, target_type: "accounting_link", target_id: null, ip: null, before: null });
    expect(rows[0]!.after).toEqual({ cause: "migration 0048_guardian_links_additive", linksMade: 2, rowsAlreadyLinked: 1, linksDisagreeing: 1, rowsOfFamiliesUnlinked: 1, rowsWithASourceAndNoCompany: 0 });
    const said = JSON.stringify(rows[0]);
    for (const id of Object.values(ids)) expect(said).not.toContain(id);
    for (const customer of ["11", "13", "17", "21"]) expect(said).not.toContain(`"${customer}"`);
  }, DATABASE_WORK);

  it("on an empty database: nothing made, and its audit row says so", async () => {
    await at0047();
    await migrateWith(path.resolve("drizzle"));
    expect(await links()).toEqual([]);
    expect((await filled()).map((r) => r.after)).toEqual([{ cause: "migration 0048_guardian_links_additive", linksMade: 0, rowsAlreadyLinked: 0, linksDisagreeing: 0,
      rowsOfFamiliesUnlinked: 0, rowsWithASourceAndNoCompany: 0 }]);
  }, DATABASE_WORK);

  it("while the roster names no company: nothing made, and the rows with a source counted", async () => {
    await at0047();
    await q(async (pg) => {
      const [f] = await pg`INSERT INTO family (name, active) VALUES ('Rivera Family', true) RETURNING id`;
      await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${REALM}, '10', ${f!.id as string}, 'carried_over')`;
      const [p] = await pg`INSERT INTO parent (name, email) VALUES ('Ana Rivera', 'ana@links.example') RETURNING id`;
      await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status, source_qbo_id) VALUES ('10', ${f!.id as string}, ${p!.id as string}, 'active', '11')`;
    });
    const before = await links();
    await migrateWith(path.resolve("drizzle"));
    expect(await links()).toEqual(before);
    expect((await filled()).map((r) => r.after)).toEqual([{ cause: "migration 0048_guardian_links_additive", linksMade: 0, rowsAlreadyLinked: 0, linksDisagreeing: 0,
      rowsOfFamiliesUnlinked: 0, rowsWithASourceAndNoCompany: 1 }]);
  }, DATABASE_WORK);
});
