import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";
import type { MembershipShape } from "@/lib/roster/shape";
import { decideAccess, type HoldSets } from "@/lib/parents/access-rules";

const LAYERED: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" };
const NO_PARENT: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null };
const NO_STUDENT: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" };
const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["M"] };

const c = (qboId: string, displayName: string, typeQboId: string, o: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId: null, typeQboId, email: null, phone: null, ...o });
const fam = (id: string, name: string, o: Partial<Cust> = {}) => c(id, name, "F", o);
const par = (id: string, name: string, family: string, email: string | null, o: Partial<Cust> = {}) => c(id, name, "P", { parentQboId: family, email, ...o });
const stu = (id: string, name: string, family: string, o: Partial<Cust> = {}) => c(id, name, "S", { parentQboId: family, ...o });

const decide = (shape: MembershipShape, customers: Cust[], o: { holds?: Record<string, HoldSets>; requireActiveStudents?: boolean } = {}) =>
  decideAccess({ roster: buildRoster(shape, customers), shape, holds: new Map(Object.entries(o.holds ?? {})), requireActiveStudents: o.requireActiveStudents ?? false });
const grants = (d: ReturnType<typeof decide>) => d.grants.map((g) => `${g.email}>${g.familyQboId}`).sort();
const denied = (d: ReturnType<typeof decide>) => d.denials.map((x) => `${x.sourceQboId}:${x.reason}`).sort();
const rules = (d: ReturnType<typeof decide>) => d.flags.map((f) => `${f.rule}:${f.qboId}`).sort();

