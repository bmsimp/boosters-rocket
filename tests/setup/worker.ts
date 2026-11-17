/**
 * Runs in a worker before each integration test file (vitest.config.mts, setupFiles), ahead of the file's own imports:
 * gives the file its worker's database in DATABASE_URL, making and migrating that database the first time the worker
 * needs it. Everything that reads the address afterwards (src/env.ts, the scratch-database helpers, the scripts a
 * test spawns with this process's environment) gets the worker's.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inject } from "vitest";
import { workerDatabase } from "./database-url";

/** vitest numbers the workers that are running at one time from 1 to the number of workers. */
function poolId(): number {
  const id = Number(process.env.VITEST_POOL_ID);
  if (!Number.isInteger(id) || id < 1) throw new Error(`The tests can't tell which worker this is: VITEST_POOL_ID is "${process.env.VITEST_POOL_ID ?? ""}".`);
  return id;
}

// The run's own address is kept, so running this twice in one process gives the same answer.
const runUrl = (process.env.BR_TEST_RUN_DATABASE_URL ??= process.env.DATABASE_URL ?? "");
const { name, url } = workerDatabase(poolId(), runUrl);
if (url !== runUrl) {
  // Each test file is a new process, so what this run has already made ready is noted in the run's own folder
  // (tests/setup/global-setup.ts): the first file in a worker checks the database, and the rest only look for the note.
  const ready = path.join(inject("testRunFolder"), `${name}.ready`);
  if (!existsSync(ready)) {
    const { prepareWorkerDatabase } = await import("./worker-databases"); // the database driver is loaded only when there is work for it
    await prepareWorkerDatabase(runUrl, poolId());
    writeFileSync(ready, "");
  }
}
process.env.DATABASE_URL = url;
