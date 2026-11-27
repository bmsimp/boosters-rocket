import type { MetadataRoute } from "next";
import { appLabel } from "./label";
import { ICONS, iconHref, iconVersion, type IconName } from "./icons";
import { PALETTE } from "@/lib/theme/palette";

/**
 * The web app manifest for this club: what a phone needs to put the portal on its home screen. One app for the whole
 * portal, parents and staff alike. Every address is a path: whoever installs the portal chooses its hostname, and the
 * browser reads these against the address it fetched the manifest from. The colors are the look's, not the club's:
 * the theme color is the top bar's surface and the splash the page's ground, so an installed app opens and sits
 * in the same calm frame as the page (the club's color is on its icon).
 */
export function buildManifest(club: { name: string; shortName: string; color: string }): MetadataRoute.Manifest {
  const version = iconVersion(club);
  const icon = (name: IconName, purpose: "any" | "maskable") =>
    ({ src: iconHref(name, version), sizes: `${ICONS[name].size}x${ICONS[name].size}`, type: "image/png", purpose });
  return {
    name: club.name.trim(),
    short_name: appLabel(club),
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: PALETTE.light.surface,
    background_color: PALETTE.light.ground,
    icons: [
      icon("icon-192.png", "any"), icon("icon-512.png", "any"),
      icon("icon-192.png", "maskable"), icon("icon-512.png", "maskable"),
    ],
  };
}
