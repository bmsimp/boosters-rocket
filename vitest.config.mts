import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { WORKERS_ENV, testWorkers } from "./tests/setup/workers.mjs";

/**
 * How many test files run at once: BR_TEST_WORKERS, or half the cores up to 6 (tests/setup/workers.mjs). With 1 the
 * files run one after another on the run's database, with the configuration the suite had before it had workers.
 */
const workers = testWorkers(process.env[WORKERS_ENV], availableParallelism());

/** Packages most test files load, bundled once for a parallel run (deps.optimizer, below). */
const HEAVY_PACKAGES = ["@peculiar/x509", "drizzle-orm", "drizzle-orm/pg-core", "drizzle-orm/postgres-js", "zod"];

const UNIT = ["tests/unit/**/*.test.ts"], INTEGRATION = ["tests/integration/**/*.test.ts"];

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/setup/empty.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["tests/setup/global-setup.ts"],
    // Hooks reset the database and close servers; on a loaded machine that has taken longer than the 10-second default.
    hookTimeout: 30_000,
    env: {
      // Values here override the shell, so a run is pointed at a private database with TEST_DATABASE_URL, not DATABASE_URL.
      // tests/setup/global-setup.ts checks the name, refuses this shared default in a git worktree, and migrates this same
      // database. The default is also DEFAULT_TEST_DATABASE_URL in tests/setup/database-url.ts: change them together.
      DATABASE_URL: process.env.TEST_DATABASE_URL || "postgres://booster:booster@localhost:5433/booster_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-32",
      SETTINGS_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      APP_URL: "http://localhost:3000",
    },
    ...(workers === 1
      ? { include: [...UNIT, ...INTEGRATION], fileParallelism: false }
      : {
        // Both kinds of file share the workers. vitest numbers the workers running at one time from 1 (VITEST_POOL_ID),
        // and an integration file takes its database from that number before it loads: the run's own for worker 1, a
        // database made for the worker for any other (tests/setup/worker.ts). A unit file has no database at all.
        maxWorkers: workers,
        // Several files at once on a machine other runs share: a test that takes under a second alone has taken five
        // here. A test that truly hangs still fails, a little later.
        testTimeout: 20_000,
        // Every test file is a new process that loads the app's packages again. These are hundreds of small files each,
        // which took about two seconds a file here; vite bundles each into one file once (node_modules/.vite) and every
        // test file loads that. Delete this line and the tests load the packages as they are, as one worker does.
        deps: { optimizer: { ssr: { enabled: true, include: HEAVY_PACKAGES } } },
        projects: [
          { extends: true, test: { name: "unit", include: UNIT, setupFiles: ["tests/setup/no-database.ts"] } },
          { extends: true, test: { name: "integration", include: INTEGRATION, setupFiles: ["tests/setup/worker.ts"] } },
        ],
      }),
  },
});
