/** Hex colors and WCAG contrast: what the club's scheme (./scheme.ts) and the contrast checks measure with. */
export class InvalidColorError extends Error {}

export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s.split("").map((c) => c + c).join("")}`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  return null;
}

type RGB = [number, number, number];
const toRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2's contrast ratio between two hex colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const INK = "#14161a";
const WHITE = "#ffffff";

/** A fill's ink: white or near-black, whichever has the higher contrast against it (the club's exact color on its logo tile and app icon). */
export const inkOn = (fill: string) => (contrastRatio(WHITE, fill) >= contrastRatio(INK, fill) ? WHITE : INK);
