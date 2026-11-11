import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";

const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const company: Cust[] = [
  c("20", "Chen Family", "1"), c("10", "Rivera Family", "1"),
  c("11", "Ana Rivera", "2", "10"), c("12", "Leo Rivera", "3", "10"), c("13", "Zoe Rivera", "3", "10", { active: false }),
  c("14", "Deep Student", "3", "12"), // under a student, not directly under a family
  c("21", "Mei Chen", "2", "20"),
  c("30", "Lincoln High", "4"), c("50", "Stray Student", "3"), c("60", "No Type", null),
  c("70", "Typed Parent Under School", "2", "30"),
];
const layered = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;

describe("building the roster from cached customers", () => {
  it("layered: families in name order with the students and parents directly under them", () => {
    const r = buildRoster(layered, company);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families.map((f) => f.customer.displayName)).toEqual(["Chen Family", "Rivera Family"]);
    const rivera = r.families[1]!;
    expect(rivera.parents.map((p) => p.displayName)).toEqual(["Ana Rivera"]);
    expect(rivera.students.map((s) => s.displayName)).toEqual(["Leo Rivera", "Zoe Rivera"]);
    expect(r.strays.map((s) => s.displayName).sort()).toEqual(["Deep Student", "Stray Student", "Typed Parent Under School"]);
    expect(r.outside).toBe(2); // Lincoln High and No Type
  });
  it("layered with the student type blank: no students, and Student customers are outside", () => {
    const r = buildRoster({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" }, company);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families.every((f) => f.students.length === 0)).toBe(true);
    expect(r.strays.map((s) => s.displayName)).toEqual(["Typed Parent Under School"]);
    expect(r.outside).toBe(6);
  });
  it("layered with both blank: families only", () => {
    const r = buildRoster({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null }, company);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families).toHaveLength(2);
    expect(r.families.every((f) => f.students.length + f.parents.length === 0)).toBe(true);
    expect(r.strays).toEqual([]);
  });
  it("a family-typed customer that is itself a sub-customer is still a family", () => {
    const r = buildRoster(layered, [...company, c("80", "Nested Family", "1", "10")]);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families.map((f) => f.customer.qboId)).toContain("80");
  });
  it("flat: every customer of the member types, in name order, whatever they sit under", () => {
    const r = buildRoster({ kind: "flat", memberTypeIds: ["3", "2"] }, company);
    if (r.kind !== "flat") throw new Error("expected flat");
    expect(r.members.map((m) => m.displayName)).toEqual(["Ana Rivera", "Deep Student", "Leo Rivera", "Mei Chen", "Stray Student", "Typed Parent Under School", "Zoe Rivera"]);
    expect(r.outside).toBe(4);
  });
});
