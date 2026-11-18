// The SQL fill of the app's own records in migration 0023, as statements that can be run again on a database that
// holds data (tests/integration/app-records-fill.test.ts, scripts/seed-e2e.ts). Reads nothing but the file, so a
// script that doesn't load the portal's modules can use it.
import { readFileSync } from "node:fs";
import path from "node:path";

export const FILL_MIGRATION = "drizzle/0023_app_records.sql";

/**
 * The statements from the fill's begin marker to its end marker, and the last one, which drops its scratch tables. The
 * carry-over's audit row is left out: it belongs to the migration's own run. Run them in order on one connection (a
 * transaction): the scratch tables are that session's.
 */
export function appRecordsFillStatements(): string[] {
  const chunks = readFileSync(path.resolve(FILL_MIGRATION), "utf8").split("--> statement-breakpoint").map((c) => c.trim()).filter(Boolean);
  const begin = chunks.findIndex((c) => c.includes("app-records fill: begin"));
  const end = chunks.findIndex((c) => c.includes("app-records fill: end"));
  const drop = chunks.at(-1) ?? "";
  if (begin < 0 || end <= begin || !drop.startsWith("DROP TABLE pg_temp.app_fill_source")) {
    throw new Error(`${FILL_MIGRATION} no longer has the app-records fill between its begin and end markers, followed by the drop of its scratch tables.`);
  }
  return [...chunks.slice(begin, end), drop];
}
