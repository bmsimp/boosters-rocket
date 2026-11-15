"use client";
import { useSyncExternalStore } from "react";
import { installDevice, installHintView, type InstallDevice } from "./install-platform";
import { installOffer, installedThisVisit, openInstallPrompt, subscribeInstallOffer, watchInstallOffer } from "./install-offer";

watchInstallOffer();

/** Remembered on this device only, like the display choices. */
const DISMISSED_KEY = "br-install-hint";
let dismissedThisVisit = false; // for a browser that won't store anything (private browsing)
const dismissedListeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => { dismissedListeners.add(listener); return () => { dismissedListeners.delete(listener); }; };
function readDismissed(): boolean {
  if (dismissedThisVisit) return true;
  try { return localStorage.getItem(DISMISSED_KEY) === "dismissed"; } catch { return false; }
}
function dismiss() {
  dismissedThisVisit = true;
  try { localStorage.setItem(DISMISSED_KEY, "dismissed"); } catch { /* it stays hidden for this visit only */ }
  for (const listener of dismissedListeners) listener();
}

function readDevice(): InstallDevice {
  if (installedThisVisit()) return "installed";
  return installDevice({
    userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
    iosStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayStandalone: window.matchMedia("(display-mode: standalone)").matches,
  });
}

const ShareIcon = () => (
  <svg className="install-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 15V3M8 7l4-4 4 4M5 11v9h14v-9" />
  </svg>
);

/**
 * How to put the portal on the home screen. Chromium: an Install button, when the browser has offered a prompt.
 * iPhone and iPad: the steps, since Apple gives a page no button for it. Nothing when the portal is already running
 * from the home screen.
 *
 * `permanent` is the box on the Display page: always there, with no "Not now". Without it the hint can be dismissed,
 * and stays dismissed on this device.
 *
 * It takes no props about the club or the person: nothing here is sent from the server.
 */
export function InstallHint({ permanent = false }: { permanent?: boolean }) {
  // The server and the first browser pass draw nothing: only the browser knows what it is.
  const device = useSyncExternalStore(subscribeInstallOffer, readDevice, () => "unknown" as const);
  const offer = useSyncExternalStore(subscribeInstallOffer, installOffer, () => null);
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, () => false);
  const view = installHintView({ device, offered: offer !== null, dismissed, permanent });
  if (view === "none") return null;

  return (
    <section className="box install-hint" aria-labelledby="install-h">
      <h2 id="install-h">Add the portal to your home screen</h2>
      <p>It opens with one tap, like any other app. There&apos;s nothing to download from a store.</p>
      {view === "install" && (
        <div className="row-actions install-actions">
          <button type="button" className="btn btn-line" onClick={() => { void openInstallPrompt(); }}>Install</button>
          {!permanent && <button type="button" className="btn btn-line" onClick={dismiss}>Not now</button>}
        </div>
      )}
      {(view === "ios" || view === "ios-in-app") && (
        <>
          {view === "ios-in-app" && (
            <p className="install-first">You&apos;re inside another app&apos;s browser, which can&apos;t do this. First open this page in Safari: look for
              a compass icon or a menu with &ldquo;Open in Safari&rdquo; or &ldquo;Open in browser&rdquo;. Then, in Safari:</p>
          )}
          <ol className="steps-list install-steps">
            <li>Tap Share <ShareIcon /> (the square with an arrow pointing up). If you don&apos;t see it, tap the button with three dots first.</li>
            <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
            <li>Tap <b>Add</b>.</li>
          </ol>
          {view === "ios" && (
            // A link opened from some apps looks exactly like Safari to this page, and has no Add to Home Screen.
            <p className="hint install-first">No Add to Home Screen in the list? This page is open inside another app. Tap the compass icon to open it in Safari, then try again.</p>
          )}
          {!permanent && (
            <div className="row-actions install-actions">
              <button type="button" className="btn btn-line" onClick={dismiss}>Not now</button>
            </div>
          )}
        </>
      )}
      {view === "menu" && (
        <p className="install-first">Open your browser&apos;s menu and look for <b>Install</b> or <b>Add to Home Screen</b>. On an iPhone or iPad, use Safari.</p>
      )}
    </section>
  );
}
