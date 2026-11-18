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
 * Migrations 0026 and 0027 (stage 2 of the app-owned families spec): volunteering's sign-ups, credit and reminder
 * claims move from QuickBooks ids to the app's own families and students. Run on data shaped like a real
 * installation, upgraded from before 0023: a guardian's own place and a student's, a place whose student has since
 * moved to another family and one whose student has left the roster, a check-in, a check-in staff added, credit
 * earned outside the portal and a removed credit with its staff-only reason, and reminder claims of each kind. Each
 * column is filled through the link of the kind it holds, in the roster's company; a sign-up keeps the family it was
 * made from; every row keeps its id; the due-date claims' keys are rewritten so no reminder goes twice; a row that
 * names a customer with no record of that kind, or a claim whose key doesn't start with its family, stops the
 * migration and changes nothing; and the database then refuses a row that names no record.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_shifts");
const folders: string[] = [];
const REALM = "4620000000000001";
const OTHER_REALM = "4620000000000999";
/** Customers that also have a family and a student record linked in OTHER_REALM. */
const CUSTOMERS_ELSEWHERE = ["F1", "F2", "S1", "S2", "S3", "S-GONE"];
const ASH_PARENT = "7c0a9a1e-0000-4000-8000-000000000001", BIRCH_PARENT = "7c0a9a1e-0000-4000-8000-000000000002", STAFF = "7c0a9a1e-0000-4000-8000-0000000000aa";
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
/** A guardian with no place on the set-up's shift, so a row a test adds meets the constraint it is about, not the one-place-each index. */
const NEW_GUARDIAN = "7c0a9a1e-0000-4000-8000-0000000000ee";

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-volunteer-"));
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

const ids: Record<string, string> = {};

