/**
 * The databases a parallel vitest run makes for itself. Test files run in several workers at once, and every test
 * empties the tables, so each worker has a database of its own: worker 1 has the run's database, and worker N has
 * <run>_w<N>_test, made and migrated the first time a test file starts in that worker (tests/setup/worker.ts).
 *
 * A worker database carries a comment naming the run it belongs to. Nothing here empties, migrates or drops a
 * database that does not carry this run's comment: a database that happens to have a worker's name is refused, never
 * taken over. When the run ends, its worker databases are dropped, and so are the scratch databases its tests make. An
 * interrupted run leaves them behind; the next run on the same database uses them again if their migrations are the
 * ones in drizzle/, replaces them if not, and drops them when it ends.
 */

import postgres from "postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { runMigrations } from "../../src/lib/db/migrate";
import { SCRATCH_PURPOSES, adminDatabaseUrl, assertTestDatabase, databaseName, scratchDatabase, workerDatabase } from "./database-url";

const quiet = { max: 1, onnotice: () => {} } as const;
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** The comment on a worker database: which run it belongs to. */
export function workerMark(runUrl: string): string {
  return `booster-rocket tests: a worker database of "${databaseName(runUrl)}". A test run made it and drops it when it ends.`;
}
const MARK_OF_ANY_RUN = /^booster-rocket tests: a worker database of "([^"]+)"/;

type Sql = ReturnType<typeof postgres>;
async function withAdmin<T>(runUrl: string, work: (admin: Sql) => Promise<T>): Promise<T> {
  const admin = postgres(adminDatabaseUrl(runUrl), quiet);
  try { return await work(admin); } finally { await admin.end({ timeout: 5 }); }
}

async function commentOn(admin: Sql, name: string): Promise<{ exists: boolean; comment: string | null }> {
  const rows = await admin<{ comment: string | null }[]>`select shobj_description(oid, 'pg_database') as comment from pg_database where datname = ${name}`;
  return rows.length ? { exists: true, comment: rows[0]!.comment } : { exists: false, comment: null };
}

/**
 * Refuses a run whose own database is another run's worker database: TEST_DATABASE_URL names the run, and a worker
 * database is emptied and dropped by the run that made it.
 */
export async function assertNotAWorkerDatabase(runUrl: string): Promise<void> {
  assertTestDatabase(runUrl);
  const name = databaseName(runUrl);
  const { comment } = await withAdmin(runUrl, (admin) => commentOn(admin, name));
  const owner = MARK_OF_ANY_RUN.exec(comment ?? "")?.[1];
  if (owner) {
    throw new Error(`The tests refuse to run: "${name}" is a worker database of the test run on "${owner}", which empties it and drops it. Name a database of your own in TEST_DATABASE_URL.`);
  }
}

/**
 * One vitest run at a time on a database: two would empty each other's tables, and the second to end would drop the
 * first one's worker databases. The lock is held on a connection of its own until the run ends (or its process dies).
 */
export async function holdRunLock(runUrl: string): Promise<() => Promise<void>> {
  const name = databaseName(runUrl);
  const admin = postgres(adminDatabaseUrl(runUrl), quiet);
  try {
    const [row] = await admin<{ held: boolean }[]>`select pg_try_advisory_lock(hashtext(${`booster-rocket test run on ${name}`})) as held`;
    if (!row!.held) {
      throw new Error(`The tests refuse to run: another vitest run is using the test database "${name}" right now. Two runs on one database empty each other's tables. `
        + `Wait for it to end (or stop it), or give this run a database of its own in TEST_DATABASE_URL.`);
    }
  } catch (e) { await admin.end({ timeout: 5 }); throw e; }
  return () => admin.end({ timeout: 5 });
}

/** The hashes drizzle records for the migrations in drizzle/, oldest first. */
function migrationsInFolder(): string[] {
  return readMigrationFiles({ migrationsFolder: "drizzle" }).map((m) => m.hash);
}

