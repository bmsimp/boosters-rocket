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
 * Migrations 0028 and 0029 (stage 2 of the app-owned families spec): form requests move from QuickBooks ids to the app's
 * own families and students, and the current company's signed-form evidence gains them beside its own copies. Run on
 * data shaped like a real installation, upgraded from before 0023: a per-family and a per-student request in each
 * state, a request whose student has since moved to another family and one whose student has left the roster, a
 * consent, reminder claims and rounds, a withdrawal waiting, the current company's evidence of a per-family and a
 * per-student form with their files, an earlier company's evidence under the number of a current family, and links of
 * the same customer ids in another company. Each request is filled through the link of the kind its requirement asks
 * for, in the roster's company, and keeps its id and the family that holds it; the evidence keeps every column it had,
 * exactly; an earlier company's gains no app record; a row with no record, or evidence of another company not marked
 * as an earlier company's, stops the migration and changes nothing; and the database then refuses a request or
 * current evidence that names no record, and an earlier company's evidence that names one.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_forms");
const folders: string[] = [];
const REALM = "4620000000000001";
const OTHER_REALM = "4620000000000999";
/** Customers that also have a family and a student record linked in OTHER_REALM. */
const CUSTOMERS_ELSEWHERE = ["F1", "F2", "S1", "S2", "S3", "S-GONE"];
const ASH_PARENT = "7c0a9a1e-0000-4000-8000-000000000001", BIRCH_PARENT = "7c0a9a1e-0000-4000-8000-000000000002";
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
const STATES = ["not_opened", "waiting", "signed", "complete", "declined"] as const;

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-forms-"));
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

const ids: Record<string, string> = {};
/** Every kept evidence row and file as 0023 left them, to compare with what the migrations leave. */
let evidenceBefore: Record<string, unknown>[] = [];
let filesBefore: Record<string, unknown>[] = [];
let keptBefore: Record<string, unknown>[] = [];

