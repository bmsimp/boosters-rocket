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
 * Migrations 0024 and 0025 (stage 2 of the app-owned families spec): the season's chosen lists, ticks, waivers and
 * due-date reminder claims move from QuickBooks ids to the app's own families and students. Run on data shaped like a
 * real installation, upgraded from before 0023: a family and a per-student requirement, a tick, a waiver, a chosen
 * list, a reminder claim, a subject the roster no longer holds, and a customer named as the other kind. Each row is
 * found through the link of the kind its requirement says; the claims are carried over; a row that names a customer
 * with no record of that kind stops the migration, changing nothing; and the database then refuses a season record
 * that names no record, or both kinds, or neither.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_seasons");
const folders: string[] = [];
const REALM = "4620000000000001";
const PARENT = "7c0a9a1e-0000-4000-8000-000000000001";

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-seasons-"));
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

/** Every season row as the customer and kind of the record it names, through that record's link, by code unit ("F-GONE" before "F1"). */
const asCustomers = (table: "requirement_cover" | "requirement_progress") => q((pg) => pg.unsafe(`
  SELECT r.title, l.customer_id AS customer, CASE WHEN t.family_id IS NOT NULL THEN 'family' ELSE 'student' END AS kind
    ${table === "requirement_progress" ? ", t.id, t.met_at IS NOT NULL AS ticked, t.waived_reason" : ""}
  FROM ${table} t JOIN requirement r ON r.id = t.requirement_id
    JOIN accounting_link l ON (l.family_id = t.family_id OR l.student_id = t.student_id) AND l.realm_id = '${REALM}'
  ORDER BY r.title, l.customer_id COLLATE "C"`));

let progressIds: Record<string, string> = {};
let claimIds: string[] = [];
let requirementIds: Record<string, string> = {};

