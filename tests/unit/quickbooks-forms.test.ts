import { describe, it, expect } from "vitest";
import { shapeFormData, sameChoice, appKeysFormData } from "@/app/staff/(app)/settings/quickbooks/forms";

const entries = (f: FormData) => [...f.entries()];
const base = { kind: "layered" as const, family: "1", student: "3", parent: "2", members: ["4", "5"] };

describe("shapeFormData", () => {
  it("a layered choice sends kind and the three types, and no members", () => {
    expect(entries(shapeFormData(base))).toEqual([["kind", "layered"], ["family", "1"], ["student", "3"], ["parent", "2"]]);
  });
  it("a layered choice with student and parent blank sends them blank", () => {
    expect(entries(shapeFormData({ ...base, student: "", parent: "" }))).toEqual([["kind", "layered"], ["family", "1"], ["student", ""], ["parent", ""]]);
  });
  it("a flat choice sends kind and one members entry per chosen type, and no family, student or parent", () => {
    expect(entries(shapeFormData({ ...base, kind: "flat", members: ["3", "2"] }))).toEqual([["kind", "flat"], ["members", "3"], ["members", "2"]]);
  });
});

describe("sameChoice", () => {
  it("is true for equal choices, whatever order the members were ticked in", () => {
    expect(sameChoice({ ...base, kind: "flat", members: ["3", "2"] }, { ...base, kind: "flat", members: ["2", "3"] })).toBe(true);
    expect(sameChoice(base, { ...base })).toBe(true);
  });
  it("is false when the kind, a select or the members differ", () => {
    expect(sameChoice(base, { ...base, kind: "flat" })).toBe(false);
    expect(sameChoice(base, { ...base, student: "" })).toBe(false);
    expect(sameChoice({ ...base, kind: "flat" }, { ...base, kind: "flat", members: ["4"] })).toBe(false);
  });
  it("ignores the fields the kind doesn't use", () => {
    expect(sameChoice(base, { ...base, members: [] })).toBe(true);
    expect(sameChoice({ ...base, kind: "flat" }, { ...base, kind: "flat", family: "9" })).toBe(true);
  });
});

describe("appKeysFormData", () => {
  it("sends the three fields, with a blank secret kept blank", () => {
    expect(entries(appKeysFormData({ clientId: "ABid", clientSecret: "", environment: "production" }))).toEqual([["clientId", "ABid"], ["clientSecret", ""], ["environment", "production"]]);
    expect(entries(appKeysFormData({ clientId: "ABid", clientSecret: "s", environment: "sandbox" }))).toEqual([["clientId", "ABid"], ["clientSecret", "s"], ["environment", "sandbox"]]);
  });
});