describe("migrations 0028 and 0029: forms name the app's own families and students, and the current company's evidence gains them", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_forms"); // marked as this run's: a database of that name the run didn't make is refused
    // The database as it was before stage 1: migrations up to 0022.
    await migrateWith(migrationsUpTo(22));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
        ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
      await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
      // S3 was in the Ash family when its form was opened, and is in the Birch family now; S-GONE has left the roster.
      await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
        ('F1', 'Ash Family', true, null, 'F', '0'), ('S1', 'Ash Kid', true, 'F1', 'S', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
        ('F2', 'Birch Family', true, null, 'F', '0'), ('S2', 'Birch Kid', true, 'F2', 'S', '0'), ('S3', 'Moved Kid', true, 'F2', 'S', '0')`;
      const [season] = await pg`INSERT INTO season (name, is_current) VALUES ('Fall', true) RETURNING id`;
      const [step] = await pg`INSERT INTO season_step (season_id, name, position) VALUES (${season!.id}, 'Forms', 0) RETURNING id`;
      const requirement = async (key: string, appliesTo: "family" | "student", position: number) => {
        const [row] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position) VALUES (${step!.id}, 'form', ${key}, ${appliesTo}, 'everyone', ${position}) RETURNING id`;
        ids[key] = row!.id as string;
      };
      // One requirement per state and kind: a request is one per requirement and subject.
      for (const [i, s] of STATES.entries()) { await requirement(`family-${s}`, "family", i); await requirement(`student-${s}`, "student", 10 + i); }
      const request = async (key: string, o: { requirement: string; family: string; subject: string; state: string }) => {
        const has = o.state !== "not_opened";
        const [row] = await pg`INSERT INTO signature_request (requirement_id, family_qbo_id, subject_qbo_id, state, envelope_id, subject_name, signers, evidence_owed)
          VALUES (${ids[o.requirement]!}, ${o.family}, ${o.subject}, ${o.state}, ${has ? `envelope_${key}` : null}, ${has ? key : null},
            ${pg.json(has ? [{ parentId: ASH_PARENT, recipientId: 1, name: "Ash Parent", email: "ash@forms.example", signedAt: o.state === "waiting" ? null : "2026-11-10T15:00:00.000Z" }] : [])}, false)
          RETURNING id`;
        ids[key] = row!.id as string;
      };
      for (const s of STATES) {
        await request(`ash-family-${s}`, { requirement: `family-${s}`, family: "F1", subject: "F1", state: s });
        await request(`ash-student-${s}`, { requirement: `student-${s}`, family: "F1", subject: "S1", state: s });
      }
      await request("birch-family", { requirement: "family-waiting", family: "F2", subject: "F2", state: "waiting" });
      // Held under the Ash family for a student QuickBooks has under the Birch family now, not yet followed; and one
      // for a student who has left the roster.
      await request("moved", { requirement: "student-waiting", family: "F1", subject: "S3", state: "waiting" });
      await request("gone", { requirement: "student-declined", family: "F1", subject: "S-GONE", state: "declined" });
      // A guardian's consent, the reminder records and a withdrawal waiting for the worker.
      const [consent] = await pg`INSERT INTO signature_consent (request_id, parent_id, parent_name, parent_email, text_version, ip)
        VALUES (${ids["ash-family-waiting"]!}, ${ASH_PARENT}, 'Ash Parent', 'ash@forms.example', '2026-11-16', '203.0.113.50') RETURNING id`;
      ids.consent = consent!.id as string;
      await pg`INSERT INTO form_reminder_claim (requirement_id, parent_id, on_date) VALUES (${ids["family-waiting"]!}, ${ASH_PARENT}, '2026-11-16'), (${ids["family-waiting"]!}, ${BIRCH_PARENT}, '2026-11-16')`;
      await pg`INSERT INTO form_reminder_round (requirement_id, on_date) VALUES (${ids["family-waiting"]!}, '2026-11-16')`;
      await pg`INSERT INTO form_withdrawal (envelope_id, any_signed) VALUES ('envelope_withdrawn_before', true)`;
      // The kept evidence of both complete requests, with their files; and an earlier company's, under F1's number.
      const evidence = async (key: string, o: { request: string | null; realm: string; earlier: boolean; family: string; subject: string; kind: "family" | "student" }) => {
        const [row] = await pg`INSERT INTO signed_form_evidence (request_id, realm_id, earlier_company_at, requirement_id, family_qbo_id, subject_qbo_id, subject_kind,
            form_title, family_name, subject_name, season_name, envelope_id, template_id, signers, consents, originals, completed_at, copies_done_at)
          VALUES (${o.request}, ${o.realm}, ${o.earlier ? new Date("2026-10-01T00:00:00Z") : null}, null, ${o.family}, ${o.subject}, ${o.kind},
            ${`Form ${key}`}, 'Ash Family', ${`Subject ${key}`}, 'Fall', ${`envelope_kept_${key}`}, 'envelope_template',
            ${pg.json([{ parentId: ASH_PARENT, name: "Ash Parent", email: "ash@forms.example", signedAt: "2026-11-10T15:00:00.000Z" }])},
            ${pg.json([{ parentId: ASH_PARENT, name: "Ash Parent", email: "ash@forms.example", textVersion: "2026-11-16", agreedAt: "2026-11-10T14:58:00.000Z", ip: "203.0.113.50", userAgent: null }])},
            ${pg.json([{ itemId: `envelope_item_${key}`, sha256: "ab".repeat(32), size: 64 }])}, '2026-11-10T15:00:00Z', now()) RETURNING id`;
        ids[key] = row!.id as string;
        for (const [i, kind] of ["sealed_pdf", "certificate_pdf", "audit_log_pdf", "audit_log_json"].entries()) {
          const bytes = Buffer.from(`%PDF-1.7\n% ${kind} ${key}\n%%EOF\n`, "latin1");
          await pg`INSERT INTO signed_form_file (evidence_id, kind, position, item_id, bytes, size, sha256)
            VALUES (${row!.id}, ${kind}, 1, ${i === 0 ? `envelope_item_${key}` : null}, ${bytes}, ${bytes.byteLength}, ${"cd".repeat(32)})`;
        }
        await pg`INSERT INTO signed_form_copy (evidence_id, parent_id, outcome, how, done_at) VALUES (${row!.id}, ${ASH_PARENT}, 'sent', 'attached', now())`;
      };
      await evidence("evidenceFamily", { request: ids["ash-family-complete"]!, realm: REALM, earlier: false, family: "F1", subject: "F1", kind: "family" });
      await evidence("evidenceStudent", { request: ids["ash-student-complete"]!, realm: REALM, earlier: false, family: "F1", subject: "S1", kind: "student" });
      await evidence("evidenceEarlier", { request: null, realm: OTHER_REALM, earlier: true, family: "F1", subject: "F1", kind: "family" });
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
      evidenceBefore = [...await pg`SELECT * FROM signed_form_evidence ORDER BY id`];
      filesBefore = [...await pg`SELECT * FROM signed_form_file ORDER BY id`];
      keptBefore = [
        ...await pg`SELECT 'consent' AS t, id::text, request_id::text AS a, parent_id::text AS b FROM signature_consent`,
        ...await pg`SELECT 'claim' AS t, id::text, requirement_id::text AS a, parent_id::text AS b FROM form_reminder_claim`,
        ...await pg`SELECT 'round' AS t, id::text, requirement_id::text AS a, on_date::text AS b FROM form_reminder_round`,
        ...await pg`SELECT 'withdrawal' AS t, envelope_id AS id, any_signed::text AS a, tries::text AS b FROM form_withdrawal`,
        ...await pg`SELECT 'copy' AS t, id::text, evidence_id::text AS a, outcome AS b FROM signed_form_copy`,
      ].sort((x, y) => `${x.t}${x.id}`.localeCompare(`${y.t}${y.id}`));
    });
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("stops, and changes nothing, when a request names a customer with no record of the kind it holds, or evidence of another company isn't marked as an earlier company's", async () => {
    // Made after 0023, so nothing made a record of them: never guessed at.
    const [bad] = await q((pg) => pg`INSERT INTO signature_request (requirement_id, family_qbo_id, subject_qbo_id) VALUES (${ids["family-signed"]!}, 'F-NOBODY', 'F-NOBODY') RETURNING id`);
    const [badStudent] = await q((pg) => pg`INSERT INTO signature_request (requirement_id, family_qbo_id, subject_qbo_id) VALUES (${ids["student-signed"]!}, 'F2', 'S-NOBODY') RETURNING id`);
    const [stray] = await q((pg) => pg`INSERT INTO signed_form_evidence (request_id, realm_id, family_qbo_id, subject_qbo_id, subject_kind, form_title, envelope_id, signers, consents, originals)
      VALUES (null, ${OTHER_REALM}, 'F2', 'F2', 'family', 'Stray', 'envelope_stray', '[]', '[]', '[]') RETURNING id`);
    const message = await failureOf(migrateWith(path.resolve("drizzle")));
    expect(message).toMatch(/Migration 0028 stopped, and changed nothing: /);
    expect(message).toMatch(/1 rows in signature_request with no family record/);
    expect(message).toMatch(/1 per-student rows in signature_request with no student record/);
    expect(message).toMatch(/1 rows in signed_form_evidence of a company other than the roster's, not marked as an earlier company's/);
    expect(await columnsOf("signature_request")).toContain("family_qbo_id");
    expect(await columnsOf("signature_request")).not.toContain("family_id");
    expect(await columnsOf("signed_form_evidence")).not.toContain("family_id");
    await q((pg) => pg`DELETE FROM signature_request WHERE id IN (${bad!.id}, ${badStudent!.id})`);
    await q((pg) => pg`DELETE FROM signed_form_evidence WHERE id = ${stray!.id}`);
  });

  describe("once every row has its record", () => {
    beforeAll(async () => { await migrateWith(path.resolve("drizzle")); });

    it("gives each request the family that holds it and, for a per-student form, its student's own record: a moved or departed student's included", async () => {
      const rows = await q((pg) => pg.unsafe(`SELECT s.id, s.state, ${customerOf("s.family_id", "family")} AS family, ${customerOf("s.student_id", "student")} AS student,
          st.active AS student_active, ${customerOf("st.family_id", "family")} AS student_now_in
        FROM signature_request s LEFT JOIN student st ON st.id = s.student_id`));
      const of = (key: string) => rows.find((r) => r.id === ids[key])!;
      expect(rows).toHaveLength(13);
      for (const s of STATES) {
        expect(of(`ash-family-${s}`), s).toMatchObject({ state: s, family: "F1", student: null });
        expect(of(`ash-student-${s}`), s).toMatchObject({ state: s, family: "F1", student: "S1", student_active: true, student_now_in: "F1" });
      }
      expect(of("birch-family")).toMatchObject({ family: "F2", student: null });
      // Moved: the request stays the Ash family's and names the student's own record, which is in the Birch family now.
      // (Until stage 3's slice 9c the next roster read followed such a move; since then nothing does.)
      expect(of("moved")).toMatchObject({ family: "F1", student: "S3", student_active: true, student_now_in: "F2" });
      // Left the roster: an inactive record that was never under a family the cache held, as 0023 made it.
      expect(of("gone")).toMatchObject({ family: "F1", student: "S-GONE", student_active: false, student_now_in: null });
    });

    it("keeps every consent, reminder claim and round, withdrawal and copy as it was", async () => {
      const kept = await q(async (pg) => [
        ...await pg`SELECT 'consent' AS t, id::text, request_id::text AS a, parent_id::text AS b FROM signature_consent`,
        ...await pg`SELECT 'claim' AS t, id::text, requirement_id::text AS a, parent_id::text AS b FROM form_reminder_claim`,
        ...await pg`SELECT 'round' AS t, id::text, requirement_id::text AS a, on_date::text AS b FROM form_reminder_round`,
        ...await pg`SELECT 'withdrawal' AS t, envelope_id AS id, any_signed::text AS a, tries::text AS b FROM form_withdrawal`,
        ...await pg`SELECT 'copy' AS t, id::text, evidence_id::text AS a, outcome AS b FROM signed_form_copy`,
      ].sort((x, y) => `${x.t}${x.id}`.localeCompare(`${y.t}${y.id}`)));
      expect(kept).toEqual(keptBefore);
      expect(kept.filter((k) => k.t === "consent")).toEqual([expect.objectContaining({ id: ids.consent, a: ids["ash-family-waiting"] })]);
    });

    it("keeps the evidence exactly as it was, every column and every byte, the current company's with the app's records beside it and the earlier company's with none", async () => {
      const after = await q(async (pg) => [...await pg`SELECT * FROM signed_form_evidence ORDER BY id`]);
      // Every column it had before, as it was: the two new ones aside.
      expect(after.map((e) => Object.fromEntries(Object.entries(e).filter(([column]) => column !== "family_id" && column !== "student_id")))).toEqual(evidenceBefore);
      expect(await q(async (pg) => [...await pg`SELECT * FROM signed_form_file ORDER BY id`])).toEqual(filesBefore);
      const of = (key: string) => after.find((e) => e.id === ids[key])!;
      expect(of("evidenceFamily")).toMatchObject({ family_id: await recordOf("F1", "family"), student_id: null, family_qbo_id: "F1", subject_qbo_id: "F1" });
      expect(of("evidenceStudent")).toMatchObject({ family_id: await recordOf("F1", "family"), student_id: await recordOf("S1", "student"), family_qbo_id: "F1", subject_qbo_id: "S1" });
      // The earlier company's, under F1's number: matched to nobody, the Ash family's record and the other company's alike.
      expect(of("evidenceEarlier")).toMatchObject({ family_id: null, student_id: null, family_qbo_id: "F1", realm_id: OTHER_REALM, request_id: null });
      expect(await columnsOf("signed_form_evidence")).toEqual(expect.arrayContaining(["family_qbo_id", "subject_qbo_id", "subject_kind", "realm_id", "family_id", "student_id"]));
    });

    it("drops the request's QuickBooks columns once nothing reads them", async () => {
      const columns = await columnsOf("signature_request");
      expect(columns).toEqual(expect.arrayContaining(["family_id", "student_id"]));
      expect(columns.filter((c) => c.endsWith("_qbo_id"))).toEqual([]);
    });

    it("refuses a request or current evidence that names no record, an earlier company's that names one, a second request for one subject, and a record's removal while one names it", async () => {
      const ash = await recordOf("F1", "family"), birch = await recordOf("F2", "family"), kid = await recordOf("S2", "student");
      const req = ids["family-waiting"]!, studentReq = ids["student-waiting"]!;
      await expect(q((pg) => pg`INSERT INTO signature_request (requirement_id, family_id) VALUES (${ids["family-signed"]!}, ${NOBODY})`)).rejects.toThrow(/signature_request_family_id_family_id_fk/);
      await expect(q((pg) => pg`INSERT INTO signature_request (requirement_id, family_id, student_id) VALUES (${studentReq}, ${birch}, ${NOBODY})`)).rejects.toThrow(/signature_request_student_id_student_id_fk/);
      await expect(q((pg) => pg`INSERT INTO signature_request (requirement_id) VALUES (${ids["family-declined"]!})`)).rejects.toThrow(/family_id/);
      // One request per form and subject: the Ash family has one for this form already, and so has the Birch family.
      await expect(q((pg) => pg`INSERT INTO signature_request (requirement_id, family_id) VALUES (${req}, ${ash})`)).rejects.toThrow(/signature_request_family_uq/);
      const ashKid = await recordOf("S1", "student");
      await expect(q((pg) => pg`INSERT INTO signature_request (requirement_id, family_id, student_id) VALUES (${ids["student-complete"]!}, ${birch}, ${ashKid})`))
        .rejects.toThrow(/signature_request_student_uq/);
      // A new one for Birch's own student is taken: the database refuses only what names no record or a second request.
      await q((pg) => pg`INSERT INTO signature_request (requirement_id, family_id, student_id) VALUES (${ids["student-not_opened"]!}, ${birch}, ${kid})`);
      const evidence = (o: { earlier: boolean; family: string | null; student: string | null; kind: "family" | "student" }) => q((pg) => pg`INSERT INTO signed_form_evidence
        (request_id, realm_id, earlier_company_at, family_qbo_id, subject_qbo_id, subject_kind, family_id, student_id, form_title, envelope_id, signers, consents, originals)
        VALUES (null, ${REALM}, ${o.earlier ? new Date() : null}, 'F2', 'F2', ${o.kind}, ${o.family}, ${o.student}, 'New', 'envelope_new', '[]', '[]', '[]')`);
      await expect(evidence({ earlier: false, family: null, student: null, kind: "family" })).rejects.toThrow(/signed_form_evidence_app_records/);
      await expect(evidence({ earlier: true, family: birch, student: null, kind: "family" })).rejects.toThrow(/signed_form_evidence_app_records/);
      await expect(evidence({ earlier: false, family: birch, student: null, kind: "student" })).rejects.toThrow(/signed_form_evidence_app_records/);
      await expect(evidence({ earlier: false, family: NOBODY, student: null, kind: "family" })).rejects.toThrow(/signed_form_evidence_family_id_family_id_fk/);
      // A record a request names can't be deleted from under it: the departed student's, named by nothing but its request;
      // nor the family a kept form names.
      const gone = await recordOf("S-GONE", "student");
      await expect(q((pg) => pg`DELETE FROM student WHERE id = ${gone}`)).rejects.toThrow(/signature_request_student_id_student_id_fk/);
      await expect(q((pg) => pg`DELETE FROM family WHERE id = ${ash}`)).rejects.toThrow(/foreign key/);
    });
  });
});
