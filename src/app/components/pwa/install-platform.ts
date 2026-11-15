/**
 * Which way of installing the portal this browser has, worked out from what the browser says about itself. No
 * component here: these are plain functions, so the rules are tested without a browser (tests/unit/pwa-install.test.ts).
 */

/** What the hint needs to know about the device. A plain string, so React can compare one reading with the next. */
export type InstallDevice =
  | "installed"    // already running from the home screen
  | "ios"          // an iPhone or iPad browser with Share, then Add to Home Screen
  | "ios-in-app"   // an iPhone or iPad page opened inside another app (Mail, Facebook, Gmail): no Add to Home Screen there
  | "other";       // everything else: Chromium may offer an install prompt; if not, the browser's own menu

export type BrowserFacts = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  /** navigator.standalone: true on an iPhone or iPad when the page was opened from the home screen. */
  iosStandalone?: boolean;
  /** matchMedia("(display-mode: standalone)").matches */
  displayStandalone?: boolean;
};

export function installDevice(b: BrowserFacts): InstallDevice {
  if (b.iosStandalone === true || b.displayStandalone === true) return "installed";
  // An iPad says it is a Mac; a Mac has no touch screen.
  const ios = /iPhone|iPad|iPod/.test(b.userAgent) || (b.platform === "MacIntel" && (b.maxTouchPoints ?? 0) > 1);
  if (!ios) return "other";
  // Safari, and the other browsers on iOS (Chrome, Firefox, Edge), end with "Safari/<number>" and have Add to Home
  // Screen in their Share sheet. A page shown inside another app has no "Safari/", or names the app.
  const inApp = !/Safari\//.test(b.userAgent) || /FBAN|FBAV|FB_IAB|Instagram|Line\/|GSA\/|LinkedInApp|Snapchat|TikTok|Twitter/.test(b.userAgent);
  return inApp ? "ios-in-app" : "ios";
}

/** What the hint shows. */
export type InstallHintView =
  | "none"         // nothing at all
  | "install"      // an Install button (Chromium has offered a prompt)
  | "ios"          // the steps: Share, then Add to Home Screen
  | "ios-in-app"   // open in Safari first, then the steps
  | "menu";        // no prompt and no steps to give: point at the browser's own menu

/**
 * `permanent` is the box on the Display page: it stays whatever was dismissed, and always has something to say.
 * Elsewhere the hint is an offer a person can turn down once, and it keeps quiet when it has nothing sure to offer.
 */
export function installHintView(o: { device: InstallDevice | "unknown"; offered: boolean; dismissed: boolean; permanent: boolean }): InstallHintView {
  if (o.device === "unknown" || o.device === "installed") return "none";
  if (o.dismissed && !o.permanent) return "none";
  if (o.device === "ios" || o.device === "ios-in-app") return o.device;
  if (o.offered) return "install";
  return o.permanent ? "menu" : "none";
}
