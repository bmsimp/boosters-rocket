/*
  Booster Rocket's service worker. It does one thing: when a page can't be loaded because there is no connection, it
  shows /offline.html instead of the browser's error screen.

  The privacy rule this file keeps: NOTHING FROM THE APP IS EVER STORED HERE. Not a page, not the data a page loads
  as you move around, not an API answer, not a script. Every one of those can hold a family's name or balance, and a
  cache outlives a sign-out. The only thing stored is /offline.html, which is the same for every club and every person.
  tests/e2e/pwa.spec.ts signs a parent in, browses, and checks that this is all the caches hold.

  Because nothing from the app is stored, there is no old copy of the app for a new worker to disagree with, so a new
  worker takes over at once (skipWaiting, clients.claim).
*/
const CACHE = "br-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Fetched fresh, and refused if it is a redirect or an error: a redirect would store some other page under this name.
    const response = await fetch(new Request(OFFLINE_URL, { cache: "reload", redirect: "error" }));
    if (!response.ok) throw new Error("offline page not available: " + response.status);
    const cache = await caches.open(CACHE);
    await cache.put(OFFLINE_URL, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Anything else in this site's caches was left by an older worker: remove it.
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  // Only the loading of a whole page. Everything else is not touched: with no respondWith, the browser makes the
  // request itself, exactly as if this worker were not here.
  if (event.request.mode !== "navigate") return;
  event.respondWith((async () => {
    try {
      return await fetch(event.request);
    } catch {
      const offline = await caches.match(OFFLINE_URL);
      return offline || Response.error();
    }
  })());
});
