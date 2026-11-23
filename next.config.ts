import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";
import pkg from "./package.json";

/**
 * The version the Health page shows (src/lib/health/version.ts), fixed here while the portal is built: the package
 * version and the commit it was built from. The commit comes from APP_COMMIT when the build is given one (the Docker
 * build is: its context has no .git), else from git. Neither is a secret, and neither is taken unless it looks like
 * what it should be.
 */
function buildVersion(): string {
  let commit = (process.env.APP_COMMIT ?? "").trim();
  if (!commit) {
    try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { commit = ""; }
  }
  return /^[0-9a-f]{7,40}$/.test(commit) ? `${pkg.version} (${commit.slice(0, 12)})` : pkg.version;
}

/**
 * Who may show the portal inside a frame: nobody. A page of the portal inside someone else's page can be dressed up
 * to trick a parent into tapping Pay or Sign out. frame-ancestors is the rule today's browsers read; X-Frame-Options
 * says the same to older ones.
 *
 * This rule is about the portal being put INSIDE another site. It says nothing about what the portal itself may
 * show in a frame, so it does not block the signing frame from another origin that forms will embed in a portal
 * page: that direction is governed by frame-src, which is not set here. (If the signing service ever sends its frame
 * back to a portal address, so that the portal is framed by itself, change 'none' to 'self' and DENY to SAMEORIGIN.)
 */
const NO_FRAMING = "frame-ancestors 'none'";

/** The addresses of the pages a set-up or reset link opens (src/app/sign-in/set-up/[token], reset/[token]). */
const LINK_PAGES = ["/sign-in/set-up/:token", "/sign-in/reset/:token"];

/** The largest body a request may send: a message's file of 10 MB with room for the form around it. */
const UPLOAD_BODY_LIMIT = "11mb";

const nextConfig: NextConfig = {
  // The Docker image sets NEXT_OUTPUT=standalone; local `pnpm start` and CI e2e keep the default output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
  env: { BR_BUILD_VERSION: buildVersion() },
  // A club message's file is uploaded through a staff action, up to 10 MB (src/lib/messages/file-types.ts), so an
  // action's body may be 11 MB, the multipart wrapping included, in place of the 1 MB default; the proxy, which buffers
  // a body before an action reads it, is given the same. The limit is for every action: Next.js reads the whole body
  // before any action's own checks run (tests/unit/pwa-static.test.ts pins it).
  experimental: { serverActions: { bodySizeLimit: UPLOAD_BODY_LIMIT }, proxyClientMaxBodySize: UPLOAD_BODY_LIMIT },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: NO_FRAMING },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        // The service worker (public/sw.js). Never taken from a cache, so a fix reaches every phone on its next visit.
        // Its own policy replaces the one above for this address: the worker may talk to this site and nothing else.
        // A script-wide policy for the pages is a later piece of work, not this one.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self'; ${NO_FRAMING}` },
        ],
      },
      // The pages a set-up or reset link opens carry its token in their address: no request they make sends it on as a
      // Referer, not even the first ones, for the page's own scripts and styles, which go out before the page's
      // <meta name="referrer"> is read. Each replaces the rule above for its own address (a later rule's header wins).
      ...LINK_PAGES.map((source) => ({ source, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] })),
    ];
  },
  async rewrites() {
    // Browsers ask for /favicon.ico on their own (a PDF, an image opened by itself). It gets the club's icon, from the
    // one handler that draws them all (src/app/icons/[name]/route.ts); pages name the icon themselves in their head.
    return [{ source: "/favicon.ico", destination: "/icons/favicon.png" }];
  },
};

export default nextConfig;
