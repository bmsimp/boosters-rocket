import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/lib/db/migrate";
import { assertOwnDatabaseInWorktree, assertTestDatabase } from "./database-url";
import { assertNotAWorkerDatabase, dropWorkerDatabases, holdRunLock } from "./worker-databases";

/**
 * Once per run, before any test file: checks and migrates the run's database, the DATABASE_URL vitest.config.mts
 * names. It refuses a database not named for tests, the shared database when this tree is a git worktree, a database
 * that is another run's worker database, and a database another vitest run is using at this moment.
 *
 * Workers past the first make their own databases as they need them (tests/setup/worker.ts). When the run ends, this
 * drops them, with any scratch database a test left behind.
 */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL ?? "";
  assertTestDatabase(url);
  assertOwnDatabaseInWorktree(project.config.root, url);
  await assertNotAWorkerDatabase(url);
  const release = await holdRunLock(url);
  try { await runMigrations(url); } catch (e) { await release(); throw e; }
  return async () => {
    try { await dropWorkerDatabases(url); } finally { await release(); }
  };
}
