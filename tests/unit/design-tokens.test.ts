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
    done: hc["hc-done"]!, due: hc["hc-due"]!, late: hc["hc-late"]!, info: hc["hc-info"]!, "badge-ink": hc["hc-ink-2"]!,
    "br-ink": hc["hc-ink"]!, "br-flame-ink": hc["hc-ink"]!,
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
  it.each(["#1e1b4b", "#5b2a86", "#f2c200", "#003366", "#e0f7fa", "#ff0000", "#1d7344"])("the club color %s, as text, on every surface of its mode", (hex) => {
    const t = deriveClubTokens(hex);
    for (const bg of [PALETTE.light.ground, PALETTE.light.surface, PALETTE.light["surface-muted"], t.tintL]) expect(contrastRatio(t.textL, bg)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [PALETTE.dark.ground, PALETTE.dark.surface, PALETTE.dark["surface-raised"], t.tintD]) expect(contrastRatio(t.textD, bg)).toBeGreaterThanOrEqual(4.5);
    for (const bg of [PALETTE.lightHc.surface, CLUB_TEXT_GROUND.lightHc]) expect(contrastRatio(t.textLhc, bg)).toBeGreaterThanOrEqual(7);
    for (const bg of [PALETTE.darkHc.surface, CLUB_TEXT_GROUND.darkHc]) expect(contrastRatio(t.textDhc, bg)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.clubOn, t.club)).toBeGreaterThanOrEqual(4.5);
  });
});

// A dark club color (Launch Indigo, the default, above all) barely parted from the dark grounds: its fill is lightened
// in dark until a primary button and the logo tile stand 3:1 off every dark ground, with its ink worked out again, and
// its tint is washed in until the current nav item is told from the surface (1.3:1) while the club's text on it reads.
describe("a dark club color in dark mode", () => {
  const DARK_GROUNDS = [PALETTE.dark.ground, PALETTE.dark.surface, PALETTE.dark["surface-raised"], PALETTE.dark["surface-muted"]];
  const HC_GROUNDS = [PALETTE.darkHc.ground, PALETTE.darkHc.surface, PALETTE.darkHc["surface-raised"]];
  it.each(["#1e1b4b", "#000000", "#003366", "#2b0000", "#5b2a86", "#333333", "#1d7344", "#0000ff", "#f2c200", "#e0f7fa", "#ff0000", "#ffffff", "#808080"])("%s: the fill stands off the ground, and the tint off the surface", (hex) => {
    const t = deriveClubTokens(hex);
    for (const bg of [...DARK_GROUNDS, ...HC_GROUNDS]) expect(contrastRatio(t.clubD, bg), `fill on ${bg}`).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t.clubOnD, t.clubD), "ink on the dark fill").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.tintD, PALETTE.dark.surface), "tint on the surface").toBeGreaterThanOrEqual(1.3);
    expect(contrastRatio(t.textD, t.tintD), "club text on the tint").toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textDhc, t.tintD), "high-contrast club text on the tint").toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.textLhc, t.tintL), "high-contrast club text on the light tint").toBeGreaterThanOrEqual(7);
  });
  it("keeps a color that already stands off the dark grounds as it is, and lightens only one that doesn't, in its own hue", () => {
    expect(deriveClubTokens("#f2c200").clubD).toBe("#f2c200");
    expect(deriveClubTokens("#ff0000").clubD).toBe("#ff0000");
    const indigo = deriveClubTokens("#1e1b4b");
    expect(indigo.club).toBe("#1e1b4b");
    expect(indigo.clubD).not.toBe("#1e1b4b");
    const hue = (hex: string) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const max = Math.max(r, g, b), d = max - Math.min(r, g, b); return max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; };
    expect(Math.abs(hue(indigo.clubD) - hue(indigo.club))).toBeLessThan(0.1);
  });
  it("the stylesheet's default (Launch Indigo, before a club picks a color) is what the derivation gives", () => {
    const t = deriveClubTokens("#1e1b4b");
    for (const [name, value] of Object.entries({ "club-l": t.club, "club-on-l": t.clubOn, "club-d": t.clubD, "club-on-d": t.clubOnD, "club-text-l": t.textL, "club-text-d": t.textD,
      "club-text-lhc": t.textLhc, "club-text-dhc": t.textDhc, "club-tint-l": t.tintL, "club-tint-d": t.tintD })) expect(css).toContain(`--${name}: ${value};`);
  });
  it("each theme picks its own fill: light the color as picked, dark the lightened one", () => {
    expect(css).toMatch(/:root, \[data-theme="light"\] \{[^}]*--club: var\(--club-l\); --club-on: var\(--club-on-l\);/);
    expect(css).toMatch(/\[data-theme="dark"\] \{[^}]*--club: var\(--club-d\); --club-on: var\(--club-on-d\);/);
    expect(css).toMatch(/:root:not\(\[data-theme="light"\]\) \{[^}]*--club: var\(--club-d\); --club-on: var\(--club-on-d\);/);
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

describe("the brand's fixed colors (brand/tokens.json)", () => {
  const brand = JSON.parse(readFileSync("brand/tokens.json", "utf8")) as {
    color: { brand: { indigo: string }; status_light: Record<string, { fg: string; bg: string }>; status_dark_proposed: Record<string, { fg: string; bg: string }>;
      app_light: { badge_ink: string }; app_dark_proposed: { badge_ink: string } };
  };
  const lower = (hex: string) => hex.toLowerCase();
  // the brand's paid, due, overdue and info are the app's done, due, late and info
  const TONES = { paid: "done", due: "due", overdue: "late", info: "info" } as const;
  it("a club that hasn't chosen a color is drawn in Launch Indigo", () => {
    const club = readFileSync("src/lib/settings/club.ts", "utf8");
    expect(/export const DEFAULT_COLOR = "(#[0-9a-f]{6})";/.exec(club)?.[1]).toBe(lower(brand.color.brand.indigo));
    expect(readFileSync("scripts/design-gallery.tsx", "utf8")).toContain(`const DEFAULT_COLOR = "${lower(brand.color.brand.indigo)}";`);
    expect(css).toContain(`--club-l: ${lower(brand.color.brand.indigo)};`);
  });
  it.each(Object.entries(TONES))("the status %s is the brand's, in light and in dark", (name, tone) => {
    const [light, dark] = [brand.color.status_light[name]!, brand.color.status_dark_proposed[name]!];
    expect([PALETTE.light[tone], PALETTE.light[`${tone}-soft`]]).toEqual([lower(light.fg), lower(light.bg)]);
    expect([PALETTE.dark[tone], PALETTE.dark[`${tone}-soft`]]).toEqual([lower(dark.fg), lower(dark.bg)]);
  });
  it("the Powered by badge is in the brand's badge ink", () => {
    expect([PALETTE.light["badge-ink"], PALETTE.dark["badge-ink"]]).toEqual([lower(brand.color.app_light.badge_ink), lower(brand.color.app_dark_proposed.badge_ink)]);
  });
});
