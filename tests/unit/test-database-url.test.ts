import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_TEST_DATABASE_URL, PRIVATE_DATABASE_RECIPE, adminDatabaseUrl, assertOwnDatabaseInWorktree, assertTestDatabase, scratchDatabase } from "../setup/database-url";

const at = (name: string) => `postgres://someone:s3cret@db.example:6000/${name}`;

describe("the test database address", () => {
  it("gives this run the database vitest.config.mts chose", () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL || "postgres://booster:booster@localhost:5433/booster_test");
  });

  it("puts the maintenance database on the same server with the same sign-in", () => {
    expect(adminDatabaseUrl(at("booster_test"))).toBe(at("postgres"));
  });

  it("names scratch databases after the run's database, so two runs never share one", () => {
    expect(scratchDatabase("migrate_script", at("booster_test"))).toEqual({ name: "booster_migrate_script_test", url: at("booster_migrate_script_test") });
    expect(scratchDatabase("migrate_script", at("booster_agent1_test")).name).toBe("booster_agent1_migrate_script_test");
  });

  it.each(["booster", "booster_test_copy", "", "Booster_test", "booster-agent_test", 'x"; drop database booster; --_test', `${"a".repeat(60)}_test`])(
    "refuses the database name %j without echoing the address", (name) => {
      for (const f of [() => assertTestDatabase(at(name)), () => adminDatabaseUrl(at(name)), () => scratchDatabase("x", at(name))]) {
        expect(f).toThrow(/refuse to run/);
        expect(f).not.toThrow(/s3cret/);
      }
    });

  it("refuses a scratch name Postgres would cut short", () => {
    expect(() => scratchDatabase("x".repeat(40), at(`${"a".repeat(30)}_test`))).toThrow(/Use a shorter test database name/);
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
