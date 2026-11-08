import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Barlow_Condensed } from "next/font/google";
import { getClubSettings, DEFAULT_COLOR } from "@/lib/settings/club";
import { deriveClubTokens, clubCssVars, normalizeHex } from "@/lib/theme/contrast";
import { DISPLAY_SCRIPT } from "./display-script";
import "./booster.css";

const read = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-read", display: "swap" });
const mark = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-mark", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const club = await getClubSettings();
  return { title: { default: club.name, template: `%s · ${club.name}` } };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
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
  const club = await getClubSettings();
  if (!club.storedColorValid) {
    console.warn(`[club settings] The stored club color is not a valid hex value; using the default ${DEFAULT_COLOR}. Save a valid color on the staff Club settings page to fix it.`);
  }
  const vars = safeVars(club.color); // values are hex only
  return (
    <html lang="en" className={`${read.variable} ${mark.variable}`} style={vars as React.CSSProperties} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: DISPLAY_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
