import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:3100" },
  webServer: { command: "pnpm start -p 3100", url: "http://localhost:3100/sign-in", reuseExistingServer: !process.env.CI, timeout: 60_000 },
  projects: [{ name: "phone", use: { viewport: { width: 390, height: 844 } } }, { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }],
});
