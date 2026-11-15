"use client";
import { useEffect } from "react";
import { watchInstallOffer } from "./install-offer";

// As soon as this file loads in the browser, before anything is drawn: the install offer comes once and early.
watchInstallOffer();

/**
 * Mounted once, in the root layout. It keeps Chromium's install offer for the install hint and, when `worker` is set,
 * registers the service worker (public/sw.js), whose one job is to show the offline page when a page can't be loaded.
 * The root layout sets `worker` in production only: in development a worker would sit between the browser and the dev server.
 */
export function AppInstall({ worker }: { worker: boolean }) {
  useEffect(() => {
    if (!worker || !("serviceWorker" in navigator)) return;
    // updateViaCache "none": the browser never takes sw.js, or anything it imports, from its HTTP cache.
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // No worker only means no offline page: the portal works without it.
    });
  }, [worker]);
  return null;
}
