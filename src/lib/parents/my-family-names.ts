// The names of a signed-in parent's own families, for the chooser and the frame's "Viewing <name>" line. Each comes from
// the app's own family record (`family.name`), found through the person's guardian row's `family_id`, never from a
// QuickBooks id, so no customer id reaches the page as a label (app-owned families spec §2). A family whose name the
// portal doesn't know, or a row with no family record yet, is said so in words (recordNameWords()). Parent code: it
// reads only the rows of the person it is given, and imports no staff-only module (tests/integration/page-guards.test.ts).
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, guardian } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";

/**
 * One query for every row asked about: guardian row id to the family's name in words. Another person's rows answer
 * nothing. Callers pass all of the person's families, in the order the chooser lists them, so that names that repeat
 * (two families the portal knows no name for, or two of the same name) are told apart by their place in that list,
 * "(1)", "(2)", and the frame's "Viewing" line reads as the chooser's button did.
 */
export async function myFamilyNames(parentId: string, guardianIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(guardianIds)];
  const rows = ids.length
    ? await db.select({ id: guardian.id, name: family.name }).from(guardian).leftJoin(family, eq(family.id, guardian.familyId))
      .where(and(eq(guardian.parentId, parentId), inArray(guardian.id, ids)))
    : [];
  const found = new Map(rows.map((r) => [r.id, r.name]));
  const words = ids.map((id) => recordNameWords(found.get(id) ?? null, "family"));
  return new Map(ids.map((id, i) => [id, numberedIfRepeated(words, i)]));
}

/** The words at `i`, with their place among the same words when they appear more than once in the list. */
function numberedIfRepeated(words: readonly string[], i: number): string {
  const same = words.filter((w) => w === words[i]).length;
  if (same < 2) return words[i]!;
  return `${words[i]} (${words.slice(0, i + 1).filter((w) => w === words[i]).length})`;
}