describe("decideAccess, layered with a parent type", () => {
  it("gives each active parent with an address access to the family it sits under", () => {
    const d = decide(LAYERED, [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("12", "Leo Rivera", "10", "leo@example.com"), stu("13", "Kid", "10")]);
    expect(d.grants).toEqual([
      { email: "ana@example.com", familyQboId: "10", sourceQboId: "11", name: "Ana Rivera" },
      { email: "leo@example.com", familyQboId: "10", sourceQboId: "12", name: "Leo Rivera" },
    ]);
    expect(d.denials).toEqual([]); expect(d.held).toEqual([]); expect(d.flags).toEqual([]);
  });

  it("never grants through the family customer's own address", () => {
    const d = decide(LAYERED, [fam("10", "Rivera Family", { email: "family@example.com" })]);
    expect(d.grants).toEqual([]);
    expect(rules(d)).toEqual(["family_no_signin:10"]);
  });

  it.each([
    ["an inactive parent", [fam("10", "R"), par("11", "Ana", "10", "ana@example.com", { active: false })], ["11:inactive"]],
    ["an inactive family", [fam("10", "R", { active: false }), par("11", "Ana", "10", "ana@example.com")], ["11:family_inactive"]],
    ["no address", [fam("10", "R"), par("11", "Ana", "10", null)], ["11:no_email"]],
    ["an unusable address", [fam("10", "R"), par("11", "Ana", "10", "call the office")], ["11:no_email"]],
  ])("refuses %s", (_label, customers, want) => {
    const d = decide(LAYERED, customers as Cust[]);
    expect(grants(d)).toEqual([]);
    expect(denied(d)).toEqual(want);
  });

  it("flags an unusable address, and a family nobody can sign in to, but not an inactive family", () => {
    expect(rules(decide(LAYERED, [fam("10", "R"), par("11", "Ana", "10", "call the office")]))).toEqual(["bad_email:11", "family_no_signin:10"]);
    expect(rules(decide(LAYERED, [fam("10", "R", { active: false }), par("11", "Ana", "10", "ana@example.com")]))).toEqual([]);
  });

  it("uses the first address on a parent record and flags the rest", () => {
    const d = decide(LAYERED, [fam("10", "R"), par("11", "Ana", "10", "ana@example.com, leo@example.com")]);
    expect(grants(d)).toEqual(["ana@example.com>10"]);
    expect(rules(d)).toEqual(["many_addresses:11"]);
  });

  it("gives one sign-in when two parents in one family share an address, from the lower QuickBooks ID", () => {
    const d = decide(LAYERED, [fam("10", "R"), par("100", "Leo Rivera", "10", "shared@example.com"), par("9", "Ana Rivera", "10", "shared@example.com")]);
    expect(d.grants).toEqual([{ email: "shared@example.com", familyQboId: "10", sourceQboId: "9", name: "Ana Rivera" }]);
    expect(d.held).toEqual([]);
    expect(rules(d)).toEqual(["name_differs:9"]);
  });

  it("holds an address that is under two families, for both, until staff approve it", () => {
    const customers = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana R.", "20", " ANA@example.com ")];
    const d = decide(LAYERED, customers);
    expect(grants(d)).toEqual([]);
    expect(denied(d)).toEqual(["11:held", "21:held"]);
    expect(d.held).toEqual([{ email: "ana@example.com", pending: true, names: ["Ana Rivera", "Ana R."],
      families: [{ qboId: "10", name: "Rivera Family", held: true }, { qboId: "20", name: "Chen Family", held: true }] }]);
    expect(rules(d)).toEqual(["family_no_signin:10", "family_no_signin:20", "held_address:null", "name_differs:11"]);
    expect(d.flags.find((x) => x.rule === "held_address")!.detail).toBe("This person's email address is under more than one family in QuickBooks. Once parent sign-ins are on, nobody at that address can sign in to those families until someone with access to Parents says whether it is one person.");
    for (const f of d.flags.filter((x) => x.rule === "held_address" || x.rule === "name_differs")) for (const text of [f.name, f.detail]) { expect(text).not.toContain("ana@example.com"); expect(text).not.toContain("Chen"); }

    const approved = decide(LAYERED, customers, { holds: { "ana@example.com": { approved: ["10", "20"], rejected: [] } } });
    expect(grants(approved)).toEqual(["ana@example.com>10", "ana@example.com>20"]);
    expect(approved.held).toEqual([]);
    expect(approved.personNames.get("ana@example.com")).toBe("Ana Rivera");
  });

  it("holds only the new family when an approved address turns up under a third", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com"), fam("30", "C"), par("31", "Ana", "30", "ana@example.com")];
    const d = decide(LAYERED, customers, { holds: { "ana@example.com": { approved: ["10", "20"], rejected: [] } } });
    expect(grants(d)).toEqual(["ana@example.com>10", "ana@example.com>20"]);
    expect(denied(d)).toEqual(["31:held"]);
    expect(d.held[0]).toMatchObject({ pending: true, families: [{ qboId: "10", held: false }, { qboId: "20", held: false }, { qboId: "30", held: true }] });
  });

  it("keeps a rejected address held, and no longer waiting, until another family appears", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com")];
    const rejected = { "ana@example.com": { approved: [], rejected: ["10", "20"] } };
    expect(decide(LAYERED, customers, { holds: rejected }).held[0]).toMatchObject({ pending: false });
    expect(grants(decide(LAYERED, customers, { holds: rejected }))).toEqual([]);
    const more = [...customers, fam("30", "C"), par("31", "Ana", "30", "ana@example.com")];
    expect(decide(LAYERED, more, { holds: rejected }).held[0]).toMatchObject({ pending: true });
  });

  it("stops holding when the address is back under one family", () => {
    const d = decide(LAYERED, [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com", { active: false })]);
    expect(grants(d)).toEqual(["ana@example.com>10"]);
    expect(d.held).toEqual([]);
  });

  it("applies the active-students setting only when it is on", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), stu("12", "Kid", "10", { active: false }), fam("20", "B"), par("21", "Bo", "20", "bo@example.com"), stu("22", "Kid", "20")];
    expect(grants(decide(LAYERED, customers))).toEqual(["ana@example.com>10", "bo@example.com>20"]);
    const on = decide(LAYERED, customers, { requireActiveStudents: true });
    expect(grants(on)).toEqual(["bo@example.com>20"]);
    expect(denied(on)).toEqual(["11:no_active_students"]);
  });

  describe("the active-students setting and a held address", () => {
    const customers = [fam("10", "A"), par("11", "Ana", "10", "ana@example.com"), fam("20", "B"), par("21", "Ana", "20", "ana@example.com"), stu("22", "Kid", "20")];
    const approved = { "ana@example.com": { approved: ["10", "20"], rejected: [] } };

    it("keeps an address held when one of its families has no active students", () => {
      const d = decide(LAYERED, customers, { requireActiveStudents: true });
      expect(grants(d)).toEqual([]);
      expect(denied(d)).toEqual(["11:held", "21:held"]);
      expect(d.held).toHaveLength(1);
      expect(d.held[0]).toMatchObject({ pending: true, families: [{ qboId: "10", held: true }, { qboId: "20", held: true }] });
    });

    it("once approved, grants only the family that has an active student", () => {
      const d = decide(LAYERED, customers, { requireActiveStudents: true, holds: approved });
      expect(grants(d)).toEqual(["ana@example.com>20"]);
      expect(denied(d)).toEqual(["11:no_active_students"]);
      expect(d.denials.find((x) => x.sourceQboId === "11")?.email).toBe("ana@example.com");
    });

    it("with the setting off, an approved address is granted to both", () => {
      expect(grants(decide(LAYERED, customers, { holds: approved }))).toEqual(["ana@example.com>10", "ana@example.com>20"]);
    });
  });

  it("flags a second record in a family that repeats an address its field did not match exactly", () => {
    const d = decide(LAYERED, [fam("10", "R"), par("11", "Ana", "10", "ana@x.com, leo@x.com"), par("12", "Ana", "10", "ana@x.com")]);
    expect(d.grants.filter((g) => g.email === "ana@x.com")).toEqual([{ email: "ana@x.com", familyQboId: "10", sourceQboId: "11", name: "Ana" }]);
    expect(rules(d)).toEqual(expect.arrayContaining(["same_address_in_family:12", "many_addresses:11"]));
  });

  it("does not add that flag when the two fields are identical (the roster's own rule covers it)", () => {
    const d = decide(LAYERED, [fam("10", "R"), par("11", "Ana", "10", "ana@x.com"), par("12", "Ana", "10", "ana@x.com")]);
    expect(rules(d).filter((r) => r.startsWith("same_address_in_family"))).toEqual([]);
  });

  it("ignores the active-students setting when the shape names no student type", () => {
    const d = decide(NO_STUDENT, [fam("10", "A"), par("11", "Ana", "10", "ana@example.com")], { requireActiveStudents: true });
    expect(grants(d)).toEqual(["ana@example.com>10"]);
  });
});

