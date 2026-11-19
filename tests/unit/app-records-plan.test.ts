import { describe, it, expect } from "vitest";
import { planAppRecords, planForOneFamily, type PlanCustomer, type PlanGuardian, type PlanInput } from "@/lib/families/plan";
import { recordNameWords } from "@/lib/families/words";

/** The rules of the app's own records (src/lib/families/plan.ts), with no database. */
const LAYERED = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" } as const;
const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, active = true): PlanCustomer =>
  ({ qboId, displayName, typeQboId, parentQboId, active });
const g = (id: string, familyQboId: string, sourceQboId: string | null, o: Partial<PlanGuardian> = {}): PlanGuardian =>
  ({ id, familyQboId, sourceQboId, status: "active", disabledReason: null, ...o });
const input = (o: Partial<PlanInput>): PlanInput => ({ shape: LAYERED, customers: [], refs: [], hints: new Map(), guardians: [], ...o });

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

  it("makes a record of the kind a record names a customer as, inactive where the roster doesn't hold it as that kind", () => {
    const plan = planAppRecords(input({
      customers: [c("10", "Rivera Family", "F"), c("12", "Leo Rivera", "S", "10"), c("30", "Lincoln High", "M")],
      refs: [{ customerId: "30", kind: "family" }, { customerId: "77", kind: "family" }, { customerId: "78", kind: "student" }, { customerId: "79", kind: "student" },
        { customerId: "12", kind: "family" }, { customerId: "10", kind: "student" }, { customerId: "77", kind: "student" }],
      hints: new Map([["78", "Gone Student"], ["30", "Not this name"]]),
      known: { families: new Map([["77", "Known Family"]]), students: new Map() },
    }));
    expect(plan.families.get("30")).toEqual({ name: "Lincoln High", active: false });        // the cache's name first
    expect(plan.families.get("77")).toEqual({ name: "Known Family", active: false });        // then the name its record has
    expect(plan.students.get("77")).toEqual({ name: null, active: false, familyCustomerId: null }); // no name known for that kind
    expect(plan.students.get("78")).toEqual({ name: "Gone Student", active: false, familyCustomerId: null });
    expect(plan.students.get("79")).toEqual({ name: null, active: false, familyCustomerId: null });
    // Named as the other kind: both records, the roster's kind active, the other not.
    expect(plan.students.get("12")).toEqual({ name: "Leo Rivera", active: true, familyCustomerId: "10" });
    expect(plan.families.get("12")).toEqual({ name: "Leo Rivera", active: false });
    expect(plan.families.get("10")).toEqual({ name: "Rivera Family", active: true });
    expect(plan.students.get("10")).toEqual({ name: "Rivera Family", active: false, familyCustomerId: null });
  });

  it("puts each guardian row in its family, but one a change of company closed, and links each from a record of its own", () => {
    const plan = planAppRecords(input({
      customers: [c("10", "Rivera Family", "F"), c("11", "Ana Rivera", "P", "10"), c("20", "Chen Family", "F")],
      guardians: [g("b", "10", "11"), g("a", "20", "SHARED"), g("c", "10", "SHARED"), g("d", "10", null), g("e", "20", "20"), g("f", "10", "15", { status: "disabled", disabledReason: "inactive" }),
        g("h", "OLD", "OLD-P", { status: "disabled", disabledReason: "company_changed" }), g("i", "10", "20")],
    }));
    expect(Object.fromEntries(plan.memberships)).toEqual({ a: "20", b: "10", c: "10", d: "10", e: "20", f: "10", h: null, i: "10" });
    expect(plan.families.has("OLD")).toBe(false);
    // Open or closed, and two from one record; never one made by hand, one from the family's own record, or another company's.
    expect(Object.fromEntries(plan.membershipLinks)).toEqual({ a: "SHARED", b: "11", c: "SHARED", f: "15", i: "20" });
  });

  it("a record with no name known is said so in words, never given a made-up name", () => {
    expect(recordNameWords(null, "family")).toBe("A family whose name the portal doesn't know");
    expect(recordNameWords(" ", "student")).toBe("A student whose name the portal doesn't know");
    expect(recordNameWords("Rivera Family", "family")).toBe("Rivera Family");
  });

  it("in flat books a member is a family of one, with no students and no link for its sign-in", () => {
    const plan = planAppRecords(input({ shape: { kind: "flat", memberTypeIds: ["M"] }, customers: [c("1", "Dana", "M"), c("2", "Eli", "M", null, false), c("3", "A family type", "F")],
      guardians: [g("a", "1", "1")] }));
    expect([...plan.families.keys()]).toEqual(["1", "2"]);
    expect(plan.students.size).toBe(0);
    expect(plan.membershipLinks.size).toBe(0);
  });
});

describe("planForOneFamily", () => {
  // "Create a family from this" (src/lib/roster/no-family.ts): the import's own plan, narrowed to one family customer.
  const whole = planAppRecords(input({
    customers: [c("10", "Rivera Family", "F"), c("11", "Ana Rivera", "P", "10"), c("12", "Leo Rivera", "S", "10"), c("13", "Mia Rivera", "S", "10", false),
      c("20", "Chen Family", "F"), c("22", "Mei Chen", "S", "20"), c("30", "Lincoln High", "M")],
    guardians: [g("a", "10", "11"), g("b", "20", null)],
  }));

  it("holds that family's record and its students' as the whole plan has them, and nobody else's", () => {
    const one = planForOneFamily(whole, "10");
    expect([...one.families]).toEqual([["10", { name: "Rivera Family", active: true }]]);
    expect([...one.students]).toEqual([
      ["12", { name: "Leo Rivera", active: true, familyCustomerId: "10" }],
      ["13", { name: "Mia Rivera", active: false, familyCustomerId: "10" }],
    ]);
  });

  it("points and links no guardian row", () => {
    const one = planForOneFamily(whole, "10");
    expect(one.memberships.size).toBe(0);
    expect(one.membershipLinks.size).toBe(0);
  });

  it("is empty for a customer the plan holds no family record of: a student, another type, one it doesn't know", () => {
    for (const id of ["12", "30", "99"]) {
      const one = planForOneFamily(whole, id);
      expect([one.families.size, one.students.size], id).toEqual([0, 0]);
    }
  });
});
