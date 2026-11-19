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
 * Migrations 0032 and 0033 (stage 2 of the app-owned families spec): the money cache moves from the family's QuickBooks
 * customer to the app's own family, and keeps everything inside a row as it was. Run on data shaped like a real
 * installation, upgraded from before 0023: two families' figures with invoices and the worker's customer check, a row
 * that has only ever failed (no company), a row naming a roster student as a family (a customer with a record of each
 * kind), a row of another company, and links of the same customer ids in another company. Each row is filled through
 * the family link in the roster's company, never a student link and never another company's; another company's row
 * goes (it is a cache, and every reader treats it as absent); a row with no family record stops the migration and
 * changes nothing; and the database then holds a row to its family by the key and a foreign key. An empty table passes
 * with or without a roster company: every test database is migrated from empty, with no roster company, by the setup.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_money");
const folders: string[] = [];
const REALM = "4640000000000001";
const OTHER_REALM = "4640000000000999";
/** Customers that also have a family and a student record linked in OTHER_REALM. */
const CUSTOMERS_ELSEWHERE = ["F1", "F2", "S1", "S2", "F-FAILED", "F-ELSEWHERE"];
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e70";
/** The columns the re-key changes or drops: every other column of a row is kept exactly. */
const RE_KEYED = new Set(["family_id", "family_qbo_id"]);

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-money-"));
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
const columnsOf = (table: string) => q(async (pg) => (await pg`SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`).map((c) => c.column_name as string).sort());
/** Drizzle wraps the database's error in its own, with the database's as the cause. */
const failureOf = async (run: Promise<unknown>) => {
  const failure = await run.then(() => null, (e: unknown) => e as Error & { cause?: unknown });
  expect(failure).not.toBeNull();
  return `${failure!.message} ${failure!.cause instanceof Error ? failure!.cause.message : ""}`;
};
const recordOf = async (customer: string, kind: "family" | "student") =>
  (await q((pg) => pg.unsafe(`SELECT ${kind}_id AS id FROM accounting_link WHERE customer_id = $1 AND ${kind}_id IS NOT NULL AND realm_id = '${REALM}'`, [customer])))[0]!.id as string;
/** A row with the re-keyed columns left out: what must be the same before and after. */
const kept = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([column]) => !RE_KEYED.has(column)));

const invoice = (qboId: string, customerQboId: string, forName: string | null, balanceCents: number) => ({ qboId, number: `INV-${qboId}`, customerQboId, forName,
  date: "2026-10-01", dueDate: "2026-12-01", totalCents: 8500, balanceCents, currency: "USD", payLink: `https://connect.intuit.com/t/${qboId}`, itemQboIds: ["4101"] });
/** Every row as 0023 left it, by its family customer, to compare with what the migrations leave. */
let before = new Map<string, Record<string, unknown>>();

