import { describe, it, expect } from "vitest";
import { normalizeHex, contrastRatio, deriveClubTokens, clubCssVars } from "@/lib/theme/contrast";

const PAPER_L = "#ffffff", PAPER_D = "#16181c", PAPER_DHC = "#000000";

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

describe("deriveClubTokens", () => {
  it.each(["#5b2a86", "#f2c200", "#003366", "#e0f7fa", "#ff0000", "#000000", "#ffffff"])("holds every contrast floor for %s", (hex) => {
    const t = deriveClubTokens(hex);
    expect(t.club).toBe(hex);
    expect(contrastRatio(t.clubOn, t.club)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textL, PAPER_L)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textD, PAPER_D)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textLhc, PAPER_L)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.textDhc, PAPER_DHC)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.textL, t.tintL)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textD, t.tintD)).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps a club color that already passes on white (FZN purple)", () => {
    expect(deriveClubTokens("#5b2a86").textL).toBe("#5b2a86");
    expect(deriveClubTokens("#5b2a86").clubOn).toBe("#ffffff");
  });
  it("uses dark ink on a light club color (gold)", () => {
    expect(deriveClubTokens("#f2c200").clubOn).toBe("#14161a");
  });
  it("throws on invalid input", () => {
    expect(() => deriveClubTokens("red")).toThrow(/color/i);
  });
  it("produces CSS variables containing only hex values", () => {
    const vars = clubCssVars(deriveClubTokens("#f2c200"));
    expect(Object.keys(vars)).toEqual(["--club-l", "--club-on-l", "--club-d", "--club-on-d", "--club-text-l", "--club-text-d", "--club-text-lhc", "--club-text-dhc", "--club-tint-l", "--club-tint-d"]);
    for (const v of Object.values(vars)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});