describe("migrations 0024 and 0025: the season's records name the app's own families and students", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_seasons"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before stage 1: migrations up to 0022.
    await migrateWith(migrationsUpTo(22));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
        ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
      await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
        ('F1', 'Ash Family', true, null, 'F', '0'), ('S1', 'Ash Kid', true, 'F1', 'S', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
        ('F2', 'Birch Family', true, null, 'F', '0'), ('S2', 'Birch Kid', true, 'F2', 'S', '0')`;
      const [season] = await pg`INSERT INTO season (name, is_current) VALUES ('Fall', true) RETURNING id`;
      const [step] = await pg`INSERT INTO season_step (season_id, name, position) VALUES (${season!.id}, 'Join', 0) RETURNING id`;
      const add = async (title: string, appliesTo: "family" | "student", covers: "everyone" | "chosen", position: number) =>
        (await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position) VALUES (${step!.id}, 'checklist', ${title}, ${appliesTo}, ${covers}, ${position}) RETURNING id`)[0]!.id as string;
      requirementIds = { locker: await add("Locker key", "family", "chosen", 0), uniform: await add("Uniform", "student", "everyone", 1), gloves: await add("Gloves", "student", "chosen", 2) };
      // A per-family chosen list with a family the roster no longer holds; a per-student one.
      await pg`INSERT INTO requirement_cover (requirement_id, subject_qbo_id) VALUES (${requirementIds.locker!}, 'F1'), (${requirementIds.locker!}, 'F-GONE'), (${requirementIds.gloves!}, 'S1')`;
      const tick = async (requirementId: string, subject: string, o: { waived?: string } = {}) =>
        (await pg`INSERT INTO requirement_progress (requirement_id, subject_qbo_id, met_at, waived_at, waived_reason)
          VALUES (${requirementId}, ${subject}, ${o.waived ? null : new Date()}, ${o.waived ? new Date() : null}, ${o.waived ?? null}) RETURNING id`)[0]!.id as string;
      progressIds = {
        "Locker key|F1": await tick(requirementIds.locker!, "F1"),
        "Locker key|F-GONE": await tick(requirementIds.locker!, "F-GONE"),
        "Locker key|F2": await tick(requirementIds.locker!, "F2", { waived: "Out of town" }),
        "Uniform|S1": await tick(requirementIds.uniform!, "S1"),
        "Uniform|S2": await tick(requirementIds.uniform!, "S2", { waived: "Borrowed one" }),
        // A student the roster no longer holds, and a family's customer named as a student by a per-student tick.
        "Uniform|S-GONE": await tick(requirementIds.uniform!, "S-GONE"),
        "Uniform|F2": await tick(requirementIds.uniform!, "F2"),
      };
      // Reminder claims already sent: one for a family on the roster, one for a family it no longer holds.
      claimIds = (await pg`INSERT INTO requirement_reminder (kind, family_qbo_id, parent_id, due_on, tried_at, outcome) VALUES
        ('due_14', 'F1', ${PARENT}, '2026-12-01', now(), 'sent'), ('due_3', 'F-GONE', ${PARENT}, '2026-12-01', now(), 'failed') RETURNING id`).map((r) => r.id as string);
    });
    // Migration 0023 makes the app's records and links from that, as on the proof-of-concept host.
    await migrateWith(migrationsUpTo(23));
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("stops, and changes nothing, when a row names a customer with no record of the kind its requirement asks for", async () => {
    // Made after 0023, so nothing made a record of it: never guessed at.
    await q((pg) => pg`INSERT INTO requirement_cover (requirement_id, subject_qbo_id) VALUES (${requirementIds.locker!}, 'F-NOBODY')`);
    // Drizzle wraps the database's error in its own, with the database's as the cause.
    const failure = await migrateWith(path.resolve("drizzle")).then(() => null, (e: unknown) => e as Error & { cause?: unknown });
    expect(failure).not.toBeNull();
    expect(`${failure!.message} ${failure!.cause instanceof Error ? failure!.cause.message : ""}`).toMatch(/Migration 0024 stopped, and changed nothing: 1 rows in requirement_cover/);
    expect(await columnsOf("requirement_cover")).toEqual(["created_at", "requirement_id", "subject_qbo_id"]);
    expect(await columnsOf("requirement_reminder")).toContain("family_qbo_id");
    await q((pg) => pg`DELETE FROM requirement_cover WHERE subject_qbo_id = 'F-NOBODY'`);
  });

  describe("once every row has its record", () => {
    beforeAll(async () => { await migrateWith(path.resolve("drizzle")); });

    it("gives each chosen list's entry the record of its requirement's kind, a family the roster no longer holds included", async () => {
      expect(await asCustomers("requirement_cover")).toEqual([
        { title: "Gloves", customer: "S1", kind: "student" },
        { title: "Locker key", customer: "F-GONE", kind: "family" },
        { title: "Locker key", customer: "F1", kind: "family" },
      ]);
    });

    it("keeps every tick and waiver, its row and its reason, on the record of its requirement's kind: never by customer id alone", async () => {
      const rows = await asCustomers("requirement_progress");
      expect(rows.map((r) => [r.title, r.customer, r.kind, r.ticked, r.waived_reason])).toEqual([
        ["Locker key", "F-GONE", "family", true, null],
        ["Locker key", "F1", "family", true, null],
        ["Locker key", "F2", "family", false, "Out of town"],
        ["Uniform", "F2", "student", true, null],      // F2 is a family on the roster: this per-student tick names its student record
        ["Uniform", "S-GONE", "student", true, null],
        ["Uniform", "S1", "student", true, null],
        ["Uniform", "S2", "student", false, "Borrowed one"],
      ]);
      for (const r of rows) expect(r.id).toBe(progressIds[`${r.title}|${r.customer}`]);
      // The records of customers the roster no longer holds are inactive, as 0023 made them.
      const gone = await q((pg) => pg`SELECT l.customer_id, coalesce(f.active, s.active) AS active FROM accounting_link l
        LEFT JOIN family f ON f.id = l.family_id LEFT JOIN student s ON s.id = l.student_id WHERE l.customer_id IN ('F-GONE', 'S-GONE') ORDER BY l.customer_id`);
      expect(gone.map((g) => [g.customer_id, g.active])).toEqual([["F-GONE", false], ["S-GONE", false]]);
    });

    it("carries every reminder claim over to the family's record, so no reminder goes twice", async () => {
      const claims = await q((pg) => pg`SELECT m.id, m.kind, m.outcome, l.customer_id FROM requirement_reminder m JOIN accounting_link l ON l.family_id = m.family_id ORDER BY m.kind`);
      expect(claims.map((c) => [c.id, c.kind, c.outcome, c.customer_id])).toEqual([[claimIds[0], "due_14", "sent", "F1"], [claimIds[1], "due_3", "failed", "F-GONE"]]);
    });

    it("drops the QuickBooks columns once nothing reads them", async () => {
      expect(await columnsOf("requirement_cover")).toEqual(["created_at", "family_id", "requirement_id", "student_id"]);
      expect(await columnsOf("requirement_progress")).not.toContain("subject_qbo_id");
      expect(await columnsOf("requirement_reminder")).not.toContain("family_qbo_id");
    });

    it("refuses a season record that names no record, both kinds, or neither, and a family's removal while one names it", async () => {
      const [ash] = await q((pg) => pg`SELECT family_id FROM accounting_link WHERE customer_id = 'F1' AND family_id IS NOT NULL`);
      const [kid] = await q((pg) => pg`SELECT student_id FROM accounting_link WHERE customer_id = 'S1' AND student_id IS NOT NULL`);
      const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
      const uniform = requirementIds.uniform!, locker = requirementIds.locker!;
      await expect(q((pg) => pg`INSERT INTO requirement_progress (requirement_id, student_id, met_at) VALUES (${uniform}, ${NOBODY}, now())`)).rejects.toThrow(/requirement_progress_student_id_student_id_fk/);
      await expect(q((pg) => pg`INSERT INTO requirement_cover (requirement_id, family_id) VALUES (${locker}, ${NOBODY})`)).rejects.toThrow(/requirement_cover_family_id_family_id_fk/);
      await expect(q((pg) => pg`INSERT INTO requirement_progress (requirement_id, met_at) VALUES (${uniform}, now())`)).rejects.toThrow(/requirement_progress_one_subject/);
      await expect(q((pg) => pg`INSERT INTO requirement_progress (requirement_id, family_id, student_id, met_at) VALUES (${locker}, ${ash!.family_id}, ${kid!.student_id}, now())`))
        .rejects.toThrow(/requirement_progress_one_subject/);
      await expect(q((pg) => pg`INSERT INTO requirement_cover (requirement_id) VALUES (${locker})`)).rejects.toThrow(/requirement_cover_one_subject/);
      await expect(q((pg) => pg`INSERT INTO requirement_reminder (kind, parent_id, due_on, tried_at) VALUES ('due_3', ${PARENT}, '2026-12-02', now())`)).rejects.toThrow(/family_id/);
      // The same family twice on one list, or ticked twice: one row each.
      await expect(q((pg) => pg`INSERT INTO requirement_cover (requirement_id, family_id) VALUES (${locker}, ${ash!.family_id})`)).rejects.toThrow(/requirement_cover_family_uq/);
      await expect(q((pg) => pg`INSERT INTO requirement_progress (requirement_id, family_id, met_at) VALUES (${locker}, ${ash!.family_id}, now())`)).rejects.toThrow(/requirement_progress_family_uq/);
      // A record a season row names can't be deleted from under it.
      await expect(q((pg) => pg`DELETE FROM family WHERE id = ${ash!.family_id}`)).rejects.toThrow(/foreign key/);

    });
  });
});
