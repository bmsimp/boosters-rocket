import { createHash } from "node:crypto";
import { DEFAULT_COLOR } from "@/lib/settings/club";
import { inkOn, normalizeHex } from "@/lib/theme/contrast";
import { iconText } from "./icon-text";

/**
 * The app's icons: the only names /icons/<name> answers, each with its size in pixels and how much of its width the
 * mark may take. The 192 and 512 icons are listed in the manifest twice, for "any" and for "maskable": Android crops a
 * maskable icon to a circle or a rounded square and promises only the middle 80%, so the mark keeps to the middle 60%.
 * The favicon is never cropped and is tiny, so its mark runs wider.
 */
export const ICONS = {
  "icon-192.png": { size: 192, mark: 0.6 },
  "icon-512.png": { size: 512, mark: 0.6 },
  "apple-touch-icon.png": { size: 180, mark: 0.6 },
  "favicon.png": { size: 48, mark: 0.84 },
} as const;
export type IconName = keyof typeof ICONS;
export const isIconName = (name: string): name is IconName => Object.hasOwn(ICONS, name);

type Club = { shortName: string; color: string };

/**
 * What the icon shows. Today: the club's short name, or the plain mark when the icon font can't draw it. When a club
 * can upload a logo, it becomes a third kind here ({ kind: "logo", ... }, drawn in src/lib/pwa/icon-render.ts) and
 * joins the version below; the addresses, the manifest and the head tags stay as they are.
 */
export type IconArt = { kind: "monogram"; text: string; background: string; foreground: string }
  | { kind: "plain"; background: string; foreground: string };

export function iconArt(club: Club): IconArt {
  const background = normalizeHex(club.color) ?? DEFAULT_COLOR;
  const foreground = inkOn(background); // white or near-black, whichever reads on the club's exact color
  const text = iconText(club.shortName);
  return text ? { kind: "monogram", text, background, foreground } : { kind: "plain", background, foreground };
}

/** Raise this when the drawing itself changes, so installed apps and browsers fetch the new one. */
const DRAWING = 1;

/** A short name for what the icons look like now. It changes when the club's color or short name does. */
export function iconVersion(club: Club): string {
  return createHash("sha256").update(JSON.stringify([DRAWING, iconArt(club)])).digest("hex").slice(0, 12);
}

/**
 * An icon's address with the version on it, so whoever fetched it can keep it for good. No hostname: the portal's
 * address is the installer's choice.
 */
export const iconHref = (name: IconName, version: string) => `/icons/${name}?v=${version}`;
