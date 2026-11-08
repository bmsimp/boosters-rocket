import { runMigrations } from "../../src/lib/db/migrate";

export default async function setup() {
  await runMigrations("postgres://booster:booster@localhost:5433/booster_test");
}
