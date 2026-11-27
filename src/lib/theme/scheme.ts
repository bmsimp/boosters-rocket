import { Hct, TonalPalette, argbFromHex, hexFromArgb } from "@material/material-color-utilities";
import { InvalidColorError, contrastRatio, inkOn, normalizeHex } from "./contrast";
import { MODES, PALETTE, STATUS_TONES, SURFACES, type Mode } from "./palette";

/**
 * A club's Material 3 color scheme, made from the one color it picks (the seed), the owner's D2 and D3 of 2026-11-26:
 *
 * - primary keeps the seed's own hue and chroma (its strength of color), at M3's fixed tones, so its contrast is
 *   guaranteed by tone distance whatever the color (HCT's tone is L*, so tone 40 on a tone 98 ground is 4.5:1 and more);
 * - secondary is the seed's hue at low chroma (16), for the current tab and rail item, ticked rows and tonal buttons;
 * - tertiary is the hue turned about 60 degrees (chroma 24), used sparingly;
 * - neither ever has more color than the seed (a gray club stays gray);
 * - the neutrals and the status colors are fixed (./palette.ts), never made from the seed.
 *
 * The club's exact color is kept as `seed` for the logo tile and the app icon only. Light and dark are both made from
 * the seed, and so are the high-contrast modes, at tones further apart (7:1). The focus ring is primary (D8), unless
 * primary would stand under 3:1 off any surface or container it can sit next to: then that mode's ring is on-surface.
 * Google's library does the color science (Apache-2.0, `@material/material-color-utilities`, pinned).
 */
export const CLUB_ROLES = [
  "primary", "on-primary", "primary-container", "on-primary-container",
  "secondary", "on-secondary", "secondary-container", "on-secondary-container",
  "tertiary", "on-tertiary", "tertiary-container", "on-tertiary-container",
] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];
export type ModeScheme = Record<ClubRole | "focus", string>;
export type ClubScheme = { seed: string; onSeed: string; modes: Record<Mode, ModeScheme> };

/** M3's tones for each role, per mode: [color, on-color, container, on-container]. */
const TONES: Record<Mode, [number, number, number, number]> = {
  light: [40, 100, 90, 10],
  dark: [80, 20, 30, 90],
  lightHc: [25, 100, 90, 0],
  darkHc: [90, 10, 25, 100],
};

/** The suffix each mode's variables carry on <html> (--primary-l, --primary-dhc); the stylesheet picks the mode's. */
export const MODE_SUFFIX: Record<Mode, string> = { light: "l", dark: "d", lightHc: "lhc", darkHc: "dhc" };

const RING_FLOOR = 3;

/** What the focus ring of a mode can sit next to: every fixed surface and container, and the club's own containers. */
function ringGrounds(mode: Mode, roles: Record<ClubRole, string>): string[] {
  const p = PALETTE[mode] as Record<string, string>;
  return [...SURFACES.map((s) => p[s]!), ...STATUS_TONES.map((t) => p[`${t}-container`]!), p["neutral-container"]!,
    roles["primary-container"], roles["secondary-container"], roles["tertiary-container"]];
}

export function clubScheme(input: string): ClubScheme {
  const seed = normalizeHex(input);
  if (!seed) throw new InvalidColorError(`“${input}” isn't a color. Use a hex value like #5b2a86.`);
  const hct = Hct.fromInt(argbFromHex(seed));
  const palettes = {
    primary: TonalPalette.fromHueAndChroma(hct.hue, hct.chroma),
    secondary: TonalPalette.fromHueAndChroma(hct.hue, Math.min(16, hct.chroma)),
    tertiary: TonalPalette.fromHueAndChroma((hct.hue + 60) % 360, Math.min(24, hct.chroma)),
  };
  const modes = Object.fromEntries(MODES.map((mode) => {
    const [c, on, container, onContainer] = TONES[mode];
    const roles = Object.fromEntries((["primary", "secondary", "tertiary"] as const).flatMap((name) => {
      const at = (tone: number) => hexFromArgb(palettes[name].tone(tone));
      return [[name, at(c)], [`on-${name}`, at(on)], [`${name}-container`, at(container)], [`on-${name}-container`, at(onContainer)]];
    })) as Record<ClubRole, string>;
    const ringHolds = ringGrounds(mode, roles).every((g) => contrastRatio(roles.primary, g) >= RING_FLOOR);
    return [mode, { ...roles, focus: ringHolds ? roles.primary : PALETTE[mode]["on-surface"] }];
  })) as Record<Mode, ModeScheme>;
  return { seed, onSeed: inkOn(seed), modes };
}

/** The scheme as CSS variables on <html>: `--seed`, `--on-seed`, and each role per mode (`--primary-l` … `--focus-dhc`). Hex values only. */
export function clubCssVars(s: ClubScheme): Record<string, string> {
  const vars: Record<string, string> = { "--seed": s.seed, "--on-seed": s.onSeed };
  for (const mode of MODES) for (const [role, hex] of Object.entries(s.modes[mode])) vars[`--${role}-${MODE_SUFFIX[mode]}`] = hex;
  return vars;
}
