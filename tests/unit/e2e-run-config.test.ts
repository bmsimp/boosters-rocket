import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_TEST_DATABASE_URL } from "../setup/database-url";
import { assertAppUrlIsThisRun, assertE2eDatabase, e2eBaseUrl, e2eMailPort, e2ePort } from "../e2e/run-config";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const CI = { DATABASE_URL: DEFAULT_TEST_DATABASE_URL, APP_URL: "http://localhost:3100" };

describe("the ports of a browser-test run", () => {
  it("are the ones CI uses when nothing is set", () => {
    expect([e2ePort({}), e2eMailPort({}), e2eBaseUrl({})]).toEqual([3100, 2465, "http://localhost:3100"]);
    expect([e2ePort({ E2E_PORT: "" }), e2eMailPort({ E2E_MAIL_PORT: " " })]).toEqual([3100, 2465]);
    expect(() => assertAppUrlIsThisRun(CI)).not.toThrow();
  });

  it("the CI workflow sets neither port and names the default address", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/E2E_(MAIL_)?PORT/);
    expect(ci).toContain(`APP_URL: ${e2eBaseUrl({})}`);
  });

  it("come from E2E_PORT and E2E_MAIL_PORT, so a second tree runs beside the first", () => {
    const env = { E2E_PORT: "3190", E2E_MAIL_PORT: "2590", APP_URL: "http://localhost:3190/" };
    expect([e2ePort(env), e2eMailPort(env), e2eBaseUrl(env)]).toEqual([3190, 2590, "http://localhost:3190"]);
    expect(() => assertAppUrlIsThisRun(env)).not.toThrow();
  });

  it.each(["80", "0", "65536", "3100x", "-1", "3e3", "31 00"])("refuses the port %j", (port) => {
    expect(() => e2ePort({ E2E_PORT: port })).toThrow(/refuse to run: E2E_PORT must be a port number/);
    expect(() => e2eMailPort({ E2E_MAIL_PORT: port })).toThrow(/refuse to run: E2E_MAIL_PORT must be a port number/);
  });

  it("refuses an APP_URL that is another run's address, or none: the app sends its redirects there", () => {
    expect(() => assertAppUrlIsThisRun({ E2E_PORT: "3190", APP_URL: "http://localhost:3100" })).toThrow(/APP_URL must be http:\/\/localhost:3190/);
    expect(() => assertAppUrlIsThisRun({ APP_URL: "http://localhost:3190" })).toThrow(/APP_URL must be http:\/\/localhost:3100/);
    expect(() => assertAppUrlIsThisRun({})).toThrow(/APP_URL must be http:\/\/localhost:3100/);
  });

  it("refuses one port for both the app and the mail sink", () => {
    expect(() => assertAppUrlIsThisRun({ E2E_PORT: "3190", E2E_MAIL_PORT: "3190", APP_URL: "http://localhost:3190" })).toThrow(/are both 3190/);
  });
});

describe("the database of a browser-test run", () => {
  const MAIN = "G:/booster-rocket", WORKTREE = "G:/booster-rocket/.worktrees/invoices";
  const at = (name: string) => `postgres://someone:s3cret@db.example:6000/${name}`;

  it("is the shared one in the main tree, as in CI", () => {
    expect(() => assertE2eDatabase(DEFAULT_TEST_DATABASE_URL, MAIN, false)).not.toThrow();
  });

  it.each([
    ["a folder under .worktrees/", WORKTREE, false],
    ["a worktree kept somewhere else, known by its .git file", "C:/work/booster-invoices", true],
  ])("is never the shared one in %s", (_what, root, gitIsFile) => {
    const run = () => assertE2eDatabase(at("booster_test"), root, gitIsFile);
    expect(run).toThrow(/is a git worktree, and this run would use "booster_test", the test database every tree shares/);
    expect(run).toThrow(/take their database from DATABASE_URL, not TEST_DATABASE_URL/);
    expect(run).not.toThrow(/s3cret/);
    expect(() => assertE2eDatabase(at("booster_invoices_test"), root, gitIsFile)).not.toThrow();
  });

  it.each(["booster", "booster_test_copy", ""])("is never %j, in any tree", (name) => {
    for (const root of [MAIN, WORKTREE]) {
      expect(() => assertE2eDatabase(at(name), root, false)).toThrow(/refuse to run/);
      expect(() => assertE2eDatabase(at(name), root, false)).not.toThrow(/s3cret/);
    }
  });

  it("is checked by the seed before it migrates or writes, and by the Playwright config before a server starts", () => {
    const seed = read("scripts/seed-e2e.ts"), config = read("playwright.config.ts");
    const main = seed.slice(seed.indexOf("async function main()"));
    expect(main.indexOf("testDatabaseUrl()")).toBeGreaterThan(-1);
    expect(main.indexOf("testDatabaseUrl()")).toBeLessThan(main.indexOf("runMigrations("));
    expect(main.indexOf("runMigrations(")).toBeLessThan(main.indexOf("postgres("));
    expect(seed).toMatch(/function testDatabaseUrl\(\): string \{\s+const url = process\.env\.DATABASE_URL \?\? "";\s+try \{ assertE2eDatabase\(url\); \}/);
    expect(config.indexOf('assertE2eDatabase(process.env.DATABASE_URL ?? "");')).toBeGreaterThan(-1);
    expect(config.indexOf("assertE2eDatabase(")).toBeLessThan(config.indexOf("defineConfig({"));
    expect(config.indexOf("assertAppUrlIsThisRun();")).toBeLessThan(config.indexOf("defineConfig({"));
  });

  it("no browser test or helper names a port or an address of its own", () => {
    const files = readdirSync(path.resolve(__dirname, "../e2e")).filter((f) => f !== "run-config.ts").map((f) => `tests/e2e/${f}`);
    expect(files.length).toBeGreaterThan(8);
    for (const file of ["playwright.config.ts", "scripts/seed-e2e.ts", ...files]) expect(read(file), file).not.toMatch(/3100|2465|localhost:\d/);
  });
});
