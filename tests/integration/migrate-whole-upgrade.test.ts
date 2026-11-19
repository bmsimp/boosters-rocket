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
 * The upgrade the proof-of-concept host will make: from the release it runs, at migration 0022, to today's, in one
 * run of the migrator. Drizzle's migrator applies every pending migration in one transaction
 * (node_modules/drizzle-orm/pg-core/dialect.js), and scripts/migrate.mjs calls migrate() once, as this file does. Each
 * migration's own test runs it on a database brought to the one before it; here the whole of 0023 to the newest goes at
 * once, over a database seeded as that release would hold it, with every kind of row a later migration re-keys. Then a
 * second database, the same but for one buy-out of another company (0030 refuses it whatever records exist: 0023 gives a
 * record to every customer a row of the roster's company names, so only another company's row can reach a refusal),
 * shows that a refusal anywhere leaves the database exactly at 0022: the portal keeps running the release it had.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const UPGRADED = scratchDatabase("migrate_upgrade");
const REFUSED = scratchDatabase("migrate_refused");
const folders: string[] = [];
const REALM = "4650000000000001";
const OTHER_REALM = "4650000000000999";
const ASH = "7c0a9a1e-0000-4000-8000-000000000021", BIRCH = "7c0a9a1e-0000-4000-8000-000000000022", STAFF = "7c0a9a1e-0000-4000-8000-0000000000ab";

