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
 * Migrations 0037 and 0038 (stage 3's fifth slice of the app-owned families spec): a parent's session names the family
 * it chose, and a pending change of sign-in address the family it was asked in, by the app's own family record, never
 * by a QuickBooks id. Run on data shaped like a real installation, upgraded from before 0023: a session of each kind
 * (one family, one of a person's two families, one not chosen yet, one whose row has closed, one in a family the person
 * has no row in), an email change carried from its own guardian row and one from the person's open row, a live one that
 * can't be carried, and a used and an expired one that can't. A session's family is the family record of its own
 * person's open guardian row in the family it chose; one that can't be carried has its family cleared, and no session
 * is deleted; a live email change that can't be carried is deleted, and a used or expired one keeps none. An open row
 * with no family record while the roster names a company stops the migration and changes nothing. One audit row says
 * how many. A second database, with no roster company, shows a session whose row names no family record cleared, and
 * no refusal. An empty database passes with or without a roster company: every test database is migrated from empty,
 * with no roster company, by the setup.
 */
// On the run's own server, named after this file's database (the run's, or its worker's). Making or dropping a
// database waits for Postgres to write out what every database on the server has changed: that has taken two minutes.
const DATABASE_WORK = 300_000;
const WITH_COMPANY = scratchDatabase("migrate_session");
const NO_COMPANY = scratchDatabase("migrate_bare");
const folders: string[] = [];
const REALM = "4650000000000001";
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e72";
/** The people, by their portal id: each a kind of person a session or a change of address can belong to. */
const ASH = "7c0a9a1e-0000-4000-8000-000000000031", BIRCH = "7c0a9a1e-0000-4000-8000-000000000032", CEDAR = "7c0a9a1e-0000-4000-8000-000000000033";
const DEE = "7c0a9a1e-0000-4000-8000-000000000034", ELM = "7c0a9a1e-0000-4000-8000-000000000035", FAY = "7c0a9a1e-0000-4000-8000-000000000036";
const GUS = "7c0a9a1e-0000-4000-8000-000000000037";
/** The columns the re-key adds or drops: every other column of a session or a request is kept exactly. */
const RE_KEYED = new Set(["family_id", "family_qbo_id"]);

/** The migrations folder as it was up to `last` (by index), for the database as it was before this slice. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-sessions-"));
  folders.push(folder);
  cpSync("drizzle", folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number }[] };
  j.entries = j.entries.filter((e) => e.idx <= last);
  writeFileSync(journal, JSON.stringify(j));
  return folder;
}
const on = (url: string) => ({
  migrate: async (folder: string) => {
    const pg = postgres(url, { max: 1, onnotice: () => {} });
    try { await migrate(drizzle(pg), { migrationsFolder: folder }); } finally { await pg.end(); }
  },
  q: async <T>(f: (pg: postgres.Sql) => Promise<T>) => {
    const pg = postgres(url, { max: 1, onnotice: () => {} });
    try { return await f(pg); } finally { await pg.end(); }
  },
});
const company = on(WITH_COMPANY.url), bare = on(NO_COMPANY.url);
const columnsOf = (db: typeof company, table: string) =>
  db.q(async (pg) => (await pg`SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`).map((c) => c.column_name as string).sort());
/** Drizzle wraps the database's error in its own, with the database's as the cause. */
const failureOf = async (run: Promise<unknown>) => {
  const failure = await run.then(() => null, (e: unknown) => e as Error & { cause?: unknown });
  expect(failure).not.toBeNull();
  return `${failure!.message} ${failure!.cause instanceof Error ? failure!.cause.message : ""}`;
};
/** A row with the re-keyed columns left out: what must be the same before and after. */
const kept = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([column]) => !RE_KEYED.has(column)));

