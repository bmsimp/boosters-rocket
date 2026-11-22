import { CLUB_TEXT_GROUND, CLUB_TINT_SURFACE } from "./palette";

export class InvalidColorError extends Error {}

const INK = "#14161a";
const WHITE = "#ffffff";
/** The club's color as text is checked against the hardest ground of each mode it is drawn on (./palette.ts). */
const GROUND_L = CLUB_TEXT_GROUND.light;
const GROUND_D = CLUB_TEXT_GROUND.dark;
const GROUND_LHC = CLUB_TEXT_GROUND.lightHc;
const GROUND_DHC = CLUB_TEXT_GROUND.darkHc;

export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s.split("").map((c) => c + c).join("")}`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  return null;
}

type RGB = [number, number, number];
const toRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const toHex = (rgb: RGB) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Moves lightness (same hue and saturation) in `direction` until `ratio` is met against `ground`. */
function adjustUntil(hex: string, ground: string, ratio: number, direction: "darker" | "lighter"): string {
  if (contrastRatio(hex, ground) >= ratio) return hex;
  const [h, s, l0] = rgbToHsl(toRgb(hex));
  for (let i = 1; i <= 100; i++) {
    const l = direction === "darker" ? l0 * (1 - i / 100) : l0 + (1 - l0) * (i / 100);
    const candidate = toHex(hslToRgb([h, s, l]));
    if (contrastRatio(candidate, ground) >= ratio) return candidate;
  }
  return direction === "darker" ? "#000000" : "#ffffff";
}

function mix(a: string, b: string, weightA: number): string {
  const [ra, ga, ba] = toRgb(a), [rb, gb, bb] = toRgb(b);
  return toHex([ra * weightA + rb * (1 - weightA), ga * weightA + gb * (1 - weightA), ba * weightA + bb * (1 - weightA)]);
}

export type ClubTokens = {
  club: string; clubOn: string; textL: string; textD: string; textLhc: string; textDhc: string; tintL: string; tintD: string;
};

export function deriveClubTokens(input: string): ClubTokens {
  const club = normalizeHex(input);
  if (!club) throw new InvalidColorError(`“${input}” isn't a color. Use a hex value like #5b2a86.`);
  const clubOn = contrastRatio(WHITE, club) >= contrastRatio(INK, club) ? WHITE : INK;
  const textL = adjustUntil(club, GROUND_L, 4.5, "darker");
  const textD = adjustUntil(club, GROUND_D, 4.5, "lighter");
  const textLhc = adjustUntil(club, GROUND_LHC, 7, "darker");
  const textDhc = adjustUntil(club, GROUND_DHC, 7, "lighter");
  const tintL = mix(club, CLUB_TINT_SURFACE.light, 0.08);
  const tintD = mix(club, CLUB_TINT_SURFACE.dark, 0.14);
  return {
    club, clubOn,
    textL: adjustUntil(textL, tintL, 4.5, "darker"),
    textD: adjustUntil(textD, tintD, 4.5, "lighter"),
    textLhc, textDhc, tintL, tintD,
  };
}

export function clubCssVars(t: ClubTokens): Record<string, string> {
  return {
    "--club": t.club, "--club-on": t.clubOn,
    "--club-text-l": t.textL, "--club-text-d": t.textD,
    "--club-text-lhc": t.textLhc, "--club-text-dhc": t.textDhc,
    "--club-tint-l": t.tintL, "--club-tint-d": t.tintD,
  };
}