/** The migrations folder as it was up to `last` (by index): the release the host runs is at 0022. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-upgrade-"));
  folders.push(folder);
  cpSync("drizzle", folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number }[] };
  j.entries = j.entries.filter((e) => e.idx <= last);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}
/** As scripts/migrate.mjs runs it in the image: one connection, one migrate() call over the folder. */
async function migrateAsTheImage(url: string, folder: string) {
  const pg = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  try { await migrate(drizzle(pg), { migrationsFolder: folder }); } finally { await pg.end({ timeout: 5 }); }
}
const on = (url: string) => async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(url, { max: 1, onnotice: () => {} });
  try { return await f(pg); } finally { await pg.end(); }
};
const journalLength = () => (JSON.parse(readFileSync(path.join("drizzle", "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;

/** Ids of the rows seeded, by what each is. */
type Seeded = Record<string, string>;

/**
 * Every kind of row a migration after 0022 re-keys, in raw SQL valid for the schema at 0022, as the release on the host
 * holds them: a roster cache of one company with its families, students and parents and `roster.source`; guardians with
 * sessions and a pending email change; a season with a chosen list, ticks, a waiver and a due-date reminder claim;
 * volunteer sign-ups, credit and reminder claims; form requests with the current company's evidence and an earlier
 * company's; buy-outs per family and per student; the money cache, with a row that has only ever failed and one whose
 * customer a later roster read removed from the cache; and a queued write.
 */
async function seedTheRelease(pg: postgres.Sql): Promise<Seeded> {
  const ids: Seeded = {};
  await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
    ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
  await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
  await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, email, sync_token) VALUES
    ('F1', 'Ash Family', true, null, 'F', null, '0'), ('S1', 'Ash Kid', true, 'F1', 'S', null, '0'), ('P1', 'Ash Parent', true, 'F1', 'P', 'ash@upgrade.example', '0'),
    ('F2', 'Birch Family', true, null, 'F', null, '0'), ('S2', 'Birch Kid', true, 'F2', 'S', null, '0'), ('P2', 'Birch Parent', true, 'F2', 'P', 'birch@upgrade.example', '0')`;

  // The guardians, each signed in to their family, and one with an email change waiting to be confirmed.
  for (const [id, name, email, familyQboId, sourceQboId] of [[ASH, "Ash Parent", "ash@upgrade.example", "F1", "P1"], [BIRCH, "Birch Parent", "birch@upgrade.example", "F2", "P2"]] as const) {
    await pg`INSERT INTO parent (id, name, email) VALUES (${id}, ${name}, ${email})`;
    await pg`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id) VALUES (${`user-${id}`}, ${name}, ${email}, true, ${id})`;
    const [g] = await pg`INSERT INTO guardian (family_qbo_id, parent_id, status, source_qbo_id) VALUES (${familyQboId}, ${id}, 'active', ${sourceQboId}) RETURNING id`;
    ids[`guardian-${familyQboId}`] = g!.id as string;
    await pg`INSERT INTO parent_auth_session (id, expires_at, token, user_id, family_qbo_id)
      VALUES (${`session-${id}`}, now() + interval '1 day', ${`token-${id}`}, ${`user-${id}`}, ${familyQboId})`;
  }
  const [change] = await pg`INSERT INTO parent_email_change (parent_id, guardian_id, family_qbo_id, record_qbo_id, new_email, token_hash, expires_at)
    VALUES (${ASH}, ${ids["guardian-F1"]!}, 'F1', 'P1', 'ash.new@upgrade.example', ${"ab".repeat(32)}, now() + interval '1 day') RETURNING id`;
  ids.emailChange = change!.id as string;

  // The season: a chosen list, ticks and a waiver, and a due-date reminder claim.
  const [season] = await pg`INSERT INTO season (name, is_current) VALUES ('Fall', true) RETURNING id`;
  const [step] = await pg`INSERT INTO season_step (season_id, name, position) VALUES (${season!.id}, 'Join', 0) RETURNING id`;
  const checklist = async (key: string, appliesTo: "family" | "student", covers: "everyone" | "chosen", position: number) => {
    const [row] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position) VALUES (${step!.id}, 'checklist', ${key}, ${appliesTo}, ${covers}, ${position}) RETURNING id`;
    ids[key] = row!.id as string;
  };
  await checklist("locker", "family", "chosen", 0);
  await checklist("uniform", "student", "everyone", 1);
  await pg`INSERT INTO requirement_cover (requirement_id, subject_qbo_id) VALUES (${ids.locker!}, 'F1')`;
  const tick = async (key: string, requirementId: string, subject: string, waived?: string) => {
    const [row] = await pg`INSERT INTO requirement_progress (requirement_id, subject_qbo_id, met_at, waived_at, waived_reason)
      VALUES (${requirementId}, ${subject}, ${waived ? null : new Date()}, ${waived ? new Date() : null}, ${waived ?? null}) RETURNING id`;
    ids[key] = row!.id as string;
  };
  await tick("tickLocker", ids.locker!, "F1");
  await tick("tickUniform", ids.uniform!, "S1");
  await tick("waiverUniform", ids.uniform!, "S2", "Borrowed one");
  const [claim] = await pg`INSERT INTO requirement_reminder (kind, family_qbo_id, parent_id, due_on, tried_at, outcome)
    VALUES ('due_14', 'F1', ${ASH}, '2026-12-01', now(), 'sent') RETURNING id`;
  ids.seasonClaim = claim!.id as string;

  // Volunteering: a guardian's place and a student's, a check-in, credit earned outside the portal, and reminder claims.
  const [hours] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position, amount, amount_unit)
    VALUES (${step!.id}, 'volunteer', 'Student hours', 'student', 'everyone', 2, 6, 'hours') RETURNING id`;
  const [event] = await pg`INSERT INTO volunteer_event (name, on_date, location, contact_name) VALUES ('Fall fair', '2026-12-02', 'Gym', 'Pat') RETURNING id`;
  const [shift] = await pg`INSERT INTO volunteer_shift (event_id, starts_at, ends_at, places) VALUES (${event!.id}, '09:00', '12:00', 9) RETURNING id`;
  const [mine] = await pg`INSERT INTO volunteer_signup (shift_id, family_qbo_id, signed_up_by, filler_kind, filler_parent_id, filler_name)
    VALUES (${shift!.id}, 'F1', ${ASH}, 'guardian', ${ASH}, 'Ash Parent') RETURNING id`;
  const [kid] = await pg`INSERT INTO volunteer_signup (shift_id, family_qbo_id, signed_up_by, filler_kind, student_qbo_id, filler_name)
    VALUES (${shift!.id}, 'F1', ${ASH}, 'student', 'S1', 'Ash Kid') RETURNING id`;
  ids.signupGuardian = mine!.id as string; ids.signupStudent = kid!.id as string;
  const [checkin] = await pg`INSERT INTO volunteer_credit ${pg({ kind: "checkin", signup_id: kid!.id, family_qbo_id: "F1", minutes: 180, shifts: 1, created_by_door: "parent", created_by: ASH })} RETURNING id`;
  const [outside] = await pg`INSERT INTO volunteer_credit ${pg({ kind: "outside", family_qbo_id: "F2", student_qbo_id: "S2", requirement_id: hours!.id, minutes: 90, shifts: 0,
    note: "Painted the set", created_by_door: "staff", created_by: STAFF })} RETURNING id`;
  ids.creditCheckin = checkin!.id as string; ids.creditOutside = outside!.id as string;
  const [dayBefore] = await pg`INSERT INTO volunteer_reminder (kind, key, family_qbo_id, tried_at, outcome) VALUES ('day_before', ${`${mine!.id}|2026-12-02`}, 'F1', now(), 'sent') RETURNING id`;
  const [due] = await pg`INSERT INTO volunteer_reminder (kind, key, family_qbo_id, tried_at, outcome) VALUES ('due_14', ${`F1|2026-12-01|${ASH}`}, 'F1', now(), 'sent') RETURNING id`;
  ids.claimDayBefore = dayBefore!.id as string; ids.claimDue = due!.id as string;

  // Forms: a family's request, complete with the current company's evidence, and a student's waiting; and an earlier
  // company's evidence under the same family number.
  const form = async (key: string, appliesTo: "family" | "student", position: number) => {
    const [row] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position) VALUES (${step!.id}, 'form', ${key}, ${appliesTo}, 'everyone', ${position}) RETURNING id`;
    ids[key] = row!.id as string;
  };
  await form("formFamily", "family", 3);
  await form("formStudent", "student", 4);
  const signers = (signedAt: string | null) => pg.json([{ parentId: ASH, recipientId: 1, name: "Ash Parent", email: "ash@upgrade.example", signedAt }]);
  const [famRequest] = await pg`INSERT INTO signature_request (requirement_id, family_qbo_id, subject_qbo_id, state, envelope_id, subject_name, signers, evidence_owed)
    VALUES (${ids.formFamily!}, 'F1', 'F1', 'complete', 'envelope_family', 'Ash Family', ${signers("2026-11-10T15:00:00.000Z")}, false) RETURNING id`;
  const [kidRequest] = await pg`INSERT INTO signature_request (requirement_id, family_qbo_id, subject_qbo_id, state, envelope_id, subject_name, signers, evidence_owed)
    VALUES (${ids.formStudent!}, 'F1', 'S1', 'waiting', 'envelope_student', 'Ash Kid', ${signers(null)}, false) RETURNING id`;
  ids.requestFamily = famRequest!.id as string; ids.requestStudent = kidRequest!.id as string;
  const evidence = async (key: string, o: { request: string | null; realm: string; earlier: boolean }) => {
    const [row] = await pg`INSERT INTO signed_form_evidence (request_id, realm_id, earlier_company_at, requirement_id, family_qbo_id, subject_qbo_id, subject_kind,
        form_title, family_name, subject_name, season_name, envelope_id, template_id, signers, consents, originals, completed_at, copies_done_at)
      VALUES (${o.request}, ${o.realm}, ${o.earlier ? new Date("2026-10-01T00:00:00Z") : null}, null, 'F1', 'F1', 'family',
        ${`Form ${key}`}, 'Ash Family', 'Ash Family', 'Fall', ${`envelope_kept_${key}`}, 'envelope_template',
        ${pg.json([{ parentId: ASH, name: "Ash Parent", email: "ash@upgrade.example", signedAt: "2026-11-10T15:00:00.000Z" }])},
        ${pg.json([{ parentId: ASH, name: "Ash Parent", email: "ash@upgrade.example", textVersion: "2026-11-16", agreedAt: "2026-11-10T14:58:00.000Z", ip: "203.0.113.50", userAgent: null }])},
        ${pg.json([{ itemId: `envelope_item_${key}`, sha256: "ab".repeat(32), size: 64 }])}, '2026-11-10T15:00:00Z', now()) RETURNING id`;
    ids[key] = row!.id as string;
  };
  await evidence("evidenceCurrent", { request: famRequest!.id as string, realm: REALM, earlier: false });
  await evidence("evidenceEarlier", { request: null, realm: OTHER_REALM, earlier: true });

  // Buy-outs: one per family and one per student, each on its own requirement.
  const buyoutRequirement = async (key: string, appliesTo: "family" | "student", position: number) => {
    const [row] = await pg`INSERT INTO requirement (step_id, kind, title, applies_to, covers, position, amount, amount_unit, item_qbo_id, buyout_unit_cents)
      VALUES (${step!.id}, 'volunteer', ${key}, ${appliesTo}, 'everyone', ${position}, 2, 'shifts', '4343', 5000) RETURNING id`;
    ids[key] = row!.id as string;
  };
  await buyoutRequirement("buyFamily", "family", 5);
  await buyoutRequirement("buyStudent", "student", 6);
  const buyout = async (key: string, o: { requirement: string; subject: string; state: string; invoice: string; realm?: string }) => {
    const [row] = await pg`INSERT INTO buyout (requirement_id, family_qbo_id, subject_qbo_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, invoice_qbo_id,
        invoice_sync_token, realm_id, chosen_by, chosen_by_label)
      VALUES (${o.requirement}, 'F1', ${o.subject}, ${o.subject}, '4343', 5000, 2, 10000, ${o.state}, ${o.invoice}, '3', ${o.realm ?? REALM}, ${ASH}, 'ash@upgrade.example')
      RETURNING id`;
    ids[key] = row!.id as string;
  };
  await buyout("buyoutFamily", { requirement: ids.buyFamily!, subject: "F1", state: "invoiced", invoice: "9001" });
  await buyout("buyoutStudent", { requirement: ids.buyStudent!, subject: "S1", state: "paid", invoice: "9002" });

  // The money cache: the Ash family's figures, a family whose every read failed (no company), and figures of the
  // roster's company for a customer a later roster read no longer returned.
  await pg`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, currency) VALUES ('F1', ${REALM}, '2026-11-17T10:00:00Z',
    ${pg.json([{ qboId: "9001", number: "INV-9001", customerQboId: "F1", forName: null, date: "2026-10-01", dueDate: "2026-12-01", totalCents: 10000, balanceCents: 10000,
      currency: "USD", payLink: "https://connect.intuit.com/t/9001", itemQboIds: ["4343"] }])}, 10000, 'USD')`;
  await pg`INSERT INTO family_money (family_qbo_id, realm_id, failed_at, failed_code) VALUES ('F-FAILED', null, '2026-11-17T08:00:00Z', 'http_500')`;
  await pg`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, currency) VALUES ('F-REMOVED', ${REALM}, '2026-11-16T10:00:00Z', ${pg.json([])}, 0, 'USD')`;

  // A staff write waiting to reach QuickBooks: the void of the family's buy-out invoice.
  const [queued] = await pg`INSERT INTO write_queue (realm_id, request, family_qbo_id, sent, tries, next_try_at)
    VALUES (${REALM}, ${pg.json({ op: "invoice_void", buyoutId: ids.buyoutFamily!, invoiceQboId: "9001", familyQboId: "F1" })}, 'F1', false, 0, now()) RETURNING id`;
  ids.queued = queued!.id as string;
  return ids;
}

