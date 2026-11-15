import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
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
    fileParallelism: false,
  },
});
