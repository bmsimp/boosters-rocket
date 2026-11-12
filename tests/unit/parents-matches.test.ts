import { describe, it, expect } from "vitest";
import { suggestMatches, type NewFamily } from "@/lib/parents/matches";
import type { PreviousCompany, PreviousFamily } from "@/lib/parents/company-change";

const old = (qboId: string, name: string, emails: string[], o: Partial<PreviousFamily> = {}): PreviousFamily =>
  ({ qboId, name, people: emails.map((email, i) => ({ parentId: `p${qboId}-${i}`, name: "x", email, welcomedAt: null })), decision: null, matchedTo: null, ...o });
const prev = (families: PreviousFamily[]): PreviousCompany => ({ realmId: "1", newRealmId: "2", at: "2026-11-11T00:00:00.000Z", families, approvals: [] });
const nu = (qboId: string, name: string, emails: string[] = []): NewFamily => ({ qboId, name, emails });

describe("suggestMatches", () => {
  it("is strong when the name matches and every old address is under the new family", () => {
    const [s] = suggestMatches(prev([old("12", "Rivera Family", ["ana@example.com", "leo@example.com"])]), [nu("87", "rivera  family", ["leo@example.com", "ana@example.com", "x@example.com"])]);
    expect(s).toEqual({ old: { qboId: "12", name: "Rivera Family", emails: ["ana@example.com", "leo@example.com"] }, suggested: { qboId: "87", name: "rivera  family" },
      nameMatches: true, addressesMatched: 2, strong: true, decision: null, matchedTo: null });
  });
  it.each([
    ["name only", old("12", "Rivera Family", ["ana@example.com"]), [nu("87", "Rivera Family")], "87", true, 0, false],
    ["addresses only", old("12", "Rivera Family", ["ana@example.com"]), [nu("87", "Rivera-Smith", ["ana@example.com"])], "87", false, 1, false],
    ["some addresses", old("12", "Rivera Family", ["ana@example.com", "leo@example.com"]), [nu("87", "Rivera Family", ["ana@example.com"])], "87", true, 1, false],
    ["nothing in common", old("12", "Rivera Family", ["ana@example.com"]), [nu("87", "Chen Family", ["mei@example.com"])], null, false, 0, false],
    ["a name match with no old addresses is never strong", old("12", "Rivera Family", []), [nu("87", "Rivera Family")], "87", true, 0, false],
  ] as const)("%s", (_label, o, families, id, nameMatches, addressesMatched, strong) => {
    const [s] = suggestMatches(prev([o]), [...families]);
    expect(s!.suggested?.qboId ?? null).toBe(id);
    expect({ nameMatches: s!.nameMatches, addressesMatched: s!.addressesMatched, strong: s!.strong }).toEqual({ nameMatches, addressesMatched, strong });
  });
  it("prefers more matching addresses over a matching name, then the lower QuickBooks ID", () => {
    const o = prev([old("12", "Rivera Family", ["ana@example.com"])]);
    expect(suggestMatches(o, [nu("90", "Rivera Family"), nu("87", "Other", ["ana@example.com"])])[0]!.suggested!.qboId).toBe("87");
    expect(suggestMatches(o, [nu("100", "Rivera Family"), nu("9", "Rivera Family")])[0]!.suggested!.qboId).toBe("9");
  });
  it("never suggests the same new family twice, and never one already matched", () => {
    const o = prev([old("12", "Rivera Family", ["ana@example.com"]), old("13", "Rivera Family", []), old("14", "Done", [], { decision: "matched", matchedTo: "87" })]);
    const s = suggestMatches(o, [nu("87", "Done"), nu("88", "Rivera Family", ["ana@example.com"])]);
    expect(s.map((x) => [x.old.qboId, x.suggested?.qboId ?? null, x.matchedTo?.qboId ?? null])).toEqual([["12", "88", null], ["13", null, null], ["14", null, "87"]]);
  });
  it("does not treat the same small ID in two companies as a match", () => {
    const [s] = suggestMatches(prev([old("12", "Rivera Family", ["ana@example.com"])]), [nu("12", "Chen Family", ["mei@example.com"])]);
    expect(s!.suggested).toBeNull();
  });
});
