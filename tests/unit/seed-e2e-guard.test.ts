import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

// Port 1 has nothing listening: if the guard let one of these through, the script would fail to connect (exit 1)
// rather than touch a database.
// (An address that isn't one at all never reaches the guard: the script's imports check the environment first.)
const run = (databaseUrl: string) => spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e.ts"], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl, SETTINGS_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" },
});

describe("scripts/seed-e2e.ts", { timeout: 60_000 }, () => {
  it.each([
    ["the site's own database", "postgres://booster:booster@127.0.0.1:1/booster"],
    ["a name that only contains test", "postgres://booster:booster@127.0.0.1:1/booster_test_copy"],
    ["no database name", "postgres://booster:booster@127.0.0.1:1/"],
  ])("refuses %s before connecting to anything", (_name, url) => {
    const r = run(url);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("seed-e2e refuses to run: DATABASE_URL names a database this script must not touch");
    expect(r.stderr).toContain('end in "_test"');
    expect(r.stderr).not.toContain("booster:booster"); // the address, with its password, is not echoed
  });

  // A name of its own, not booster_test: in a git worktree the shared database is refused too (tests/unit/e2e-run-config.test.ts).
  it("goes on to connect when the database name ends in _test", () => {
    const r = run("postgres://booster:booster@127.0.0.1:1/booster_seedguard_test");
    expect(r.status).toBe(1); // past the guard: it tried the database, and nothing listens on port 1
    expect(r.stderr).not.toContain("refuses to run");
  });
});
