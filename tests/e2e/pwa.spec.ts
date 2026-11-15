import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";

// The portal as an installable app. The club is the one scripts/seed-e2e.ts saves: "E2E Boosters" (12 characters, so
// it is also the label under the icon), short name "E2E", color #5b2a86.
const CLUB = { name: "E2E Boosters", shortName: "E2E", color: "#5b2a86" };
const VERSIONED = /\?v=[0-9a-f]{12}$/;

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

/** The width and height a PNG states in its header, after checking that it is one. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex"), "the PNG signature").toBe("89504e470d0a1a0a");
  expect(bytes.toString("latin1", 12, 16)).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Waits until the service worker is active and in charge of this page. */
async function workerInCharge(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((done) => navigator.serviceWorker.addEventListener("controllerchange", () => done(), { once: true }));
  });
}

/** Everything in every cache of this site: each cache's name, and each entry's address and text. */
const cacheContents = (page: Page) => page.evaluate(async () => {
  const found: { cache: string; url: string; body: string }[] = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) found.push({ cache: name, url: new URL(request.url).pathname + new URL(request.url).search, body: await (await cache.match(request))!.text() });
  }
  return found;
});

test("the manifest answers as a manifest, built from the club's settings, with no hostname in it", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = await res.json();
  expect(manifest).toMatchObject({
    name: CLUB.name, short_name: CLUB.name, id: "/", start_url: "/", scope: "/", display: "standalone",
    theme_color: CLUB.color, background_color: CLUB.color,
  });
  expect(manifest.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`))
    .toEqual(["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]);
  for (const icon of manifest.icons) expect(icon.src).toMatch(/^\/icons\/icon-(192|512)\.png\?v=[0-9a-f]{12}$/);
  expect(await res.text()).not.toMatch(/https?:|localhost/);
});

test("each icon is a PNG of the size it states", async ({ request, page }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  await page.goto("/sign-in");
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  const listed: { src: string; size: number }[] = [
    ...manifest.icons.map((i: { src: string; sizes: string }) => ({ src: i.src, size: Number(i.sizes.split("x")[0]) })),
    { src: apple!, size: 180 },
    { src: "/icons/favicon.png", size: 48 },
    { src: "/favicon.ico", size: 48 }, // what a browser asks for on its own
  ];
  expect(listed).toHaveLength(7);
  for (const { src, size } of listed) {
    const res = await request.get(src, { maxRedirects: 0 });
    expect(res.status(), src).toBe(200);
    expect(res.headers()["content-type"], src).toBe("image/png");
    expect(pngSize(await res.body()), src).toEqual({ width: size, height: size });
    expect(res.headers()["cache-control"], src).toBe(VERSIONED.test(src) ? "public, max-age=31536000, immutable" : "no-cache");
  }
  expect((await request.get("/icons/icon-64.png")).status()).toBe(404);
});

test("the head of the sign-in page carries what a phone needs to install the portal", async ({ page }) => {
  const res = await page.goto("/sign-in");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /^\/icons\/apple-touch-icon\.png\?v=[0-9a-f]{12}$/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("sizes", "180x180");
  await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /^\/icons\/favicon\.png\?v=[0-9a-f]{12}$/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", CLUB.color);
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "light dark");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).toContain("width=device-width");
  expect(viewport).toContain("initial-scale=1");
  expect(viewport).toContain("viewport-fit=cover");
  expect(viewport, "zoom is never limited").not.toMatch(/user-scalable|maximum-scale/);
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute("content", CLUB.name);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", CLUB.name);
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "default");
  // The scaffold's favicon is gone: every icon in the head is one of the club's.
  for (const href of await page.locator('link[rel~="icon"]').evaluateAll((links) => links.map((l) => l.getAttribute("href")))) expect(href).toMatch(/^\/icons\//);

  const headers = res!.headers();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();
  // The same on the root address and on a redirect, an API answer and a page that isn't there.
  for (const path of ["/", "/api/health", "/no-such-page"]) {
    const other = (await page.request.get(path, { maxRedirects: 0 })).headers();
    expect(other["x-content-type-options"], path).toBe("nosniff");
    expect(other["content-security-policy"], path).toBe("frame-ancestors 'none'");
    expect(other["x-powered-by"], path).toBeUndefined();
  }
});

test("the service worker and the offline page are served as themselves", async ({ request }) => {
  const sw = await request.get("/sw.js", { maxRedirects: 0 });
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toBe("application/javascript; charset=utf-8");
  expect(sw.headers()["cache-control"]).toBe("no-cache, no-store, must-revalidate");
  expect(sw.headers()["content-security-policy"]).toBe("default-src 'self'; script-src 'self'; frame-ancestors 'none'");
  expect(sw.headers()["x-content-type-options"]).toBe("nosniff");
  expect(await sw.text()).toBe(readFileSync("public/sw.js", "utf8"));

  const offline = await request.get("/offline.html", { maxRedirects: 0 });
  expect(offline.status()).toBe(200);
  expect(offline.headers()["content-type"]).toContain("text/html");
  expect(await offline.text()).toBe(readFileSync("public/offline.html", "utf8"));
});

test("while setup is open, none of the installable-app files is sent to /setup", async ({ request }) => {
  const [before] = await sql`SELECT value FROM setting WHERE key = 'setup.state'`;
  await sql`UPDATE setting SET value = jsonb_set(value, '{status}', '"open"') WHERE key = 'setup.state'`;
  try {
    expect((await request.get("/sign-in", { maxRedirects: 0 })).status(), "setup really is open").toBe(307);
    const manifest = await request.get("/manifest.webmanifest", { maxRedirects: 0 });
    expect(manifest.status()).toBe(200);
    expect((await manifest.json()).name).toBe(CLUB.name);
    for (const path of ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon.png", "/favicon.ico", "/sw.js", "/offline.html"]) {
      expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
    }
    expect(await (await request.get("/offline.html", { maxRedirects: 0 })).text()).toContain("You're offline");
  } finally {
    await sql`UPDATE setting SET value = ${sql.json(before!.value)} WHERE key = 'setup.state'`;
  }
});

test("the worker takes charge, and pages still load and redirect through it", async ({ page, context }) => {
  await page.goto("/sign-in");
  await workerInCharge(page);
  expect(await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    return { scope: new URL(registration!.scope).pathname, script: new URL(registration!.active!.scriptURL).pathname, state: registration!.active!.state, updateViaCache: registration!.updateViaCache };
  })).toEqual({ scope: "/", script: "/sw.js", state: "activated", updateViaCache: "none" });

  // An anonymous visitor is still sent to sign in, and a signed-in parent still gets their page: the worker hands
  // every page load to the network, redirects and cookies included.
  await page.goto("/display");
  await expect(page).toHaveURL(/\/sign-in$/);
  await context.addCookies([parentSessionCookie()]);
  const home = await page.goto("/");
  expect(home?.status()).toBe(200);
  expect(home?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
});

test("offline, a page load shows the offline page, and Try again brings the page back", async ({ page, context }) => {
  await page.goto("/sign-in");
  await workerInCharge(page);
  await context.setOffline(true);
  try {
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're offline");
    await expect(page).toHaveURL(/\/sign-in$/); // the address the person asked for stays in the bar
    await expect(page).toHaveTitle("You're offline");
    const again = page.getByRole("link", { name: "Try again" });
    await expect(again).toBeVisible();
    expect((await again.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await again.click(); // still offline: the same page again, not the browser's error
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're offline");
    await page.goto("/no-such-page?x=1"); // any address at all
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're offline");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), "no sideways scroll").toBe(false);
  } finally {
    await context.setOffline(false);
  }
  await page.goto("/sign-in");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await expect(page).not.toHaveTitle("You're offline");
  await context.setOffline(true);
  await page.goto("/sign-in");
  await expect(page).toHaveTitle("You're offline");
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).not.toHaveTitle("You're offline");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("after a signed-in parent has browsed, the caches hold the offline page and nothing else", async ({ page, context }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/");
  await workerInCharge(page);
  // Browse as a parent does, with the worker in charge: full page loads, and moving between pages inside the app.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
  await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
  await page.getByRole("link", { name: /Your account and display settings/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Display");
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
  await page.goto("/display");
  await page.reload();
  await page.goto("/forms"); // a page that isn't built yet: a 404 from the app is not stored either

  const held = await cacheContents(page);
  expect(held.map((h) => `${h.cache} ${h.url}`)).toEqual(["br-offline-v1 /offline.html"]);
  expect(held[0]!.body).toBe(readFileSync("public/offline.html", "utf8"));
  const everything = JSON.stringify(held);
  for (const theirs of ["Zelda", "Quetzalcoatl", "E2E-FAMILY", "zelda@example.com", "Second Family", "Rivera", "Okafor", CLUB.name]) {
    expect(everything, `the caches hold "${theirs}"`).not.toContain(theirs);
  }

  // Going offline now shows the offline page, not a kept copy of the parent's home.
  await context.setOffline(true);
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're offline");
    expect(await page.content()).not.toContain("Zelda");
  } finally {
    await context.setOffline(false);
  }
});

test("Chromium finds the portal installable: no manifest errors and no installability errors", async ({ browser, baseURL }, testInfo) => {
  // A normal profile, kept on disk for this test: Chromium calls a private window not installable, whatever the site does.
  const context: BrowserContext = await browser.browserType().launchPersistentContext(testInfo.outputPath("profile"), { baseURL, viewport: testInfo.project.use.viewport });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto("/sign-in");
    await workerInCharge(page);
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send("Page.getAppManifest");
    expect(manifest.url).toBe(`${baseURL}/manifest.webmanifest`);
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data!)).toMatchObject({ name: CLUB.name, start_url: "/", display: "standalone" });
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    expect(installabilityErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test.describe("the install hint on the Display page", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const heading = (page: Page) => page.getByRole("heading", { level: 2, name: "Add the portal to your home screen" });

  async function displayPage(browser: import("@playwright/test").Browser, userAgent?: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext(userAgent ? { userAgent } : {});
    await context.addCookies([parentSessionCookie()]);
    const page = await context.newPage();
    return { context, page };
  }

  test("on an iPhone it gives the steps: Share, then Add to Home Screen", async ({ browser }) => {
    const { context, page } = await displayPage(browser, `${IPHONE} Version/18.5 Mobile/15E148 Safari/604.1`);
    await page.goto("/display");
    await expect(heading(page)).toBeVisible();
    const steps = page.locator(".install-hint ol li");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("Tap Share");
    await expect(steps.nth(1)).toContainText("Add to Home Screen");
    await expect(page.locator(".install-hint")).not.toContainText("First open this page in Safari");
    await expect(page.locator(".install-hint")).toContainText("No Add to Home Screen in the list?"); // some apps' browsers look just like Safari
    await expect(page.locator(".install-hint").getByRole("button")).toHaveCount(0); // a permanent box: nothing to dismiss, no button Apple won't honor
    await context.close();
  });

  test("inside another app's browser on an iPhone it says to open Safari first", async ({ browser }) => {
    const { context, page } = await displayPage(browser, `${IPHONE} Mobile/15E148 [FBAN/FBIOS;FBAV/520.0.0.38.101]`);
    await page.goto("/display");
    await expect(heading(page)).toBeVisible();
    await expect(page.locator(".install-hint")).toContainText("First open this page in Safari");
    await expect(page.locator(".install-hint ol li")).toHaveCount(3);
    await context.close();
  });

  test("on Chromium it offers an Install button once the browser has offered a prompt, and opens that prompt", async ({ browser }) => {
    const { context, page } = await displayPage(browser);
    await page.goto("/display");
    await expect(heading(page)).toBeVisible(); // the permanent box is there with or without a prompt
    // The browser's offer, as Chromium makes it: an event whose prompt() opens the install dialog.
    await page.evaluate(() => {
      const offer = Object.assign(new Event("beforeinstallprompt"), {
        prompt: async () => { (window as unknown as { prompted: number }).prompted = ((window as unknown as { prompted?: number }).prompted ?? 0) + 1; },
        userChoice: Promise.resolve({ outcome: "dismissed" }),
      });
      window.dispatchEvent(offer);
    });
    const install = page.locator(".install-hint").getByRole("button", { name: "Install" });
    await expect(install).toBeVisible();
    expect((await install.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator(".install-hint").getByRole("button", { name: "Not now" })).toHaveCount(0);
    await install.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { prompted?: number }).prompted)).toBe(1);
    await expect(install).toHaveCount(0); // an offer is used once; the box stays and points at the browser's menu
    await expect(page.locator(".install-hint")).toContainText("Open your browser's menu");
    await context.close();
  });

  // A test browser can't be put on a home screen, so each test makes the page see what an installed app sees:
  // Android and desktop answer the media query (display-mode: standalone); an iPhone sets navigator.standalone.
  const INSTALLED: Record<string, { userAgent?: string; pretend: () => void }> = {
    "Android or a desktop (display-mode: standalone)": {
      pretend: () => {
        const real = window.matchMedia.bind(window);
        window.matchMedia = (query: string) => (query === "(display-mode: standalone)" ? { ...real(query), matches: true, media: query } as MediaQueryList : real(query));
      },
    },
    "an iPhone (navigator.standalone)": {
      userAgent: `${IPHONE} Version/18.5 Mobile/15E148 Safari/604.1`,
      pretend: () => { Object.defineProperty(navigator, "standalone", { value: true }); },
    },
  };
  for (const [where, { userAgent, pretend }] of Object.entries(INSTALLED)) {
    test(`it shows nothing when the portal is already running from the home screen: ${where}`, async ({ browser }) => {
      const { context, page } = await displayPage(browser, userAgent);
      await context.addInitScript(pretend);
      await page.goto("/display");
      await expect(page.getByRole("heading", { level: 2, name: "Signing out" })).toBeVisible();
      await expect(page.getByRole("radio").first()).toBeAttached(); // the display choices are drawn by the browser: the page is awake
      await expect(heading(page)).toHaveCount(0);
      // The same page without the pretending does show it, so the check above is not passing for some other reason.
      const plain = await displayPage(browser, userAgent);
      await plain.page.goto("/display");
      await expect(heading(plain.page)).toBeVisible();
      await plain.context.close();
      await context.close();
    });
  }
});

test("with a notch and a home indicator, the bar, the gutters, the tabs and the body keep clear of them", async ({ page, context }, testInfo) => {
  await context.addCookies([parentSessionCookie()]);
  const cdp = await context.newCDPSession(page);
  const insets = { top: 47, bottom: 34, left: 59, right: 59 };
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
  } catch {
    test.skip(true, "this Chromium cannot pretend to have safe-area insets");
  }
  await page.goto("/");
  const px = (selector: string, property: string) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
  expect(await px("header.bar", "padding-top")).toBe("47px");
  expect(await px("header.bar .wrap", "padding-left")).toBe("59px");
  expect(await px("main.wrap", "padding-right")).toBe("59px");
  if (testInfo.project.name === "phone") {
    expect(await px("nav.tabs", "padding-bottom")).toBe("34px");
    expect(await px("nav.tabs", "padding-left")).toBe("59px");
    expect(await px("body", "padding-bottom")).toBe("122px"); // the tab bar's 88 and the home indicator's 34
  } else {
    expect(await px("body", "padding-bottom")).toBe("34px");
  }
  // With nothing to clear, the layout is what it was.
  await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 0, bottom: 0, left: 0, right: 0 } } as never);
  await page.reload();
  expect(await px("header.bar", "padding-top")).toBe("0px");
  expect(await px("main.wrap", "padding-left")).toBe("24px");
  expect(await px("body", "padding-bottom")).toBe(testInfo.project.name === "phone" ? "88px" : "0px");
});
