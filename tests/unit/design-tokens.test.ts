import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { contrastRatio, deriveClubTokens } from "@/lib/theme/contrast";
import { CLUB_TEXT_GROUND, MARK_PAIRS, PALETTE, TEXT_PAIRS, THEME_COLOR, type Mode } from "@/lib/theme/palette";

// The token blocks of booster.css hold the same colors as src/lib/theme/palette.ts, and every pair the system draws
// passes its floor in every display mode: 4.5:1 for text (7:1 in high contrast), 3:1 for a control's edge or a mark.
const css = readFileSync("src/app/booster.css", "utf8");

/** The `--name: #hex` declarations between a `/* @tokens <name> *\/` marker and the next `/* @end *\/`. */
function block(name: string): Record<string, string> {
  const start = css.indexOf(`/* @tokens ${name} */`);
  expect(start, `booster.css has a /* @tokens ${name} */ block`).toBeGreaterThan(0);
  const body = css.slice(start, css.indexOf("/* @end */", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
}
/** A high-contrast set is written as the --hc-* names its theme block maps onto the roles. */
function hcBlock(name: string): Record<string, string> {
  const hc = block(name);
  const line = hc["hc-line"]!;
  return {
    ground: hc["hc-ground"]!, surface: hc["hc-surface"]!, "surface-raised": hc["hc-surface-raised"]!, "surface-muted": hc["hc-surface-muted"]!,
    border: line, "border-control": line, "border-strong": line,
    ink: hc["hc-ink"]!, "ink-2": hc["hc-ink-2"]!, "ink-3": hc["hc-ink-2"]!,
    done: hc["hc-done"]!, due: hc["hc-due"]!, late: hc["hc-late"]!,
  };
}
const inCss: Record<Mode, Record<string, string>> = {
  light: block("light"), dark: block("dark"),
  lightHc: { ...block("light"), ...hcBlock("light-hc") }, darkHc: { ...block("dark"), ...hcBlock("dark-hc") },
};

describe("the stylesheet's colors are the palette's", () => {
  it.each(Object.keys(PALETTE) as Mode[])("%s", (mode) => {
    for (const [token, hex] of Object.entries(PALETTE[mode])) expect(inCss[mode][token], `--${token} in ${mode}`).toBe(hex);
  });
  it("the dark set is written the same for the attribute and for the device setting", () => {
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)![1]!;
    const fromMedia = Object.fromEntries([...media.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
    expect(fromMedia).toEqual(block("dark"));
  });
  it("the browser's theme color is the top bar's surface", () => {
    expect(THEME_COLOR).toEqual({ light: PALETTE.light.surface, dark: PALETTE.dark.surface });
  });
});

describe("every pair passes its floor", () => {
  it.each(Object.keys(PALETTE) as Mode[])("%s", (mode) => {
    const p = PALETTE[mode] as Record<string, string>;
    const floor = mode.endsWith("Hc") ? 7 : 4.5;
    for (const [fg, bg] of TEXT_PAIRS) expect(contrastRatio(p[fg]!, p[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(floor);
    for (const [fg, bg] of MARK_PAIRS) expect(contrastRatio(p[fg]!, p[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });
  it.each(["#5b2a86", "#f2c200", "#003366", "#e0f7fa", "#ff0000", "#1d7344"])("the club color %s, as text, on every surface of its mode", (hex) => {
    const t = deriveClubTokens(hex);
    for (const bg of [PALETTE.light.ground, PALETTE.light.surface, PALETTE.light["surface-muted"], t.tintL]) expect(contrastRatio(t.textL, bg)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [PALETTE.dark.ground, PALETTE.dark.surface, PALETTE.dark["surface-raised"], t.tintD]) expect(contrastRatio(t.textD, bg)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [PALETTE.lightHc.surface, CLUB_TEXT_GROUND.lightHc]) expect(contrastRatio(t.textLhc, bg)).toBeGreaterThanOrEqual(7);
    for (const bg of [PALETTE.darkHc.surface, CLUB_TEXT_GROUND.darkHc]) expect(contrastRatio(t.textDhc, bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.clubOn, t.club)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the stylesheet keeps to the type floor and to rem", () => {
  it("no font size under 0.8125rem, and none in px", () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    for (const size of sizes) {
      expect(size, "a font size in px").not.toMatch(/\dpx/);
      const rem = /^([\d.]+)rem$/.exec(size);
      if (rem) expect(Number(rem[1]), size).toBeGreaterThanOrEqual(0.8125);
    }
  });
  it("the scale's own steps are the six it names, plus the control size between sm and md", () => {
    expect(css).toContain("--text-xs: 0.8125rem; --text-sm: 0.875rem; --text-control: 0.9375rem; --text-md: 1rem; --text-lg: 1.125rem; --text-xl: 1.5rem; --text-2xl: 2rem;");
  });
});
