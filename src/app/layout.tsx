import { cache } from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { getClubSettings, DEFAULT_COLOR } from "@/lib/settings/club";
import { deriveClubTokens, clubCssVars, normalizeHex } from "@/lib/theme/contrast";
import { THEME_COLOR } from "@/lib/theme/palette";
import { appLabel } from "@/lib/pwa/label";
import { ICONS, iconHref, iconVersion, type IconName } from "@/lib/pwa/icons";
import { DISPLAY_SCRIPT } from "./display-script";
import { AppInstall } from "./components/pwa/app-install";
import "./booster.css";

/** Inter, the one typeface, self-hosted by next/font (fetched at build time, served from the portal). A variable font: every weight. */
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

/** The club's settings, read once for each request: the head tags and the layout both need them. */
const clubSettings = cache(getClubSettings);

export async function generateMetadata(): Promise<Metadata> {
  const club = await clubSettings();
  const version = iconVersion(club);
  const icon = (name: IconName) => ({ url: iconHref(name, version), type: "image/png", sizes: `${ICONS[name].size}x${ICONS[name].size}` });
  return {
    title: { default: club.name, template: `%s · ${club.name}` },
    applicationName: club.name,
    // The link to /manifest.webmanifest is added by Next.js because src/app/manifest.ts exists.
    icons: { icon: [icon("favicon.png"), icon("icon-192.png")], apple: [icon("apple-touch-icon.png")] },
    // "default" keeps iOS's own status bar above the page, in the device's light or dark, so the clock stays readable
    // over any club color.
    appleWebApp: { capable: true, title: appLabel(club), statusBarStyle: "default" },
    // Next.js writes only mobile-web-app-capable for appleWebApp.capable; older iOS reads this name.
    other: { "apple-mobile-web-app-capable": "yes" },
  };
}

/**
 * viewportFit "cover" lets the page reach under the notch and the home indicator; booster.css keeps its content clear
 * of them with env(safe-area-inset-*). Zoom is never limited (no maximumScale, no userScalable): WCAG 2.2 AA.
 */
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover", colorScheme: "light dark",
  // The browser's own bar matches the portal's top bar: its white surface in light, the dark surface in dark. The club's
  // color is an accent inside the page, not the frame around it (it stays the installed app's splash, src/lib/pwa/manifest.ts).
  themeColor: [{ media: "(prefers-color-scheme: light)", color: THEME_COLOR.light }, { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark }],
};
export const dynamic = "force-dynamic";

/** A bad stored color must never take every page down: fall back to the default. */
function safeVars(color: string) {
  try {
    return clubCssVars(deriveClubTokens(normalizeHex(color) ?? DEFAULT_COLOR));
  } catch {
    return clubCssVars(deriveClubTokens(DEFAULT_COLOR));
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const club = await clubSettings();
  if (!club.storedColorValid) {
    console.warn(`[club settings] The stored club color is not a valid hex value; using the default ${DEFAULT_COLOR}. Save a valid color on the staff Club settings page to fix it.`);
  }
  const vars = safeVars(club.color); // values are hex only
  return (
    <html lang="en" className={sans.variable} style={vars as React.CSSProperties} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: DISPLAY_SCRIPT }} /></head>
      <body>
        {children}
        {/* The service worker (the offline page) is registered in production only. The server decides: no client code reads the environment. */}
        <AppInstall worker={process.env.NODE_ENV === "production"} />
      </body>
    </html>
  );
}
