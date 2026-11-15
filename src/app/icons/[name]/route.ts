import { getClubSettings } from "@/lib/settings/club";
import { iconVersion, isIconName } from "@/lib/pwa/icons";
import { renderIcon } from "@/lib/pwa/icon-render";

export const dynamic = "force-dynamic";

/**
 * The club's app icons, at /icons/icon-192.png, icon-512.png, apple-touch-icon.png and favicon.png (ICONS in
 * src/lib/pwa/icons.ts; any other name is a 404). Public on purpose: a phone fetches them before anyone has signed in,
 * and they show only the club's short name on the club's color. Nothing about a family is read here.
 *
 * Drawn on request from the club's settings and kept in memory. The manifest and the head tags ask with ?v=<version>;
 * that address can be kept forever, because the version changes when the icon does. Asked without it, or with an old
 * one, the answer is checked again each time.
 */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }): Promise<Response> {
  const { name } = await params;
  if (!isIconName(name)) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  const club = await getClubSettings();
  const version = iconVersion(club);
  const icon = await renderIcon(name, club);
  if (icon.degraded) {
    // The plain mark stands in for letters that could not be drawn: nobody should keep it.
    return new Response(new Uint8Array(icon.png), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  const etag = `"${version}"`;
  const current = new URL(req.url).searchParams.get("v") === version;
  const headers = {
    "content-type": "image/png", etag,
    "cache-control": current ? "public, max-age=31536000, immutable" : "no-cache",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(icon.png), { headers });
}
