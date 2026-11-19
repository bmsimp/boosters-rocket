import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, guardian } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";
import { myFamilyNames, numberedWhereRepeated } from "@/lib/parents/my-family-names";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";

/**
 * The chooser's and the frame's names for a person's own families (src/lib/parents/my-family-names.ts): from each
 * family's record through the person's own guardian rows, words that repeat told apart by their place, and a number
 * never landing on another family's own words.
 */
const UNKNOWN = recordNameWords(null, "family");

/** A guardian row of this person in a new family record of this name (null: the portal knows none). */
async function rowIn(parentId: string, familyQboId: string, name: string | null) {
  const g = await seedGuardian({ parentId, familyQboId });
  const [f] = await db.insert(family).values({ name, active: true }).returning({ id: family.id });
  await db.update(guardian).set({ familyId: f!.id }).where(eq(guardian.id, g.id));
  return g.id;
}

describe("numberedWhereRepeated()", () => {
  it("numbers only words that repeat, by their order among the same words", () => {
    expect(numberedWhereRepeated(["Ash", "Birch", "Ash"])).toEqual(["Ash (1)", "Birch", "Ash (2)"]);
    expect(numberedWhereRepeated(["Ash"])).toEqual(["Ash"]);
    expect(numberedWhereRepeated([])).toEqual([]);
  });

  it("raises a number past another family's own words, and past a label already given", () => {
    expect(numberedWhereRepeated(["Ash (1)", "Ash", "Ash"])).toEqual(["Ash (1)", "Ash (2)", "Ash (3)"]);
    expect(numberedWhereRepeated(["Ash", "Ash (2)", "Ash", "Ash (1)"])).toEqual(["Ash (3)", "Ash (2)", "Ash (4)", "Ash (1)"]);
    // Every label differs from every other, whatever the words.
    const labels = numberedWhereRepeated(["X", "X (1)", "X", "X (2)", "X (1)", "X"]);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("myFamilyNames()", () => {
  beforeEach(async () => { await resetDb(); });

  it("gives a family named like another's numbered label a number of its own", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const named = await rowIn(ana.id, "F1", `${UNKNOWN} (1)`), first = await rowIn(ana.id, "F2", null), second = await rowIn(ana.id, "F3", null);
    const names = await myFamilyNames(ana.id, [named, first, second]);
    expect([...names.entries()]).toEqual([[named, `${UNKNOWN} (1)`], [first, `${UNKNOWN} (2)`], [second, `${UNKNOWN} (3)`]]);
  });

  it("answers nothing for a row that isn't the person's, and does not count it toward the numbering", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    const bens = await rowIn(ben.id, "F9", null);
    const first = await rowIn(ana.id, "F1", null), only = await rowIn(ana.id, "F2", "Birch Family");
    const nobody = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e72";
    const names = await myFamilyNames(ana.id, [bens, first, nobody, only]);
    // Ben's row and an id of no row get no entry; Ana's one unnamed family is alone, so it has no number.
    expect([...names.entries()]).toEqual([[first, UNKNOWN], [only, "Birch Family"]]);
    expect(names.has(bens)).toBe(false);
    expect(names.has(nobody)).toBe(false);
  });
});

describe("the chooser's order (enterableGuardianRows())", () => {
  beforeEach(async () => { await resetDb(); });

  it("keeps the rows that name a customer in their place, by customer, and puts those that name none (slice 9d) after them, by row", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const second = await rowIn(ana.id, "F2", "Birch Family"), first = await rowIn(ana.id, "F1", "Ash Family");
    // Two families staff added in the portal while they had no link: rows naming no customer.
    const byHand: string[] = [];
    for (const name of ["Ash Family", "Cedar Family"]) {
      const [f] = await db.insert(family).values({ name, active: true }).returning({ id: family.id });
      const [g] = await db.insert(guardian).values({ parentId: ana.id, familyQboId: null, familyId: f!.id, status: "invited" }).returning({ id: guardian.id });
      byHand.push(g!.id);
    }
    byHand.sort();
    expect((await enterableGuardianRows(ana.id)).map((r) => r.id)).toEqual([first, second, ...byHand]);
    // The two Ash families are told apart by that place: the linked one stays "(1)".
    const names = await myFamilyNames(ana.id, [first, second, ...byHand]);
    expect(names.get(first)).toBe("Ash Family (1)");
  });
});