type Standing = "missing" | "ready" | "behind" | "other";
/** How a worker database stands against drizzle/: migrated to the end, part of the way, or along some other path. */
async function standing(url: string, wanted: string[]): Promise<Standing> {
  const pg = postgres(url, quiet);
  try {
    const [has] = await pg<{ table: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations')::text as table`;
    const applied = has!.table ? (await pg<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations order by created_at, id`).map((r) => r.hash) : [];
    if (applied.length > wanted.length || applied.some((hash, i) => hash !== wanted[i])) return "other";
    return applied.length === wanted.length ? "ready" : "behind";
  } catch (e) {
    if ((e as { code?: string }).code === "3D000") return "missing"; // invalid_catalog_name: no such database
    throw e;
  } finally { await pg.end({ timeout: 5 }); }
}

async function create(admin: Sql, name: string, mark: string) {
  await admin.unsafe(`CREATE DATABASE ${ident(name)}`);
  await admin.unsafe(`COMMENT ON DATABASE ${ident(name)} IS ${literal(mark)}`);
}

/**
 * The database for one worker of this run, ready to use: worker 1 has the run's own (the global setup migrated it),
 * and any other has its own, made here if it is missing and replaced if an interrupted run left one whose migrations
 * are not the ones in drizzle/.
 */
export async function prepareWorkerDatabase(runUrl: string, poolId: number): Promise<string> {
  const { name, url } = workerDatabase(poolId, runUrl);
  if (url === runUrl) return url;
  const mark = workerMark(runUrl), wanted = migrationsInFolder();
  await withAdmin(runUrl, async (admin) => {
    // One at a time, should two files ever start in one worker together: the second waits and finds the database ready.
    await admin`select pg_advisory_lock(hashtext(${`booster-rocket worker database ${name}`}))`;
    const { exists, comment } = await commentOn(admin, name);
    if (exists && comment !== mark) {
      throw new Error(`The tests refuse to run: this run would use "${name}" for its worker ${poolId}, and a database of that name exists that this run did not make `
        + `(it does not carry the run's comment). The tests empty every table in a worker database. If nothing needs it, drop it: DROP DATABASE "${name}". `
        + `Or run with fewer workers (BR_TEST_WORKERS).`);
    }
    let stands: Standing = exists ? await standing(url, wanted) : "missing";
    if (stands === "ready") return;
    if (stands === "behind") {
      try { await runMigrations(url); return; } catch { stands = "other"; } // left half-made: make it again
    }
    if (stands === "other") await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
    await create(admin, name, mark);
    await runMigrations(url);
  });
  return url;
}

/**
 * Drops what this run made: the worker databases that carry its comment, and the scratch databases its tests make
 * (named after the run's database and each worker's, tests/setup/database-url.ts), with the worker databases a test
 * made for a scratch database of its own (tests/integration/worker-databases.test.ts). Returns the names it dropped.
 */
export async function dropWorkerDatabases(runUrl: string): Promise<string[]> {
  return withAdmin(runUrl, async (admin) => {
    const urlOf = (name: string) => { const u = new URL(runUrl); u.pathname = `/${name}`; return u.toString(); };
    const workersOf = async (urls: string[]) => {
      const marks = urls.map(workerMark);
      if (marks.length === 0) return [];
      return (await admin<{ name: string }[]>`select datname as name from pg_database where shobj_description(oid, 'pg_database') in ${admin(marks)} order by datname`).map((r) => r.name);
    };
    const workers = await workersOf([runUrl]);
    const scratch = [runUrl, ...workers.map(urlOf)].flatMap((url) => SCRATCH_PURPOSES.flatMap((purpose) => scratchNames(purpose, url)));
    const dropped: string[] = [];
    for (const name of [...await workersOf(scratch.map(urlOf)), ...scratch, ...workers]) {
      const [was] = await admin<{ n: number }[]>`select count(*)::int as n from pg_database where datname = ${name}`;
      if (!was!.n) continue;
      await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
      dropped.push(name);
    }
    return dropped;
  });
}

/** A scratch database's name, and the one scripts/restore.sh loads a dump into before it renames it in. */
function scratchNames(purpose: (typeof SCRATCH_PURPOSES)[number], url: string): string[] {
  try { const { name } = scratchDatabase(purpose, url); return [name, `${name}_restoring`]; } catch { return []; } // a name too long was never made
}