describe("the whole upgrade from the release at 0022, in one run of the migrator", { timeout: 120_000 }, () => {
  afterAll(async () => {
    await dropScratchDatabase(UPGRADED.name);
    await dropScratchDatabase(REFUSED.name);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  describe("a database the release holds", () => {
    const q = on(UPGRADED.url);
    let ids: Seeded = {};
    /** The customer an app record names, through its link of that kind in the roster's company. `column` is qualified by its table. */
    const customerOf = (column: string, kind: "family" | "student") =>
      `(SELECT l.customer_id FROM accounting_link l WHERE l.${kind}_id = ${column} AND l.system = 'quickbooks' AND l.realm_id = '${REALM}')`;
    const recordOf = async (customer: string, kind: "family" | "student") =>
      (await q((pg) => pg.unsafe(`SELECT ${kind}_id AS id FROM accounting_link WHERE customer_id = $1 AND ${kind}_id IS NOT NULL AND realm_id = '${REALM}'`, [customer])))[0]!.id as string;

    beforeAll(async () => {
      await makeScratchDatabase("migrate_upgrade"); // marked as this run's: a database of that name the run didn't make is refused
      await migrateAsTheImage(UPGRADED.url, migrationsUpTo(22));
      ids = await q(seedTheRelease);
      // Every migration from 0023 to the newest, at once, as the host's migrate service runs them.
      await migrateAsTheImage(UPGRADED.url, path.resolve("drizzle"));
    }, DATABASE_WORK);

    it("applies every migration in the folder", async () => {
      const [row] = await q((pg) => pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      expect(row!.n).toBe(journalLength());
    });

    it("gives each guardian row its family, and carries each session and the pending email change over to it (0037, 0038)", async () => {
      const guardians = await q((pg) => pg.unsafe(`SELECT t.family_qbo_id, ${customerOf("t.family_id", "family")} AS family FROM guardian t ORDER BY t.family_qbo_id COLLATE "C"`));
      expect(guardians.map((g) => [g.family_qbo_id, g.family])).toEqual([["F1", "F1"], ["F2", "F2"]]);
      // Each session names the app's record of the family it chose, the one its person's row there names.
      const sessions = await q((pg) => pg.unsafe(`SELECT t.id, ${customerOf("t.family_id", "family")} AS family FROM parent_auth_session t ORDER BY t.id COLLATE "C"`));
      expect(sessions.map((s) => [s.id, s.family])).toEqual([[`session-${ASH}`, "F1"], [`session-${BIRCH}`, "F2"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
      const [change] = await q((pg) => pg`SELECT family_id, guardian_id, record_qbo_id FROM parent_email_change WHERE id = ${ids.emailChange!}`);
      expect(change).toMatchObject({ family_id: await recordOf("F1", "family"), guardian_id: ids["guardian-F1"], record_qbo_id: "P1" });
      // Neither keeps a QuickBooks family column.
      const columns = await q((pg) => pg`SELECT table_name FROM information_schema.columns WHERE column_name = 'family_qbo_id' AND table_name IN ('parent_auth_session', 'parent_email_change')`);
      expect(columns).toEqual([]);
      const [carried] = await q((pg) => pg`SELECT after FROM audit_log WHERE action = 'parent.session.carried_over'`);
      expect(carried!.after).toMatchObject({ sessionsCarried: 2, sessionsCleared: 0, emailChangesCarried: 1, emailChangesDeleted: 0, realmId: REALM });
    });

    it("re-keys the season: the chosen list, the ticks, the waiver with its reason, and the reminder claim", async () => {
      const [cover] = await q((pg) => pg.unsafe(`SELECT ${customerOf("t.family_id", "family")} AS family, t.student_id FROM requirement_cover t WHERE t.requirement_id = $1`, [ids.locker!]));
      expect(cover).toEqual({ family: "F1", student_id: null });
      const progress = await q((pg) => pg.unsafe(`SELECT t.id, ${customerOf("t.family_id", "family")} AS family, ${customerOf("t.student_id", "student")} AS student, t.waived_reason FROM requirement_progress t`));
      const of = (key: string) => progress.find((p) => p.id === ids[key])!;
      expect(of("tickLocker")).toMatchObject({ family: "F1", student: null });
      expect(of("tickUniform")).toMatchObject({ family: null, student: "S1" });
      expect(of("waiverUniform")).toMatchObject({ family: null, student: "S2", waived_reason: "Borrowed one" });
      const [claim] = await q((pg) => pg.unsafe(`SELECT ${customerOf("t.family_id", "family")} AS family FROM requirement_reminder t WHERE t.id = $1`, [ids.seasonClaim!]));
      expect(claim!.family).toBe("F1");
    });

    it("re-keys volunteering: the places, the credit, and the due-date claim's key", async () => {
      const signups = await q((pg) => pg.unsafe(`SELECT t.id, ${customerOf("t.family_id", "family")} AS family, ${customerOf("t.student_id", "student")} AS student FROM volunteer_signup t`));
      expect(signups.find((s) => s.id === ids.signupGuardian)).toMatchObject({ family: "F1", student: null });
      expect(signups.find((s) => s.id === ids.signupStudent)).toMatchObject({ family: "F1", student: "S1" });
      const credit = await q((pg) => pg.unsafe(`SELECT t.id, t.signup_id, ${customerOf("t.family_id", "family")} AS family, ${customerOf("t.student_id", "student")} AS student FROM volunteer_credit t`));
      expect(credit.find((c) => c.id === ids.creditCheckin)).toMatchObject({ family: "F1", student: null, signup_id: ids.signupStudent });
      expect(credit.find((c) => c.id === ids.creditOutside)).toMatchObject({ family: "F2", student: "S2" });
      const claims = await q((pg) => pg`SELECT id, key, family_id FROM volunteer_reminder`);
      const ash = await recordOf("F1", "family");
      expect(claims.find((c) => c.id === ids.claimDue)).toMatchObject({ family_id: ash, key: `${ash}|2026-12-01|${ASH}` });
      expect(claims.find((c) => c.id === ids.claimDayBefore)).toMatchObject({ family_id: ash, key: `${ids.signupGuardian}|2026-12-02` });
    });

    it("re-keys forms: each request names its family and its student, the current company's evidence its family, and the earlier company's evidence none", async () => {
      const requests = await q((pg) => pg.unsafe(`SELECT t.id, ${customerOf("t.family_id", "family")} AS family, ${customerOf("t.student_id", "student")} AS student FROM signature_request t`));
      expect(requests.find((r) => r.id === ids.requestFamily)).toMatchObject({ family: "F1", student: null });
      expect(requests.find((r) => r.id === ids.requestStudent)).toMatchObject({ family: "F1", student: "S1" });
      const evidence = await q((pg) => pg.unsafe(`SELECT t.id, t.family_id, t.student_id, t.family_qbo_id, t.realm_id, ${customerOf("t.family_id", "family")} AS family FROM signed_form_evidence t`));
      expect(evidence.find((e) => e.id === ids.evidenceCurrent)).toMatchObject({ family: "F1", student_id: null, family_qbo_id: "F1", realm_id: REALM });
      // Kept whole, by its own copies of the QuickBooks ids, and tied to no app record: no current family can come to read it.
      expect(evidence.find((e) => e.id === ids.evidenceEarlier)).toMatchObject({ family_id: null, student_id: null, family_qbo_id: "F1", realm_id: OTHER_REALM });
    });

    it("re-keys the buy-outs, per family and per student, and leaves what they bill as it was", async () => {
      const buyouts = await q((pg) => pg.unsafe(`SELECT t.id, t.customer_qbo_id, t.invoice_qbo_id, ${customerOf("t.family_id", "family")} AS family, ${customerOf("t.student_id", "student")} AS student FROM buyout t`));
      expect(buyouts.find((b) => b.id === ids.buyoutFamily)).toMatchObject({ family: "F1", student: null, customer_qbo_id: "F1", invoice_qbo_id: "9001" });
      expect(buyouts.find((b) => b.id === ids.buyoutStudent)).toMatchObject({ family: "F1", student: "S1", customer_qbo_id: "S1", invoice_qbo_id: "9002" });
    });

    it("re-keys the money cache, the row that only ever failed and the one whose customer left the cache included", async () => {
      const rows = await q((pg) => pg.unsafe(`SELECT m.realm_id, ${customerOf("m.family_id", "family")} AS family, f.active FROM family_money m JOIN family f ON f.id = m.family_id`));
      const byCustomer = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
      expect(rows.map((r) => [r.family, r.realm_id, r.active]).sort(byCustomer)).toEqual([
        ["F-FAILED", null, false], ["F-REMOVED", REALM, false], ["F1", REALM, true]]);
    });

    it("files the write queue's item under the family record of the family it named, and keeps what it sends", async () => {
      const [queued] = await q((pg) => pg`SELECT family_id, student_id, request FROM write_queue WHERE id = ${ids.queued!}`);
      // The request is as it was written, its family's customer included (never sent, and read by nothing now).
      expect(queued).toMatchObject({ family_id: await recordOf("F1", "family"), student_id: null, request: { op: "invoice_void", invoiceQboId: "9001", familyQboId: "F1" } });
      expect(await q((pg) => pg`SELECT column_name FROM information_schema.columns WHERE table_name = 'write_queue' AND column_name = 'family_qbo_id'`)).toHaveLength(0);
    });
  });

  describe("a database the release holds, with one row of another company that a migration refuses", () => {
    const q = on(REFUSED.url);
    let applied = 0;

    beforeAll(async () => {
      await makeScratchDatabase("migrate_refused"); // marked as this run's: a database of that name the run didn't make is refused
      await migrateAsTheImage(REFUSED.url, migrationsUpTo(22));
      await q(async (pg) => {
        const ids = await seedTheRelease(pg);
        // A buy-out of another company. F2 is on the roster, so 0023 gives it a family record and link in the roster's
        // company; 0030 fills a buy-out only through a link of its own company, and refuses this one rather than guess.
        // That is the only kind of row that can stop the run: 0023 gives a record to every customer a row of the
        // roster's company names, so no row of that company is left without one.
        await pg`INSERT INTO buyout (requirement_id, family_qbo_id, subject_qbo_id, customer_qbo_id, item_qbo_id, unit_cents, units, amount_cents, state, invoice_qbo_id,
            invoice_sync_token, realm_id, chosen_by, chosen_by_label)
          VALUES (${ids.buyFamily!}, 'F2', 'F2', 'F2', '4343', 5000, 2, 10000, 'invoiced', '9100', '3', ${OTHER_REALM}, ${BIRCH}, 'birch@upgrade.example')`;
      });
      applied = (await q((pg) => pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`))[0]!.n as number;
    }, DATABASE_WORK);

    it("refuses, and leaves the database exactly at 0022: no migration recorded, no app records, every QuickBooks column in place", async () => {
      expect(applied).toBe(23);
      const failure = await migrateAsTheImage(REFUSED.url, path.resolve("drizzle")).then(() => null, (e: unknown) => e as Error & { cause?: unknown });
      expect(failure).not.toBeNull();
      expect(`${failure!.message} ${failure!.cause instanceof Error ? failure!.cause.message : ""}`).toMatch(/Migration 0030 stopped, and changed nothing: 1 rows in buyout of a company other than the roster's/);

      const [after] = await q((pg) => pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
      expect(after!.n).toBe(applied);
      // 0023 to 0029 ran before 0030 refused, in the same transaction: none of what they did is left.
      const tables = await q((pg) => pg`SELECT to_regclass('public.family')::text AS family, to_regclass('public.student')::text AS student,
        to_regclass('public.accounting_link')::text AS link`);
      expect(tables[0]).toEqual({ family: null, student: null, link: null });
      const columns = await q((pg) => pg`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND (column_name::text IN ('family_id', 'student_id') OR (table_name::text, column_name::text) IN
          (('requirement_progress', 'subject_qbo_id'), ('volunteer_signup', 'family_qbo_id'), ('signature_request', 'family_qbo_id'), ('buyout', 'family_qbo_id'), ('family_money', 'family_qbo_id')))`);
      expect(columns.filter((c) => c.column_name === "family_id" || c.column_name === "student_id")).toEqual([]);
      expect(columns.map((c) => c.table_name as string).sort()).toEqual(["buyout", "family_money", "requirement_progress", "signature_request", "volunteer_signup"]);
      // The rows are as the release left them.
      const [counts] = await q((pg) => pg`SELECT (SELECT count(*)::int FROM buyout) AS buyouts, (SELECT count(*)::int FROM family_money) AS money,
        (SELECT count(*)::int FROM volunteer_reminder WHERE key LIKE 'F1|%') AS claims`);
      expect(counts).toEqual({ buyouts: 3, money: 3, claims: 1 });
    });
  });
});
