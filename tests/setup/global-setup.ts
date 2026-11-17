import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/lib/db/migrate";
import { assertOwnDatabaseInWorktree, assertTestDatabase } from "./database-url";
import { assertNotAWorkerDatabase, dropWorkerDatabases, holdRunLock } from "./worker-databases";

declare module "vitest" {
  export interface ProvidedContext {
    /** A folder that lasts as long as the run: tests/setup/worker.ts notes there which worker databases are ready. */
    testRunFolder: string;
  }
}

/**
 * Once per run, before any test file: checks and migrates the run's database, the DATABASE_URL vitest.config.mts
 * names. It refuses a database not named for tests, the shared database when this tree is a git worktree, a database
 * that is another run's worker database, and a database another vitest run is using at this moment.
 *
 * Workers past the first make their own databases as they need them (tests/setup/worker.ts). When the run ends, this
 * drops them, with any scratch database a test made and left behind; one with a scratch name that this run didn't make
 * is left alone, and said so.
 */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL ?? "";
  assertTestDatabase(url);
  assertOwnDatabaseInWorktree(project.config.root, url);
  await assertNotAWorkerDatabase(url);
  const release = await holdRunLock(url);
  let folder = "";
  try {
    await runMigrations(url);
    folder = mkdtempSync(path.join(tmpdir(), "br-test-run-"));
    project.provide("testRunFolder", folder);
  } catch (e) { await release(); throw e; }
  return async () => {
    try {
      rmSync(folder, { recursive: true, force: true });
      const { leftAlone } = await dropWorkerDatabases(url);
      if (leftAlone.length > 0) {
        console.warn(`Left alone: ${leftAlone.join(", ")}. ${leftAlone.length === 1 ? "It has" : "They have"} the name of a scratch database this run's tests use, `
          + `but this run did not make ${leftAlone.length === 1 ? "it" : "them"} (no comment marks ${leftAlone.length === 1 ? "it" : "them"} as this run's), so ${leftAlone.length === 1 ? "it was" : "they were"} not dropped. `
          + `A test that needs one of these names refuses to run until it is gone.`);
      }
    } finally { await release(); }
  };
}
