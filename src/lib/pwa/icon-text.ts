/**
 * What may be written on the app icon. The icon is drawn with the one font that ships inside Next.js
 * (node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf). For a character that font lacks, the renderer asks
 * Google Fonts for another font, over the internet, from the server. So only characters in the tables below are ever
 * drawn; a short name with anything else gets the plain mark.
 *
 * The tables are that font's advance widths in thousandths of an em, read from the file; a 0 is a character it lacks.
 * tests/unit/pwa-icon-text.test.ts reads the font and fails if a Next.js upgrade changes it.
 */
const ASCII_FROM = 0x20;
const ASCII = [
  250, 213, 346, 478, 629, 802, 620, 178, 274, 274, 430, 558, 201, 419, 201, 480,
  663, 384, 619, 613, 615, 626, 593, 524, 604, 593, 297, 297, 544, 540, 544, 559,
  906, 668, 680, 703, 694, 603, 590, 700, 713, 270, 597, 640, 580, 877, 743, 739,
  650, 733, 672, 640, 552, 689, 667, 945, 606, 576, 544, 347, 455, 347, 426, 557,
  248, 551, 595, 546, 595, 561, 395, 594, 581, 244, 260, 590, 267, 877, 581, 573,
  595, 595, 379, 520, 392, 575, 536, 819, 585, 537, 537, 389, 264, 389, 523,
];
const LATIN_FROM = 0xa0;
const LATIN = [
  0, 213, 546, 611, 624, 576, 264, 549, 350, 828, 401, 533, 500, 0, 635, 356,
  404, 538, 348, 332, 248, 575, 596, 201, 317, 242, 419, 537, 732, 800, 782, 559,
  668, 668, 668, 668, 668, 669, 972, 703, 603, 603, 603, 603, 270, 270, 270, 270,
  694, 743, 739, 739, 739, 739, 739, 502, 739, 689, 689, 689, 689, 576, 620, 587,
  551, 551, 551, 551, 551, 551, 919, 546, 561, 561, 561, 561, 244, 244, 244, 244,
  573, 581, 573, 573, 573, 573, 573, 540, 573, 575, 575, 575, 575, 537, 595, 537,
];

/** The widest short name the settings page accepts. */
export const ICON_TEXT_MAX = 4;

/** A character's width in ems in the icon font, or 0 when the font lacks it. */
export function glyphWidthEm(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const units = ASCII[code - ASCII_FROM] ?? LATIN[code - LATIN_FROM] ?? 0;
  return units / 1000;
}

/** The width of a line of text in ems; 0 when any character is missing from the font. */
export function textWidthEm(text: string): number {
  let width = 0;
  for (const char of text) {
    const w = glyphWidthEm(char);
    if (w === 0) return 0;
    width += w;
  }
  return width;
}

/**
 * The text for the icon, from the club's short name: its first four characters, as typed. Null means "draw the plain
 * mark": the name is empty, or holds a character the icon font can't draw (an emoji, a letter outside Western
 * European alphabets, a combining accent).
 */
export function iconText(shortName: string): string | null {
  const text = [...shortName.trim()].slice(0, ICON_TEXT_MAX).join("").trim();
  if (!text || textWidthEm(text) === 0) return null;
  return text;
}
