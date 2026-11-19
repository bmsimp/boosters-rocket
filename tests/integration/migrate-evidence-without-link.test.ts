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
 * Migration 0036 (a part of stage 3's source move, brought forward): signed-form evidence is kept for a family with no
 * QuickBooks link, so the evidence's own copies of the customers (`family_qbo_id`, `subject_qbo_id`) take null. It only
 * drops the two NOT NULLs: every row is as it was, and the check that an earlier company's evidence names no app record
 * still holds.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_kept");
const folders: string[] = [];
const REALM = "4650000000000001";
const OTHER_REALM = "4650000000000999";

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-kept-"));
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
const failureOf = async (run: Promise<unknown>) => {
  const failure = await run.then(() => null, (e: unknown) => e as Error);
  expect(failure).not.toBeNull();
  return failure!.message;
};

let familyId = "";
let studentId = "";
/** One evidence row's insert, with the copies and company given: as the job keeps it, or as it now may. */
const insertEvidence = (pg: postgres.Sql, o: { envelope: string; realm: string | null; familyQboId: string | null; subjectQboId: string | null; kind: "family" | "student"; earlier?: boolean }) =>
  pg`INSERT INTO signed_form_evidence (request_id, realm_id, earlier_company_at, requirement_id, family_qbo_id, subject_qbo_id, subject_kind, family_id, student_id,
      form_title, family_name, subject_name, season_name, envelope_id, template_id, signers, consents, originals, completed_at)
    VALUES (gen_random_uuid(), ${o.realm}, ${o.earlier ? new Date("2026-10-01T00:00:00Z") : null}, null, ${o.familyQboId}, ${o.subjectQboId}, ${o.kind},
      ${o.earlier ? null : familyId}, ${o.earlier || o.kind === "family" ? null : studentId},
      'Code of conduct', 'Ash Family', ${o.kind === "family" ? "Ash Family" : "Ash Kid"}, 'Fall', ${o.envelope}, 'envelope_template',
      ${pg.json([{ parentId: null, name: "Ash Parent", email: "ash@kept.example", signedAt: "2026-11-10T15:00:00.000Z" }])}, ${pg.json([])},
      ${pg.json([{ itemId: `envelope_item_${o.envelope}`, sha256: "ab".repeat(32), size: 64 }])}, '2026-11-10T15:00:00Z')
    RETURNING id`;

let before: Record<string, unknown>[] = [];

describe("migration 0036: signed-form evidence keeps no QuickBooks copy for a record with no link, and changes no row it holds", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_kept"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(35));
    await q(async (pg) => {
      const [f] = await pg`INSERT INTO family (name, active) VALUES ('Ash Family', true) RETURNING id`;
      familyId = f!.id as string;
      const [s] = await pg`INSERT INTO student (family_id, name, active) VALUES (${familyId}, 'Ash Kid', true) RETURNING id`;
      studentId = s!.id as string;
      // The evidence as 0035 holds it: the current company's, a family's and a student's, and an earlier company's.
      await insertEvidence(pg, { envelope: "envelope_family", realm: REALM, familyQboId: "F1", subjectQboId: "F1", kind: "family" });
      await insertEvidence(pg, { envelope: "envelope_student", realm: REALM, familyQboId: "F1", subjectQboId: "S1", kind: "student" });
      await insertEvidence(pg, { envelope: "envelope_earlier", realm: OTHER_REALM, familyQboId: "F1", subjectQboId: "F1", kind: "family", earlier: true });
      before = [...await pg`SELECT * FROM signed_form_evidence ORDER BY envelope_id COLLATE "C"`];
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("before it, evidence must keep both copies", async () => {
    const message = await failureOf(q((pg) => insertEvidence(pg, { envelope: "envelope_refused", realm: null, familyQboId: null, subjectQboId: null, kind: "family" })));
    expect(message).toMatch(/null value in column "family_qbo_id"/);
  });

  it("changes no row, and then both copies take null, with or without a company; the app-records check still holds", async () => {
    await migrateWith(path.resolve("drizzle"));
    const after = await q((pg) => pg`SELECT * FROM signed_form_evidence ORDER BY envelope_id COLLATE "C"`);
    expect([...after]).toEqual(before);

    const columns = await q((pg) => pg`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'signed_form_evidence' AND column_name IN ('family_qbo_id', 'subject_qbo_id', 'subject_kind', 'realm_id') ORDER BY column_name COLLATE "C"`);
    expect(columns.map((c) => [c.column_name, c.is_nullable])).toEqual([["family_qbo_id", "YES"], ["realm_id", "YES"], ["subject_kind", "NO"], ["subject_qbo_id", "YES"]]);

    // A family with no link: no copy and no company. A student with no link in a linked family: the family's copy and
    // the company, and no subject copy.
    await q((pg) => insertEvidence(pg, { envelope: "envelope_unlinked", realm: null, familyQboId: null, subjectQboId: null, kind: "family" }));
    await q((pg) => insertEvidence(pg, { envelope: "envelope_unlinked_student", realm: REALM, familyQboId: "F1", subjectQboId: null, kind: "student" }));
    const kept = await q((pg) => pg`SELECT envelope_id, realm_id, family_qbo_id, subject_qbo_id FROM signed_form_evidence WHERE envelope_id LIKE 'envelope_unlinked%' ORDER BY envelope_id COLLATE "C"`);
    expect(kept.map((r) => ({ ...r }))).toEqual([
      { envelope_id: "envelope_unlinked", realm_id: null, family_qbo_id: null, subject_qbo_id: null },
      { envelope_id: "envelope_unlinked_student", realm_id: REALM, family_qbo_id: "F1", subject_qbo_id: null },
    ]);
    // The current company's evidence still names its family: a row with no copies is no exception.
    const message = await failureOf(q((pg) => pg`INSERT INTO signed_form_evidence (request_id, realm_id, family_qbo_id, subject_qbo_id, subject_kind, family_id,
        form_title, envelope_id, signers, consents, originals)
      VALUES (gen_random_uuid(), null, null, null, 'family', null, 'Code of conduct', 'envelope_nobody', ${pg.json([])}, ${pg.json([])}, ${pg.json([])})`));
    expect(message).toMatch(/signed_form_evidence_app_records/);
  });
});