describe("migrations 0026 and 0027: volunteering names the app's own families and students", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_shifts"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before stage 1: migrations up to 0022.
    await migrateWith(migrationsUpTo(22));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
        ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
      await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
      // S3 was in the Ash family when its place was taken, and is in the Birch family now; S-GONE has left the roster.
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
        ('F1', 'Ash Family', true, null, 'F', '0'), ('S1', 'Ash Kid', true, 'F1', 'S', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
        ('F2', 'Birch Family', true, null, 'F', '0'), ('S2', 'Birch Kid', true, 'F2', 'S', '0'), ('S3', 'Moved Kid', true, 'F2', 'S', '0')`;
      const [season] = await pg`INSERT INTO season (name, is_current) VALUES ('Fall', true) RETURNING id`;
      const [step] = await pg`INSERT INTO season_step (season_id, name, position) VALUES (${season!.id}, 'Help', 0) RETURNING id`;
      const [hours] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position, amount, amount_unit)
        VALUES (${step!.id}, 'volunteer', 'Student hours', 'student', 'everyone', 0, 6, 'hours') RETURNING id`;
      ids.requirement = hours!.id as string;
      const [event] = await pg`INSERT INTO volunteer_event (name, on_date, location, contact_name) VALUES ('Fall fair', '2026-12-02', 'Gym', 'Pat') RETURNING id`;
      const [shift] = await pg`INSERT INTO volunteer_shift (event_id, starts_at, ends_at, places) VALUES (${event!.id}, '09:00', '12:00', 9) RETURNING id`;
      ids.shift = shift!.id as string;
      const signup = async (key: string, family: string, o: { student?: string; name: string; by?: string }) => {
        const [row] = o.student
          ? await pg`INSERT INTO volunteer_signup (shift_id, family_qbo_id, signed_up_by, filler_kind, student_qbo_id, filler_name)
              VALUES (${shift!.id}, ${family}, ${o.by ?? ASH_PARENT}, 'student', ${o.student}, ${o.name}) RETURNING id`
          : await pg`INSERT INTO volunteer_signup (shift_id, family_qbo_id, signed_up_by, filler_kind, filler_parent_id, filler_name)
              VALUES (${shift!.id}, ${family}, ${o.by ?? ASH_PARENT}, 'guardian', ${o.by ?? ASH_PARENT}, ${o.name}) RETURNING id`;
        ids[key] = row!.id as string;
      };
      await signup("guardian", "F1", { name: "Ash Parent" });
      await signup("student", "F1", { student: "S1", name: "Ash Kid" });
      await signup("moved", "F1", { student: "S3", name: "Moved Kid" });
      await signup("gone", "F1", { student: "S-GONE", name: "Gone Kid" });
      await signup("birch", "F2", { name: "Birch Parent", by: BIRCH_PARENT });
      const credit = async (key: string, values: Record<string, unknown>) => {
        const [row] = await pg`INSERT INTO volunteer_credit ${pg({ minutes: 180, shifts: 1, created_by_door: "staff", created_by: STAFF, ...values })} RETURNING id`;
        ids[key] = row!.id as string;
      };
      await credit("checkin", { kind: "checkin", signup_id: ids.student, family_qbo_id: "F1", created_by_door: "parent", created_by: ASH_PARENT });
      await credit("staffCheckin", { kind: "staff_checkin", signup_id: ids.guardian, family_qbo_id: "F1" });
      await credit("outside", { kind: "outside", family_qbo_id: "F2", student_qbo_id: "S2", requirement_id: hours!.id, minutes: 90, shifts: 0, note: "Painted the set QV01" });
      await credit("removed", { kind: "outside", family_qbo_id: "F1", requirement_id: hours!.id, minutes: 60, shifts: 0, note: "Raked leaves",
        removed_at: new Date(), removed_by: STAFF, removed_reason: "Wrong family QV02; staff only" });
      const claim = async (key: string, kind: string, family: string, claimKey: string, outcome: string) => {
        const [row] = await pg`INSERT INTO volunteer_reminder (kind, key, family_qbo_id, tried_at, outcome) VALUES (${kind}, ${claimKey}, ${family}, now(), ${outcome}) RETURNING id`;
        ids[key] = row!.id as string;
      };
      await claim("dayBefore", "day_before", "F1", `${ids.guardian}|2026-12-02`, "sent");
      await claim("due14", "due_14", "F1", `F1|2026-12-01|${ASH_PARENT}`, "sent");
      await claim("due3", "due_3", "F2", `F2|2026-12-04|${BIRCH_PARENT}`, "failed");
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
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("stops, and changes nothing, when a row names a customer with no record of the kind its column holds, or a claim's key doesn't start with its family", async () => {
    // Made after 0023, so nothing made a record of them: never guessed at.
    const [bad] = await q((pg) => pg`INSERT INTO volunteer_signup (shift_id, family_qbo_id, signed_up_by, filler_kind, filler_parent_id, filler_name)
      VALUES (${ids.shift!}, 'F-NOBODY', ${NEW_GUARDIAN}, 'guardian', ${NEW_GUARDIAN}, 'Nobody') RETURNING id`);
    const [badCredit] = await q((pg) => pg`INSERT INTO volunteer_credit (kind, family_qbo_id, student_qbo_id, requirement_id, minutes, shifts, created_by_door, created_by)
      VALUES ('outside', 'F1', 'S-NOBODY', ${ids.requirement!}, 30, 0, 'staff', ${STAFF}) RETURNING id`);
    const message = await failureOf(migrateWith(path.resolve("drizzle")));
    expect(message).toMatch(/Migration 0026 stopped, and changed nothing: /);
    expect(message).toMatch(/1 rows in volunteer_signup/);
    expect(message).toMatch(/1 rows in volunteer_credit/);
    for (const table of ["volunteer_signup", "volunteer_credit", "volunteer_reminder"]) {
      expect(await columnsOf(table)).toContain("family_qbo_id");
      expect(await columnsOf(table)).not.toContain("family_id");
    }
    await q((pg) => pg`DELETE FROM volunteer_signup WHERE id = ${bad!.id}`);
    await q((pg) => pg`DELETE FROM volunteer_credit WHERE id = ${badCredit!.id}`);

    // A due-date claim whose key doesn't start with its family (none the portal writes): 0027 stops rather than guess.
    const [badClaim] = await q((pg) => pg`INSERT INTO volunteer_reminder (kind, key, family_qbo_id, tried_at, outcome) VALUES ('due_3', ${`ELSEWHERE|2026-12-09|${ASH_PARENT}`}, 'F1', now(), 'sent') RETURNING id`);
    expect(await failureOf(migrateWith(path.resolve("drizzle")))).toMatch(/Migration 0027 stopped, and changed nothing: 1 due-date reminder claims/);
    expect(await columnsOf("volunteer_reminder")).toContain("family_qbo_id");
    expect((await q((pg) => pg`SELECT key FROM volunteer_reminder WHERE id = ${badClaim!.id}`))[0]!.key).toBe(`ELSEWHERE|2026-12-09|${ASH_PARENT}`);
    await q((pg) => pg`DELETE FROM volunteer_reminder WHERE id = ${badClaim!.id}`);
  });

  describe("once every row has its record", () => {
    beforeAll(async () => { await migrateWith(path.resolve("drizzle")); });

    it("gives each sign-up the family it was made from and its student's own record, by the link of each kind: a moved or departed student's included", async () => {
      const rows = await q((pg) => pg.unsafe(`SELECT s.id, s.filler_name, ${customerOf("s.family_id", "family")} AS family, ${customerOf("s.student_id", "student")} AS student,
          st.active AS student_active, ${customerOf("st.family_id", "family")} AS student_now_in
        FROM volunteer_signup s LEFT JOIN student st ON st.id = s.student_id ORDER BY s.filler_name COLLATE "C"`));
      expect(rows.map((r) => [r.filler_name, r.family, r.student, r.student_active, r.student_now_in])).toEqual([
        ["Ash Kid", "F1", "S1", true, "F1"],
        ["Ash Parent", "F1", null, null, null],
        ["Birch Parent", "F2", null, null, null],
        // Left the roster: an inactive record that was never under a family the cache held, as 0023 made it.
        ["Gone Kid", "F1", "S-GONE", false, null],
        // Moved: the place stays the Ash family's and names the student's own record, which is in the Birch family now,
        // so neither family counts it (AGENTS.md, Volunteering).
        ["Moved Kid", "F1", "S3", true, "F2"],
      ]);
      const byName = new Map(rows.map((r) => [r.filler_name as string, r.id as string]));
      for (const [key, name] of [["guardian", "Ash Parent"], ["student", "Ash Kid"], ["moved", "Moved Kid"], ["gone", "Gone Kid"], ["birch", "Birch Parent"]]) expect(byName.get(name!)).toBe(ids[key!]);
    });

    it("keeps every credit, its row, note and staff-only reason, with the family it was earned for", async () => {
      const rows = await q((pg) => pg.unsafe(`SELECT c.id, c.kind, c.signup_id, c.note, c.removed_reason, ${customerOf("c.family_id", "family")} AS family,
          ${customerOf("c.student_id", "student")} AS student FROM volunteer_credit c`));
      const of = (key: string) => rows.find((r) => r.id === ids[key])!;
      expect(rows).toHaveLength(4);
      expect(of("checkin")).toMatchObject({ kind: "checkin", signup_id: ids.student, family: "F1", student: null });
      expect(of("staffCheckin")).toMatchObject({ kind: "staff_checkin", signup_id: ids.guardian, family: "F1", student: null });
      expect(of("outside")).toMatchObject({ kind: "outside", family: "F2", student: "S2", note: "Painted the set QV01" });
      expect(of("removed")).toMatchObject({ kind: "outside", family: "F1", student: null, removed_reason: "Wrong family QV02; staff only" });
    });

    it("carries every reminder claim over to the family's record, the family in each due-date key rewritten, so no reminder goes twice", async () => {
      const rows = await q((pg) => pg.unsafe(`SELECT m.id, m.kind, m.key, m.outcome, m.family_id::text AS family_id, ${customerOf("m.family_id", "family")} AS family
        FROM volunteer_reminder m ORDER BY m.kind COLLATE "C"`));
      const familyOf = (customer: string) => rows.find((r) => r.family === customer)!.family_id as string;
      expect(rows.map((r) => [r.id, r.kind, r.key, r.outcome, r.family])).toEqual([
        [ids.dayBefore, "day_before", `${ids.guardian}|2026-12-02`, "sent", "F1"],
        [ids.due14, "due_14", `${familyOf("F1")}|2026-12-01|${ASH_PARENT}`, "sent", "F1"],
        [ids.due3, "due_3", `${familyOf("F2")}|2026-12-04|${BIRCH_PARENT}`, "failed", "F2"],
      ]);
    });

    it("drops the QuickBooks columns once nothing reads them", async () => {
      for (const table of ["volunteer_signup", "volunteer_credit", "volunteer_reminder"]) {
        const columns = await columnsOf(table);
        expect(columns, table).toContain("family_id");
        expect(columns.filter((c) => c.endsWith("_qbo_id")), table).toEqual([]);
      }
      expect(await columnsOf("volunteer_signup")).toContain("student_id");
      expect(await columnsOf("volunteer_credit")).toContain("student_id");
    });

    it("refuses a row that names no record, or a student filler without a student, and a family's removal while one names it", async () => {
      const [ash] = await q((pg) => pg`SELECT family_id FROM accounting_link WHERE customer_id = 'F1' AND family_id IS NOT NULL AND realm_id = ${REALM}`);
      const [kid] = await q((pg) => pg`SELECT student_id FROM accounting_link WHERE customer_id = 'S1' AND student_id IS NOT NULL AND realm_id = ${REALM}`);
      const shift = ids.shift!;
      await expect(q((pg) => pg`INSERT INTO volunteer_signup (shift_id, family_id, signed_up_by, filler_kind, filler_parent_id, filler_name)
        VALUES (${shift}, ${NOBODY}, ${NEW_GUARDIAN}, 'guardian', ${NEW_GUARDIAN}, 'x')`)).rejects.toThrow(/volunteer_signup_family_id_family_id_fk/);
      await expect(q((pg) => pg`INSERT INTO volunteer_signup (shift_id, family_id, signed_up_by, filler_kind, student_id, filler_name)
        VALUES (${shift}, ${ash!.family_id}, ${ASH_PARENT}, 'student', ${NOBODY}, 'x')`)).rejects.toThrow(/volunteer_signup_student_id_student_id_fk/);
      await expect(q((pg) => pg`INSERT INTO volunteer_signup (shift_id, signed_up_by, filler_kind, filler_parent_id, filler_name)
        VALUES (${shift}, ${NEW_GUARDIAN}, 'guardian', ${NEW_GUARDIAN}, 'x')`)).rejects.toThrow(/family_id/);
      await expect(q((pg) => pg`INSERT INTO volunteer_signup (shift_id, family_id, signed_up_by, filler_kind, filler_name)
        VALUES (${shift}, ${ash!.family_id}, ${ASH_PARENT}, 'student', 'x')`)).rejects.toThrow(/volunteer_signup_filler_record/);
      await expect(q((pg) => pg`INSERT INTO volunteer_credit (kind, signup_id, family_id, student_id, minutes, shifts, created_by_door, created_by)
        VALUES ('checkin', ${ids.birch!}, ${ash!.family_id}, ${kid!.student_id}, 60, 1, 'parent', ${ASH_PARENT})`)).rejects.toThrow(/volunteer_credit_source_record/);
      await expect(q((pg) => pg`INSERT INTO volunteer_credit (kind, family_id, requirement_id, minutes, shifts, created_by_door, created_by)
        VALUES ('outside', ${NOBODY}, ${ids.requirement!}, 60, 0, 'staff', ${STAFF})`)).rejects.toThrow(/volunteer_credit_family_id_family_id_fk/);
      await expect(q((pg) => pg`INSERT INTO volunteer_reminder (kind, key, tried_at) VALUES ('due_3', 'k', now())`)).rejects.toThrow(/family_id/);
      // The same student twice on one shift: one live place.
      await expect(q((pg) => pg`INSERT INTO volunteer_signup (shift_id, family_id, signed_up_by, filler_kind, student_id, filler_name)
        VALUES (${shift}, ${ash!.family_id}, ${ASH_PARENT}, 'student', ${kid!.student_id}, 'x')`)).rejects.toThrow(/volunteer_signup_student_id_uq/);
      // A record a sign-up names can't be deleted from under it: the departed student's, named by nothing else.
      const [gone] = await q((pg) => pg`SELECT student_id FROM accounting_link WHERE customer_id = 'S-GONE' AND student_id IS NOT NULL AND realm_id = ${REALM}`);
      await expect(q((pg) => pg`DELETE FROM student WHERE id = ${gone!.student_id}`)).rejects.toThrow(/volunteer_signup_student_id_student_id_fk/);
      await expect(q((pg) => pg`DELETE FROM family WHERE id = ${ash!.family_id}`)).rejects.toThrow(/foreign key/);
    });
  });
});
