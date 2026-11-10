import { defineConfig } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm tsx tests/e2e/mail-sink-cert.ts && pnpm start -p 3100",
    url: "http://localhost:3100/sign-in", reuseExistingServer: false, timeout: 60_000,
    // NODE_EXTRA_CA_CERTS makes this e2e server trust the local mail sink's certificate. Only this file sets it.
    env: { ...(process.env as Record<string, string>), SETUP_STATUS_CACHE_MS: "0", NODE_EXTRA_CA_CERTS: path.resolve(".e2e/sink-cert.pem") },
  },
  projects: [{ name: "phone", use: { viewport: { width: 390, height: 844 } } }, { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }],
});
