// Plain-JS migrations for the production image (no tsx). Same migrator and folder as src/lib/db/migrate.ts.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const folder = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const pg = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
try {
  await migrate(drizzle(pg), { migrationsFolder: folder });
  console.log("migrated");
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
