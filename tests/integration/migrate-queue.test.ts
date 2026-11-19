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
 * Migrations 0034 and 0035 (stage 3 of the app-owned families spec): each item of the write queue is filed under the
 * app's own family and, for a student's rename, move or make-inactive, names the app's own student; what it sends stays
 * QuickBooks'. Run on data shaped like a real installation, upgraded from before 0023: every op and role of a staff
 * roster write and both buy-out writes, in every state, a flat-shape member's item (filed under no family until now),
 * a parent's own change and a new family (which have no record to name), a roster family named as a student and a
 * roster student named as a family (customers with a record of each kind), a row of another company, and links of the
 * same customer ids in another company. Each column is filled through a link of the kind it holds, in the roster's
 * company; another company's row is left with nulls; a row of the roster's company with no record of its kind stops
 * the migration and changes nothing; and the database then holds each item to its records by foreign keys. An empty
 * table passes with or without a roster company: every test database is migrated from empty, with no roster company,
 * by the setup.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_queue");
const folders: string[] = [];
const REALM = "4650000000000001";
const OTHER_REALM = "4650000000000999";
/** Customers that also have a family and a student record linked in OTHER_REALM. */
const CUSTOMERS_ELSEWHERE = ["F1", "F2", "S1", "S2", "M1"];
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e71";
const BUYOUT = "7c0a9a1e-0000-4000-8000-0000000000b1";
/** The columns the re-key adds or drops: every other column of an item is kept exactly. */
const RE_KEYED = new Set(["family_id", "student_id", "family_qbo_id"]);

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-queue-"));
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

/** Each item by a name of this test's, as 0022 held it. */
const ids: Record<string, string> = {};
let before = new Map<string, Record<string, unknown>>();

