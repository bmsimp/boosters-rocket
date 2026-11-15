import { createElement } from "react";
import { ImageResponse } from "next/og";
import { ICONS, iconArt, type IconArt, type IconName } from "./icons";
import { textWidthEm } from "./icon-text";
import { isSquarePng, plainIconPng } from "./plain-icon";

/** `degraded` is true when the letters could not be drawn and the plain mark stands in for them. */
export type RenderedIcon = { png: Buffer; degraded: boolean };

/** The icon font's line (ascender plus descender) in ems. The whole line, not only the capitals, stays inside the mark's share. */
const LINE_EM = 1.3;

/** The font size, in pixels, at which `text` fills the mark's share of a `size` pixel icon without leaving it. */
export function monogramFontSize(text: string, size: number, mark: number): number {
  const room = size * mark;
  return Math.floor(Math.min(room / textWidthEm(text), room / LINE_EM));
}

/** The short name in the bundled font, centered on the club's color. */
async function monogramPng(art: Extract<IconArt, { kind: "monogram" }>, size: number, mark: number): Promise<Buffer> {
  const image = new ImageResponse(
    createElement("div", {
      style: {
        width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        background: art.background, color: art.foreground, fontSize: monogramFontSize(art.text, size, mark), whiteSpace: "nowrap",
      },
    }, art.text),
    { width: size, height: size },
  );
  // ImageResponse answers before it has drawn anything, so a failure would leave as a 200 with a broken body.
  // Reading the bytes here makes it throw here instead.
  const png = Buffer.from(await image.arrayBuffer());
  if (!isSquarePng(png, size)) throw new Error(`the icon renderer did not return a ${size}px PNG`);
  return png;
}

async function draw(art: IconArt, size: number, mark: number): Promise<RenderedIcon> {
  if (art.kind === "plain") return { png: plainIconPng(size, art.background, art.foreground, mark), degraded: false };
  try {
    return { png: await monogramPng(art, size, mark), degraded: false };
  } catch (e) {
    console.error(`[app icon] Could not draw the ${size}px icon with the club's short name; serving the plain mark instead.`, e);
    return { png: plainIconPng(size, art.background, art.foreground, mark), degraded: true };
  }
}

/**
 * Drawn icons, kept in memory by size, color and short name: a club has one color and one short name, so this holds
 * a handful of small PNGs. A degraded icon is kept only briefly, so the letters come back when the renderer does.
 */
const MAX_KEPT = 32;
const RETRY_DEGRADED_MS = 5 * 60_000;
const kept = new Map<string, { icon: Promise<RenderedIcon>; until: number }>();

export function renderIcon(name: IconName, club: { shortName: string; color: string }, now = Date.now()): Promise<RenderedIcon> {
  const { size, mark } = ICONS[name];
  const art = iconArt(club);
  const key = JSON.stringify([size, mark, art]);
  const hit = kept.get(key);
  if (hit && now < hit.until) return hit.icon;
  const entry = { icon: draw(art, size, mark), until: Infinity };
  kept.delete(key);
  kept.set(key, entry);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  entry.icon.then((icon) => { if (icon.degraded) entry.until = now + RETRY_DEGRADED_MS; }, () => { kept.delete(key); });
  return entry.icon;
}

/** For tests: forget every drawn icon. */
export const forgetRenderedIcons = () => kept.clear();
