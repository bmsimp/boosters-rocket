import type { MetadataRoute } from "next";
import { appLabel } from "./label";
import { ICONS, iconArt, iconHref, iconVersion, type IconName } from "./icons";

/**
 * The web app manifest for this club: what a phone needs to put the portal on its home screen. One app for the whole
 * portal, parents and staff alike. Every address is a path: whoever installs the portal chooses its hostname, and the
 * browser reads these against the address it fetched the manifest from.
 */
export function buildManifest(club: { name: string; shortName: string; color: string }): MetadataRoute.Manifest {
  const version = iconVersion(club);
  const color = iconArt(club).background;
  const icon = (name: IconName, purpose: "any" | "maskable") =>
    ({ src: iconHref(name, version), sizes: `${ICONS[name].size}x${ICONS[name].size}`, type: "image/png", purpose });
  return {
    name: club.name.trim(),
    short_name: appLabel(club),
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: color,
    background_color: color,
    icons: [
      icon("icon-192.png", "any"), icon("icon-512.png", "any"),
      icon("icon-192.png", "maskable"), icon("icon-512.png", "maskable"),
    ],
  };
}