describe("migrations 0032 and 0033: the money cache is kept by the app's own family, and holds what it held", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_money"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before stage 1: migrations up to 0022.
    await migrateWith(migrationsUpTo(22));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
        ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
      await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
        ('F1', 'Ash Family', true, null, 'F', '0'), ('S1', 'Ash Kid', true, 'F1', 'S', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
        ('F2', 'Birch Family', true, null, 'F', '0'), ('S2', 'Birch Kid', true, 'F2', 'S', '0')`;
      // The Ash family's figures, with the worker's check of each customer; the Birch family's, read by a page load and
      // marked behind by a buy-out since.
      await pg`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, balance_with_jobs_cents, currency, mismatch_audited_at,
          checked_at, customer_checks, failed_at, failed_code, stale_at)
        VALUES ('F1', ${REALM}, '2026-11-17T10:00:00Z', ${pg.json([invoice("9001", "F1", null, 8500), invoice("9002", "S1", "Ash Kid", 0)])}, 8500, 9000, 'USD',
          '2026-11-17T10:00:01Z', '2026-11-17T10:00:02Z',
          ${pg.json([{ customerQboId: "F1", name: null, balanceCents: 9000, invoicesCents: 8500, currency: "USD" }, { customerQboId: "S1", name: "Ash Kid", balanceCents: 0, invoicesCents: 0, currency: "USD" }])},
          '2026-11-17T09:00:00Z', 'timeout', null),
          ('F2', ${REALM}, '2026-11-17T11:00:00Z', ${pg.json([invoice("9003", "S2", "Birch Kid", 8500)])}, 8500, null, 'USD', null, null, null, null, null, '2026-11-17T11:05:00Z')`;
      // A family whose every read has failed (no company), one no longer in the roster; a roster student's customer named
      // as a family (0023 made it a family record beside its student record); and figures read from another company.
      await pg`INSERT INTO family_money (family_qbo_id, realm_id, failed_at, failed_code) VALUES ('F-FAILED', null, '2026-11-17T08:00:00Z', 'http_500')`;
      await pg`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, currency) VALUES ('S2', ${REALM}, '2026-11-17T12:00:00Z', ${pg.json([])}, 0, 'USD')`;
      await pg`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, currency)
        VALUES ('F-ELSEWHERE', ${OTHER_REALM}, '2026-11-17T12:00:00Z', ${pg.json([invoice("9100", "F-ELSEWHERE", null, 100)])}, 8500, 'USD')`;
    });
    // Migration 0023 makes the app's records and links from that, as on the proof-of-concept host.
    await migrateWith(migrationsUpTo(23));
    // Links of the same customer ids in another company (left from before a change of company, say): the fill must
    // take this company's family record of each, never another company's nor a student record.
    await q(async (pg) => {
      for (const customer of CUSTOMERS_ELSEWHERE) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`Elsewhere ${customer}`}, false) RETURNING id`;
        await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${OTHER_REALM}, ${customer}, ${f!.id}, 'carried_over')`;
        const [s] = await pg`INSERT INTO student (name, active) VALUES (${`Elsewhere ${customer}`}, false) RETURNING id`;
        await pg`INSERT INTO accounting_link (system, realm_id, customer_id, student_id, origin) VALUES ('quickbooks', ${OTHER_REALM}, ${customer}, ${s!.id}, 'carried_over')`;
      }
      before = new Map((await pg`SELECT * FROM family_money`).map((r) => [r.family_qbo_id as string, { ...r }]));
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("stops, and changes nothing, on a row of the roster's company or a row that has only ever failed with no family record", async () => {
    // Made after 0023, so nothing made a record of them: never guessed at.
    await q((pg) => pg`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, currency)
      VALUES ('F-NOBODY', ${REALM}, now(), ${pg.json([])}, 0, 'USD')`);
    await q((pg) => pg`INSERT INTO family_money (family_qbo_id, realm_id, failed_at, failed_code) VALUES ('F-NOBODY-FAILED', null, now(), 'timeout')`);
    const message = await failureOf(migrateWith(path.resolve("drizzle")));
    expect(message).toMatch(/Migration 0032 stopped, and changed nothing: /);
    expect(message).toMatch(/1 rows in family_money of the roster's company with no family record/);
    expect(message).toMatch(/1 rows in family_money that have only ever failed with no family record/);
    expect(await columnsOf("family_money")).toContain("family_qbo_id");
    expect(await columnsOf("family_money")).not.toContain("family_id");
    // Not even another company's row went: the migrations run as one, and nothing before them was kept either.
    expect((await q((pg) => pg`SELECT family_qbo_id FROM family_money WHERE realm_id = ${OTHER_REALM}`)).map((r) => r.family_qbo_id)).toEqual(["F-ELSEWHERE"]);
    expect(await columnsOf("buyout")).toContain("family_qbo_id");
    await q((pg) => pg`DELETE FROM family_money WHERE family_qbo_id IN ('F-NOBODY', 'F-NOBODY-FAILED')`);
  });

  it("stops on every row while the roster names no company: no link of any company answers, and nothing is deleted", async () => {
    await q((pg) => pg`UPDATE setting SET key = 'roster.source.away' WHERE key = 'roster.source'`);
    try {
      const message = await failureOf(migrateWith(path.resolve("drizzle")));
      expect(message).toMatch(/Migration 0032 stopped, and changed nothing: /);
      expect(message).toMatch(/1 rows in family_money that have only ever failed with no family record/);
      expect(message).toMatch(/4 rows in family_money of a company while the roster names none/);
      expect(await columnsOf("family_money")).not.toContain("family_id");
      expect(await q((pg) => pg`SELECT family_qbo_id FROM family_money`)).toHaveLength(5);
    } finally {
      await q((pg) => pg`UPDATE setting SET key = 'roster.source' WHERE key = 'roster.source.away'`);
    }
  });

  describe("once every row of the roster's company has its record", () => {
    beforeAll(async () => { await migrateWith(path.resolve("drizzle")); });

    it("gives each row its family customer's own family record in the roster's company: never a student record, never another company's", async () => {
      const rows = await q(async (pg) => [...await pg`SELECT m.family_id, l.customer_id, l.realm_id FROM family_money m
        LEFT JOIN accounting_link l ON l.family_id = m.family_id ORDER BY l.customer_id COLLATE "C"`]);
      expect(rows.map((r) => [r.customer_id, r.realm_id])).toEqual([["F-FAILED", REALM], ["F1", REALM], ["F2", REALM], ["S2", REALM]]);
      for (const customer of ["F1", "F2", "F-FAILED", "S2"]) {
        expect(rows.find((r) => r.customer_id === customer)!.family_id, customer).toBe(await recordOf(customer, "family"));
      }
      // The roster student named as a family: its family record, never its student record.
      expect(rows.find((r) => r.customer_id === "S2")!.family_id).not.toBe(await recordOf("S2", "student"));
    });

    it("deletes the row of another company, which every reader treated as absent", async () => {
      const left = await q(async (pg) => [...await pg`SELECT realm_id FROM family_money`]);
      expect(left).toHaveLength(4);
      expect(left.every((r) => r.realm_id === REALM || r.realm_id === null)).toBe(true);
    });

    it("keeps everything inside each row exactly: the invoices with their customers, the check, the totals and every time", async () => {
      const after = await q(async (pg) => [...await pg`SELECT m.*, l.customer_id AS customer FROM family_money m JOIN accounting_link l ON l.family_id = m.family_id`]);
      expect(after).toHaveLength(4);
      for (const row of after) {
        const { customer, ...rest } = row;
        expect(kept(rest), String(customer)).toEqual(kept(before.get(customer as string)!));
      }
      const ash = after.find((r) => r.customer === "F1")!;
      expect((ash.invoices as { customerQboId: string; qboId: string; itemQboIds: string[] }[]).map((i) => [i.qboId, i.customerQboId, i.itemQboIds])).toEqual([["9001", "F1", ["4101"]], ["9002", "S1", ["4101"]]]);
      expect((ash.customer_checks as { customerQboId: string }[]).map((c) => c.customerQboId)).toEqual(["F1", "S1"]);
    });

    it("keys the table by the family record: the primary key, a foreign key that refuses a record's removal, and no QuickBooks column for the family", async () => {
      const columns = await columnsOf("family_money");
      expect(columns).toContain("family_id");
      expect(columns).not.toContain("family_qbo_id");
      expect(columns.filter((c) => c.endsWith("_qbo_id"))).toEqual([]);
      const key = await q(async (pg) => (await pg`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'family_money'::regclass AND i.indisprimary`).map((r) => r.attname as string));
      expect(key).toEqual(["family_id"]);
      const indexes = await q(async (pg) => (await pg`SELECT indexname FROM pg_indexes WHERE tablename = 'family_money'`).map((i) => i.indexname as string).sort());
      expect(indexes).toEqual(["family_money_pkey"]);
      const insert = (familyId: string | null) => q((pg) => pg`INSERT INTO family_money (family_id, realm_id, failed_at, failed_code) VALUES (${familyId}, null, now(), 'timeout')`);
      await expect(insert(NOBODY)).rejects.toThrow(/family_money_family_id_family_id_fk/);
      await expect(insert(null)).rejects.toThrow(/family_id/);
      await expect(insert(await recordOf("F1", "family"))).rejects.toThrow(/family_money_pkey/);
      // A record whose figures are kept can't be deleted from under them: the change of company deletes the figures first.
      const failed = await recordOf("F-FAILED", "family");
      await expect(q((pg) => pg`DELETE FROM family WHERE id = ${failed}`)).rejects.toThrow(/family_money_family_id_family_id_fk/);
    });
  });
});
