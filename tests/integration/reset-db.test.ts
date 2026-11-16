import { describe, it, expect } from "vitest";
import { getTableName, isTable, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { auditLog, heldAddress, jobRun, qboCustomer, role, roleRule, setting } from "@/lib/db/schema";
import { childrenFirst, resetDb, seedGuardian, seedParent, seedParentSession, seedStaff } from "../helpers/db";

/** Row counts for every table in the public schema, read from the database rather than from a list someone keeps. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const counts: Record<string, number> = {};
  for (const { tablename } of tables) {
    const [row] = await db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM "${tablename}"`));
    counts[tablename] = row!.n;
  }
  return counts;
}

describe("resetDb", () => {
  it("leaves every public table empty except the built-in Admin role", async () => {
    await resetDb();
    const staff = await seedStaff({ email: "admin@club.org", admin: true });
    const ana = await seedParent({ name: "Ana Rivera" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    await seedParentSession(ana.authUserId, { familyQboId: "10" });
    const [custom] = await db.insert(role).values({ key: "custom", name: "Custom" }).returning();
    await db.insert(roleRule).values({ roleId: custom!.id, kind: "include", pattern: "Roster.*" });
    await db.insert(setting).values({ key: "reset.test", value: { any: "thing" } });
    await db.insert(qboCustomer).values({ qboId: "10", displayName: "Rivera Family", active: true, syncToken: "0" });
    await db.insert(heldAddress).values({ email: "sam@example.com" });
    await db.insert(jobRun).values({ job: "reset.test", startedBy: "test" });
    await db.insert(auditLog).values({ door: "staff", actorId: staff.id, actorLabel: staff.email, action: "reset.test" });

    const before = await rowCounts();
    for (const t of ["staff_user", "role_assignment", "parent", "parent_auth_user", "guardian", "parent_auth_session", "role_rule", "setting", "qbo_customer", "held_address", "job_run", "audit_log"]) {
      expect(before[t], `${t} should hold a row before the reset`).toBeGreaterThan(0);
    }
    expect(before.role).toBe(2);

    await resetDb();

    const after = await rowCounts();
    const notEmpty = Object.entries(after).filter(([t, n]) => t !== "role" && n > 0).map(([t, n]) => `${t} (${n})`);
    expect(notEmpty, "tables resetDb left rows in").toEqual([]);
    expect(await db.select({ key: role.key, builtin: role.builtin }).from(role)).toEqual([{ key: "admin", builtin: true }]);
  });

  it("covers every table the schema declares", async () => {
    // The list comes from the database, so this can only fail if a table is declared outside the public schema, where
    // resetDb would not see it.
    const declared = Object.values(schema).filter(isTable).map((t) => getTableName(t)).sort();
    const inDatabase = Object.keys(await rowCounts()).sort();
    expect(declared.length).toBeGreaterThan(20);
    expect(inDatabase).toEqual(declared);
  });

  it("starts identity columns again from 1", async () => {
    await db.insert(auditLog).values({ door: "system", actorLabel: "test", action: "reset.test" });
    await resetDb();
    const [row] = await db.insert(auditLog).values({ door: "system", actorLabel: "test", action: "reset.test" }).returning();
    expect(Number(row!.id)).toBe(1);
    await resetDb();
  });

  it("leaves the background vacuum off for every table, so rows read back in the order they were written", async () => {
    // tests/setup/worker-databases.ts (readyTablesForRun): a reset deletes rows, and tests read them back with no ORDER BY.
    const on = await db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      AND NOT coalesce('autovacuum_enabled=false' = ANY(reloptions), false) ORDER BY relname`);
    expect([...on].map((t) => t.name)).toEqual([]);
    for (let round = 0; round < 3; round++) {
      await resetDb();
      for (let i = 0; i < 50; i++) await db.insert(auditLog).values({ door: "system", actorLabel: `row ${i}`, action: "reset.test" });
      expect((await db.select({ label: auditLog.actorLabel }).from(auditLog)).map((r) => r.label)).toEqual(Array.from({ length: 50 }, (_, i) => `row ${i}`));
    }
    await resetDb();
  });
});

// The order resetDb deletes in: a table before every table it refers to.
describe("childrenFirst", () => {
  it("puts each table before the tables it refers to", () => {
    // 3 refers to 2, and 2 to 1; 4 refers to 1 and 3.
    const order = childrenFirst([1, 2, 3, 4], [{ child: 3, parent: 2 }, { child: 2, parent: 1 }, { child: 4, parent: 1 }, { child: 4, parent: 3 }])!;
    expect(order).toHaveLength(4);
    for (const [child, parent] of [[3, 2], [2, 1], [4, 1], [4, 3]]) expect(order.indexOf(child!)).toBeLessThan(order.indexOf(parent!));
  });

  it("has no order for tables that refer to each other in a circle", () => {
    expect(childrenFirst([1, 2, 3], [{ child: 1, parent: 2 }, { child: 2, parent: 3 }, { child: 3, parent: 1 }])).toBeNull();
  });

  it("has no order when a table that is not emptied refers to one that is", () => {
    expect(childrenFirst([1, 2], [{ child: 9, parent: 1 }])).toBeNull();
    expect(childrenFirst([1, 2], [{ child: 1, parent: 9 }])).toEqual([1, 2]); // referring out to a table left alone is fine
  });
});
