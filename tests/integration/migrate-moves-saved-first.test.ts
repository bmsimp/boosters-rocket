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
 * Migration 0042 (stage 3's slice 9f): no schema change, one check. A move is saved in the portal first since this
 * slice, its follow-ups run once at that save, so a move queued before it (whose follow-ups would run when QuickBooks
 * answers) must be cleared first: the update refuses, in words and with the count, changing nothing, while a move of
 * the roster's company is waiting or stuck. A rename, a create, a make-inactive, a buy-out's void, a move done or given
 * up, and another company's move don't count.
 */
// Making or dropping a database waits for Postgres to write out what every database on the server has changed: that
// has taken two minutes.
const DATABASE_WORK = 300_000;
const { name: NAME, url: DB_URL } = scratchDatabase("migrate_moves");
const folders: string[] = [];

/** The migrations folder as it was up to `last` (by index): these tests run up to 0042, since a later migration is its own test's. */
function migrationsUpTo(last: number): string {
  const folder = mkdtempSync(path.join(tmpdir(), "br-migrate-moves-"));
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

const applied = () => q(async (pg) => Number((await pg`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)[0]!.n));
const queue = () => q(async (pg) => [...await pg`SELECT * FROM write_queue ORDER BY id`]);
const queueItem = (state: string, request: Record<string, unknown>, target: string | null, realm = "R1") =>
  q(async (pg) => (await pg`INSERT INTO write_queue (realm_id, request, target_qbo_id, state, sent) VALUES (${realm}, ${pg.json(request as never)}, ${target}, ${state}, false) RETURNING id`)[0]!.id as string);
const removeItem = (id: string) => q((pg) => pg`DELETE FROM write_queue WHERE id = ${id}`);
const MOVE = { op: "move", role: "student", qboId: "C2", syncToken: "3", fromFamilyQboId: "C1", toFamilyQboId: "C9" };
/** The items 0042 lets through, each a kind its refusal must not count; they stay on the queue through every test here. */
const PASSING: [string, Record<string, unknown>, string | null, string?][] = [
  ["waiting", { op: "rename", role: "student", qboId: "C2", syncToken: "3", name: "Ari B. Ash", was: "Ari Ash" }, "C2"],
  ["stuck", { op: "create", role: "family", name: "Elm Family", typeQboId: "T1", familyQboId: null, email: null }, null],
  ["waiting", { op: "deactivate", role: "student", qboId: "C2", syncToken: "3" }, "C2"],
  ["waiting", { op: "invoice_void", buyoutId: "00000000-0000-4000-8000-000000000001", invoiceQboId: "9174", customerQboId: "C2", why: "student_moved" }, null],
  ["done", MOVE, "C2"],
  ["given_up", MOVE, "C2"],
  ["waiting", MOVE, "C2", "R2"],
];

describe("migration 0042: a move is saved in the portal first", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await makeScratchDatabase("migrate_moves"); // marked as this run's: a database of that name the run didn't make is refused
    await migrateWith(migrationsUpTo(41));
    await q((pg) => pg`INSERT INTO setting (key, value) VALUES ('roster.source', ${pg.json({ realmId: "R1" })})`);
    // The kinds 0042's refusal doesn't count go in one at a time, in an order no unique index cares about.
    for (const [state, request, target, realm] of PASSING) await queueItem(state, request, target, realm);
  }, DATABASE_WORK);

  afterAll(async () => {
    await dropScratchDatabase(NAME);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, DATABASE_WORK);

  it("refuses, changing nothing, while a move of the roster's company is waiting or stuck, and says how many", async () => {
    const held = await queue();
    const appliedBefore = await applied();
    const refusedWith = async (count: number) => {
      const failure = await failureOf(migrateWith(migrationsUpTo(42)));
      expect(saidBy(failure)).toContain(`Migration 0042 stopped, and changed nothing: ${count} staff move(s) of a student are still waiting or stuck on the queue.`);
      expect(saidBy(failure)).toContain(`Clear them on the Reconciliation page, with "Try again now" or "Give up", then update again.`);
      // The database is exactly at the one before: 0041 applied, 0042 not.
      expect(await applied()).toBe(appliedBefore);
    };
    const waiting = await queueItem("waiting", MOVE, "C2");
    await refusedWith(1);
    await removeItem(waiting);
    const stuck = await queueItem("stuck", MOVE, "C2");
    await refusedWith(1);
    const second = await queueItem("waiting", { ...MOVE, toFamilyQboId: "C1", fromFamilyQboId: "C9" }, "C2");
    await refusedWith(2);
    await removeItem(stuck);
    await removeItem(second);
    expect(await queue()).toEqual(held);
  });

  it("goes through with every other kind on the queue, changing no row", async () => {
    const held = await queue();
    const appliedBefore = await applied();
    await migrateWith(migrationsUpTo(42));
    expect(await applied()).toBe(appliedBefore + 1);
    expect(await queue()).toEqual(held);
    expect(held.map((r) => r.state as string).sort()).toEqual(PASSING.map(([state]) => state).sort());
  });

  it("lets a fresh database through with no roster company, whatever its queue holds", async () => {
    // With no `roster.source` nothing counts: the check names no company to count moves of.
    await q((pg) => pg`DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`);
    await q((pg) => pg`DELETE FROM setting WHERE key = 'roster.source'`);
    const waiting = await queueItem("waiting", MOVE, "C2");
    await migrateWith(migrationsUpTo(42));
    await removeItem(waiting);
  });
});
