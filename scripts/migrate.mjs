// Plain-JS migrations for the production image (no tsx). Same migrator and folder as src/lib/db/migrate.ts.
// With --backup-check (deploy/compose.yml's migrate service) it first refuses to change a database that holds data
// unless a backup was made recently (scripts/backup-check.mjs); without it (the proof of concept, which backs up first
// itself, and the image's smoke test) it migrates as it always has.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { backupCheck } from "./backup-check.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const folder = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const checked = process.argv.includes("--backup-check");

const pg = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
try {
  const check = checked ? await backupCheck(pg, { folder }) : { go: true, words: null };
  if (check.words) console.log(check.words);
  if (!check.go) {
    console.error(check.message);
    process.exitCode = 1;
  } else {
    await migrate(drizzle(pg), { migrationsFolder: folder });
    console.log("migrated");
  }
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