describe("migrations 0034 and 0035: the write queue names the app's own records it is filed under, and sends what it sent", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_queue"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before stage 1: migrations up to 0022.
    await migrateWith(migrationsUpTo(22));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
        ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
      await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
        ('F1', 'Ash Family', true, null, 'F', '0'), ('S1', 'Ash Kid', true, 'F1', 'S', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
        ('F2', 'Birch Family', true, null, 'F', '0'), ('S2', 'Birch Kid', true, 'F2', 'S', '0')`;
      const item = async (key: string, o: { request: Record<string, unknown>; target?: string | null; family?: string | null; state?: string; realm?: string }) => {
        const [row] = await pg`INSERT INTO write_queue (realm_id, request, target_qbo_id, family_qbo_id, state, sent, tries, last_code, next_try_at, finished_at)
          VALUES (${o.realm ?? REALM}, ${pg.json(o.request as never)}, ${o.target ?? null}, ${o.family ?? null}, ${o.state ?? "waiting"}, false, 1, 'http_429',
            ${o.state === "done" || o.state === "given_up" || o.state === "stuck" ? null : new Date("2026-11-18T10:00:00Z")},
            ${o.state === "done" || o.state === "given_up" ? new Date("2026-11-18T11:00:00Z") : null})
          RETURNING id`;
        ids[key] = row!.id as string;
      };
      // Every staff roster write as prepare() filed it: a new family under no family, a new student and parent under the
      // family they go into, a change of a student or parent under its family, a family's own rename under itself, a
      // move under the family it leaves, and a member's change (flat books) under no family, found by its target.
      await item("create-family", { request: { op: "create", role: "family", name: "Patel Family", typeQboId: "F", familyQboId: null, email: null } });
      await item("create-student", { request: { op: "create", role: "student", name: "Rosa Ash", typeQboId: "S", familyQboId: "F1", email: null }, family: "F1" });
      await item("create-parent", { request: { op: "create", role: "parent", name: "Luis Birch", typeQboId: "P", familyQboId: "F2", email: "luis@queue.example" }, family: "F2", state: "stuck" });
      await item("rename-student", { request: { op: "rename", role: "student", qboId: "S1", syncToken: "0", name: "Ash Child", was: "Ash Kid" }, target: "S1", family: "F1" });
      await item("move-student", { request: { op: "move", role: "student", qboId: "S1", syncToken: "0", fromFamilyQboId: "F1", toFamilyQboId: "F2" }, target: "S1", family: "F1", state: "stuck" });
      await item("deactivate-student", { request: { op: "deactivate", role: "student", qboId: "S2", syncToken: "0" }, target: "S2", family: "F2", state: "done" });
      await item("rename-parent", { request: { op: "rename", role: "parent", qboId: "P1", syncToken: "0", name: "Ash Guardian", was: "Ash Parent" }, target: "P1", family: "F1", state: "given_up" });
      await item("rename-family", { request: { op: "rename", role: "family", qboId: "F2", syncToken: "0", name: "Birch Household", was: "Birch Family" }, target: "F2", family: "F2" });
      await item("deactivate-member", { request: { op: "deactivate", role: "member", qboId: "M1", syncToken: "0" }, target: "M1" });
      // A family's own change that named no family (as a test seed or an older writer may have left it): found by its
      // target, as refsQuery and 0023 read it.
      await item("rename-family-unfiled", { request: { op: "rename", role: "family", qboId: "F1", syncToken: "0", name: "Ash Household", was: "Ash Family" }, target: "F1" });
      // A roster family changed as a student (its type changed in QuickBooks): 0023 made it a student record beside its
      // family record, and the item names that student record.
      await item("student-both", { request: { op: "rename", role: "student", qboId: "F2", syncToken: "0", name: "New", was: "Old" }, target: "F2", family: "F1" });
      // The buy-out writes, filed under the family that chose: one named a roster student's customer as its family, so
      // 0023 made it a family record beside its student record.
      await item("invoice-create", { request: { op: "invoice_create", buyoutId: BUYOUT, customerQboId: "S1", itemQboId: "4343", units: 2, unitCents: 5000, familyQboId: "F1" }, family: "F1" });
      await item("invoice-void", { request: { op: "invoice_void", buyoutId: BUYOUT, invoiceQboId: "9001", customerQboId: "F2", familyQboId: "F2", why: "switched_back" }, family: "F2", state: "done" });
      await item("family-both", { request: { op: "invoice_void", buyoutId: BUYOUT, invoiceQboId: "9002", customerQboId: "S2", familyQboId: "S2", why: "switched_back" }, family: "S2" });
      // Another company's item: no path makes one (a change of company deletes the queue), and nothing is filled for it.
      await item("elsewhere", { request: { op: "rename", role: "student", qboId: "S1", syncToken: "0", name: "Other", was: "Ash Kid" }, target: "S1", family: "F1", realm: OTHER_REALM });
    });
    // Migration 0023 makes the app's records and links from that, as on the proof-of-concept host.
    await migrateWith(migrationsUpTo(23));
    // Links of the same customer ids in another company (left from before a change of company, say): the fill must
    // take this company's record of each, never another company's.
    await q(async (pg) => {
      for (const customer of CUSTOMERS_ELSEWHERE) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`Elsewhere ${customer}`}, false) RETURNING id`;
        await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${OTHER_REALM}, ${customer}, ${f!.id}, 'carried_over')`;
        const [s] = await pg`INSERT INTO student (name, active) VALUES (${`Elsewhere ${customer}`}, false) RETURNING id`;
        await pg`INSERT INTO accounting_link (system, realm_id, customer_id, student_id, origin) VALUES ('quickbooks', ${OTHER_REALM}, ${customer}, ${s!.id}, 'carried_over')`;
      }
      before = new Map((await pg`SELECT * FROM write_queue`).map((r) => [r.id as string, { ...r }]));
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("stops, and changes nothing, on an item of the roster's company whose family or student has no record of that kind", async () => {
    // Made after 0023, so nothing made a record of them: never guessed at.
    const bad = await q((pg) => pg`INSERT INTO write_queue (realm_id, request, target_qbo_id, family_qbo_id, sent) VALUES
      (${REALM}, ${pg.json({ op: "create", role: "student", name: "Nobody Kid", typeQboId: "S", familyQboId: "F-NOBODY", email: null })}, null, 'F-NOBODY', false),
      (${REALM}, ${pg.json({ op: "rename", role: "student", qboId: "S-NOBODY", syncToken: "0", name: "New", was: "Old" })}, 'S-NOBODY', 'F1', false)
      RETURNING id`);
    const message = await failureOf(migrateWith(path.resolve("drizzle")));
    expect(message).toMatch(/Migration 0034 stopped, and changed nothing: /);
    expect(message).toMatch(/1 rows in write_queue with no family record/);
    expect(message).toMatch(/1 student rows in write_queue with no student record/);
    expect(await columnsOf("write_queue")).toContain("family_qbo_id");
    expect(await columnsOf("write_queue")).not.toContain("family_id");
    // Nothing before it was kept either: the migrations run as one.
    expect(await columnsOf("family_money")).toContain("family_qbo_id");
    await q((pg) => pg`DELETE FROM write_queue WHERE id IN ${pg(bad.map((b) => b.id as string))}`);
  });

  describe("once every item of the roster's company has its records", () => {
    beforeAll(async () => { await migrateWith(path.resolve("drizzle")); });

    it("files each item under its family's own family record, and names a student's change's own student record", async () => {
      const rows = new Map((await q(async (pg) => [...await pg`SELECT id, family_id, student_id FROM write_queue`])).map((r) => [r.id as string, r]));
      const of = (key: string) => { const r = rows.get(ids[key]!)!; return { family: r.family_id, student: r.student_id }; };
      const [f1, f2, m1, s2AsFamily] = await Promise.all([recordOf("F1", "family"), recordOf("F2", "family"), recordOf("M1", "family"), recordOf("S2", "family")]);
      const [s1, s2, f2AsStudent] = await Promise.all([recordOf("S1", "student"), recordOf("S2", "student"), recordOf("F2", "student")]);
      expect(of("create-student")).toEqual({ family: f1, student: null });
      expect(of("create-parent")).toEqual({ family: f2, student: null });
      expect(of("rename-student")).toEqual({ family: f1, student: s1 });
      expect(of("move-student")).toEqual({ family: f1, student: s1 });      // the family it leaves
      expect(of("deactivate-student")).toEqual({ family: f2, student: s2 }); // a done item too
      expect(of("rename-family")).toEqual({ family: f2, student: null });
      // A member's change, which named no family, is filed under the member's own family record.
      expect(of("deactivate-member")).toEqual({ family: m1, student: null });
      // A family's own change that named no family is filed under that family, through its target.
      expect(of("rename-family-unfiled")).toEqual({ family: f1, student: null });
      expect(of("invoice-create")).toEqual({ family: f1, student: null });
      expect(of("invoice-void")).toEqual({ family: f2, student: null });
      // A customer with a record of each kind: the kind the column holds, never the other.
      expect(of("student-both")).toEqual({ family: f1, student: f2AsStudent });
      expect(of("student-both").student).not.toBe(f2);
      expect(of("family-both")).toEqual({ family: s2AsFamily, student: null });
      expect(of("family-both").family).not.toBe(s2);
    });

    it("leaves a new family, a parent's own customer and another company's item without the records they have none of", async () => {
      const rows = new Map((await q(async (pg) => [...await pg`SELECT id, family_id, student_id FROM write_queue`])).map((r) => [r.id as string, r]));
      expect(rows.get(ids["create-family"]!)).toMatchObject({ family_id: null, student_id: null });
      // A parent's change is filed under the parent's family; the parent has no family or student record of their own.
      expect(rows.get(ids["rename-parent"]!)).toMatchObject({ family_id: await recordOf("F1", "family"), student_id: null });
      // Never another company's link, though its customers have one there.
      expect(rows.get(ids.elsewhere!)).toMatchObject({ family_id: null, student_id: null });
    });

    it("keeps everything an item sends and every other column exactly: the request, the target, the state and every time", async () => {
      const after = await q(async (pg) => [...await pg`SELECT * FROM write_queue`]);
      expect(after).toHaveLength(before.size);
      for (const row of after) expect(kept(row), String(row.id)).toEqual(kept(before.get(row.id as string)!));
      const move = after.find((r) => r.id === ids["move-student"])!;
      expect(move).toMatchObject({ target_qbo_id: "S1", realm_id: REALM, request: { op: "move", qboId: "S1", fromFamilyQboId: "F1", toFamilyQboId: "F2" } });
    });

    it("drops the family's customer column and its index, and holds each item to its records by foreign keys", async () => {
      const columns = await columnsOf("write_queue");
      expect(columns).toEqual(expect.arrayContaining(["family_id", "student_id", "target_qbo_id", "result_qbo_id", "realm_id"]));
      expect(columns.filter((c) => c.endsWith("_qbo_id"))).toEqual(["result_qbo_id", "target_qbo_id"]);
      const indexes = await q(async (pg) => (await pg`SELECT indexname FROM pg_indexes WHERE tablename = 'write_queue'`).map((i) => i.indexname as string).sort());
      expect(indexes).toEqual(["write_queue_family_id_ix", "write_queue_pkey", "write_queue_state_ix", "write_queue_student_ix", "write_queue_target_ix"]);
      const insert = (o: { familyId?: string | null; studentId?: string | null }) => q((pg) => pg`INSERT INTO write_queue (realm_id, request, family_id, student_id, sent)
        VALUES (${REALM}, ${pg.json({ op: "deactivate", role: "student", qboId: "S1", syncToken: "0" })}, ${o.familyId ?? null}, ${o.studentId ?? null}, false)`);
      await expect(insert({ familyId: NOBODY })).rejects.toThrow(/write_queue_family_id_family_id_fk/);
      await expect(insert({ studentId: NOBODY })).rejects.toThrow(/write_queue_student_id_student_id_fk/);
      // Both may be null: a new family or member has no record until QuickBooks answers.
      await insert({});
      // A record an item is filed under can't be deleted from under it: the change of company deletes the queue first.
      const m1 = await recordOf("M1", "family"), s1 = await recordOf("S1", "student");
      await expect(q((pg) => pg`DELETE FROM family WHERE id = ${m1}`)).rejects.toThrow(/write_queue_family_id_family_id_fk/);
      await expect(q((pg) => pg`DELETE FROM student WHERE id = ${s1}`)).rejects.toThrow(/write_queue_student_id_student_id_fk/);
    });
  });
});
