import type { MetadataRoute } from "next";
import { getClubSettings } from "@/lib/settings/club";
import { buildManifest } from "@/lib/pwa/manifest";

// Without this the manifest is built once, at `next build`: the Docker build has no database, and a build that had one
// would bake that club's name and color into the image. It is read from the club's settings on every request.
export const dynamic = "force-dynamic";

/** Served at /manifest.webmanifest. Public: it holds the club's name, short name and color, which the sign-in page shows anyway. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  return buildManifest(await getClubSettings());
}
