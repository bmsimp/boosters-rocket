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
    env: {
      DATABASE_URL: "postgres://booster:booster@localhost:5433/booster_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-32",
      SETTINGS_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      APP_URL: "http://localhost:3000",
    },
    fileParallelism: false,
  },
});
