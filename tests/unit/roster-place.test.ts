import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { placesOf, placeWords } from "@/lib/roster/place";
import type { MembershipShape } from "@/lib/roster/shape";

/**
 * Where the books have a student's linked customer, and its words (src/lib/roster/place.ts): the one rule a family's
 * page and the accounting links screen both say a move by.
 */
const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const company: Cust[] = [
  c("10", "Rivera Family", "1"), c("12", "Leo Rivera", "3", "10"), c("13", "Zoe Rivera", "3", "10", { active: false }),
  c("20", "Chen Family", "1"), c("22", "Sam Chen", "3", "20"),
  c("40", "Old Family", "1", null, { active: false }), c("41", "Ivy Old", "3", "40"),
  c("30", "Lincoln High", "4"), c("31", "Kim Lincoln", "3", "30"),
  c("50", "Stray Student", "3"), c("60", "Now A Parent", "2", "10"),
];
const layered = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;
const placeOf = placesOf(layered, buildRoster(layered, company), company);

describe("where the books have a student", () => {
  it("under the family's own customer, active or not", () => {
    expect(placeOf("12", "10")).toEqual({ at: "here" });
    expect(placeOf("13", "10")).toEqual({ at: "here" });
  });
  it("under another customer the roster lists as a family, by its name in the books, inactive or not", () => {
    expect(placeOf("22", "10")).toEqual({ at: "other_family", familyQboId: "20", familyName: "Chen Family" });
    expect(placeOf("41", "10")).toEqual({ at: "other_family", familyQboId: "40", familyName: "Old Family" });
  });
  it("under no customer, under one that is no family here, not a student customer now, or gone", () => {
    expect(placeOf("50", "10")).toEqual({ at: "top" });
    expect(placeOf("31", "10")).toEqual({ at: "under_other" });
    expect(placeOf("60", "10")).toEqual({ at: "not_student" });
    expect(placeOf("99", "10")).toEqual({ at: "gone" });
  });
  it("a family with no customer has nobody here; an empty cache tells nothing", () => {
    expect(placeOf("12", null)).toEqual({ at: "other_family", familyQboId: "10", familyName: "Rivera Family" });
    expect(placesOf(layered, buildRoster(layered, []), [])("12", "10")).toEqual({ at: "unknown" });
  });
  it("with no student type, or in flat books, no customer is a student customer", () => {
    const noStudents = { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } as const;
    expect(placesOf(noStudents, buildRoster(noStudents, company), company)("12", "10")).toEqual({ at: "not_student" });
    const flat: MembershipShape = { kind: "flat", memberTypeIds: ["1"] };
    expect(placesOf(flat, buildRoster(flat, company), company)("12", "10")).toEqual({ at: "not_student" });
  });
  it("says each place in words that name QuickBooks, a family's name as the books have it", () => {
    expect(placeWords({ at: "other_family", familyQboId: "20", familyName: "Chen Family" })).toBe("Under Chen Family in QuickBooks");
    expect(placeWords({ at: "here" })).toBe("Under this family in QuickBooks");
    expect(placeWords({ at: "top" })).toBe("Not under any customer in QuickBooks");
    expect(placeWords({ at: "under_other" })).toBe("Under a customer in QuickBooks that isn't a family here");
    expect(placeWords({ at: "not_student" })).toBe("Not a student customer in QuickBooks now");
    expect(placeWords({ at: "gone" })).toBe("Its customer isn't in the portal's copy of QuickBooks any more");
    expect(placeWords({ at: "unknown" })).toBe("Not under a family in QuickBooks");
  });
});
