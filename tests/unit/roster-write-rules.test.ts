import { describe, it, expect } from "vitest";
import { NOT_HERE, offers, shapeOperations, typeForNew, type RosterOperation } from "@/lib/roster/operations";
import { checkName, freeName, NAME_MAX } from "@/lib/roster/names";
import { afterFailedTry, beforeResend, classify, emailStands, MAX_TRIES, type CachedCustomer } from "@/lib/roster/write-rules";
import type { MembershipShape } from "@/lib/roster/shape";

const FULL: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" };
const NO_PARENT: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null };
const NO_STUDENT: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" };
const BARE: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null };
const FLAT_ONE: MembershipShape = { kind: "flat", memberTypeIds: ["7"] };
const FLAT_TWO: MembershipShape = { kind: "flat", memberTypeIds: ["7", "8"] };
const sorted = (s: ReadonlySet<RosterOperation>) => [...s].sort();

describe("what each membership shape lets staff change (v1 spec §6.1)", () => {
  it("layered with a student type and a parent type: everything", () => {
    expect(sorted(shapeOperations(FULL).offered)).toEqual(["add_parent", "add_student", "create_family", "deactivate_family", "deactivate_parent", "deactivate_student",
      "move_student", "rename_family", "rename_parent", "rename_student"]);
    expect(shapeOperations(FULL).notOffered).toEqual([]);
  });

  it("layered with no parent type: no parent to add, rename or make inactive, and the page says the addresses are in the family's email field", () => {
    const ops = shapeOperations(NO_PARENT);
    expect(sorted(ops.offered)).toEqual(["add_student", "create_family", "deactivate_family", "deactivate_student", "move_student", "rename_family", "rename_student"]);
    expect(ops.notOffered).toEqual([{ operations: ["add_parent", "rename_parent", "deactivate_parent"], why: NOT_HERE.parentsInFamilyEmail }]);
    expect(NOT_HERE.parentsInFamilyEmail).toMatch(/family's email field.*changed in QuickBooks/);
  });

  it("layered with no student type: no student to add or move, and the page says the portal can't tell a student", () => {
    const ops = shapeOperations(NO_STUDENT);
    expect(ops.offered.has("add_student")).toBe(false);
    expect(ops.offered.has("move_student")).toBe(false);
    expect(ops.offered.has("add_parent")).toBe(true);
    expect(ops.notOffered[0]).toEqual({ operations: ["add_student", "move_student", "rename_student", "deactivate_student"], why: NOT_HERE.noStudents });
    expect(sorted(shapeOperations(BARE).offered)).toEqual(["create_family", "deactivate_family", "rename_family"]);
    expect(shapeOperations(BARE).notOffered).toHaveLength(2);
  });

  it("flat: make, rename and make inactive a member, and nothing else", () => {
    expect(sorted(shapeOperations(FLAT_ONE).offered)).toEqual(["create_member", "deactivate_member", "rename_member"]);
    expect(shapeOperations(FLAT_ONE).notOffered).toEqual([{ operations: [], why: NOT_HERE.flat }]);
    for (const op of ["create_family", "add_student", "add_parent", "move_student"] as const) expect(offers(FLAT_TWO, op)).toBe(false);
    expect(offers(FULL, "create_member")).toBe(false);
  });

  it("makes a new customer with the shape's type: for flat, the one member type, or the one chosen among several", () => {
    expect(typeForNew(FULL, "family", null)).toBe("1");
    expect(typeForNew(FULL, "student", null)).toBe("3");
    expect(typeForNew(FULL, "parent", null)).toBe("2");
    expect(typeForNew(NO_PARENT, "parent", null)).toBeNull();
    expect(typeForNew(FULL, "member", "1")).toBeNull();
    expect(typeForNew(FLAT_ONE, "member", null)).toBe("7");
    expect(typeForNew(FLAT_TWO, "member", null)).toBeNull();   // several: staff must choose
    expect(typeForNew(FLAT_TWO, "member", "8")).toBe("8");
    expect(typeForNew(FLAT_TWO, "member", "1")).toBeNull();    // not a member type
    expect(typeForNew(FLAT_TWO, "family", "7")).toBeNull();
  });
});

describe("a display name (v1 spec §6.1, name collisions)", () => {
  it("is trimmed, 1 to 100 characters, with no colon, tab or line break", () => {
    expect(checkName("  Rivera  Family ")).toEqual({ ok: true, name: "Rivera Family" });
    expect(checkName("")).toMatchObject({ ok: false });
    expect(checkName("   ")).toMatchObject({ ok: false });
    expect(checkName(42)).toMatchObject({ ok: false });
    expect(checkName("x".repeat(NAME_MAX))).toMatchObject({ ok: true });
    expect(checkName("x".repeat(NAME_MAX + 1))).toMatchObject({ ok: false, error: expect.stringContaining("100 characters") });
    expect(checkName("Rivera:Leo")).toMatchObject({ ok: false, error: expect.stringContaining("colon") });
    expect(checkName("Leo\tRivera")).toMatchObject({ ok: false, error: expect.stringContaining("one line") });
    expect(checkName("Leo\nRivera")).toMatchObject({ ok: false });
    expect(checkName(`Leo${String.fromCharCode(0x2028)}Rivera`)).toMatchObject({ ok: false });
  });

  it("that is taken is offered with the first free suffix, comparing names ignoring case", () => {
    expect(freeName("Smith Family", ["Jones Family"])).toBeNull();
    expect(freeName("Smith Family", ["smith family"])).toBe("Smith Family (2)");
    expect(freeName("Smith Family", ["Smith Family", "Smith Family (2)", "SMITH FAMILY (3)"])).toBe("Smith Family (4)");
    // An offered name that is taken in turn goes on from its base, not "(2) (2)".
    expect(freeName("Smith Family (2)", ["Smith Family", "Smith Family (2)"])).toBe("Smith Family (3)");
    // A suffixed name still fits in 100 characters.
    const long = "y".repeat(NAME_MAX);
    const offered = freeName(long, [long])!;
    expect(offered).toHaveLength(NAME_MAX);
    expect(offered.endsWith(" (2)")).toBe(true);
  });
});

describe("the write queue's rules (v1 spec §4, §8.4)", () => {
  it("tells a refusal, a stale record, a taken name and what may go through later apart", () => {
    expect(classify("fault_5010")).toEqual({ kind: "stale" });
    expect(classify("fault_6240")).toEqual({ kind: "duplicate" });
    expect(classify("fault_6000")).toEqual({ kind: "refused" });
    expect(classify("fault_2010")).toEqual({ kind: "refused" });
    expect(classify("http_400")).toEqual({ kind: "refused" });
    expect(classify("bad_id")).toEqual({ kind: "refused" });
    expect(classify("not_connected")).toEqual({ kind: "not_connected" });
    expect(classify("token_not_connected")).toEqual({ kind: "not_connected" });
    expect(classify("needs_admin")).toEqual({ kind: "needs_admin" });
    expect(classify("token_invalid_grant")).toEqual({ kind: "needs_admin" });
    expect(classify("token_unreadable")).toEqual({ kind: "needs_admin" });
    expect(classify("other_company")).toEqual({ kind: "other_company" });
    // Nothing was sent, or QuickBooks didn't act on it: safe to send again.
    expect(classify("token_busy")).toEqual({ kind: "retry", sent: false });
    expect(classify("token_unreachable")).toEqual({ kind: "retry", sent: false });
    expect(classify("http_429")).toEqual({ kind: "retry", sent: false });
    // It went, and nobody knows what QuickBooks did: looked for before it is sent again.
    for (const code of ["timeout", "unreachable", "bad_answer", "http_500", "http_503", "http_500_fault_10000"]) expect(classify(code), code).toEqual({ kind: "retry", sent: true });
  });

  it("backs off 1, 5, 15 and 60 minutes, then every 6 hours, and is stuck after 8 tries or 24 hours", () => {
    const made = new Date("2026-11-16T12:00:00Z"), now = new Date("2026-11-16T12:30:00Z");
    const wait = (tries: number) => { const r = afterFailedTry(tries, made, now); return r.state === "waiting" ? (r.nextTryAt.getTime() - now.getTime()) / 60_000 : r.state; };
    expect([1, 2, 3, 4, 5, 6, 7].map(wait)).toEqual([1, 5, 15, 60, 360, 360, 360]);
    expect(wait(MAX_TRIES)).toBe("stuck");
    expect(afterFailedTry(2, made, new Date(made.getTime() + 24 * 3_600_000 - 1))).toMatchObject({ state: "waiting" });
    expect(afterFailedTry(2, made, new Date(made.getTime() + 24 * 3_600_000))).toEqual({ state: "stuck" });
  });

  const c = (o: Partial<CachedCustomer> & { qboId: string }): CachedCustomer => ({ displayName: "x", active: true, parentQboId: null, typeQboId: "3", syncToken: "4", ...o });

  it("finds a create that QuickBooks made: the same name, under the same family, of the same type", () => {
    const w = { op: "create" as const, role: "student" as const, name: "Leo Rivera (2)", typeQboId: "3", familyQboId: "10", email: null };
    expect(beforeResend(w, [c({ qboId: "99", displayName: "leo rivera (2)", parentQboId: "10" })])).toEqual({ is: "done", qboId: "99" });
    expect(beforeResend(w, [c({ qboId: "99", displayName: "Leo Rivera (2)", parentQboId: "20" })])).toEqual({ is: "send" });
    expect(beforeResend(w, [c({ qboId: "99", displayName: "Leo Rivera (2)", parentQboId: "10", typeQboId: "2" })])).toEqual({ is: "send" });
    expect(beforeResend(w, [])).toEqual({ is: "send" });
  });

  it("finds an update already in place, and never sends one whose record moved on", () => {
    const rename = { op: "rename" as const, role: "student" as const, qboId: "12", syncToken: "4", name: "Leon Rivera", was: "Leo Rivera" };
    expect(beforeResend(rename, [c({ qboId: "12", displayName: "Leon Rivera", syncToken: "5" })])).toEqual({ is: "done", qboId: "12" });
    expect(beforeResend(rename, [c({ qboId: "12", displayName: "Leo Rivera", syncToken: "4" })])).toEqual({ is: "send" });
    expect(beforeResend(rename, [c({ qboId: "12", displayName: "Leo R.", syncToken: "5" })])).toEqual({ is: "stuck", code: "moved_on" });
    expect(beforeResend(rename, [])).toEqual({ is: "stuck", code: "gone" });
    const move = { op: "move" as const, role: "student" as const, qboId: "12", syncToken: "4", fromFamilyQboId: "10", toFamilyQboId: "20" };
    expect(beforeResend(move, [c({ qboId: "12", parentQboId: "20", syncToken: "5" })])).toEqual({ is: "done", qboId: "12" });
    expect(beforeResend(move, [c({ qboId: "12", parentQboId: "10", syncToken: "4" })])).toEqual({ is: "send" });
    const off = { op: "deactivate" as const, role: "family" as const, qboId: "10", syncToken: "4" };
    expect(beforeResend(off, [c({ qboId: "10", active: false, syncToken: "5" })])).toEqual({ is: "done", qboId: "10" });
    expect(beforeResend(off, [c({ qboId: "10", active: true, syncToken: "6" })])).toEqual({ is: "stuck", code: "moved_on" });
  });
});

describe("how an email field stands against a change of sign-in email (stage 3's slice S11e)", () => {
  const own = { role: "parent" as const, from: "old@x.example", to: "new@x.example" };
  const fam = { role: "family" as const, from: "old@x.example", to: "new@x.example" };
  it("by the record's rule: the first address of a person's own record, any of a family's", () => {
    expect(emailStands("old@x.example, g@x.example", own)).toEqual({ is: "sendable", held: "old@x.example" });
    expect(emailStands("g@x.example, old@x.example", own)).toEqual({ is: "differs" });
    expect(emailStands("g@x.example; old@x.example", fam)).toEqual({ is: "sendable", held: "old@x.example" });
    expect(emailStands("new@x.example", own)).toEqual({ is: "in_place" });
    expect(emailStands("old@x.example, new@x.example", own)).toEqual({ is: "sendable", held: "old@x.example" });
  });
  it("the new address in the field and none it replaces anywhere: nothing left to replace, so in place", () => {
    expect(emailStands("g@x.example, new@x.example", own)).toEqual({ is: "in_place" });
    expect(emailStands("g@x.example", own)).toEqual({ is: "differs" });
  });
  it("an address another person signs in with now is never one it replaces", () => {
    const taken = new Set(["old@x.example"]);
    expect(emailStands("old@x.example", fam, taken)).toEqual({ is: "differs" });
    expect(emailStands("old@x.example, new@x.example", fam, taken)).toEqual({ is: "in_place" });
    expect(emailStands("old@x.example", { ...fam, orFrom: ["mid@x.example"] }, taken)).toEqual({ is: "differs" });
    expect(emailStands("mid@x.example; old@x.example", { ...fam, orFrom: ["mid@x.example"] }, taken)).toEqual({ is: "sendable", held: "mid@x.example" });
  });
});
