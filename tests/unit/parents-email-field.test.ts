import { describe, it, expect } from "vitest";
import { EMAIL_FIELD_MAX, fieldHasChange, replaceAddressInField } from "@/lib/parents/email-field";
import { parseEmailField } from "@/lib/parents/emails";

describe("replaceAddressInField: one address in a QuickBooks email field, and every other character kept", () => {
  it.each([
    ["one address", "ana@example.com", "new@example.com"],
    ["one address, with the spaces QuickBooks kept around it", "  ana@example.com ", "  new@example.com "],
    ["first of several", "ana@example.com, leo@example.com", "new@example.com, leo@example.com"],
    ["last of several", "leo@example.com, ana@example.com", "leo@example.com, new@example.com"],
    ["in the middle", "leo@example.com;ana@example.com;  mia@example.com", "leo@example.com;new@example.com;  mia@example.com"],
    ["mixed separators", "leo@example.com ana@example.com ;mia@example.com,", "leo@example.com new@example.com ;mia@example.com,"],
    ["written in another case", "Leo@Example.com, ANA@Example.COM", "Leo@Example.com, new@example.com"],
    ["the address twice", "ana@example.com; Ana@Example.com, leo@example.com", "new@example.com; new@example.com, leo@example.com"],
    ["beside something that isn't an address", "ana@example.com, call first", "new@example.com, call first"],
  ])("%s", (_name, field, changed) => {
    expect(replaceAddressInField(field, "ana@example.com", "new@example.com")).toEqual({ ok: true, field: changed });
  });

  it("writes the new address as the portal stores addresses, trimmed and lower-cased, and takes the old one in any case", () => {
    expect(replaceAddressInField("ana@example.com, leo@example.com", " ANA@example.com", " New@Example.com ")).toEqual({ ok: true, field: "new@example.com, leo@example.com" });
  });

  it("refuses when the new address is in the field already, wherever and however it is written", () => {
    for (const field of ["ana@example.com, new@example.com", "NEW@example.com ana@example.com", "ana@example.com;new@example.com;new@example.com"]) {
      expect(replaceAddressInField(field, "ana@example.com", "new@example.com"), field).toEqual({ ok: false, reason: "already_there" });
    }
  });

  it("refuses when the old address isn't there", () => {
    for (const field of [null, "", "leo@example.com", "ana@example.co", "xana@example.com", "ana@example.com.au", "<ana@example.com>"]) {
      expect(replaceAddressInField(field, "ana@example.com", "new@example.com"), String(field)).toEqual({ ok: false, reason: "absent" });
    }
  });

  it("refuses an address that isn't one, and a change to the same address", () => {
    expect(replaceAddressInField("ana@example.com", "ana@example.com", "not an address")).toEqual({ ok: false, reason: "invalid" });
    expect(replaceAddressInField("ana@example.com", "", "new@example.com")).toEqual({ ok: false, reason: "invalid" });
    expect(replaceAddressInField("ana@example.com", "ana@example.com", "ANA@example.com")).toEqual({ ok: false, reason: "invalid" });
  });

  it(`refuses a field longer than ${EMAIL_FIELD_MAX} characters once changed, and takes one exactly that long`, () => {
    const other = (n: number) => `${"x".repeat(n - "@example.com".length)}@example.com`;
    // "a@b.co" (6) becomes "new@example.com" (15): the field grows by 9.
    const fits = `a@b.co, ${other(EMAIL_FIELD_MAX - 15 - 2)}`;
    const r = replaceAddressInField(fits, "a@b.co", "new@example.com");
    expect(r).toMatchObject({ ok: true });
    expect((r as { field: string }).field).toHaveLength(EMAIL_FIELD_MAX);
    expect(replaceAddressInField(`a@b.co, ${other(EMAIL_FIELD_MAX - 15 - 1)}`, "a@b.co", "new@example.com")).toEqual({ ok: false, reason: "too_long" });
  });

  it("leaves the field reading, address by address, as it did with the one address changed", () => {
    const field = " Leo@Example.com;ana@example.com ,  mia@example.com; nope ";
    const r = replaceAddressInField(field, "ana@example.com", "new@example.com");
    expect(r.ok).toBe(true);
    const changed = (r as { field: string }).field;
    expect(parseEmailField(changed)).toEqual({ usable: ["leo@example.com", "new@example.com", "mia@example.com"], unusable: ["nope"] });
    expect(changed.replace("new@example.com", "ana@example.com")).toBe(field);
  });
});

describe("fieldHasChange: a field that already reads as the change made", () => {
  it.each([
    ["the new address alone", "new@example.com", false, true],
    ["the new address among others", "leo@example.com, New@Example.com", false, true],
    ["the old address still there", "new@example.com, ana@example.com", false, false],
    ["neither address", "leo@example.com", false, false],
    ["empty", null, false, false],
    ["first only: the new address first", "new@example.com, leo@example.com", true, true],
    ["first only: the new address not first", "leo@example.com, new@example.com", true, false],
  ])("%s", (_name, field, firstOnly, made) => {
    expect(fieldHasChange(field, "ana@example.com", "new@example.com", firstOnly)).toBe(made);
  });
});
