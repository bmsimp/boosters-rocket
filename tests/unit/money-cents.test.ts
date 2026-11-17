import { describe, it, expect } from "vitest";
import { currencyOf, formatMoney, toCents } from "@/lib/money/cents";

describe("QuickBooks amounts become integer cents, once", () => {
  it.each([
    [85, 8500], [85.0, 8500], [1234.56, 123456], [0, 0], [0.01, 1], [0.1, 10], [100.1, 10010],
    ["85.00", 8500], [" 12.5 ", 1250], ["7", 700], ["7.", 700], ["+3.20", 320],
  ])("%j is %i cents", (value, cents) => { expect(toCents(value)).toBe(cents); });

  it.each([
    [0.57, 57], [1.15, 115], [19.99, 1999], [4.35, 435], [0.1 + 0.2, 30], [1.1 * 3, 330], [8.2 - 0.1, 810],
  ])("binary floating point never decides a cent: %j is %i", (value, cents) => { expect(toCents(value)).toBe(cents); });

  it.each([
    [1.005, 101], [1.004, 100], ["2.675", 268], ["2.6749", 267], [0.005, 1], [0.004, 0], ["10.999", 1100],
  ])("a third decimal place rounds half up: %j is %i", (value, cents) => { expect(toCents(value)).toBe(cents); });

  it.each([
    [-5, -500], [-0.01, -1], ["-12.34", -1234], [-1.005, -101], [-0.004, 0], ["-0.00", 0],
  ])("a negative amount keeps its sign, and zero has none: %j is %i", (value, cents) => {
    expect(toCents(value)).toBe(cents);
    expect(Object.is(toCents(value), -0)).toBe(false);
  });

  it("reads large amounts exactly", () => {
    expect(toCents(1234567.89)).toBe(123456789);
    expect(toCents("90000000000.01")).toBe(9000000000001);
  });

  it.each([
    [undefined], [null], [""], ["  "], ["abc"], ["12abc"], ["1,234.56"], ["$5"], ["1e3"], [NaN], [Infinity], [-Infinity],
    [true], [{}], [[85]], [1e21], ["99999999999999999999"],
  ])("%j is not an amount", (value) => { expect(toCents(value)).toBeNull(); });

  it("a number too small to be a cent is zero", () => { expect(toCents(1e-7)).toBe(0); });
});

describe("one formatter for every amount a parent reads", () => {
  it.each([
    [0, "$0.00"], [1, "$0.01"], [50, "$0.50"], [8500, "$85.00"], [18500, "$185.00"], [123456, "$1,234.56"],
    [100000000, "$1,000,000.00"], [123456789, "$1,234,567.89"],
  ])("%i cents is %s", (cents, text) => { expect(formatMoney(cents)).toBe(text); });

  it("shows a negative amount with a minus sign, never brackets or color", () => {
    expect(formatMoney(-500)).toBe("-$5.00");
    expect(formatMoney(-123456)).toBe("-$1,234.56");
  });

  it("uses the invoice's own currency, and US dollars when there is none", () => {
    expect(formatMoney(8500, "USD")).toBe("$85.00");
    expect(formatMoney(8500, "CAD")).toBe("CA$85.00");
    expect(formatMoney(8500, "EUR")).toBe("€85.00");
    expect(formatMoney(8500, "JPY")).toBe("¥85.00"); // two places whatever the currency: the cents are QuickBooks'
    expect(formatMoney(8500, "")).toBe("$85.00");
    expect(formatMoney(8500, "not a code")).toBe("$85.00");
  });

  it("reads a currency code from QuickBooks, or falls back to USD", () => {
    expect(currencyOf("CAD")).toBe("CAD");
    expect(currencyOf(" cad ")).toBe("CAD");
    for (const v of [undefined, null, "", "US", "DOLLARS", 840, { value: "CAD" }, "<b>"]) expect(currencyOf(v)).toBe("USD");
  });
});
