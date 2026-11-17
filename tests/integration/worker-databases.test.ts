import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { adminDatabaseUrl, databaseName, scratchDatabase, workerDatabase } from "../setup/database-url";
import { assertNotAWorkerDatabase, dropScratchDatabase, dropWorkerDatabases, holdRunLock, makeScratchDatabase, prepareWorkerDatabase, scratchMark, workerMark } from "../setup/worker-databases";

/**
 * The databases a parallel run makes for its workers (tests/setup/worker-databases.ts), tried on a run of this test's
 * own: a pretend run whose database has a scratch name. That database is never made; only its workers' are, and they
 * are really created, migrated, replaced and dropped on the server this test file was given.
 */
const RUN = scratchDatabase("workers");
const W2 = workerDatabase(2, RUN.url), W3 = workerDatabase(3, RUN.url);
const SCRATCH_OF_W2 = scratchDatabase("migrate_script", W2.url);
/** Someone's own database that happens to have a name the pretend run's scratch databases have. */
const PRIVATE = scratchDatabase("restore", RUN.url);
const ANOTHER_RUNS_MARK = workerMark(RUN.url.replace(RUN.name, "someone_elses_test"));
const MINE = [W2.name, W3.name, SCRATCH_OF_W2.name, PRIVATE.name];

const admin = postgres(adminDatabaseUrl(), { max: 1, onnotice: () => {} });
const dropMine = async () => { for (const name of MINE) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); };
const exists = async (name: string) => (await admin`select 1 from pg_database where datname = ${name}`).length === 1;
const commentOn = async (name: string) => (await admin<{ c: string | null }[]>`select shobj_description(oid, 'pg_database') as c from pg_database where datname = ${name}`)[0]?.c ?? null;
const inside = async <T>(url: string, work: (pg: postgres.Sql) => Promise<T>) => {
  const pg = postgres(url, { max: 1, onnotice: () => {} });
  try { return await work(pg); } finally { await pg.end({ timeout: 5 }); }
};
const migratedToTheEnd = (url: string) => inside(url, async (pg) => {
  const [admins] = await pg<{ n: number }[]>`select count(*)::int as n from role where key = 'admin' and builtin`;
  const [newest] = await pg<{ n: number }[]>`select count(*)::int as n from information_schema.tables where table_schema = 'public'`;
  return admins!.n === 1 && newest!.n > 20;
});
const hasTable = (url: string, table: string) => inside(url, async (pg) => (await pg`select 1 from information_schema.tables where table_schema = 'public' and table_name = ${table}`).length === 1);

