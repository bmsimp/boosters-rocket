import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { contrastRatio } from "@/lib/theme/contrast";
import { MARK_PAIRS, MODES, PALETTE, STATUS_TONES, SURFACES, TEXT_PAIRS, THEME_COLOR, type Mode } from "@/lib/theme/palette";
import { CLUB_ROLES, MODE_SUFFIX, clubCssVars, clubScheme } from "@/lib/theme/scheme";

// The token blocks of booster.css hold the same colors as src/lib/theme/palette.ts; every pair the system draws passes
// its floor in every display mode (4.5:1 for text, 7:1 in high contrast, 3:1 for a control's edge or a mark); and every
// club's scheme, made from its color (M3 Expressive, the owner's D1 to D8 of 2026-11-26), passes too.
const css = readFileSync("src/app/booster.css", "utf8");

/** The `--name: #hex` declarations between a `/* @tokens <name> *\/` marker and the next `/* @end *\/`. */
function block(name: string): Record<string, string> {
  const start = css.indexOf(`/* @tokens ${name} */`);
  expect(start, `booster.css has a /* @tokens ${name} */ block`).toBeGreaterThan(0);
  const body = css.slice(start, css.indexOf("/* @end */", start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
}
/** A theme's own colors, without its high-contrast set (written as --hc-* in its nested block). */
const own = (name: string) => Object.fromEntries(Object.entries(block(name)).filter(([k]) => !k.startsWith("hc-")));
/** A high-contrast set: the --hc-* names its theme block maps onto the roles, over the theme's own. */
const hc = (theme: string, name: string) => ({ ...own(theme), ...Object.fromEntries(Object.entries(block(name)).map(([k, v]) => [k.replace(/^hc-/, ""), v])) });
const inCss: Record<Mode, Record<string, string>> = { light: own("light"), dark: own("dark"), lightHc: hc("light", "light-hc"), darkHc: hc("dark", "dark-hc") };

describe("the stylesheet's colors are the palette's", () => {
  it.each(MODES)("%s", (mode) => {
    for (const [token, hex] of Object.entries(PALETTE[mode])) expect(inCss[mode][token], `--${token} in ${mode}`).toBe(hex);
  });
  it("the dark set is written the same for the attribute and for the device setting", () => {
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)![1]!;
    const hexes = (s: string) => Object.fromEntries([...s.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]));
    const roles = (s: string) => [...s.matchAll(/--([a-z-]+): var\(--([a-z-]+)\)/g)].map((m) => `${m[1]}=${m[2]}`);
    const start = css.indexOf("/* @tokens dark */");
    const dark = css.slice(start, css.indexOf("@media (prefers-color-scheme: dark)", start));
    expect(hexes(media)).toEqual(block("dark"));
    expect(roles(media)).toEqual(roles(dark));
  });
  it("the browser's theme color is the top bar's surface", () => {
    expect(THEME_COLOR).toEqual({ light: PALETTE.light.surface, dark: PALETTE.dark.surface });
  });
  it("each mode picks its own club roles: light the -l set, dark the -d, high contrast the -lhc and -dhc", () => {
    for (const role of [...CLUB_ROLES, "focus"]) {
      expect(css).toMatch(new RegExp(`:root, \\[data-theme="light"\\] \\{[^}]*--${role}: var\\(--${role}-l\\);[^}]*--hc-${role}: var\\(--${role}-lhc\\);`));
      expect(css).toMatch(new RegExp(`\\[data-theme="dark"\\] \\{[^}]*--${role}: var\\(--${role}-d\\);[^}]*--hc-${role}: var\\(--${role}-dhc\\);`));
      expect(css).toContain(`--${role}: var(--hc-${role});`);
    }
  });
});

