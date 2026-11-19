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
 * Migration 0041 (stage 3's slice 9e): `accounting_link` gains `synced_token` and `synced_at`, the customer's version the
 * portal last aligned with, filled for each link of the roster's company from the roster cache's `sync_token`. It
 * refuses, in words and with the count, changing nothing, only while one of the changes the slice sends another way is
 * waiting or stuck on the queue for the roster's company: a rename of a family, member or student, or a student's
 * create. A move, a make-inactive, a Parent customer's change, a family's own create, a buy-out's invoice write, an
 * item done, given up or kept refused, and another company's item don't count.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_synced");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index). */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-synced-"));
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
  return failure!;
};
/** The database's own words, which drizzle carries as the error's cause. */
const saidBy = (e: Error) => `${e.message} ${(e as { cause?: { message?: string } }).cause?.message ?? ""}`;

const ids: Record<string, string> = {};
const columns = () => q(async (pg) => (await pg`SELECT column_name FROM information_schema.columns WHERE table_name = 'accounting_link' AND column_name IN ('synced_token', 'synced_at')`).length);
const applied = () => q(async (pg) => Number((await pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n));
/** Every row of the tables the migration must not change, and the links without their two new columns. */
const snapshot = () => q(async (pg) => ({
  links: [...await pg`SELECT id, system, realm_id, customer_id, family_id, student_id, guardian_id, origin, linked_at, linked_by, created_at, updated_at FROM accounting_link ORDER BY id`],
  families: [...await pg`SELECT * FROM family ORDER BY id`],
  students: [...await pg`SELECT * FROM student ORDER BY id`],
  customers: [...await pg`SELECT * FROM qbo_customer ORDER BY qbo_id COLLATE "C"`],
  queue: [...await pg`SELECT * FROM write_queue ORDER BY id`],
}));
const queueItem = (state: string, request: Record<string, unknown>, target: string | null, realm = "R1") =>
  q(async (pg) => (await pg`INSERT INTO write_queue (realm_id, request, target_qbo_id, state, sent) VALUES (${realm}, ${pg.json(request as never)}, ${target}, ${state}, false) RETURNING id`)[0]!.id as string);
/** The items 0041 lets through, each a kind its refusal must not count; they stay on the queue through every test here. */
const PASSING: [string, Record<string, unknown>, string | null, string?][] = [
  ["waiting", { op: "invoice_void", buyoutId: "00000000-0000-4000-8000-000000000001", invoiceQboId: "9174", customerQboId: "C1", why: "switched_back" }, null],
  ["waiting", { op: "deactivate", role: "student", qboId: "C2", syncToken: "3" }, "C2"],
  ["stuck", { op: "move", role: "student", qboId: "C2", syncToken: "3", fromFamilyQboId: "C1", toFamilyQboId: "C9" }, "C2"],
  ["waiting", { op: "rename", role: "parent", qboId: "C3", syncToken: "12", name: "Pat A. Ash", was: "Pat Ash" }, "C3"],
  ["stuck", { op: "create", role: "parent", name: "Lee Ash", typeQboId: "T3", familyQboId: "C1", email: "lee@synced.example" }, null],
  ["waiting", { op: "create", role: "family", name: "Elm Family", typeQboId: "T1", familyQboId: null, email: null }, null],
  ["done", { op: "rename", role: "student", qboId: "C2", syncToken: "3", name: "Ari B. Ash", was: "Ari Ash" }, "C2"],
  ["given_up", { op: "rename", role: "family", qboId: "C1", syncToken: "7", name: "Ash House", was: "Ash Family" }, "C1"],
  ["refused", { op: "rename", role: "family", qboId: "C1", syncToken: "7", name: "Ash Home", was: "Ash Family" }, "C1"],
  ["waiting", { op: "rename", role: "family", qboId: "C1", syncToken: "7", name: "Ash Elsewhere", was: "Ash Family" }, "C1", "R2"],
];
const removeItem = (id: string) => q((pg) => pg`DELETE FROM write_queue WHERE id = ${id}`);

describe("migration 0041: each link holds the version the portal last aligned with", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_synced"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(40));
    await q(async (pg) => {
      await pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: "R1" })})`;
      for (const [id, name, token, parent] of [["C1", "Ash Family", "7", null], ["C2", "Ari Ash", "3", "C1"], ["C3", "Pat Ash", "12", "C1"]] as const) {
        await pg`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, sync_token) VALUES (${id}, ${name}, true, ${parent}, ${token})`;
      }
      for (const n of ["ash", "birch", "cedar"]) ids[n] = (await pg`INSERT INTO family (name, active) VALUES (${`${n} Family`}, true) RETURNING id`)[0]!.id as string;
      ids.ari = (await pg`INSERT INTO student (family_id, name, active) VALUES (${ids.ash!}, 'Ari Ash', true) RETURNING id`)[0]!.id as string;
      ids.parent = (await pg`INSERT INTO parent (name, email) VALUES ('Pat Ash', 'pat@synced.example') RETURNING id`)[0]!.id as string;
      ids.guardian = (await pg`INSERT INTO guardian (family_qbo_id, family_id, parent_id, status) VALUES ('C1', ${ids.ash!}, ${ids.parent!}, 'active') RETURNING id`)[0]!.id as string;
      const link = async (key: string, realm: string, customer: string, record: { family?: string; student?: string; guardian?: string }) => {
        ids[key] = (await pg`INSERT INTO accounting_link (system, realm_id, customer_id, family_id, student_id, guardian_id, origin)
          VALUES ('quickbooks', ${realm}, ${customer}, ${record.family ?? null}, ${record.student ?? null}, ${record.guardian ?? null}, 'carried_over') RETURNING id`)[0]!.id as string;
      };
      await link("ashLink", "R1", "C1", { family: ids.ash! });
      await link("ariLink", "R1", "C2", { student: ids.ari! });
      await link("guardianLink", "R1", "C3", { guardian: ids.guardian! });
      await link("birchLink", "R1", "C9", { family: ids.birch! });   // a customer the cache doesn't hold
      await link("cedarLink", "R2", "C1", { family: ids.cedar! });   // another company's link to a customer of the same number
    });
    // On the queue, and not a change 0041's refusal counts: each kind of PASSING, kept through every test here.
    for (const [state, request, target, realm] of PASSING) await queueItem(state, request, target, realm);
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("refuses, changing nothing, while a rename of a family, member or student or a student's create is waiting or stuck for the roster's company, and says how many", async () => {
    const held = await snapshot();
    const appliedBefore = await applied();
    const refusedWith = async (count: number) => {
      const failure = await failureOf(migrateWith(path.resolve("drizzle")));
      expect(saidBy(failure)).toMatch(new RegExp(`Migration 0041 stopped, and changed nothing: ${count} staff change\\(s\\) to the roster are still waiting or stuck on the queue`));
      expect(saidBy(failure)).toMatch(/Clear them on the Reconciliation page, with "Try again now" or "Give up", then update again\./);
      expect(await columns()).toBe(0);
      expect(await applied()).toBe(appliedBefore);
    };
    const each = [
      () => queueItem("waiting", { op: "rename", role: "family", qboId: "C1", syncToken: "7", name: "Ash Household", was: "Ash Family" }, "C1"),
      () => queueItem("stuck", { op: "rename", role: "member", qboId: "C1", syncToken: "7", name: "Ash Household", was: "Ash Family" }, "C1"),
      () => queueItem("waiting", { op: "rename", role: "student", qboId: "C2", syncToken: "3", name: "Ari B. Ash", was: "Ari Ash" }, "C2"),
      () => queueItem("stuck", { op: "create", role: "student", name: "Bo Ash", typeQboId: "T2", familyQboId: "C1", email: null }, null),
    ];
    for (const make of each) {
      const id = await make();
      await refusedWith(1);
      await removeItem(id);
    }
    const all = [];
    for (const make of each) all.push(await make());
    await refusedWith(4);
    for (const id of all) await removeItem(id);
    expect(await snapshot()).toEqual(held);
  });

  it("goes through with every other kind on the queue: fills each link of the roster's company from the cache, and changes no other row", async () => {
    const held = await snapshot();
    const startedAt = Date.now();
    // Up to 0041: 0042 (stage 3's slice 9f) refuses while a move is waiting or stuck, as PASSING's stuck move is; that
    // refusal is 0042's own test's (migrate-moves-saved-first).
    await migrateWith(migrationsUpTo(41));
    expect(await snapshot()).toEqual(held);
    const tokens = await q((pg) => pg`SELECT id, synced_token, synced_at FROM accounting_link`);
    const of = (key: string) => tokens.find((t) => t.id === ids[key])!;
    expect(of("ashLink").synced_token).toBe("7");
    expect(of("ariLink").synced_token).toBe("3");
    expect(of("guardianLink").synced_token).toBe("12");
    for (const key of ["ashLink", "ariLink", "guardianLink"]) expect((of(key).synced_at as Date).getTime()).toBeGreaterThan(startedAt - 60_000);
    for (const key of ["birchLink", "cedarLink"]) {
      expect(of(key).synced_token).toBeNull();
      expect(of(key).synced_at).toBeNull();
    }
    // Every item it let through is on the queue as it was (the snapshot above holds each row whole).
    expect((await q((pg) => pg`SELECT state FROM write_queue`)).map((r) => r.state as string).sort()).toEqual(PASSING.map(([state]) => state).sort());
  });
});