describe("a run's worker databases", { timeout: 300_000 }, () => {
  beforeAll(dropMine, 300_000);
  afterAll(async () => { await dropMine(); await admin.end({ timeout: 5 }); }, 300_000);

  it("gives worker 1 the run's own database and makes nothing for it", async () => {
    expect(await prepareWorkerDatabase(RUN.url, 1)).toBe(RUN.url);
    expect(await exists(RUN.name)).toBe(false);
  });

  it("makes another worker's database the first time it is asked for: migrated, and marked as this run's", async () => {
    expect(await exists(W2.name)).toBe(false);
    expect(await prepareWorkerDatabase(RUN.url, 2)).toBe(W2.url);
    expect(await migratedToTheEnd(W2.url)).toBe(true);
    expect(await commentOn(W2.name)).toBe(workerMark(RUN.url));
    expect(await commentOn(W2.name)).toContain(`"${RUN.name}"`);
  });

  it("uses a database an interrupted run left behind as it stands, when its migrations are the ones in drizzle/", async () => {
    await inside(W2.url, (pg) => pg`create table left_behind (id int)`);
    expect(await prepareWorkerDatabase(RUN.url, 2)).toBe(W2.url);
    expect(await hasTable(W2.url, "left_behind")).toBe(true); // the same database, not a new one
  });

  it("replaces a leftover whose migrations are not the ones in drizzle/", async () => {
    // As after a migration was generated again in this tree: the database holds one that drizzle/ no longer does.
    await inside(W2.url, (pg) => pg`update drizzle.__drizzle_migrations set hash = 'a migration this tree no longer has' where id = (select max(id) from drizzle.__drizzle_migrations)`);
    await prepareWorkerDatabase(RUN.url, 2);
    expect(await hasTable(W2.url, "left_behind")).toBe(false);
    expect(await migratedToTheEnd(W2.url)).toBe(true);
    expect(await commentOn(W2.name)).toBe(workerMark(RUN.url));
  });

  it("makes again a leftover that was cut off part of the way through its migrations", async () => {
    await inside(W2.url, async (pg) => {
      await pg`create table left_behind (id int)`;
      await pg`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`; // the tables say otherwise
    });
    await prepareWorkerDatabase(RUN.url, 2);
    expect(await hasTable(W2.url, "left_behind")).toBe(false);
    expect(await migratedToTheEnd(W2.url)).toBe(true);
  });

  it("migrates a leftover that was made and never migrated", async () => {
    await admin.unsafe(`DROP DATABASE "${W2.name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${W2.name}"`);
    await admin.unsafe(`COMMENT ON DATABASE "${W2.name}" IS '${workerMark(RUN.url).replaceAll("'", "''")}'`);
    await prepareWorkerDatabase(RUN.url, 2);
    expect(await migratedToTheEnd(W2.url)).toBe(true);
  });

  it.each([
    ["carries no comment", null],
    ["is another run's worker database", ANOTHER_RUNS_MARK],
  ])("refuses a database with a worker's name that %s, and leaves it as it is", async (_what, comment) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${W3.name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${W3.name}"`);
    if (comment) await admin.unsafe(`COMMENT ON DATABASE "${W3.name}" IS '${comment.replaceAll("'", "''")}'`);
    await inside(W3.url, (pg) => pg`create table someone_elses (id int)`);
    const asking = prepareWorkerDatabase(RUN.url, 3);
    await expect(asking).rejects.toThrow(`a database of that name exists that this run did not make`);
    await expect(asking).rejects.toThrow(`DROP DATABASE "${W3.name}"`);
    await expect(asking).rejects.not.toThrow(`:${new URL(RUN.url).password}@`); // the address, with its password, is not echoed
    expect(await hasTable(W3.url, "someone_elses")).toBe(true);
    expect(await hasTable(W3.url, "role")).toBe(false);
    expect(await commentOn(W3.name)).toBe(comment);
  });

  it("refuses to run on a database that is a run's worker database", async () => {
    await expect(assertNotAWorkerDatabase(W2.url)).rejects.toThrow(`"${W2.name}" is a worker database of the test run on "${RUN.name}"`);
    await expect(assertNotAWorkerDatabase(W3.url)).rejects.toThrow(/is a worker database of the test run on "someone_elses_test"/);
    await expect(assertNotAWorkerDatabase(RUN.url)).resolves.toBeUndefined(); // not made yet: the migration will say so
  });

  it("lets one run at a time use a database, and the next one in when it ends", async () => {
    const first = await holdRunLock(RUN.url);
    try {
      await expect(holdRunLock(RUN.url)).rejects.toThrow(`another vitest run is using the test database "${RUN.name}" right now`);
      const other = await holdRunLock(W2.url); // a run on another database is not in the way
      await other();
    } finally { await first(); }
    await (await holdRunLock(RUN.url))();
  });

  it("makes a scratch database marked as the run's, and refuses one of that name the run didn't make", async () => {
    // Made from worker 2's file, for the pretend run: named after worker 2's database, marked with the run's name.
    await makeScratchDatabase("migrate_script", { fileUrl: W2.url, runUrl: RUN.url });
    expect(await commentOn(SCRATCH_OF_W2.name)).toBe(scratchMark(RUN.url));
    await inside(SCRATCH_OF_W2.url, (pg) => pg`create table left_behind (id int)`);
    // One this run left is made again, empty.
    await makeScratchDatabase("migrate_script", { fileUrl: W2.url, runUrl: RUN.url });
    expect(await hasTable(SCRATCH_OF_W2.url, "left_behind")).toBe(false);
    // Someone's own database with a scratch name: refused, and left as it is, by the test that would make it and by a drop.
    await admin.unsafe(`CREATE DATABASE "${PRIVATE.name}"`);
    await inside(PRIVATE.url, (pg) => pg`create table someone_elses (id int)`);
    const making = makeScratchDatabase("restore", { fileUrl: RUN.url, runUrl: RUN.url });
    await expect(making).rejects.toThrow(`a database of that name exists that this run did not make`);
    await expect(making).rejects.toThrow(`DROP DATABASE "${PRIVATE.name}"`);
    expect(await dropScratchDatabase(PRIVATE.name, { runUrl: RUN.url })).toBe(false);
    expect(await hasTable(PRIVATE.url, "someone_elses")).toBe(true);
    await expect(assertNotAWorkerDatabase(SCRATCH_OF_W2.url)).rejects.toThrow(`"${SCRATCH_OF_W2.name}" is a scratch database of the test run on "${RUN.name}"`);
  });

  // The roadmap's known gap from step 4: the teardown dropped databases by their scratch names, whoever made them.
  it("when the run ends, drops its worker databases and the scratch databases its tests made, and leaves one of a scratch name it didn't make", async () => {
    const dropped = await dropWorkerDatabases(RUN.url);
    expect(dropped).toEqual({ dropped: [W2.name, SCRATCH_OF_W2.name].sort(), leftAlone: [PRIVATE.name] });
    expect(await exists(W2.name)).toBe(false);
    expect(await exists(SCRATCH_OF_W2.name)).toBe(false);
    expect(await exists(W3.name)).toBe(true); // another run's, by its comment, though it has this run's worker's name
    expect(await hasTable(PRIVATE.url, "someone_elses")).toBe(true); // a private database with a scratch purpose's name
    expect(await exists(databaseName(process.env.DATABASE_URL!))).toBe(true);
    expect(await dropWorkerDatabases(RUN.url)).toEqual({ dropped: [], leftAlone: [PRIVATE.name] });
  });
});
