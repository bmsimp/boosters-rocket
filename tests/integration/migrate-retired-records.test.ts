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
 * Migration 0046 (stage 3's slice 12a of the app-owned families spec): what nothing reads goes. The held-address
 * review's table (`held_address`), the match review's (`family_match`), the QuickBooks record an email change named
 * (`parent_email_change.record_qbo_id`, read by nothing since slice 11d) and the two settings the review left
 * (`parents.previous_company`, `parents.review_notice`). It refuses nothing and fills nothing; one audit row keeps the
 * counts of what went, and never an address, a note or a QuickBooks id.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_retired");
const folders: string[] = [];
const ASH = "7c0a9a1e-0000-4000-8000-000000000061", BIRCH = "7c0a9a1e-0000-4000-8000-000000000062";
const STAFF = "7c0a9a1e-0000-4000-8000-0000000000ac";
const HELD = ["held.one@retired.example", "held.two@retired.example"];
const NOTE = "Both hers, said the treasurer";

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-retired-"));
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
const tableThere = async (table: string) => (await q((pg) => pg`SELECT to_regclass(${`public.${table}`})::text AS t`))[0]!.t !== null;
const changeColumns = async () => (await q((pg) => pg`SELECT column_name FROM information_schema.columns WHERE table_name = 'parent_email_change'`))
  .map((c) => c.column_name as string);
const settingKeys = async () => (await q((pg) => pg`SELECT key FROM setting ORDER BY key COLLATE "C"`)).map((s) => s.key as string);
const changes = () => q((pg) => pg`SELECT * FROM parent_email_change ORDER BY id`);
const droppedRows = () => q((pg) => pg`SELECT door, actor_label, actor_id, target_type, target_id, ip, before, after FROM audit_log WHERE action = 'parents.retired_records.dropped'`);
/** Every column of a request but the one 0046 drops. */
const withoutRecord = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "record_qbo_id")));

describe("migration 0046: the retired reviews' records go", { timeout: 60_000 }, () => {
  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  describe("a database that holds them", () => {
    let changesBefore: Record<string, unknown>[] = [];
    let keysBefore: string[] = [];

    beforeAll(async () => {
      await makeScratchDatabase("migrate_retired"); // marked as this run's: a database of that name the run didn't make is refused
      await migrateWith(migrationsUpTo(45));
      await q(async (pg) => {
        // Two held addresses, one with staff's decision and note; two matches across companies.
        await pg`INSERT INTO held_address (email) VALUES (${HELD[0]!})`;
        await pg`INSERT INTO held_address (email, approved_family_qbo_ids, rejected_family_qbo_ids, note, decided_by, decided_at)
          VALUES (${HELD[1]!}, ${pg.json(["12", "20"])}, ${pg.json(["30"])}, ${NOTE}, ${STAFF}, now())`;
        await pg`INSERT INTO family_match (old_realm_id, old_family_qbo_id, new_realm_id, new_family_qbo_id, decided_by)
          VALUES ('1111', '12', '2222', '87', ${STAFF}), ('1111', '20', '2222', '90', ${STAFF})`;
        // Both retired settings, and one setting that stays.
        await pg`INSERT INTO setting (key, value) VALUES ('parents.previous_company', ${pg.json({ realmId: "1111", people: [{ name: "Old Name", email: "old@retired.example" }] })}),
          ('parents.review_notice', ${pg.json({ lastSentAt: "2026-11-01T00:00:00Z" })}),
          ('parents.settings', ${pg.json({ signin: true, welcome: false, requireActiveStudents: false })})`;
        // Two people, each in a family of their own, each with a live change of sign-in address: one asked before
        // slice 11d, naming the QuickBooks record it would write, one since, naming none.
        for (const [id, name] of [[ASH, "Ash"], [BIRCH, "Birch"]] as const) {
          await pg`INSERT INTO parent (id, name, email) VALUES (${id}, ${name}, ${`${name.toLowerCase()}@retired.example`})`;
          const [f] = await pg`INSERT INTO family (name, active) VALUES (${`${name} Family`}, true) RETURNING id`;
          const [g] = await pg`INSERT INTO guardian (parent_id, status, family_id) VALUES (${id}, 'active', ${f!.id}) RETURNING id`;
          await pg`INSERT INTO parent_email_change (parent_id, guardian_id, family_id, record_qbo_id, new_email, token_hash, expires_at)
            VALUES (${id}, ${g!.id}, ${f!.id}, ${id === ASH ? "P1" : null}, ${`${name.toLowerCase()}.new@retired.example`}, ${(id === ASH ? "ab" : "cd").repeat(32)}, now() + interval '1 day')`;
        }
      });
      changesBefore = [...await changes()];
      keysBefore = await settingKeys();
      await migrateWith(path.resolve("drizzle"));
    }, DATABASE_WORK);

    it("drops both review tables and the request's record column", async () => {
      expect(await tableThere("held_address")).toBe(false);
      expect(await tableThere("family_match")).toBe(false);
      const columns = await changeColumns();
      expect(columns).not.toContain("record_qbo_id");
      expect(columns).toEqual(expect.arrayContaining(["parent_id", "guardian_id", "family_id", "new_email", "token_hash", "expires_at", "used_at"]));
    });

    it("deletes the two retired settings and keeps every other", async () => {
      // The earlier migrations store settings of their own (0044's among them): each is kept.
      expect(keysBefore).toEqual(expect.arrayContaining(["parents.previous_company", "parents.review_notice", "parents.settings"]));
      expect(await settingKeys()).toEqual(keysBefore.filter((k) => k !== "parents.previous_company" && k !== "parents.review_notice"));
    });

    it("keeps every email change, live, with every other column as it was", async () => {
      expect(changesBefore).toHaveLength(2);
      const after = [...await changes()];
      expect(after).toEqual(withoutRecord(changesBefore));
      expect(after.every((c) => c.used_at === null)).toBe(true);
    });

    it("writes one audit row with the counts, holding no address, note or QuickBooks id", async () => {
      const rows = await droppedRows();
      expect(rows).toEqual([{ door: "system", actor_label: "migration", actor_id: null, target_type: "parent", target_id: null, ip: null, before: null,
        after: { cause: "migration 0046_retired_records_dropped", heldAddresses: 2, familyMatches: 2, emailChangesNamingARecord: 1, retiredSettings: 2 } }]);
      const said = JSON.stringify(rows);
      for (const s of [...HELD, NOTE, "old@retired.example", "P1", "1111", "2222", "87", "90", STAFF]) expect(said).not.toContain(s);
    });
  });

  describe("an empty database", () => {
    beforeAll(async () => {
      await makeScratchDatabase("migrate_retired"); // replaces the first, made by this run
      await migrateWith(migrationsUpTo(45));
      await migrateWith(path.resolve("drizzle"));
    }, DATABASE_WORK);

    it("drops the same and counts nothing", async () => {
      expect(await tableThere("held_address")).toBe(false);
      expect(await tableThere("family_match")).toBe(false);
      expect(await changeColumns()).not.toContain("record_qbo_id");
      expect((await droppedRows()).map((r) => r.after)).toEqual([
        { cause: "migration 0046_retired_records_dropped", heldAddresses: 0, familyMatches: 0, emailChangesNamingARecord: 0, retiredSettings: 0 }]);
    });
  });
});
