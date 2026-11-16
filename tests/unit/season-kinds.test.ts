import { describe, it, expect } from "vitest";
import { KIND_LABELS, KIND_RULES, NO_RULE_YET, REQUIREMENT_KINDS, availableKinds, isAvailableKind, pairKey, type Recorded } from "@/lib/seasons/kinds";
import type { Requirement } from "@/lib/seasons/progress";

/** The registry of how each kind of requirement is met (v1 spec 10.2): one entry per kind, checklist filled in. */
const item: Requirement = { id: "r1", kind: "checklist", title: "Uniform fitting", required: true, appliesTo: "student", amount: null, amountUnit: null, dueOn: null, covers: "everyone", coveredQboIds: [] };
const row = (o: Partial<Recorded>): Recorded => ({ requirementId: "r1", subjectQboId: "LEO", metAt: null, metBy: null, waivedAt: null, waivedBy: null, waivedReason: null, ...o });

describe("the kinds of requirement", () => {
  it("has one entry for each of the four kinds, each with a name for staff", () => {
    expect([...REQUIREMENT_KINDS].sort()).toEqual(["checklist", "form", "payment", "volunteer"]);
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...REQUIREMENT_KINDS].sort());
    expect(KIND_LABELS.checklist).toBe("Checklist item");
  });

  it("lets staff create only the kinds whose rule exists: today, checklist items and forms", () => {
    expect(availableKinds()).toEqual(["checklist", "form"]);
    expect(isAvailableKind("checklist")).toBe(true);
    expect(isAvailableKind("form")).toBe(true);
    for (const kind of ["payment", "volunteer", "raffle", "", null, 7]) expect(isAvailableKind(kind)).toBe(false);
    // The other two have their place in the registry, empty until their slice fills it.
    expect([KIND_RULES.payment, KIND_RULES.volunteer]).toEqual([null, null]);
    expect(NO_RULE_YET.met).toBe(false);
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
    const standings = await rule.standings({ requirements: [item], subjectQboIds: null, recorded: [
      row({ subjectQboId: "LEO", metAt: new Date() }),
      row({ subjectQboId: "MAYA", waivedAt: new Date(), waivedReason: "borrowed one" }),
      row({ subjectQboId: "NICO", metAt: new Date(), waivedAt: new Date(), waivedReason: "both" }),
    ] });
    expect([...standings]).toEqual([[pairKey("r1", "LEO"), { met: true, words: "Done" }], [pairKey("r1", "NICO"), { met: true, words: "Done" }]]);
  });
});