describe("decideAccess, other shapes", () => {
  it("layered with no parent type: every address on the family customer signs in to that family", () => {
    const d = decide(NO_PARENT, [fam("10", "Rivera Family", { email: "ana@example.com; leo@example.com" }), fam("20", "Chen Family")]);
    expect(d.grants).toEqual([
      { email: "ana@example.com", familyQboId: "10", sourceQboId: "10", name: "Rivera Family" },
      { email: "leo@example.com", familyQboId: "10", sourceQboId: "10", name: "Rivera Family" },
    ]);
    expect(denied(d)).toEqual(["20:no_email"]);
    expect(rules(d)).toEqual(["family_no_signin:20", "no_email:20"]);
  });

  it("flat: each member signs in to their own record, by their first address", () => {
    const d = decide(FLAT, [c("5", "Ana Rivera", "M", { email: "ana@example.com" }), c("6", "Old Member", "M", { email: "old@example.com", active: false }), c("7", "Vendor", "V", { email: "v@example.com" })]);
    expect(d.grants).toEqual([{ email: "ana@example.com", familyQboId: "5", sourceQboId: "5", name: "Ana Rivera" }]);
    expect(denied(d)).toEqual(["6:inactive"]);
  });

  it("flat: one address on two members is held like any repeat across families", () => {
    const d = decide(FLAT, [c("5", "Ana", "M", { email: "ana@example.com" }), c("6", "Ana Two", "M", { email: "ana@example.com" })]);
    expect(grants(d)).toEqual([]);
    expect(denied(d)).toEqual(["5:held", "6:held"]);
    expect(d.held).toHaveLength(1);
    expect(d.held[0]!.families).toEqual([{ qboId: "5", name: "Ana", held: true }, { qboId: "6", name: "Ana Two", held: true }]);
  });
});

describe("decideAccess is pure and steady", () => {
  it("returns the same answer for the same input, in a fixed order, without changing its input", () => {
    const customers = [fam("20", "B"), par("21", "Bo", "20", "bo@example.com"), fam("10", "A"), par("11", "Ana", "10", "ana@example.com")];
    const frozen = JSON.stringify(customers);
    const a = decide(LAYERED, customers), b = decide(LAYERED, [...customers].reverse());
    const whole = (d: ReturnType<typeof decide>) => ({ grants: d.grants, denials: d.denials, held: d.held, flags: d.flags, personNames: [...d.personNames.entries()] });
    expect(whole(a)).toEqual(whole(b));
    expect(a.grants.map((g) => g.familyQboId)).toEqual(["10", "20"]);
    expect(JSON.stringify(customers)).toBe(frozen);
  });
});
