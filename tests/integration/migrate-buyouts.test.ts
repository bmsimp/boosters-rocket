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
 * Migrations 0030 and 0031 (stage 2 of the app-owned families spec): buy-outs move from QuickBooks ids for their family
 * and subject to the app's own families and students, and keep what they bill as it was. Run on data shaped like a real
 * installation, upgraded from before 0023: a per-family buy-out in each state, another family's, a per-student one,
 * one whose student has since moved to another family and one whose student has left the roster, one naming a roster
 * family as its student (a customer named as both kinds), a queued write for one, and links of the same customer ids in
 * another company. Each buy-out is filled through the link of the kind its column holds, in the roster's company, and
 * keeps its id, its customer, item, invoice, version and company; a row with no record, of another company, or a
 * per-family one whose subject isn't its family, stops the migration and changes nothing; and the database then refuses
 * a buy-out that names no record, a second live one for a family's requirement or for a student's (whichever family
 * chose it), and a record's removal while a buy-out names it.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_buyouts");
const folders: string[] = [];
const REALM = "4630000000000001";
const OTHER_REALM = "4630000000000999";
/** Customers that also have a family and a student record linked in OTHER_REALM. */
const CUSTOMERS_ELSEWHERE = ["F1", "F2", "S1", "S2", "S3", "S-GONE"];
const ASH_PARENT = "7c0a9a1e-0000-4000-8000-000000000011", BIRCH_PARENT = "7c0a9a1e-0000-4000-8000-000000000012";
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e6f";
const STATES = ["being_invoiced", "invoiced", "paid", "being_voided", "voided", "refused", "stuck"] as const;
/** The columns the re-key changes or drops: every other column of a buy-out is kept exactly. */
const RE_KEYED = new Set(["family_id", "student_id", "family_qbo_id", "subject_qbo_id"]);

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-buyouts-"));
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
/** The app record's customer, through its link of that kind in the roster's company. */
const customerOf = (column: string, kind: "family" | "student") => `(SELECT l.customer_id FROM accounting_link l WHERE l.${kind}_id = ${column} AND l.realm_id = '${REALM}')`;
const recordOf = async (customer: string, kind: "family" | "student") =>
  (await q((pg) => pg.unsafe(`SELECT ${kind}_id AS id FROM accounting_link WHERE customer_id = $1 AND ${kind}_id IS NOT NULL AND realm_id = '${REALM}'`, [customer])))[0]!.id as string;
/** A buy-out row with the re-keyed columns left out: what must be the same before and after. */
const kept = (rows: Record<string, unknown>[]) => rows.map((b) => Object.fromEntries(Object.entries(b).filter(([column]) => !RE_KEYED.has(column))));

const ids: Record<string, string> = {};
/** Every buy-out, and every queued write, as 0023 left them, to compare with what the migrations leave. */
let buyoutsBefore: Record<string, unknown>[] = [];
let queueBefore: Record<string, unknown>[] = [];

