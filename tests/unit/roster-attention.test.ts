import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { needsAttention, type SignIn } from "@/lib/roster/attention";

const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const layered = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;
const signIn = (familyQboId: string, status: SignIn["status"] = "active", email = "p@example.com"): SignIn => ({ guardianId: `g-${familyQboId}-${email}`, familyQboId, name: "P", email, status });
const rules = (customers: Cust[], shape: Parameters<typeof buildRoster>[0] = layered, signIns: SignIn[] = []) =>
  needsAttention(buildRoster(shape, customers), shape, signIns).map((a) => `${a.rule}:${a.qboId ?? a.name}`).sort();

const tidy: Cust[] = [c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10", { email: "ana@example.com" }), c("12", "Leo Rivera", "3", "10")];

describe("Needs attention", () => {
  it("finds nothing wrong with a tidy family", () => {
    expect(rules(tidy, layered, [signIn("10")])).toEqual([]);
  });
  it("a family with no parent, only when a parent type is set", () => {
    const company = [c("10", "Rivera Family", "1"), c("12", "Leo Rivera", "3", "10")];
    expect(rules(company)).toEqual(["family_no_parent:10"]);
    expect(rules(company, { ...layered, parentTypeId: null })).toEqual([]);
  });
  it("a family with no student, only when a student type is set", () => {
    const company = [c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10", { email: "ana@example.com" })];
    expect(rules(company)).toEqual(["family_no_student:10"]);
    expect(rules(company, { ...layered, studentTypeId: null })).toEqual([]);
  });
  it("an inactive parent or student doesn't count as one", () => {
    expect(rules([c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10", { email: "a@example.com", active: false }), c("12", "Leo Rivera", "3", "10")]))
      .toEqual(["family_no_parent:10"]);
  });
  it("a student or parent that isn't directly under a family", () => {
    expect(rules([...tidy, c("50", "Stray Student", "3"), c("51", "Stray Parent", "2", "12", { email: "s@example.com" })]))
      .toEqual(["not_under_family:50", "not_under_family:51"]);
  });
  it("a family that is itself a sub-customer", () => {
    expect(rules([...tidy, c("80", "Nested Family", "1", "10"), c("81", "N Parent", "2", "80", { email: "n@example.com" }), c("82", "N Student", "3", "80")]))
      .toEqual(["family_is_sub:80"]);
  });
  it("a parent with no email, and a flat member with no email", () => {
    expect(rules([c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10"), c("12", "Leo Rivera", "3", "10")])).toEqual(["no_email:11"]);
    expect(rules([c("12", "Leo Rivera", "3"), c("13", "Zoe Rivera", "3", null, { email: "z@example.com" })], { kind: "flat", memberTypeIds: ["3"] })).toEqual(["no_email:12"]);
  });
  it("two parents in the same family with the same email, but not the same person in two families", () => {
    const twice = [...tidy, c("15", "Ana Again", "2", "10", { email: "ana@example.com" })];
    expect(rules(twice)).toEqual(["same_email:11", "same_email:15"]);
    const twoFamilies = [...tidy, c("20", "Chen Family", "1"), c("21", "Ana Rivera", "2", "20", { email: "ana@example.com" }), c("22", "Bo Chen", "3", "20")];
    expect(rules(twoFamilies)).toEqual([]);
  });
  it("two flat members with the same email", () => {
    expect(rules([c("12", "Leo", "3", null, { email: "x@example.com" }), c("13", "Zoe", "3", null, { email: "x@example.com" })], { kind: "flat", memberTypeIds: ["3"] }))
      .toEqual(["same_email:12", "same_email:13"]);
  });
  it("leaves inactive customers out of the clean-up rules", () => {
    expect(rules([c("40", "Old Family", "1", null, { active: false }), c("41", "Old Stray", "3", null, { active: false })])).toEqual([]);
  });
  it("a portal sign-in whose QuickBooks ID isn't a family or a member", () => {
    expect(rules(tidy, layered, [signIn("POC-FAMILY-1"), signIn("11")])).toEqual(["signin_unknown:P (p@example.com)", "signin_unknown:P (p@example.com)"]);
    expect(rules([c("12", "Leo", "3", null, { email: "l@example.com" })], { kind: "flat", memberTypeIds: ["3"] }, [signIn("12"), signIn("99")])).toEqual(["signin_unknown:P (p@example.com)"]);
  });
  it("an inactive family that still has a sign-in that isn't disabled", () => {
    const company = [c("40", "Old Family", "1", null, { active: false })];
    expect(rules(company, layered, [signIn("40", "active")])).toEqual(["inactive_with_signin:40"]);
    expect(rules(company, layered, [signIn("40", "invited")])).toEqual(["inactive_with_signin:40"]);
    expect(rules(company, layered, [signIn("40", "disabled")])).toEqual([]);
  });
  it("says each problem in plain words", () => {
    const [item] = needsAttention(buildRoster(layered, [c("10", "Rivera Family", "1"), c("12", "Leo Rivera", "3", "10")]), layered, []);
    expect(item).toEqual({ rule: "family_no_parent", qboId: "10", name: "Rivera Family", detail: "No parent is listed under this family in QuickBooks." });
  });
});