/** As 0022 held them: a person with their sign-in user, their guardian rows, sessions and requests. */
async function person(pg: postgres.Sql, id: string, name: string) {
  const email = `${name.toLowerCase()}@sessions.example`;
  await pg`INSERT INTO parent (id, name, email) VALUES (${id}, ${name}, ${email})`;
  await pg`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id) VALUES (${`user-${id}`}, ${name}, ${email}, true, ${id})`;
}
async function row(pg: postgres.Sql, parentId: string, familyQboId: string, o: { status?: string; source?: string | null } = {}): Promise<string> {
  const [g] = await pg`INSERT INTO guardian (family_qbo_id, parent_id, status, source_qbo_id, disabled_reason, status_before_disable)
    VALUES (${familyQboId}, ${parentId}, ${o.status ?? "active"}, ${o.source ?? null}, ${o.status === "disabled" ? "removed" : null}, ${o.status === "disabled" ? "active" : null}) RETURNING id`;
  return g!.id as string;
}
const session = (pg: postgres.Sql, key: string, parentId: string, familyQboId: string | null) =>
  pg`INSERT INTO parent_auth_session (id, expires_at, token, user_id, family_qbo_id) VALUES (${key}, now() + interval '30 days', ${`token-${key}`}, ${`user-${parentId}`}, ${familyQboId})`;
async function change(pg: postgres.Sql, key: string, o: { parentId: string; guardianId: string | null; familyQboId: string | null; expiresAt?: Date; usedAt?: Date | null }): Promise<string> {
  const [e] = await pg`INSERT INTO parent_email_change (parent_id, guardian_id, family_qbo_id, record_qbo_id, new_email, token_hash, expires_at, used_at)
    VALUES (${o.parentId}, ${o.guardianId}, ${o.familyQboId}, 'P1', ${`${key}.new@sessions.example`}, ${key.padEnd(64, "0")}, ${o.expiresAt ?? new Date(Date.now() + 86_400_000)}, ${o.usedAt ?? null})
    RETURNING id`;
  return e!.id as string;
}

/** Each request by a name of this test's, and the sessions and requests as 0036 held them. */
const changes: Record<string, string> = {};
let sessionsBefore: Record<string, unknown>[] = [];
let changesBefore: Record<string, unknown>[] = [];

