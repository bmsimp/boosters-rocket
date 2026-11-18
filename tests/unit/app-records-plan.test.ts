import { describe, it, expect } from "vitest";
import { planAppRecords, type PlanCustomer, type PlanGuardian, type PlanInput } from "@/lib/families/plan";

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

  it("makes an inactive record of a customer a record names that the roster doesn't hold as one, named from what the portal last knew", () => {
    const plan = planAppRecords(input({
      customers: [c("10", "Rivera Family", "F"), c("12", "Leo Rivera", "S", "10"), c("30", "Lincoln High", "M")],
      refs: [{ customerId: "30", kind: "family" }, { customerId: "77", kind: "family" }, { customerId: "78", kind: "student" }, { customerId: "79", kind: "student" },
        { customerId: "12", kind: "family" }, { customerId: "77", kind: "student" }],
      hints: new Map([["78", "Gone Student"], ["30", "Not this name"]]),
    }));
    expect(plan.families.get("30")).toEqual({ name: "Lincoln High", active: false });       // the cache's name first
    expect(plan.families.get("77")).toEqual({ name: "Family 77", active: false });          // named a family and a student: a family
    expect(plan.students.get("78")).toEqual({ name: "Gone Student", active: false, familyCustomerId: null });
    expect(plan.students.get("79")).toEqual({ name: "Student 79", active: false, familyCustomerId: null });
    expect(plan.families.has("12")).toBe(false);                                            // the roster's student stays a student
    expect(plan.students.has("77")).toBe(false);
  });

  it("puts each guardian row in its family, but one a change of company closed, and links the sign-ins from a record of their own", () => {
    const plan = planAppRecords(input({
      customers: [c("10", "Rivera Family", "F"), c("11", "Ana Rivera", "P", "10"), c("20", "Chen Family", "F")],
      guardians: [g("b", "10", "11"), g("a", "20", "SHARED"), g("c", "10", "SHARED"), g("d", "10", null), g("e", "20", "20"), g("f", "10", "15", { status: "disabled", disabledReason: "inactive" }),
        g("h", "OLD", "OLD-P", { status: "disabled", disabledReason: "company_changed" }), g("i", "10", "20")],
    }));
    expect(Object.fromEntries(plan.memberships)).toEqual({ a: "20", b: "10", c: "10", d: "10", e: "20", f: "10", h: null, i: "10" });
    expect(plan.families.has("OLD")).toBe(false);
    // The first row by id of two from one record; not one made by hand, one from the family's own record, a closed one,
    // or one whose record is a family's.
    expect(Object.fromEntries(plan.membershipLinks)).toEqual({ a: "SHARED", b: "11" });
  });

  it("in flat books a member is a family of one, with no students and no link for its sign-in", () => {
    const plan = planAppRecords(input({ shape: { kind: "flat", memberTypeIds: ["M"] }, customers: [c("1", "Dana", "M"), c("2", "Eli", "M", null, false), c("3", "A family type", "F")],
      guardians: [g("a", "1", "1")] }));
    expect([...plan.families.keys()]).toEqual(["1", "2"]);
    expect(plan.students.size).toBe(0);
    expect(plan.membershipLinks.size).toBe(0);
  });
});
