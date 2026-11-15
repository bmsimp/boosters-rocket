import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  // The Docker image sets NEXT_OUTPUT=standalone; local `pnpm start` and CI e2e keep the default output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
  poweredByHeader: false,
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
    ];
  },
  async rewrites() {
    // Browsers ask for /favicon.ico on their own (a PDF, an image opened by itself). It gets the club's icon, from the
    // one handler that draws them all (src/app/icons/[name]/route.ts); pages name the icon themselves in their head.
    return [{ source: "/favicon.ico", destination: "/icons/favicon.png" }];
  },
};

export default nextConfig;
