import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { setupStatusCached } from "@/lib/setup/state";

/**
 * While setup is open, every page goes to /setup. Not matched, so never redirected: API routes (health, sign-in
 * callbacks), and what a phone fetches to install the portal or to show it offline: the manifest, the icons
 * (/icons/*.png), the service worker (/sw.js) and the offline page. A redirect there would hand the browser the setup
 * page in place of a manifest, and the service worker would store it as its offline page.
 */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/setup" || pathname.startsWith("/setup/")) return NextResponse.next();
  if ((await setupStatusCached()) === "open") return NextResponse.redirect(new URL("/setup", env.APP_URL));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico|manifest\\.webmanifest$|offline\\.html$|.*\\.(?:png|svg|ico|webp|jpg|css|js|woff2?|txt)$).*)"],
};
