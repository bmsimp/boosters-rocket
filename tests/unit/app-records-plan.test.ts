import { describe, it, expect } from "vitest";
import { planAppRecords, planForOneFamily, type PlanCustomer, type PlanInput } from "@/lib/families/plan";
import { recordNameWords } from "@/lib/families/words";

/** The rules of the app's own records (src/lib/families/plan.ts), with no database. */
const LAYERED = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" } as const;
const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, active = true): PlanCustomer =>
  ({ qboId, displayName, typeQboId, parentQboId, active });
const input = (o: Partial<PlanInput>): PlanInput => ({ shape: LAYERED, customers: [], ...o });

describe("planAppRecords", () => {
  it("makes a record of each family of the roster, and of each student directly under one", () => {
    const plan = planAppRecords(input({ customers: [c("10", "Rivera Family", "F"), c("11", "Ana Rivera", "P", "10"), c("12", "Leo Rivera", "S", "10"),
      c("13", "Mia Rivera", "S", "10", false), c("40", "Old Family", "F", null, false), c("50", "Stray Student", "S"), c("51", "Under a student", "S", "12"), c("30", "Lincoln High", "M")] }));
    expect([...plan.families]).toEqual([["10", { name: "Rivera Family", active: true }], ["40", { name: "Old Family", active: false }]]);
    expect([...plan.students]).toEqual([
      ["12", { name: "Leo Rivera", active: true, familyCustomerId: "10" }],
      ["13", { name: "Mia Rivera", active: false, familyCustomerId: "10" }],
    ]);
  });

  it("plans only what the roster holds, each record of its own kind: a customer of another type, or a student under no family, has none", () => {
    const plan = planAppRecords(input({ customers: [c("10", "Rivera Family", "F"), c("12", "Leo Rivera", "S", "10"), c("30", "Lincoln High", "M"), c("50", "Stray", "S")] }));
    expect([...plan.families.keys()]).toEqual(["10"]);
    expect([...plan.students.keys()]).toEqual(["12"]);
  });

  it("holds families and students alone: guardian rows are not the import's (stage 3's slice 12b1)", () => {
    const plan = planAppRecords(input({ customers: [c("10", "Rivera Family", "F"), c("11", "Ana Rivera", "P", "10"), c("20", "Chen Family", "F")] }));
    expect(Object.keys(plan).sort()).toEqual(["families", "students"]);
    expect([...plan.families.keys()]).toEqual(["10", "20"]); // the Parent customer is no record of the import's
  });

  it("a record with no name known is said so in words, never given a made-up name", () => {
    expect(recordNameWords(null, "family")).toBe("A family whose name the portal doesn't know");
    expect(recordNameWords(" ", "student")).toBe("A student whose name the portal doesn't know");
    expect(recordNameWords("Rivera Family", "family")).toBe("Rivera Family");
  });

  it("in flat books a member is a family of one, with no students", () => {
    const plan = planAppRecords(input({ shape: { kind: "flat", memberTypeIds: ["M"] }, customers: [c("1", "Dana", "M"), c("2", "Eli", "M", null, false), c("3", "A family type", "F")] }));
    expect([...plan.families.keys()]).toEqual(["1", "2"]);
    expect(plan.students.size).toBe(0);
  });
});

describe("planForOneFamily", () => {
  // "Create a family from this" (src/lib/roster/no-family.ts): the import's own plan, narrowed to one family customer.
  const whole = planAppRecords(input({
    customers: [c("10", "Rivera Family", "F"), c("11", "Ana Rivera", "P", "10"), c("12", "Leo Rivera", "S", "10"), c("13", "Mia Rivera", "S", "10", false),
      c("20", "Chen Family", "F"), c("22", "Mei Chen", "S", "20"), c("30", "Lincoln High", "M")],
  }));

  it("holds that family's record and its students' as the whole plan has them, and nobody else's", () => {
    const one = planForOneFamily(whole, "10");
    expect([...one.families]).toEqual([["10", { name: "Rivera Family", active: true }]]);
    expect([...one.students]).toEqual([
      ["12", { name: "Leo Rivera", active: true, familyCustomerId: "10" }],
      ["13", { name: "Mia Rivera", active: false, familyCustomerId: "10" }],
    ]);
  });

  it("holds a family and its students alone, as the whole plan does", () => {
    expect(Object.keys(planForOneFamily(whole, "10")).sort()).toEqual(["families", "students"]);
  });

  it("is empty for a customer the plan holds no family record of: a student, another type, one it doesn't know", () => {
    for (const id of ["12", "30", "99"]) {
      const one = planForOneFamily(whole, id);
      expect([one.families.size, one.students.size], id).toEqual([0, 0]);
    }
  });
});
