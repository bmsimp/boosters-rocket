/**
 * Which database a vitest run uses, and the addresses derived from it. vitest.config.mts gives every test DATABASE_URL:
 * TEST_DATABASE_URL when it is set (an agent in its own worktree must set it), else the shared default. The global setup
 * checks and migrates that database; tests that need the server's maintenance database or an empty scratch database
 * ask here, so nothing is hard-coded and two runs on different databases never touch each other's.
 */

import { statSync } from "node:fs";
import path from "node:path";

/** The database a run uses when TEST_DATABASE_URL is not set: one database, shared by every run that doesn't name its own. */
export const DEFAULT_TEST_DATABASE_URL = "postgres://booster:booster@localhost:5433/booster_test";

/** Lowercase letters, digits and underscores, ending in _test: safe to write into SQL as an identifier, and never the site's own database. */
const TEST_NAME = /^[a-z][a-z0-9_]*_test$/;
/** Postgres cuts identifiers off at 63 bytes, which would make two long names the same database. */
const MAX_NAME = 63;
const validName = (name: string) => TEST_NAME.test(name) && name.length <= MAX_NAME;

export function databaseName(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.slice(1)); } catch { return ""; }
}

/** The tests empty every table, so they only run on a database named for it. The address (it holds a password) is never echoed: only the name. */
export function assertTestDatabase(url: string): void {
  const name = databaseName(url);
  if (!validName(name)) {
    throw new Error(`The tests refuse to run: the test database name must be lowercase letters, digits and underscores, end in "_test" and be at most ${MAX_NAME} characters (it is "${name}"). The tests empty every table in it. Check TEST_DATABASE_URL.`);
  }
}

/** How a worktree gets a database of its own: the same two commands as AGENTS.md (tests/unit/test-database-url.test.ts keeps them the same). */
export const PRIVATE_DATABASE_RECIPE = [
  `docker exec booster-rocket-db-1 psql -U booster -d booster -c 'CREATE DATABASE "booster_<name>_test" OWNER booster'`,
  `export TEST_DATABASE_URL=postgres://booster:booster@localhost:5433/booster_<name>_test`,
];

/** A linked git worktree keeps a file named .git that points at the main tree; the main tree keeps a folder. */
function gitDirIsFile(root: string): boolean {
  try { return statSync(path.join(root, ".git")).isFile(); } catch { return false; }
}

/**
 * A run in a git worktree must have its own database. Agents work in parallel, each in a worktree under .worktrees/:
 * on the shared database two runs empty each other's tables in the middle of a test, and a migration generated in one
 * worktree would be applied to the database every other tree uses. So a run whose tree is a worktree (a folder under
 * .worktrees/, or any tree whose .git is a file) and whose database is the shared default is refused before anything
 * is migrated.
 */
export function assertOwnDatabaseInWorktree(root: string, url: string, linkedWorktree = gitDirIsFile(root)): void {
  const tree = root.replaceAll("\\", "/");
  if (!linkedWorktree && !/\/\.worktrees\/[^/]+/.test(`${tree}/`)) return;
  const shared = databaseName(DEFAULT_TEST_DATABASE_URL);
  if (databaseName(url) !== shared) return;
  throw new Error([
    `The tests refuse to run: ${tree} is a git worktree, and this run would use "${shared}", the test database every tree shares. `
      + `Two runs on one database empty each other's tables, and a migration generated here would be applied to it. Give this worktree its own database (AGENTS.md, Tests):`,
    ...PRIVATE_DATABASE_RECIPE.map((line) => `  ${line}`),
    `Drop the database when the worktree is removed.`,
  ].join("\n"));
}

/** Inside a test: the address vitest.config.mts gave this run. */
function runDatabaseUrl(url = process.env.DATABASE_URL ?? ""): string {
  assertTestDatabase(url);
  return url;
}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The same server and sign-in as the run's database, on the maintenance database: for CREATE DATABASE and DROP DATABASE. */
export function adminDatabaseUrl(runUrl?: string): string {
  return withDatabase(runDatabaseUrl(runUrl), "postgres");
}

/**
 * A scratch database for a test that needs an empty one. Its name comes from the run's database name, so two runs on
 * different databases never drop each other's scratch databases: booster_test gives booster_<purpose>_test, and
 * booster_agent1_test gives booster_agent1_<purpose>_test.
 */
export function scratchDatabase(purpose: string, runUrl?: string): { name: string; url: string } {
  const run = runDatabaseUrl(runUrl);
  const name = `${databaseName(run).replace(/_test$/, "")}_${purpose}_test`;
  if (!validName(name)) {
    throw new Error(`The scratch database name "${name}" must be lowercase letters, digits and underscores, at most ${MAX_NAME} characters. Use a shorter test database name.`);
  }
  return { name, url: withDatabase(run, name) };
}
