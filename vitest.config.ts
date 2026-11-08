import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://booster:booster@localhost:5433/booster_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-32",
      APP_URL: "http://localhost:3000",
    },
    fileParallelism: false,
  },
});
