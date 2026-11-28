import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { getParentSettings, PARENTS_KEY } from "@/lib/parents/settings";
import { studentsRuleInForce } from "@/lib/parents/sessions";
import { resetDb } from "../helpers/db";

// Migration 0062 (stage 5's slice P2): "Families with no active student" no longer waits for a membership shape that
// names a student type, so a value stored on beside a shape with none, which was not in force, is switched off and
// audited: nobody who could sign in the day before is kept out the day after.

const migration = () => {
  const file = readdirSync("drizzle").find((f) => f.endsWith("_students_rule_kept.sql"));
  if (!file) throw new Error("no students_rule_kept migration");
  return readFileSync(path.join("drizzle", file), "utf8");
};
const store = (key: string, value: unknown) => db.insert(setting).values({ key, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
const saved = async () => (await db.select().from(auditLog)).filter((r) => r.action === "settings.parents.save");
const parents = (requireActiveStudents: boolean) => ({ signin: true, welcome: false, requireActiveStudents, level: "standard" });

describe("migration 0062: the students rule kept as it was in force", () => {
  beforeEach(async () => { await resetDb(); });

  for (const [what, shape] of [
    ["no shape", null],
    ["a flat shape", { kind: "flat", memberTypeIds: ["M"] }],
    ["a layered shape with no student type", { kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" }],
    // One getShape() can't read (an empty student type, no family type) was no shape at all to the rule.
    ["a layered shape the portal can't read", { kind: "layered", familyTypeId: "", studentTypeId: "", parentTypeId: null }],
  ] as const) {
    it(`switches it off beside ${what}, where it wasn't in force, and audits that`, async () => {
      await store(PARENTS_KEY, parents(true));
      if (shape) await store("membership.shape", shape);
      await db.execute(sql.raw(migration()));
      expect(await getParentSettings()).toMatchObject({ signin: true, requireActiveStudents: false, level: "standard" });
      expect(await studentsRuleInForce()).toBe(false);
      const [row] = await saved();
      expect(row).toMatchObject({ door: "system", actorLabel: "migration", targetType: "setting", targetId: PARENTS_KEY,
        before: parents(true), after: { ...parents(false), cause: "migration 0062_students_rule_kept" } });
    });
  }

  it("keeps it on beside a shape that names students, where it was in force, and an off value as it is", async () => {
    await store(PARENTS_KEY, parents(true));
    await store("membership.shape", { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" });
    await db.execute(sql.raw(migration()));
    expect(await studentsRuleInForce()).toBe(true);
    await store(PARENTS_KEY, parents(false));
    await db.delete(setting).where(eq(setting.key, "membership.shape"));
    await db.execute(sql.raw(migration()));
    expect((await getParentSettings()).requireActiveStudents).toBe(false);
    expect(await saved()).toEqual([]);
  });
});
