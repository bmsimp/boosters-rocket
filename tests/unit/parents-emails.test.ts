import { describe, it, expect } from "vitest";
import { parseEmailField } from "@/lib/parents/emails";

describe("parseEmailField", () => {
  it.each([
    [null, [], []],
    ["", [], []],
    ["   ", [], []],
    ["ana@example.com", ["ana@example.com"], []],
    ["  Ana@Example.COM ", ["ana@example.com"], []],
    ["ana@example.com, leo@example.com", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com;leo@example.com", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com ; leo@example.com,", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com leo@example.com", ["ana@example.com", "leo@example.com"], []],
    ["ana@example.com, ANA@example.com", ["ana@example.com"], []],
    ["not an address", [], ["not", "an", "address"]],
    ["ana@example.com, nope", ["ana@example.com"], ["nope"]],
    ["Ana <ana@example.com>", [], ["ana", "<ana@example.com>"]],
  ])("%j", (raw, usable, unusable) => {
    expect(parseEmailField(raw)).toEqual({ usable, unusable });
  });

  it("does not throw on a very long field, and keeps no unusable piece longer than 80 characters", () => {
    const r = parseEmailField(`${"x".repeat(5000)}, ana@example.com`);
    expect(r.usable).toEqual(["ana@example.com"]);
    expect(r.unusable).toEqual(["x".repeat(80)]);
  });
});
