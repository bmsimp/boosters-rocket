import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_TEST_DATABASE_URL, NO_DATABASE_URL, PRIVATE_DATABASE_RECIPE, SCRATCH_PURPOSES, adminDatabaseUrl, assertOwnDatabaseInWorktree, assertTestDatabase, scratchDatabase, workerDatabase } from "../setup/database-url";
import { MOST_BY_DEFAULT, MOST_WORKERS, WORKERS_ENV, testWorkers } from "../setup/workers.mjs";
import { parseEnv } from "@/env";

const at = (name: string) => `postgres://someone:s3cret@db.example:6000/${name}`;

describe("the test database address", () => {
  // With one worker the files run one at a time, as they always did, and every file has the run's database.
  const oneWorker = testWorkers(process.env[WORKERS_ENV], 12) === 1 && process.env.VITEST_POOL_ID === "1";

  it("gives a unit test no database when the files run in parallel, and the run's own when they run one at a time", () => {
    const runs = process.env.TEST_DATABASE_URL || "postgres://booster:booster@localhost:5433/booster_test";
    if (process.env.DATABASE_URL !== NO_DATABASE_URL) expect(oneWorker).toBe(true);
    expect(process.env.DATABASE_URL).toBe(oneWorker ? runs : NO_DATABASE_URL);
  });

  it("gives a unit test an address the app's own check of its environment accepts, on a port nothing listens on", () => {
    expect(parseEnv({ ...process.env, DATABASE_URL: NO_DATABASE_URL }).DATABASE_URL).toBe(NO_DATABASE_URL);
    expect(new URL(NO_DATABASE_URL).port).toBe("1");
    expect(() => assertTestDatabase(NO_DATABASE_URL)).toThrow(/refuse to run/); // and nothing would take it for a test database
  });

  it("puts the maintenance database on the same server with the same sign-in", () => {
    expect(adminDatabaseUrl(at("booster_test"))).toBe(at("postgres"));
  });

  it("names scratch databases after the run's database, so two runs never share one", () => {
    expect(scratchDatabase("migrate_script", at("booster_test"))).toEqual({ name: "booster_migrate_script_test", url: at("booster_migrate_script_test") });
    expect(scratchDatabase("migrate_script", at("booster_agent1_test")).name).toBe("booster_agent1_migrate_script_test");
  });

  it("gives the first worker the run's database and every other one named after it", () => {
    expect(workerDatabase(1, at("booster_test"))).toEqual({ name: "booster_test", url: at("booster_test") });
    expect(workerDatabase(2, at("booster_test"))).toEqual({ name: "booster_w2_test", url: at("booster_w2_test") });
    expect(workerDatabase(12, at("booster_agent1_test")).name).toBe("booster_agent1_w12_test");
    // Two runs never share a worker database, and a worker's name is never another worker's or a scratch database's.
    const names = ["booster_test", "booster_agent1_test"].flatMap((run) => [1, 2, 3].flatMap((n) => {
      const worker = workerDatabase(n, at(run));
      return [worker.name, ...SCRATCH_PURPOSES.map((purpose) => scratchDatabase(purpose, worker.url).name)];
    }));
    expect(new Set(names).size).toBe(names.length);
  });

  it("names a worker's scratch databases after the worker's database", () => {
    expect(scratchDatabase("restore", workerDatabase(3, at("booster_agent1_test")).url).name).toBe("booster_agent1_w3_restore_test");
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the worker number %j", (n) => {
    expect(() => workerDatabase(n, at("booster_test"))).toThrow(/a worker's number must be a whole number from 1/);
  });

  it("refuses a worker name Postgres would cut short, without echoing the address", () => {
    const run = () => workerDatabase(2, at(`${"a".repeat(57)}_test`));
    expect(run).toThrow(/Use a shorter test database name/);
    expect(run).not.toThrow(/s3cret/);
    expect(workerDatabase(1, at(`${"a".repeat(57)}_test`)).name).toHaveLength(62);
  });

  it.each(["booster", "booster_test_copy", "", "Booster_test", "booster-agent_test", 'x"; drop database booster; --_test', `${"a".repeat(60)}_test`])(
    "refuses the database name %j without echoing the address", (name) => {
      for (const f of [() => assertTestDatabase(at(name)), () => adminDatabaseUrl(at(name)), () => scratchDatabase("restore", at(name)), () => workerDatabase(2, at(name))]) {
        expect(f).toThrow(/refuse to run/);
        expect(f).not.toThrow(/s3cret/);
      }
    });

  it("refuses a scratch name Postgres would cut short", () => {
    expect(() => scratchDatabase("migrate_parents", at(`${"a".repeat(45)}_test`))).toThrow(/Use a shorter test database name/);
  });
});

// vitest.config.mts asks tests/setup/workers.mjs how many test files to run at once.
describe("the number of workers", () => {
  it("is half the cores when nothing is set, at least 1 and at most 6", () => {
    expect([1, 2, 3, 4, 8, 12, 16, 64].map((cores) => testWorkers(undefined, cores))).toEqual([1, 1, 1, 2, 4, 6, 6, 6]);
    expect(testWorkers("", 12)).toBe(6);
    expect(testWorkers("  ", 12)).toBe(6);
    expect(MOST_BY_DEFAULT).toBe(6);
  });

  it("is BR_TEST_WORKERS when that is set, whatever the machine", () => {
    expect(WORKERS_ENV).toBe("BR_TEST_WORKERS");
    expect([testWorkers("1", 12), testWorkers("4", 2), testWorkers(" 8 ", 12), testWorkers(String(MOST_WORKERS), 12)]).toEqual([1, 4, 8, MOST_WORKERS]);
  });

  it.each(["0", "-1", "1.5", "four", "1e1", "017", String(MOST_WORKERS + 1), "100"])("refuses %j, and says what it takes", (value) => {
    expect(() => testWorkers(value, 12)).toThrow(`${WORKERS_ENV} must be a whole number from 1 to ${MOST_WORKERS}`);
  });

  it("with one worker, vitest.config.mts runs the files one at a time and gives none of them a worker's database", () => {
    const config = readFileSync(path.resolve(__dirname, "../../vitest.config.mts"), "utf8");
    const serial = /\(workers === 1\s*\? \{([^}]*)\}/.exec(config)![1]!;
    const parallel = config.slice(config.indexOf(serial) + serial.length);
    expect(serial).toContain("fileParallelism: false");
    expect(serial).not.toMatch(/setupFiles|projects/);
    expect(parallel).toContain(`setupFiles: ["tests/setup/worker.ts"]`);
    expect(parallel).toContain(`setupFiles: ["tests/setup/no-database.ts"]`);
  });
});

// tests/setup/global-setup.ts asks this before it migrates anything, with the tree vitest runs in and the run's database.
describe("a run in a git worktree", () => {
  const MAIN = "G:/booster-rocket", WORKTREE = "G:/booster-rocket/.worktrees/invoices";
  const OWN = "postgres://booster:booster@localhost:5433/booster_invoices_test";

  it("knows the shared database by the address vitest.config.mts falls back to", () => {
    expect(DEFAULT_TEST_DATABASE_URL).toBe("postgres://booster:booster@localhost:5433/booster_test");
    const config = readFileSync(path.resolve(__dirname, "../../vitest.config.mts"), "utf8");
    expect(config).toContain(`DATABASE_URL: process.env.TEST_DATABASE_URL || "${DEFAULT_TEST_DATABASE_URL}"`);
  });

  it.each([
    ["a folder under .worktrees/", WORKTREE, false],
    ["the same folder as Windows writes it", "G:\\booster-rocket\\.worktrees\\invoices", false],
    ["a folder inside a worktree", `${WORKTREE}/tests`, false],
    ["a worktree kept somewhere else, known by its .git file", "C:/work/booster-invoices", true],
  ])("refuses the shared database in %s, and says how to make its own", (_what, root, gitIsFile) => {
    const run = () => assertOwnDatabaseInWorktree(root, DEFAULT_TEST_DATABASE_URL, gitIsFile);
    expect(run).toThrow(/The tests refuse to run: .* is a git worktree, and this run would use "booster_test", the test database every tree shares/);
    for (const line of PRIVATE_DATABASE_RECIPE) expect(run).toThrow(line);
  });

  it("refuses the shared database even when TEST_DATABASE_URL names it, whoever signs in", () => {
    expect(() => assertOwnDatabaseInWorktree(WORKTREE, at("booster_test"), false)).toThrow(/refuse to run/);
    expect(() => assertOwnDatabaseInWorktree(WORKTREE, at("booster_test"), false)).not.toThrow(/s3cret/);
  });

  it("runs in a worktree on a database of its own", () => {
    expect(() => assertOwnDatabaseInWorktree(WORKTREE, OWN, false)).not.toThrow();
    expect(() => assertOwnDatabaseInWorktree("C:/work/booster-invoices", OWN, true)).not.toThrow();
  });

  it("runs in the main tree on the shared database, with or without worktrees beside it", () => {
    expect(() => assertOwnDatabaseInWorktree(MAIN, DEFAULT_TEST_DATABASE_URL, false)).not.toThrow();
    expect(() => assertOwnDatabaseInWorktree("G:/.worktrees-old/booster-rocket", DEFAULT_TEST_DATABASE_URL, false)).not.toThrow();
  });

  it("tells a worktree from the main tree by what .git is, when it isn't told", () => {
    // git gives a linked worktree a file named .git that points at the main tree; the main tree has a folder.
    const dir = mkdtempSync(path.join(tmpdir(), "booster-tree-"));
    try {
      const linked = path.join(dir, "linked"), main = path.join(dir, "main"), bare = path.join(dir, "no-git");
      for (const tree of [linked, main, bare]) mkdirSync(tree);
      writeFileSync(path.join(linked, ".git"), "gitdir: /somewhere/.git/worktrees/linked\n");
      mkdirSync(path.join(main, ".git"));
      expect(() => assertOwnDatabaseInWorktree(linked, DEFAULT_TEST_DATABASE_URL)).toThrow(/is a git worktree/);
      expect(() => assertOwnDatabaseInWorktree(linked, OWN)).not.toThrow();
      expect(() => assertOwnDatabaseInWorktree(main, DEFAULT_TEST_DATABASE_URL)).not.toThrow();
      expect(() => assertOwnDatabaseInWorktree(bare, DEFAULT_TEST_DATABASE_URL)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("gives the recipe AGENTS.md gives, word for word", () => {
    const agents = readFileSync(path.resolve(__dirname, "../../AGENTS.md"), "utf8");
    for (const line of PRIVATE_DATABASE_RECIPE) expect(agents).toContain(`\`${line}\``);
  });
});