describe("migrations 0030 and 0031: buy-outs name the app's own families and students, and bill as they did", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_buyouts"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before stage 1: migrations up to 0022.
    await migrateWith(migrationsUpTo(22));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
        ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
      await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
      // S3 was in the Ash family when its buy-out was chosen, and is in the Birch family now; S-GONE has left the roster.
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
        ('F1', 'Ash Family', true, null, 'F', '0'), ('S1', 'Ash Kid', true, 'F1', 'S', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
        ('F2', 'Birch Family', true, null, 'F', '0'), ('S2', 'Birch Kid', true, 'F2', 'S', '0'), ('S3', 'Moved Kid', true, 'F2', 'S', '0')`;
      const [season] = await pg`INSERT INTO season (name, is_current) VALUES ('Fall', true) RETURNING id`;
      const [step] = await pg`INSERT INTO season_step (season_id, name, position) VALUES (${season!.id}, 'Volunteer', 0) RETURNING id`;
      const requirement = async (key: string, appliesTo: "family" | "student", position: number) => {
        const [row] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position, amount, amount_unit, item_qbo_id, buyout_unit_cents)
          VALUES (${step!.id}, 'volunteer', ${key}, ${appliesTo}, 'everyone', ${position}, 2, 'shifts', '4343', 5000) RETURNING id`;
        ids[key] = row!.id as string;
      };
      // One requirement per buy-out: at most one is live per requirement and subject, and each row here is its own case.
      for (const [i, s] of STATES.entries()) await requirement(`family-${s}`, "family", i);
      for (const [i, k] of ["own", "moved", "gone", "both"].entries()) await requirement(`student-${k}`, "student", 10 + i);
      const buyout = async (key: string, o: { requirement: string; family: string; subject: string; state: string; chosenBy?: string; invoice?: string | null }) => {
        const invoice = o.invoice === undefined ? (o.state === "being_invoiced" || o.state === "refused" ? null : `9${Object.keys(ids).length}`) : o.invoice;
        const [row] = await pg`INSERT INTO buyout (requirement_id, family_qbo_id, subject_qbo_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, invoice_qbo_id,
            invoice_sync_token, realm_id, chosen_by, chosen_by_label, flag, flagged_at)
          VALUES (${ids[o.requirement]!}, ${o.family}, ${o.subject}, ${o.subject}, '4343', 5000, 2, 10000, ${o.state}, ${invoice}, ${invoice ? "3" : null}, ${REALM},
            ${o.chosenBy ?? ASH_PARENT}, 'ash@buyouts.example', ${o.state === "stuck" ? "given_up" : null}, ${o.state === "stuck" ? new Date("2026-11-12T10:00:00Z") : null})
          RETURNING id`;
        ids[key] = row!.id as string;
      };
      for (const s of STATES) await buyout(`ash-${s}`, { requirement: `family-${s}`, family: "F1", subject: "F1", state: s });
      await buyout("birch", { requirement: "family-invoiced", family: "F2", subject: "F2", state: "paid", chosenBy: BIRCH_PARENT });
      await buyout("ash-student", { requirement: "student-own", family: "F1", subject: "S1", state: "invoiced" });
      // Chosen by the Ash family for a student QuickBooks has under the Birch family now, not yet followed; and one for
      // a student who has left the roster.
      await buyout("moved", { requirement: "student-moved", family: "F1", subject: "S3", state: "invoiced" });
      await buyout("gone", { requirement: "student-gone", family: "F1", subject: "S-GONE", state: "paid" });
      // A per-student buy-out whose student is a customer the roster holds as a family: 0023 made it a student record too.
      await buyout("both", { requirement: "student-both", family: "F1", subject: "F2", state: "voided" });
      // The queued create of the one being invoiced: what the write queue sends stays its own QuickBooks ids, untouched here.
      await pg`INSERT INTO write_queue (realm_id, request, family_qbo_id, sent, tries, next_try_at)
        VALUES (${REALM}, ${pg.json({ op: "invoice_create", buyoutId: ids["ash-being_invoiced"]!, customerQboId: "F1", itemQboId: "4343", units: 2, unitCents: 5000, familyQboId: "F1" })}, 'F1', false, 0, now())`;
    });
    // Migration 0023 makes the app's records and links from that, as on the proof-of-concept host.
    await migrateWith(migrationsUpTo(23));
    // Links of the same customer ids in another company (left from before a change of company, say): the fill must
    // take this company's record of each, never another company's, so every check below reads through this company.
    await q(async (pg) => {
      for (const customer of CUSTOMERS_ELSEWHERE) {
        const [f] = await pg`INSERT INTO family (name, active) VALUES (${`Elsewhere ${customer}`}, false) RETURNING id`;
        await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, origin) VALUES ('quickbooks', ${OTHER_REALM}, ${customer}, ${f!.id}, 'carried_over')`;
        const [s] = await pg`INSERT INTO student (name, active) VALUES (${`Elsewhere ${customer}`}, false) RETURNING id`;
        await pg`INSERT INTO accounting_link (system, realm_id, customer_id, student_id, origin) VALUES ('quickbooks', ${OTHER_REALM}, ${customer}, ${s!.id}, 'carried_over')`;
      }
      buyoutsBefore = [...await pg`SELECT * FROM buyout ORDER BY id`];
      queueBefore = [...await pg`SELECT * FROM write_queue ORDER BY id`];
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("stops, and changes nothing, on a buy-out with no record of the kind it holds, one of another company, or a per-family one whose subject isn't its family", async () => {
    // Made after 0023, so nothing made a record of them: never guessed at. Each is voided, so none trips the live index.
    const bad = await q((pg) => pg`INSERT INTO buyout (requirement_id, family_qbo_id, subject_qbo_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, realm_id, chosen_by)
      VALUES (${ids["family-paid"]!}, 'F-NOBODY', 'F-NOBODY', 'F-NOBODY', '4343', 5000, 1, 5000, 'voided', ${REALM}, ${ASH_PARENT}),
             (${ids["student-own"]!}, 'F2', 'S-NOBODY', 'S-NOBODY', '4343', 5000, 1, 5000, 'voided', ${REALM}, ${BIRCH_PARENT}),
             (${ids["family-paid"]!}, 'F2', 'F2', 'F2', '4343', 5000, 1, 5000, 'voided', ${OTHER_REALM}, ${BIRCH_PARENT}),
             (${ids["family-paid"]!}, 'F1', 'F2', 'F2', '4343', 5000, 1, 5000, 'voided', ${REALM}, ${ASH_PARENT})
      RETURNING id`);
    const message = await failureOf(migrateWith(path.resolve("drizzle")));
    expect(message).toMatch(/Migration 0030 stopped, and changed nothing: /);
    expect(message).toMatch(/1 rows in buyout of a company other than the roster's/);
    expect(message).toMatch(/1 rows in buyout with no family record/);
    expect(message).toMatch(/1 per-student rows in buyout with no student record/);
    expect(message).toMatch(/1 per-family rows in buyout whose subject is not their family/);
    expect(await columnsOf("buyout")).toContain("family_qbo_id");
    expect(await columnsOf("buyout")).not.toContain("family_id");
    // Nothing before it was kept either: the migrations run as one.
    expect(await columnsOf("signature_request")).toContain("family_qbo_id");
    await q((pg) => pg`DELETE FROM buyout WHERE id IN ${pg(bad.map((b) => b.id as string))}`);
  });

  it("stops on a buy-out while the roster names no company: no link of any company answers", async () => {
    await q((pg) => pg`UPDATE setting SET key = 'roster.source.away' WHERE key = 'roster.source'`);
    try {
      const message = await failureOf(migrateWith(path.resolve("drizzle")));
      expect(message).toMatch(/Migration 0030 stopped, and changed nothing: /);
      expect(message).toMatch(/12 rows in buyout of a company other than the roster's/);
      expect(await columnsOf("buyout")).not.toContain("family_id");
    } finally {
      await q((pg) => pg`UPDATE setting SET key = 'roster.source' WHERE key = 'roster.source.away'`);
    }
  });

  describe("once every row has its record", () => {
    beforeAll(async () => { await migrateWith(path.resolve("drizzle")); });

    it("gives each buy-out the family that chose it and, for a per-student one, its student's own record: a moved or departed student's included", async () => {
      const rows = await q((pg) => pg.unsafe(`SELECT b.id, b.state, ${customerOf("b.family_id", "family")} AS family, ${customerOf("b.student_id", "student")} AS student,
          st.active AS student_active, ${customerOf("st.family_id", "family")} AS student_now_in
        FROM buyout b LEFT JOIN student st ON st.id = b.student_id`));
      const of = (key: string) => rows.find((r) => r.id === ids[key])!;
      expect(rows).toHaveLength(STATES.length + 5);
      for (const s of STATES) expect(of(`ash-${s}`), s).toMatchObject({ state: s, family: "F1", student: null });
      expect(of("birch")).toMatchObject({ family: "F2", student: null });
      expect(of("ash-student")).toMatchObject({ family: "F1", student: "S1", student_active: true, student_now_in: "F1" });
      // Moved: the buy-out stays the Ash family's and names the student's own record, which is in the Birch family now,
      // for the daily check to follow.
      expect(of("moved")).toMatchObject({ family: "F1", student: "S3", student_active: true, student_now_in: "F2" });
      // Left the roster: an inactive record that was never under a family the cache held, as 0023 made it.
      expect(of("gone")).toMatchObject({ family: "F1", student: "S-GONE", student_active: false, student_now_in: null });
      // A roster family named as a student: its student record, never its family record.
      expect(of("both")).toMatchObject({ family: "F1", student: "F2" });
      const [both] = await q((pg) => pg`SELECT student_id FROM buyout WHERE id = ${ids.both!}`);
      expect(both!.student_id).not.toBe(await recordOf("F2", "family"));
      expect(both!.student_id).toBe(await recordOf("F2", "student"));
    });

    it("keeps what every buy-out bills, and the write queue, exactly as they were", async () => {
      const after = await q(async (pg) => [...await pg`SELECT * FROM buyout ORDER BY id`]);
      expect(kept(after)).toEqual(kept(buyoutsBefore));
      expect(kept(after).every((b) => typeof b.customer_qbo_id === "string" && b.item_qbo_id === "4343" && b.realm_id === REALM)).toBe(true);
      // The queue's own columns as they were; its family's columns are 0034's and 0035's to change (migrate-queue.test.ts).
      expect(kept(await q(async (pg) => [...await pg`SELECT * FROM write_queue ORDER BY id`]))).toEqual(kept(queueBefore));
    });

    it("drops the QuickBooks columns of the family and the subject, and keeps those of what is billed", async () => {
      const columns = await columnsOf("buyout");
      expect(columns).toEqual(expect.arrayContaining(["family_id", "student_id", "realm_id", "invoice_sync_token"]));
      expect(columns.filter((c) => c.endsWith("_qbo_id"))).toEqual(["customer_qbo_id", "invoice_qbo_id", "item_qbo_id"]);
      const indexes = await q(async (pg) => (await pg`SELECT indexname FROM pg_indexes WHERE tablename = 'buyout'`).map((i) => i.indexname as string).sort());
      expect(indexes).toEqual(["buyout_family_id_ix", "buyout_family_live_uq", "buyout_pkey", "buyout_state_ix", "buyout_student_id_ix", "buyout_student_live_uq"]);
    });

    it("refuses a buy-out that names no record, a second live one for a family's requirement or a student's whichever family chose it, and a record's removal while one names it", async () => {
      const ash = await recordOf("F1", "family"), birch = await recordOf("F2", "family"), ashKid = await recordOf("S1", "student");
      const insert = (o: { requirement: string; family: string | null; student?: string | null; state: string; by?: string }) => q((pg) => pg`INSERT INTO buyout
        (requirement_id, family_id, student_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, realm_id, chosen_by)
        VALUES (${o.requirement}, ${o.family}, ${o.student ?? null}, 'F1', '4343', 5000, 1, 5000, ${o.state}, ${REALM}, ${o.by ?? ASH_PARENT})`);
      await expect(insert({ requirement: ids["family-voided"]!, family: NOBODY, state: "invoiced" })).rejects.toThrow(/buyout_family_id_family_id_fk/);
      await expect(insert({ requirement: ids["student-gone"]!, family: birch, student: NOBODY, state: "invoiced" })).rejects.toThrow(/buyout_student_id_student_id_fk/);
      await expect(insert({ requirement: ids["family-voided"]!, family: null, state: "invoiced" })).rejects.toThrow(/family_id/);
      // One live buy-out per family's requirement: the Ash family's invoiced one stands.
      await expect(insert({ requirement: ids["family-invoiced"]!, family: ash, state: "being_invoiced" })).rejects.toThrow(/buyout_family_live_uq/);
      // One live buy-out per student's requirement, whichever family chose it: the Ash family's for its kid stands, so the
      // Birch family can't choose one for the same student.
      await expect(insert({ requirement: ids["student-own"]!, family: birch, student: ashKid, state: "being_invoiced", by: BIRCH_PARENT })).rejects.toThrow(/buyout_student_live_uq/);
      // An ended one beside a live one is history, and taken; and the Birch family's own live one beside the Ash family's.
      await insert({ requirement: ids["family-invoiced"]!, family: ash, state: "voided" });
      await insert({ requirement: ids["student-own"]!, family: birch, student: ashKid, state: "refused", by: BIRCH_PARENT });
      await insert({ requirement: ids["family-being_invoiced"]!, family: birch, state: "being_invoiced", by: BIRCH_PARENT });
      // A record a buy-out names can't be deleted from under it: the departed student's, named by nothing but its
      // buy-out; nor the family that chose one.
      const gone = await recordOf("S-GONE", "student");
      await expect(q((pg) => pg`DELETE FROM student WHERE id = ${gone}`)).rejects.toThrow(/buyout_student_id_student_id_fk/);
      await expect(q((pg) => pg`DELETE FROM family WHERE id = ${ash}`)).rejects.toThrow(/foreign key/);
    });
  });
});
