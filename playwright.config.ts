import { defineConfig } from "@playwright/test";
import path from "node:path";
import { assertAppUrlIsThisRun, assertE2eDatabase, e2eBaseUrl, e2ePort } from "./tests/e2e/run-config";

// One run per tree: its own app port (E2E_PORT), mail sink port (E2E_MAIL_PORT) and, in a git worktree, its own database.
// Refused here, before a server starts, when the database is the shared one in a worktree or APP_URL is another run's.
assertE2eDatabase(process.env.DATABASE_URL ?? "");
assertAppUrlIsThisRun();
const baseURL = e2eBaseUrl();

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: { baseURL },
  webServer: {
    command: `pnpm tsx tests/e2e/mail-sink-cert.ts && pnpm start -p ${e2ePort()}`,
    url: `${baseURL}/sign-in`, reuseExistingServer: false, timeout: 60_000,
    // NODE_EXTRA_CA_CERTS makes this e2e server trust the local mail sink's certificate. Only this file sets it.
    // QBO_RELAY_URL names a port nothing listens on, so no browser test ever reaches Boosters Rocket Connect, the relay.
    env: { ...(process.env as Record<string, string>), SETUP_STATUS_CACHE_MS: "0", NODE_EXTRA_CA_CERTS: path.resolve(".e2e/sink-cert.pem"), QBO_RELAY_URL: "http://127.0.0.1:9" },
  },
  projects: [{ name: "phone", use: { viewport: { width: 390, height: 844 } } }, { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }],
});
