import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";
import type { MembershipShape } from "@/lib/roster/shape";
import { suggestCustomers, type Suggestion } from "@/lib/accounting/match";

/**
 * The accounting links screen's suggestions (stage 4's slice M1, src/lib/accounting/match.ts): a family's own customer
 * is suggested by an exact sign-in address of one of its guardians, on the family customer's own email field or on an
 * active Parent customer directly under it, and only when nothing else claims it. Never by a name.
 */
const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const LAYERED: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" };
const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["1"] };

/** The suggestion for each family, with every customer of the company in the pool unless told otherwise. */
function suggest(shape: MembershipShape, customers: Cust[], families: { key: string; addresses: string[] }[], pool?: string[]) {
  const roster = buildRoster(shape, customers);
  const all = roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId);
  return suggestCustomers(families, roster, new Set(pool ?? all));
}
/** A suggestion in short: the customer filled in, the candidates of several, or none. */
const short = (s: Suggestion<string> | undefined) => (s === undefined ? "missing" : s.kind === "suggested" ? `suggested ${s.candidate.customerId}`
  : s.kind === "several" ? `several (${s.why}) ${s.candidates.map((x) => x.customerId).join(",")}` : "none");

describe("suggesting a family's customer by its guardians' sign-in addresses", () => {
  it("suggests the one customer whose own email field holds a guardian's address exactly", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1", null, { email: "asha@example.com" }), c("80", "Okafor Family", "1", null, { email: "ike@example.com" })],
      [{ key: "patel", addresses: ["asha@example.com"] }]);
    expect(short(r.get("patel"))).toBe("suggested 70");
    expect(r.get("patel")).toEqual({ kind: "suggested", candidate: { customerId: "70", name: "Patel Family", email: "asha@example.com",
      holders: [{ address: "asha@example.com", on: { kind: "family" } }] } });
  });

  it("matches one address of several in a field that holds more than one", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1", null, { email: "first@example.com; asha@example.com, third@example.com" })],
      [{ key: "patel", addresses: ["asha@example.com"] }]);
    expect(short(r.get("patel"))).toBe("suggested 70");
  });

  it("trims and ignores case on both sides, and nothing less than the whole address matches", () => {
    const customers = [c("70", "Patel Family", "1", null, { email: "  Asha@Example.COM " }), c("80", "Okafor Family", "1", null, { email: "masha@example.com" })];
    expect(short(suggest(LAYERED, customers, [{ key: "patel", addresses: [" ASHA@example.com "] }]).get("patel"))).toBe("suggested 70");
    expect(short(suggest(LAYERED, customers, [{ key: "x", addresses: ["sha@example.com"] }]).get("x"))).toBe("none");
  });

  it("suggests the family above a Parent customer that holds the address, and says which Parent customer held it", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1"), c("73", "Nita Patel", "2", "70", { email: "nita@example.com" })],
      [{ key: "patel", addresses: ["nita@example.com"] }]);
    expect(r.get("patel")).toEqual({ kind: "suggested", candidate: { customerId: "70", name: "Patel Family", email: null,
      holders: [{ address: "nita@example.com", on: { kind: "parent", customerId: "73", name: "Nita Patel" } }] } });
  });

  it("never counts an inactive Parent customer or a student customer's email", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1"), c("73", "Nita Patel", "2", "70", { email: "nita@example.com", active: false }),
      c("71", "Asha Patel", "3", "70", { email: "asha@example.com" })],
    [{ key: "a", addresses: ["nita@example.com"] }, { key: "b", addresses: ["asha@example.com"] }]);
    expect(short(r.get("a"))).toBe("none");
    expect(short(r.get("b"))).toBe("none");
  });

  it("never counts a stray Parent customer under no family, or one under a customer that isn't a family", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1"), c("90", "Stray Parent", "2", null, { email: "stray@example.com" }),
      c("30", "Lincoln High", "4"), c("91", "Parent Under School", "2", "30", { email: "school@example.com" })],
    [{ key: "a", addresses: ["stray@example.com", "school@example.com"] }]);
    expect(short(r.get("a"))).toBe("none");
  });

  it("offers no suggestion when two customers hold the family's addresses, and names both", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1", null, { email: "asha@example.com" }), c("75", "Patel Household", "1"),
      c("76", "Ravi Patel", "2", "75", { email: "ravi@example.com" })],
    [{ key: "patel", addresses: ["asha@example.com", "ravi@example.com"] }]);
    expect(short(r.get("patel"))).toBe("several (many) 70,75");
  });

  it("offers no suggestion to either of two families that one customer's addresses match, so no two rows aim at one customer", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1", null, { email: "asha@example.com, ravi@example.com" })],
      [{ key: "one", addresses: ["asha@example.com"] }, { key: "two", addresses: ["ravi@example.com"] }]);
    expect(r.get("one")).toMatchObject({ kind: "several", why: "shared", alsoMatches: ["two"] });
    expect(r.get("two")).toMatchObject({ kind: "several", why: "shared", alsoMatches: ["one"] });
  });

  it("makes each family of a guardian in two families several possible when the address is on both families' customers: nothing narrows it", () => {
    const r = suggest(LAYERED, [c("70", "Patel Family", "1", null, { email: "sam@example.com" }), c("80", "Okafor Family", "1", null, { email: "sam@example.com" })],
      [{ key: "patel", addresses: ["sam@example.com", "asha@example.com"] }, { key: "okafor", addresses: ["sam@example.com"] }]);
    expect(short(r.get("patel"))).toBe("several (many) 80,70");
    expect(short(r.get("okafor"))).toBe("several (many) 80,70");
  });

  it("in flat books matches the member's own field, and nobody under it", () => {
    const customers = [c("70", "Patel Family", "1", null, { email: "asha@example.com" }), c("73", "Nita Patel", "2", "70", { email: "nita@example.com" })];
    const r = suggest(FLAT, customers, [{ key: "a", addresses: ["asha@example.com"] }, { key: "b", addresses: ["nita@example.com"] }]);
    expect(short(r.get("a"))).toBe("suggested 70");
    expect(short(r.get("b"))).toBe("none");
  });

  it("never suggests by a name alone, and never a customer outside the pool", () => {
    const customers = [c("70", "patel@example.com", "1"), c("80", "Okafor Family", "1", null, { email: "ike@example.com" })];
    expect(short(suggest(LAYERED, customers, [{ key: "a", addresses: ["patel@example.com"] }]).get("a"))).toBe("none");
    expect(short(suggest(LAYERED, customers, [{ key: "b", addresses: ["ike@example.com"] }], ["70"]).get("b"))).toBe("none");
  });

  it("finds nothing for a family with no guardians", () => {
    expect(short(suggest(LAYERED, [c("70", "Patel Family", "1", null, { email: "asha@example.com" })], [{ key: "a", addresses: [] }]).get("a"))).toBe("none");
  });
});
