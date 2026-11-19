import { describe, it, expect } from "vitest";
import { KIND_LABELS, KIND_RULES, NO_RULE_YET, REQUIREMENT_KINDS, availableKinds, isAvailableKind } from "@/lib/seasons/kinds";
import { pairKey, type Recorded } from "@/lib/seasons/kinds";
import type { Requirement } from "@/lib/seasons/progress";
import { asAppStudentId } from "@/lib/families/ids";

/**
 * The registry of how each kind of requirement is met (v1 spec 10.2): one entry per kind, checklist filled in. Every
 * rule is asked by the app's own ids and answers by pairKey().
 */
const LEO = asAppStudentId("00000000-0000-4000-8000-00000000000a"), MAYA = asAppStudentId("00000000-0000-4000-8000-00000000000b"),
  NICO = asAppStudentId("00000000-0000-4000-8000-00000000000c");
const item: Requirement = { id: "r1", kind: "checklist", title: "Uniform fitting", required: true, appliesTo: "student", amount: null, amountUnit: null, dueOn: null, covers: "everyone", coveredIds: [] };
const row = (o: Partial<Recorded>): Recorded => ({ requirementId: "r1", subjectId: LEO, metAt: null, metBy: null, waivedAt: null, waivedBy: null, waivedReason: null, ...o });

describe("the kinds of requirement", () => {
  it("has one entry for each of the four kinds, each with a name for staff", () => {
    expect([...REQUIREMENT_KINDS].sort()).toEqual(["checklist", "form", "payment", "volunteer"]);
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...REQUIREMENT_KINDS].sort());
    expect(KIND_LABELS.checklist).toBe("Checklist item");
  });

  it("lets staff create every kind, since each has its rule: checklist items, forms, payments and volunteering", () => {
    expect(availableKinds()).toEqual(["checklist", "form", "payment", "volunteer"]);
    for (const kind of REQUIREMENT_KINDS) expect(isAvailableKind(kind)).toBe(true);
    for (const kind of ["raffle", "", null, 7]) expect(isAvailableKind(kind)).toBe(false);
    expect(NO_RULE_YET.met).toBe(false);
  });

  it("meets a payment requirement from QuickBooks' invoices, never by a tick", () => {
    const rule = KIND_RULES.payment!;
    expect(rule.ticked).toBe(false);
    expect(rule.nothingYet({ ...item, kind: "payment" })).toEqual({ met: false, words: "No invoice yet" });
  });

  it("meets a form only by its signed document, never by a staff tick", () => {
    const rule = KIND_RULES.form!;
    expect(rule.ticked).toBe(false);
    expect(rule.nothingYet({ ...item, kind: "form" })).toEqual({ met: false, words: "Not signed yet" });
  });

  it("meets a checklist item with a staff tick, for that family or student alone; a waiver is not a tick", async () => {
    const rule = KIND_RULES.checklist!;
    expect(rule.ticked).toBe(true);
    expect(rule.nothingYet(item)).toEqual({ met: false, words: "Not done yet" });
    const standings = await rule.standings({ requirements: [item], asked: null, viewing: { amounts: "none", parentId: null }, recorded: [
      row({ subjectId: LEO, metAt: new Date() }),
      row({ subjectId: MAYA, waivedAt: new Date(), waivedReason: "borrowed one" }),
      row({ subjectId: NICO, metAt: new Date(), waivedAt: new Date(), waivedReason: "both" }),
    ] });
    expect([...standings]).toEqual([[pairKey("r1", LEO), { met: true, words: "Done" }], [pairKey("r1", NICO), { met: true, words: "Done" }]]);
  });
});
