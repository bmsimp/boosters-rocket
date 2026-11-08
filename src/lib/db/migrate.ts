import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function runMigrations(url: string) {
  const pg = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(pg), { migrationsFolder: "drizzle" });
  await pg.end();
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations(process.env.DATABASE_URL!)
    .then(() => console.log("migrated"))
    .catch((e) => { console.error(e); process.exit(1); });
}
