import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/lib/db/migrate";
import { assertTestDatabase } from "./database-url";

/** Migrates the database the tests are about to use: the DATABASE_URL vitest.config.mts gives them. */
export default async function setup(project: TestProject) {
  const url = project.config.env.DATABASE_URL ?? "";
  assertTestDatabase(url);
  await runMigrations(url);
}
