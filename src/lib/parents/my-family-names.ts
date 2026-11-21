// The names of a signed-in parent's own families, for the chooser and the frame's "Viewing <name>" line. Each comes from
// the app's own family record (`family.name`), found through the person's guardian row's `family_id`, never from a
// QuickBooks id, so no customer id reaches the page as a label (app-owned families spec §2). A family whose name the
// portal doesn't know is said so in words (recordNameWords()); a previous company's row, the one kind in no family
// record, is never offered here. Parent code: it
// reads only the rows of the person it is given, and imports no staff-only module (tests/integration/page-guards.test.ts).
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, guardian } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";

/**
 * One query for every row asked about: guardian row id to the family's name in words. An id that is not one of this
 * person's rows answers nothing: it gets no entry, and does not count toward the numbering. Callers pass all of the
 * person's families, in the order the chooser lists them, so that names that repeat (two families the portal knows no
 * name for, or two of the same name) are told apart by their place in that list, "(1)", "(2)", and the frame's
 * "Viewing" line reads as the chooser's button did. A number is raised past any label that is already another family's
 * own words (a family named "Ash (1)" beside two named "Ash"), so no two of the person's families read alike.
 */
export async function myFamilyNames(parentId: string, guardianIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(guardianIds)];
  const rows = ids.length
    ? await db.select({ id: guardian.id, name: family.name }).from(guardian).leftJoin(family, eq(family.id, guardian.familyId))
      .where(and(eq(guardian.parentId, parentId), inArray(guardian.id, ids)))
    : [];
  const found = new Map(rows.map((r) => [r.id, r.name]));
  const mine = ids.filter((id) => found.has(id));
  const labels = numberedWhereRepeated(mine.map((id) => recordNameWords(found.get(id) ?? null, "family")));
  return new Map(mine.map((id, i) => [id, labels[i]!]));
}

/**
 * The words of each place in the list, those that appear more than once numbered by their order among the same words,
 * each number raised until the label is no other place's words and no label given already.
 */
export function numberedWhereRepeated(words: readonly string[]): string[] {
  const taken = new Set(words);
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  const next = new Map<string, number>();
  return words.map((w) => {
    if (counts.get(w)! < 2) return w;
    let n = next.get(w) ?? 0, label: string;
    do { n += 1; label = `${w} (${n})`; } while (taken.has(label));
    next.set(w, n);
    taken.add(label);
    return label;
  });
}