describe("every fixed pair passes its floor", () => {
  it.each(MODES)("%s", (mode) => {
    const p = PALETTE[mode] as Record<string, string>;
    const floor = mode.endsWith("Hc") ? 7 : 4.5;
    for (const [fg, bg] of TEXT_PAIRS) expect(contrastRatio(p[fg]!, p[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(floor);
    for (const [fg, bg] of MARK_PAIRS) expect(contrastRatio(p[fg]!, p[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The seeds every scheme is checked for: the default (Launch Indigo), a very light yellow, a near-black, a saturated
 * red, FZN green and a purple, and a few more that once caught a hand-made rule out (gold, cyan, pure black and white).
 */
const SEEDS = ["#1e1b4b", "#fff59d", "#111111", "#d50000", "#2e7d32", "#6a1b9a", "#f2c200", "#e0f7fa", "#000000", "#ffffff", "#0000ff", "#808080"];

describe("the contrast matrix: every club's scheme, in every mode", () => {
  describe.each(SEEDS)("seeded from %s", (seed) => {
    const s = clubScheme(seed);
    it.each(MODES)("%s", (mode) => {
      const p = PALETTE[mode] as Record<string, string>, r = s.modes[mode];
      const floor = mode.endsWith("Hc") ? 7 : 4.5;
      // each role's ink on its own color: a filled button, the bulk bar, the current tab's pill, a ticked row
      for (const role of ["primary", "secondary", "tertiary"] as const) {
        expect(contrastRatio(r[`on-${role}`], r[role]), `on-${role} on ${role}`).toBeGreaterThanOrEqual(floor);
        expect(contrastRatio(r[`on-${role}-container`], r[`${role}-container`]), `on-${role}-container on its container`).toBeGreaterThanOrEqual(floor);
      }
      // primary as text and links on every surface, and on the club's containers (a link in a ticked row, the tonal card)
      for (const bg of SURFACES) expect(contrastRatio(r.primary, p[bg]!), `primary on ${bg}`).toBeGreaterThanOrEqual(floor);
      for (const bg of ["primary-container", "secondary-container"] as const) expect(contrastRatio(r.primary, r[bg]), `primary on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // the fixed status colors and the surfaces' text, where they sit on a ticked row's secondary container
      expect(contrastRatio(p["on-surface"]!, r["secondary-container"]), "on-surface on secondary-container").toBeGreaterThanOrEqual(floor);
      // the ink on the tonal (primary container) card and the bulk bar carries its own text
      expect(contrastRatio(r["on-primary-container"], r["primary-container"])).toBeGreaterThanOrEqual(floor);
    });
    it("the logo tile's ink reads on the club's exact color", () => {
      expect(s.seed).toBe(seed);
      expect(contrastRatio(s.onSeed, s.seed)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe("the focus ring (D8): 3px, in primary, 3:1 against every surface it can sit on, else on-surface", () => {
  it("is 3px with a 2px offset everywhere", () => {
    expect(css).toContain("--ring: 3px;");
    expect(css).toContain(":focus-visible { outline: var(--ring) solid var(--focus); outline-offset: 2px; }");
    expect(css).not.toMatch(/--ring: 2px/);
  });
  it.each(SEEDS)("%s", (seed) => {
    const s = clubScheme(seed);
    for (const mode of MODES) {
      const p = PALETTE[mode] as Record<string, string>, r = s.modes[mode];
      const grounds = [...SURFACES.map((g) => p[g]!), ...STATUS_TONES.map((t) => p[`${t}-container`]!), p["neutral-container"]!,
        r["primary-container"], r["secondary-container"], r["tertiary-container"]];
      for (const g of grounds) expect(contrastRatio(r.focus, g), `${mode} ring on ${g}`).toBeGreaterThanOrEqual(3);
      expect([r.primary, p["on-surface"]]).toContain(r.focus);
    }
  });
  it("falls back to on-surface for a mode where primary can't hold 3:1", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("@material/material-color-utilities", async (orig) => {
      const lib = await orig<typeof import("@material/material-color-utilities")>();
      // every tone the same light gray: primary can't stand off the light surfaces
      const flat = { tone: () => lib.argbFromHex("#d0d0d0") };
      return { ...lib, TonalPalette: { fromHueAndChroma: () => flat } };
    });
    const { clubScheme: flatScheme } = await import("@/lib/theme/scheme");
    expect(flatScheme("#2e7d32").modes.light.focus).toBe(PALETTE.light["on-surface"]);
    vi.doUnmock("@material/material-color-utilities");
    vi.resetModules();
  });
});

describe("the club's palette keeps to D2", () => {
  it("primary has the seed's own hue, at M3's fixed tones; secondary is quieter; tertiary is turned", async () => {
    const { Hct, argbFromHex } = await import("@material/material-color-utilities");
    const hct = (hex: string) => Hct.fromInt(argbFromHex(hex));
    const seed = hct("#2e7d32"), s = clubScheme("#2e7d32");
    expect(Math.round(hct(s.modes.light.primary).tone)).toBe(40);
    expect(Math.round(hct(s.modes.dark.primary).tone)).toBe(80);
    expect(Math.round(hct(s.modes.light["primary-container"]).tone)).toBe(90);
    expect(Math.round(hct(s.modes.dark["primary-container"]).tone)).toBe(30);
    expect(Math.abs(hct(s.modes.light.primary).hue - seed.hue)).toBeLessThan(6);
    expect(hct(s.modes.light.secondary).chroma).toBeLessThanOrEqual(17);
    const turned = (hct(s.modes.light.tertiary).hue - seed.hue + 360) % 360;
    expect(turned).toBeGreaterThan(40);
    expect(turned).toBeLessThan(80);
  });
  it("a gray seed makes a gray scheme", async () => {
    const { Hct, argbFromHex } = await import("@material/material-color-utilities");
    for (const hex of Object.values(clubScheme("#808080").modes.light)) expect(Hct.fromInt(argbFromHex(hex)).chroma).toBeLessThan(4);
  });
  it("the stylesheet's default (Launch Indigo, before a club picks a color) is what the scheme gives", () => {
    for (const [name, value] of Object.entries(clubCssVars(clubScheme("#1e1b4b")))) expect(css).toContain(`${name}: ${value};`);
  });
  it("writes every role of every mode, as hex only", () => {
    const vars = clubCssVars(clubScheme("#f2c200"));
    expect(Object.keys(vars)).toHaveLength(2 + (CLUB_ROLES.length + 1) * MODES.length);
    for (const mode of MODES) expect(vars).toHaveProperty(`--primary-${MODE_SUFFIX[mode]}`);
    for (const v of Object.values(vars)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("the stylesheet keeps to the type floor, rem, and M3's 48px target", () => {
  it("no font size under 0.8125rem, and none in px", () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    for (const size of sizes) {
      expect(size, "a font size in px").not.toMatch(/\dpx/);
      const rem = /^([\d.]+)rem$/.exec(size);
      if (rem) expect(Number(rem[1]), size).toBeGreaterThanOrEqual(0.8125);
    }
    for (const m of css.matchAll(/font:\s*(\d{3}) ([\d.]+)(rem|px)/g)) {
      expect(m[3], `a font shorthand in px: ${m[0]}`).toBe("rem");
      expect(Number(m[2]), m[0]).toBeGreaterThanOrEqual(0.8125);
    }
  });
  it("the size steps, and M3's type roles in rem with body-large at 1rem", () => {
    expect(css).toContain("--text-xs: 0.8125rem; --text-sm: 0.875rem; --text-control: 0.875rem; --text-md: 1rem; --text-lg: 1.375rem; --text-xl: 2rem; --text-2xl: 2.25rem;");
    expect(css).toContain("--body-l: 400 1rem/1.5rem var(--font);");
    expect(css).toContain("--label-m: 600 0.8125rem/1rem var(--font);");
  });
  it("the touch target is 48px, and nothing still asks for 44", () => {
    expect(css).toContain("--target: 48px;");
    expect(css).not.toMatch(/\b44px\b/);
  });
  it("M3's shape scale", () => {
    expect(css).toContain("--shape-xs: 4px; --shape-s: 8px; --shape-m: 12px; --shape-l: 16px; --shape-l-inc: 20px;");
    expect(css).toContain("--shape-xl: 28px; --shape-xl-inc: 32px; --shape-xxl: 48px; --shape-full: 999px;");
  });
  it("a status label has 8px corners, so it never looks like a button (D7)", () => {
    expect(/\.badge \{[^}]*border-radius: var\(--shape-s\)/.test(css)).toBe(true);
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
    expect(css).toContain(`--seed: ${lower(brand.color.brand.indigo)};`);
  });
  it.each(Object.entries(TONES))("the status %s is the brand's, in light and in dark", (name, tone) => {
    const [light, dark] = [brand.color.status_light[name]!, brand.color.status_dark_proposed[name]!];
    expect([PALETTE.light[tone], PALETTE.light[`${tone}-container`]]).toEqual([lower(light.fg), lower(light.bg)]);
    expect([PALETTE.dark[tone], PALETTE.dark[`${tone}-container`]]).toEqual([lower(dark.fg), lower(dark.bg)]);
  });
  it("the Powered by badge is in the brand's badge ink", () => {
    expect([PALETTE.light["badge-ink"], PALETTE.dark["badge-ink"]]).toEqual([lower(brand.color.app_light.badge_ink), lower(brand.color.app_dark_proposed.badge_ink)]);
  });
});
