import { describe, it, expect } from "vitest";
import { adminDatabaseUrl, assertTestDatabase, scratchDatabase } from "../setup/database-url";

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
