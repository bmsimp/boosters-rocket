import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/lib/db/migrate";
import { assertOwnDatabaseInWorktree, assertTestDatabase } from "./database-url";

/**
 * Migrates the database the tests are about to use: the DATABASE_URL vitest.config.mts gives them. Before that it
 * refuses a database not named for tests, and the shared database when this tree is a git worktree.
 */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL ?? "";
  assertTestDatabase(url);
  assertOwnDatabaseInWorktree(project.config.root, url);
  await runMigrations(url);
}
