import { describe, it, expect } from "vitest";
import { parseShapeForm, shapeTypeIds, missingTypes, describeShape, type TypeRow } from "@/lib/roster/shape";

const types: TypeRow[] = [
  { qboId: "1", name: "Family", active: true }, { qboId: "2", name: "Parent", active: true }, { qboId: "3", name: "Student", active: true },
  { qboId: "4", name: "School", active: true },
];

describe("the membership shape", () => {
  it("reads a layered shape, with student and parent optional", () => {
    expect(parseShapeForm({ kind: "layered", family: "1", student: "3", parent: "2" }, types))
      .toEqual({ ok: true, shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } });
    expect(parseShapeForm({ kind: "layered", family: "1", student: "", parent: "" }, types))
      .toEqual({ ok: true, shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null } });
  });
  it("reads a flat shape with one or several types, without repeats", () => {
    expect(parseShapeForm({ kind: "flat", members: ["3"] }, types)).toEqual({ ok: true, shape: { kind: "flat", memberTypeIds: ["3"] } });
    expect(parseShapeForm({ kind: "flat", members: ["3", "2", "3"] }, types)).toEqual({ ok: true, shape: { kind: "flat", memberTypeIds: ["3", "2"] } });
  });
  it.each([
    [{ kind: "layered", family: "", student: "3" }, "Choose which customer type is a family."],
    [{ kind: "layered", family: "9" }, "Choose customer types from the list."],
    [{ kind: "layered", family: "1", student: "1" }, "A customer type can have only one role."],
    [{ kind: "layered", family: "1", student: "3", parent: "3" }, "A customer type can have only one role."],
    [{ kind: "flat", members: [] }, "Choose at least one customer type for members."],
    [{ kind: "flat", members: ["9"] }, "Choose customer types from the list."],
    [{ kind: "other" }, "Choose flat or layered."],
  ])("refuses %j", (form, message) => {
    expect(parseShapeForm(form, types)).toEqual({ ok: false, errors: [message] });
  });
  it("lists the types a shape names", () => {
    expect(shapeTypeIds(null)).toEqual([]);
    expect(shapeTypeIds({ kind: "flat", memberTypeIds: ["3", "2"] })).toEqual(["3", "2"]);
    expect(shapeTypeIds({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" })).toEqual(["1", "2"]);
  });
  it("finds types QuickBooks no longer has", () => {
    expect(missingTypes({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "8" }, types)).toEqual(["8"]);
    expect(missingTypes({ kind: "flat", memberTypeIds: ["3"] }, types)).toEqual([]);
  });
  it("says the shape in words", () => {
    expect(describeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" }, types))
      .toBe("Layered: families are Family, students are Student, parents are Parent.");
    expect(describeShape({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null }, types))
      .toBe("Layered: families are Family. Students and parents aren't identified in QuickBooks.");
    expect(describeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, types))
      .toBe("Layered: families are Family, students are Student. Parents aren't identified in QuickBooks.");
    expect(describeShape({ kind: "flat", memberTypeIds: ["3", "2"] }, types)).toBe("Flat: members are Student and Parent.");
    expect(describeShape({ kind: "flat", memberTypeIds: ["8"] }, types)).toBe("Flat: members are a type QuickBooks no longer has.");
  });
});