describe("migrations 0037 and 0038: a session and a pending email change name the app's own family", { timeout: 60_000 }, () => {
  afterAll(async () => {
    await dropScratchDatabase(WITH_COMPANY.name);
    await dropScratchDatabase(NO_COMPANY.name);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  describe("while the roster names a company", () => {
    beforeAll(async () => {
      await makeScratchDatabase("migrate_session"); // marked as this run's: a database of that name the run didn't make is refused
      // The database as it was before stage 1: migrations up to 0022.
      await company.migrate(migrationsUpTo(22));
      await company.q(async (pg) => {
        await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: REALM })}),
          ('membership.shape', ${pg.json({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" })})`;
        await pg`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('F', 'Family', true), ('S', 'Student', true), ('P', 'Parent', true)`;
        await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, sync_token) VALUES
          ('F1', 'Ash Family', true, null, 'F', '0'), ('P1', 'Ash Parent', true, 'F1', 'P', '0'),
          ('F2', 'Birch Family', true, null, 'F', '0'), ('P2', 'Birch Parent', true, 'F2', 'P', '0')`;
        for (const [id, name] of [[ASH, "Ash"], [BIRCH, "Birch"], [CEDAR, "Cedar"], [DEE, "Dee"], [ELM, "Elm"]] as const) await person(pg, id, name);
        // Ash: one family, chosen; a session still choosing; and a change asked in that family, under that row.
        const ashRow = await row(pg, ASH, "F1", { source: "P1" });
        await session(pg, "ash-in-f1", ASH, "F1");
        await session(pg, "ash-choosing", ASH, null);
        changes.fromRow = await change(pg, "fromrow", { parentId: ASH, guardianId: ashRow, familyQboId: "F1" });
        // Birch: two families (a row made by hand in one), a session in each; a used change in a family Birch was never
        // in, and a live one with no row named (as an older writer left it), found by Birch's open row in its family.
        await row(pg, BIRCH, "F1");
        await row(pg, BIRCH, "F2", { source: "P2" });
        await session(pg, "birch-in-f1", BIRCH, "F1");
        await session(pg, "birch-in-f2", BIRCH, "F2");
        changes.usedElsewhere = await change(pg, "usedelsewhere", { parentId: BIRCH, guardianId: null, familyQboId: "F-GONE", usedAt: new Date(Date.now() - 3_600_000) });
        changes.fromOpenRow = await change(pg, "fromopenrow", { parentId: BIRCH, guardianId: null, familyQboId: "F2" });
        // Cedar: a row that has closed since the session chose it, and another open row, so the gate keeps Cedar.
        await row(pg, CEDAR, "F2", { status: "disabled", source: "P2" });
        await row(pg, CEDAR, "F1");
        await session(pg, "cedar-row-closed", CEDAR, "F2");
        // Dee: a session in a family Dee has no row in, and a live change asked there, which can't be carried.
        await row(pg, DEE, "F1");
        await session(pg, "dee-family-unknown", DEE, "F-NOBODY");
        changes.liveNowhere = await change(pg, "livenowhere", { parentId: DEE, guardianId: null, familyQboId: "F-NOBODY" });
        // Elm: an unused change that has expired, in a family Elm has no row in.
        await row(pg, ELM, "F2");
        changes.expiredNowhere = await change(pg, "expirednowhere", { parentId: ELM, guardianId: null, familyQboId: "F-NOBODY", expiresAt: new Date(Date.now() - 3_600_000) });
      });
      // Migration 0023 gives every guardian row its family record, as on the proof-of-concept host; 0024 to 0036 follow.
      await company.migrate(migrationsUpTo(36));
      await company.q(async (pg) => {
        sessionsBefore = [...await pg`SELECT * FROM parent_auth_session ORDER BY id COLLATE "C"`];
        changesBefore = [...await pg`SELECT * FROM parent_email_change ORDER BY id`];
      });
    }, DATABASE_WORK);

    it("stops, and changes nothing, on an open guardian row with no family record", async () => {
      // Made after 0023 and never brought into step: its person could never choose it again.
      await company.q(async (pg) => {
        await person(pg, FAY, "Fay");
        await row(pg, FAY, "F-NOBODY");
      });
      const message = await failureOf(company.migrate(path.resolve("drizzle")));
      expect(message).toMatch(/Migration 0037 stopped, and changed nothing: 1 open guardian rows of 1 people name no family record, while the roster names company 4650000000000001/);
      expect(await columnsOf(company, "parent_auth_session")).toContain("family_qbo_id");
      expect(await columnsOf(company, "parent_auth_session")).not.toContain("family_id");
      expect(await columnsOf(company, "parent_email_change")).not.toContain("family_id");
      await company.q(async (pg) => {
        expect([...await pg`SELECT * FROM parent_auth_session ORDER BY id COLLATE "C"`]).toEqual(sessionsBefore);
        expect([...await pg`SELECT * FROM parent_email_change ORDER BY id`]).toEqual(changesBefore);
        expect(await pg`SELECT id FROM audit_log WHERE action = 'parent.session.carried_over'`).toHaveLength(0);
        await pg`DELETE FROM guardian WHERE parent_id = ${FAY}`;
        await pg`DELETE FROM parent_auth_user WHERE parent_id = ${FAY}`;
        await pg`DELETE FROM parent WHERE id = ${FAY}`;
      });
    });

    describe("once every open row has its family record", () => {
      /** The customer each session's family record is linked to, by session. */
      let familyOf = new Map<string, string | null>();
      beforeAll(async () => {
        await company.migrate(path.resolve("drizzle"));
        familyOf = new Map((await company.q((pg) => pg`SELECT s.id, l.customer_id FROM parent_auth_session s
          LEFT JOIN accounting_link l ON l.family_id = s.family_id AND l.system = 'quickbooks' AND l.realm_id = ${REALM}`)).map((r) => [r.id as string, (r.customer_id as string | null) ?? null]));
      });

      it("gives each session the family record of its person's open row in the family it chose, and the same people reach the same families", async () => {
        expect(familyOf.get("ash-in-f1")).toBe("F1");
        expect(familyOf.get("birch-in-f1")).toBe("F1");
        expect(familyOf.get("birch-in-f2")).toBe("F2");
        // For every session that chose a family and was carried: the record of the customer it named before, and the
        // family of an open row of its own person, which is what the gate lets it into.
        const carried = await company.q((pg) => pg`SELECT s.id, s.family_id, g.id AS row FROM parent_auth_session s
          JOIN parent_auth_user u ON u.id = s.user_id
          LEFT JOIN guardian g ON g.parent_id = u.parent_id AND g.family_id = s.family_id AND g.status <> 'disabled'
          WHERE s.family_id IS NOT NULL ORDER BY s.id COLLATE "C"`);
        expect(carried.map((s) => s.id)).toEqual(["ash-in-f1", "birch-in-f1", "birch-in-f2"]);
        for (const s of carried) {
          expect(s.row, String(s.id)).not.toBeNull();
          expect(familyOf.get(s.id as string)).toBe(sessionsBefore.find((b) => b.id === s.id)!.family_qbo_id);
        }
      });

      it("clears the family of a session that can't be carried, whatever the reason, deletes no session, and leaves one still choosing as it was", async () => {
        // Its row closed; a family its person has no row in; and one that hadn't chosen.
        for (const id of ["cedar-row-closed", "dee-family-unknown", "ash-choosing"]) expect(familyOf.get(id), id).toBeNull();
        const after = await company.q(async (pg) => [...await pg`SELECT * FROM parent_auth_session ORDER BY id COLLATE "C"`]);
        expect(after.map((s) => s.id)).toEqual(sessionsBefore.map((s) => s.id));
        for (const s of after) expect(kept(s), String(s.id)).toEqual(kept(sessionsBefore.find((b) => b.id === s.id)!));
      });

      it("carries an email change from its own guardian row or its person's open row, deletes a live one it can't carry, and keeps a used or expired one with none", async () => {
        const rows = new Map((await company.q(async (pg) => [...await pg`SELECT * FROM parent_email_change`])).map((r) => [r.id as string, r]));
        const familyRecord = async (customer: string) => (await company.q((pg) => pg`SELECT family_id FROM accounting_link WHERE customer_id = ${customer} AND family_id IS NOT NULL AND realm_id = ${REALM}`))[0]!.family_id;
        expect(rows.get(changes.fromRow!)).toMatchObject({ family_id: await familyRecord("F1"), record_qbo_id: "P1" });
        expect(rows.get(changes.fromOpenRow!)).toMatchObject({ family_id: await familyRecord("F2"), record_qbo_id: "P1" });
        expect(rows.has(changes.liveNowhere!)).toBe(false);
        expect(rows.get(changes.usedElsewhere!)).toMatchObject({ family_id: null });
        expect(rows.get(changes.expiredNowhere!)).toMatchObject({ family_id: null });
        // Everything else of each request is kept exactly.
        for (const [id, r] of rows) expect(kept(r), id).toEqual(kept(changesBefore.find((b) => b.id === id)!));
      });

      it("writes one audit row with the counts", async () => {
        const rows = await company.q((pg) => pg`SELECT door, actor_label, target_type, after FROM audit_log WHERE action = 'parent.session.carried_over'`);
        expect(rows).toEqual([{ door: "system", actor_label: "migration", target_type: "parent_auth_session", after: {
          cause: "migration 0037_sessions_app_ids_additive", realmId: REALM, sessionsCarried: 3, sessionsCleared: 2, emailChangesCarried: 2, emailChangesDeleted: 1 } }]);
      });

      it("drops both QuickBooks family columns, keeps the record's, and holds each to its family record by a foreign key", async () => {
        const sessionColumns = await columnsOf(company, "parent_auth_session"), changeColumns = await columnsOf(company, "parent_email_change");
        expect(sessionColumns).toContain("family_id");
        expect(sessionColumns).not.toContain("family_qbo_id");
        expect(changeColumns).toEqual(expect.arrayContaining(["family_id", "guardian_id", "record_qbo_id"]));
        expect(changeColumns).not.toContain("family_qbo_id");
        const indexes = await company.q(async (pg) => (await pg`SELECT indexname FROM pg_indexes WHERE tablename IN ('parent_auth_session', 'parent_email_change')`).map((i) => i.indexname as string).sort());
        expect(indexes).toEqual(expect.arrayContaining(["parent_auth_session_family_ix", "parent_email_change_family_ix"]));
        await expect(company.q((pg) => pg`INSERT INTO parent_auth_session (id, expires_at, token, user_id, family_id)
          VALUES ('no-such-family', now() + interval '1 day', 'token-no-such-family', ${`user-${ASH}`}, ${NOBODY})`)).rejects.toThrow(/parent_auth_session_family_id_family_id_fk/);
        await expect(company.q((pg) => pg`INSERT INTO parent_email_change (parent_id, family_id, new_email, token_hash, expires_at, used_at)
          VALUES (${ASH}, ${NOBODY}, 'x@sessions.example', ${"f".repeat(64)}, now(), now())`)).rejects.toThrow(/parent_email_change_family_id_family_id_fk/);
        // A family a session or a request names can't be deleted from under it: a change of company deletes them first.
        // Each on a family record nothing else names, so the key that stops the delete is that one.
        const held = async () => (await company.q((pg) => pg`INSERT INTO family (name, active) VALUES ('Held', true) RETURNING id`))[0]!.id as string;
        const bySession = await held(), byChange = await held();
        await company.q((pg) => pg`INSERT INTO parent_auth_session (id, expires_at, token, user_id, family_id)
          VALUES ('holds-a-family', now() + interval '1 day', 'token-holds-a-family', ${`user-${ASH}`}, ${bySession})`);
        await company.q((pg) => pg`INSERT INTO parent_email_change (parent_id, family_id, new_email, token_hash, expires_at, used_at)
          VALUES (${ASH}, ${byChange}, 'held@sessions.example', ${"e".repeat(64)}, now(), now())`);
        await expect(company.q((pg) => pg`DELETE FROM family WHERE id = ${bySession}`)).rejects.toThrow(/parent_auth_session_family_id_family_id_fk/);
        await expect(company.q((pg) => pg`DELETE FROM family WHERE id = ${byChange}`)).rejects.toThrow(/parent_email_change_family_id_family_id_fk/);
      });
    });
  });

  describe("while the roster names no company", () => {
    beforeAll(async () => {
      await makeScratchDatabase("migrate_bare");
      await bare.migrate(migrationsUpTo(22));
      await bare.q(async (pg) => {
        // A guardian signed in to a family before any roster company was recorded: 0023 makes no record, so the row
        // names none, and that is no refusal (nobody can enter a family until there are records).
        await person(pg, GUS, "Gus");
        const gusRow = await row(pg, GUS, "F1");
        await session(pg, "gus-row-names-no-family", GUS, "F1");
        changes.bare = await change(pg, "bare", { parentId: GUS, guardianId: gusRow, familyQboId: "F1" });
      });
      await bare.migrate(path.resolve("drizzle"));
    }, DATABASE_WORK);

    it("clears the family of a session whose row names no family record, deletes its live email change, and says so", async () => {
      expect(await bare.q((pg) => pg`SELECT id, family_id FROM parent_auth_session`)).toEqual([{ id: "gus-row-names-no-family", family_id: null }]);
      expect(await bare.q((pg) => pg`SELECT id FROM parent_email_change`)).toEqual([]);
      const rows = await bare.q((pg) => pg`SELECT after FROM audit_log WHERE action = 'parent.session.carried_over'`);
      expect(rows).toEqual([{ after: { cause: "migration 0037_sessions_app_ids_additive", realmId: null, sessionsCarried: 0, sessionsCleared: 1, emailChangesCarried: 0, emailChangesDeleted: 1 } }]);
      expect(await columnsOf(bare, "parent_auth_session")).not.toContain("family_qbo_id");
    });
  });
});
