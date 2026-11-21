import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family } from "@/lib/db/schema";
import { setRosterSource } from "@/lib/roster/source";
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
async function rowIn(parentId: string, name: string | null) {
  const [f] = await db.insert(family).values({ name, active: true }).returning({ id: family.id });
  return (await seedGuardian({ parentId, familyId: f!.id })).id;
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
    const named = await rowIn(ana.id, `${UNKNOWN} (1)`), first = await rowIn(ana.id, null), second = await rowIn(ana.id, null);
    const names = await myFamilyNames(ana.id, [named, first, second]);
    expect([...names.entries()]).toEqual([[named, `${UNKNOWN} (1)`], [first, `${UNKNOWN} (2)`], [second, `${UNKNOWN} (3)`]]);
  });

  it("answers nothing for a row that isn't the person's, and does not count it toward the numbering", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    const bens = await rowIn(ben.id, null);
    const first = await rowIn(ana.id, null), only = await rowIn(ana.id, "Birch Family");
    const nobody = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e72";
    const names = await myFamilyNames(ana.id, [bens, first, nobody, only]);
    // Ben's row and an id of no row get no entry; Ana's one unnamed family is alone, so it has no number.
    expect([...names.entries()]).toEqual([[first, UNKNOWN], [only, "Birch Family"]]);
    expect(names.has(bens)).toBe(false);
    expect(names.has(nobody)).toBe(false);
  });
});

describe("the chooser's order (enterableGuardianRows())", () => {
  const REALM = "9130000000000079";
  beforeEach(async () => { await resetDb(); await db.transaction((tx) => setRosterSource(tx, REALM)); });

  /** A family record of this name linked to `customer` in the roster's company, as the import makes one. */
  async function linkedFamily(customer: string, name: string) {
    const [f] = await db.insert(family).values({ name, active: true }).returning({ id: family.id });
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: customer, familyId: f!.id, origin: "carried_over" });
    return f!.id;
  }
  const rowOf = async (parentId: string, familyId: Awaited<ReturnType<typeof linkedFamily>>) => (await seedGuardian({ parentId, familyId })).id;

  it("orders the rows by the customer their family's own link names, then those of families with no link (slice 9d), by row", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const second = await rowOf(ana.id, await linkedFamily("F2", "Birch Family")), first = await rowOf(ana.id, await linkedFamily("F1", "Ash Family"));
    // Two families staff added in the portal, with no link.
    const byHand = [await rowIn(ana.id, "Ash Family"), await rowIn(ana.id, "Cedar Family")].sort();
    expect((await enterableGuardianRows(ana.id)).map((r) => r.id)).toEqual([first, second, ...byHand]);
    // The two Ash families are told apart by that place: the linked one stays "(1)".
    const names = await myFamilyNames(ana.id, [first, second, ...byHand]);
    expect(names.get(first)).toBe("Ash Family (1)");
  });

  it("places a row made while its family had no link among the linked ones once the family is linked, and at the end again once it is unlinked", async () => {
    const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
    const ash = await rowOf(ana.id, await linkedFamily("F1", "Ash Family")), cedar = await rowOf(ana.id, await linkedFamily("F3", "Cedar Family"));
    const [birch] = await db.insert(family).values({ name: "Birch Family", active: true }).returning({ id: family.id });
    const made = await rowOf(ana.id, birch!.id);
    expect((await enterableGuardianRows(ana.id)).map((r) => r.id)).toEqual([ash, cedar, made]);
    // Linked since (a Confirm on the accounting links screen): its row takes its family's customer's place.
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "F2", familyId: birch!.id, origin: "confirmed" });
    expect((await enterableGuardianRows(ana.id)).map((r) => r.id)).toEqual([ash, made, cedar]);
    // Another company's link names no place: only the roster's company's does.
    await db.delete(accountingLink).where(eq(accountingLink.familyId, birch!.id));
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "9130000000000080", customerId: "F0", familyId: birch!.id, origin: "carried_over" });
    expect((await enterableGuardianRows(ana.id)).map((r) => r.id)).toEqual([ash, cedar, made]);
  });
});
