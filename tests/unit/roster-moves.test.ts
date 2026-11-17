import { describe, it, expect } from "vitest";
import { studentMoves, type Placed } from "@/lib/roster/moves";

const p = (qboId: string, typeQboId: string | null, parentQboId: string | null = null, active = true): Placed => ({ qboId, typeQboId, parentQboId, active });
const layered = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;
const company: Placed[] = [
  p("10", "1"), p("20", "1"), p("40", "1", null, false), p("30", "4"),
  p("11", "2", "10"), p("12", "3", "10"), p("13", "3", "10"), p("21", "2", "20"), p("50", "3"),
];
const moved = (changes: Record<string, Partial<Placed>>) => company.map((c) => ({ ...c, ...changes[c.qboId] }));

describe("the students a refresh finds moved to another family", () => {
  it("a student now directly under another family moved from the one they were under", () => {
    expect(studentMoves(layered, company, moved({ "12": { parentQboId: "20" } }))).toEqual([{ studentQboId: "12", fromFamilyQboId: "10", toFamilyQboId: "20" }]);
  });

  it("the same roster read again finds nothing: a move staff made in the portal is in the cache already", () => {
    const after = moved({ "12": { parentQboId: "20" } });
    expect(studentMoves(layered, company, company)).toEqual([]);
    expect(studentMoves(layered, after, after)).toEqual([]);
  });

  it("a family that is inactive is still a family, on either side", () => {
    expect(studentMoves(layered, company, moved({ "12": { parentQboId: "40" } }))).toEqual([{ studentQboId: "12", fromFamilyQboId: "10", toFamilyQboId: "40" }]);
    const fromInactive = moved({ "12": { parentQboId: "40" } });
    expect(studentMoves(layered, fromInactive, company)).toEqual([{ studentQboId: "12", fromFamilyQboId: "40", toFamilyQboId: "10" }]);
  });

  it("a student made inactive, moved or not, is followed by nothing", () => {
    expect(studentMoves(layered, company, moved({ "12": { active: false } }))).toEqual([]);
    expect(studentMoves(layered, company, moved({ "12": { parentQboId: "20", active: false } }))).toEqual([]);
  });

  it("a student taken back into use under another family is followed: their forms were left under the old one", () => {
    const inactive = moved({ "12": { active: false } });
    expect(studentMoves(layered, inactive, moved({ "12": { parentQboId: "20" } }))).toEqual([{ studentQboId: "12", fromFamilyQboId: "10", toFamilyQboId: "20" }]);
  });

  it("a student moved to something that isn't a family is followed by nothing: a school, a parent, another student, no one", () => {
    for (const to of ["30", "21", "13", null, "999"]) expect(studentMoves(layered, company, moved({ "12": { parentQboId: to } })), String(to)).toEqual([]);
  });

  it("a stray, a new student and a customer whose type changed are not moves", () => {
    expect(studentMoves(layered, company, moved({ "50": { parentQboId: "20" } }))).toEqual([]);   // was under no family
    expect(studentMoves(layered, company, [...company, p("99", "3", "20")])).toEqual([]);          // new to the cache
    expect(studentMoves(layered, company, moved({ "11": { parentQboId: "20" } }))).toEqual([]);   // a parent moved: not a student
    expect(studentMoves(layered, company, moved({ "12": { parentQboId: "20", typeQboId: "2" } }))).toEqual([]); // now a parent
    expect(studentMoves(layered, moved({ "12": { typeQboId: "2" } }), moved({ "12": { parentQboId: "20" } }))).toEqual([]); // was a parent
  });

  it("the old family as the old cache had it: a family whose type changed since is still where the student came from", () => {
    expect(studentMoves(layered, company, moved({ "12": { parentQboId: "20" }, "10": { typeQboId: "4" } })))
      .toEqual([{ studentQboId: "12", fromFamilyQboId: "10", toFamilyQboId: "20" }]);
    expect(studentMoves(layered, moved({ "20": { typeQboId: "4" } }), moved({ "12": { parentQboId: "20" } })))
      .toEqual([{ studentQboId: "12", fromFamilyQboId: "10", toFamilyQboId: "20" }]);
  });

  it("no shape, a flat shape, or a layered one with no student type: nothing is a move", () => {
    const after = moved({ "12": { parentQboId: "20" } });
    expect(studentMoves(null, company, after)).toEqual([]);
    expect(studentMoves({ kind: "flat", memberTypeIds: ["1", "3"] }, company, after)).toEqual([]);
    expect(studentMoves({ ...layered, studentTypeId: null }, company, after)).toEqual([]);
  });

  it("an empty cache before (the first read of a company) finds nothing", () => {
    expect(studentMoves(layered, [], company)).toEqual([]);
  });

  it("many moves at once, in QuickBooks ID order as numbers", () => {
    const before = [p("10", "1"), p("20", "1"), ...Array.from({ length: 40 }, (_, i) => p(String(100 + i * 7), "3", i % 2 ? "10" : "20"))];
    const after = before.map((c) => (c.typeQboId === "3" ? { ...c, parentQboId: c.parentQboId === "10" ? "20" : "10" } : c));
    const found = studentMoves(layered, [...before].reverse(), [...after].reverse());
    expect(found).toHaveLength(40);
    expect(found.map((m) => Number(m.studentQboId))).toEqual([...found.map((m) => Number(m.studentQboId))].sort((a, b) => a - b));
    expect(found.every((m) => m.fromFamilyQboId !== m.toFamilyQboId)).toBe(true);
  });
});
