import { describe, it, expect } from "vitest";
import { contrastRatio, inkOn, normalizeHex } from "@/lib/theme/contrast";
import { clubScheme } from "@/lib/theme/scheme";

describe("normalizeHex", () => {
  it.each([["#5B2A86", "#5b2a86"], ["5b2a86", "#5b2a86"], ["#FFF", "#ffffff"], [" #abc ", "#aabbcc"]])("%j → %j", (i, o) => expect(normalizeHex(i)).toBe(o));
  it.each(["red", "#12", "#1234567", "#ggg000", "#000;}body{display:none", ""])("rejects %j", (i) => expect(normalizeHex(i)).toBeNull());
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for equal colors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

describe("inkOn (the logo tile's and app icon's ink)", () => {
  it("is white on a dark club color and near-black on a light one", () => {
    expect(inkOn("#5b2a86")).toBe("#ffffff");
    expect(inkOn("#f2c200")).toBe("#14161a");
  });
});

describe("clubScheme", () => {
  it("throws on invalid input", () => {
    expect(() => clubScheme("red")).toThrow(/color/i);
  });
  it("keeps the club's exact color as its seed, for the logo tile alone", () => {
    expect(clubScheme("#5B2A86").seed).toBe("#5b2a86");
  });
});
