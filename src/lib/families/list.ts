import { asc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, guardian, student } from "@/lib/db/schema";
import { numberedWhereRepeated } from "@/lib/parents/my-family-names";
import type { AppFamilyId, AppStudentId } from "./ids";
import { recordNameWords } from "./words";

// The Families pages with no books (stage 5's slice P2, docs/superpowers/specs/2026-11-28-accounting-plugin-design.md
// section 2): the club's families and students as the portal keeps them, with nothing from any books. Staff-only: it
// reads every family (tests/integration/page-guards.test.ts, STAFF_ONLY_IMPORTS). Names are the portal's own, shown as
// text only.

const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
const byName = <T extends { name: string; id: unknown }>(a: T, b: T) => COLLATOR.compare(a.name, b.name) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/** A family in the list: its active students and its open guardians, counted. */
export type FamilyRow = { id: AppFamilyId; name: string; active: boolean; students: number; guardians: number };

/** Every family the portal keeps, by name, active or not, each with how many active students and open guardians it has. */
export async function listFamilies(): Promise<FamilyRow[]> {
  const [families, students, guardians] = await Promise.all([
    db.select({ id: family.id, name: family.name, active: family.active }).from(family),
    db.select({ familyId: student.familyId, n: sql<number>`count(*)::int` }).from(student).where(eq(student.active, true)).groupBy(student.familyId),
    db.select({ familyId: guardian.familyId, n: sql<number>`count(*)::int` }).from(guardian).where(ne(guardian.status, "disabled")).groupBy(guardian.familyId),
  ]);
  const count = (rows: { familyId: AppFamilyId | null; n: number }[]) => new Map(rows.map((r) => [String(r.familyId), r.n]));
  const s = count(students), g = count(guardians);
  return families.map((f) => ({ id: f.id, name: recordNameWords(f.name, "family"), active: f.active, students: s.get(String(f.id)) ?? 0, guardians: g.get(String(f.id)) ?? 0 }))
    .sort(byName);
}

/** A student of a family's page. */
export type HereStudent = { id: AppStudentId; name: string; active: boolean };
/** One family as the portal keeps it, with its students, active first, each by name. */
export type FamilyHere = { id: AppFamilyId; name: string; active: boolean; students: HereStudent[] };

/** The family record `familyId` names (an app id the page checked with familyRecordAt()), or null. */
export async function familyHere(familyId: AppFamilyId): Promise<FamilyHere | null> {
  const [f] = await db.select({ id: family.id, name: family.name, active: family.active }).from(family).where(eq(family.id, familyId));
  if (!f) return null;
  const rows = await db.select({ id: student.id, name: student.name, active: student.active }).from(student).where(eq(student.familyId, familyId)).orderBy(asc(student.id));
  const students = rows.map((r) => ({ id: r.id, name: recordNameWords(r.name, "student"), active: r.active }))
    .sort((a, b) => Number(b.active) - Number(a.active) || byName(a, b));
  return { id: f.id, name: recordNameWords(f.name, "family"), active: f.active, students };
}

/**
 * The families a student of `fromFamilyId` may be moved to by hand: every other active family, by name; names the list
 * can't tell apart are told apart by their place in it (numberedWhereRepeated()), as the parent's family chooser does.
 */
export async function moveTargetsHere(fromFamilyId: AppFamilyId): Promise<{ id: string; name: string }[]> {
  const rows = (await db.select({ id: family.id, name: family.name }).from(family).where(eq(family.active, true)))
    .filter((r) => String(r.id) !== String(fromFamilyId))
    .map((r) => ({ id: r.id, name: recordNameWords(r.name, "family") }))
    .sort(byName);
  const labels = numberedWhereRepeated(rows.map((r) => r.name));
  return rows.map((r, i) => ({ id: String(r.id), name: labels[i]! }));
}
