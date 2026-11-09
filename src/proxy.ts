import { NextResponse, type NextRequest } from "next/server";
import { setupStatusCached } from "@/lib/setup/state";

/** While setup is open, every page goes to /setup. API routes (health, sign-in callbacks) are not matched. */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/setup" || pathname.startsWith("/setup/")) return NextResponse.next();
  if ((await setupStatusCached()) === "open") return NextResponse.redirect(new URL("/setup", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico|.*\\.(?:png|svg|ico|webp|jpg|css|js|woff2?|txt)$).*)"],
};
