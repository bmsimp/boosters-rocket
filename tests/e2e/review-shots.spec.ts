import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { staffSessionCookie } from "./staff-session";
import { parentSessionCookie } from "./parent-session";

/**
 * The design review's pictures and measures (.claude/agents/design-review.md), for the pages a pull request touches:
 * each address in REVIEW_PAGES (separated by commas or spaces, each starting with "/"; one starting "parent:/" is
 * opened as the seeded parent, the rest as the seeded staff member) at 390, 1440 and 2560 wide, in light and in dark.
 * Each is saved as test-results/screenshots/review/<address>-<scheme>-<width>.png, beside a .json of what can be
 * measured: the visible controls under 48 by 48, axe's color-contrast failures, and whether the page scrolls sideways.
 * Nothing is checked here and nothing is pressed: the reviewer reads them. With REVIEW_PAGES unset it does nothing, so
 * an ordinary run takes no pictures. Run it on the desktop project only (it sizes its own windows):
 * REVIEW_PAGES="/staff/links,parent:/" pnpm e2e tests/e2e/review-shots.spec.ts --project=desktop
 */
const PAGES = (process.env.REVIEW_PAGES ?? "").split(/[\s,]+/).filter((p) => p !== "");
const WIDTHS = [390, 1440, 2560] as const;
const SCHEMES = ["light", "dark"] as const;
const DIR = "test-results/screenshots/review";

const settle = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
  .map((a) => a.finished.catch(() => undefined))));

/** The visible controls smaller than M3's 48 by 48 target, by their role and name, with their size. */
const smallTargets = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [tabindex]:not([tabindex='-1'])")]
  .filter((el) => el.getClientRects().length > 0 && !el.closest("[inert], dialog:not([open])"))
  .map((el) => { const r = el.getBoundingClientRect(); return { el, w: Math.round(r.width), h: Math.round(r.height) }; })
  .filter(({ w, h }) => w < 48 || h < 48)
  .map(({ el, w, h }) => ({ tag: el.tagName.toLowerCase(), name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 80), size: `${w}x${h}` })));

test("the pages a pull request touches, at 390, 1440 and 2560, light and dark, for the design review", async ({ browser }, info) => {
  test.skip(PAGES.length === 0, "REVIEW_PAGES names no page");
  test.skip(info.project.name !== "desktop", "it sizes its own windows");
  test.setTimeout(60_000 * PAGES.length);
  mkdirSync(DIR, { recursive: true });
  for (const entry of PAGES) {
    const parent = entry.startsWith("parent:");
    const address = parent ? entry.slice("parent:".length) : entry;
    expect(address.startsWith("/") && !address.startsWith("//"), `${entry} is an address on this site`).toBe(true);
    const slug = `${parent ? "parent-" : ""}${address.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "home"}`.slice(0, 80);
    for (const width of WIDTHS) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport: { width, height: width >= 2000 ? 1300 : width < 600 ? 844 : 1000 }, colorScheme: scheme,
          ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) });
        await context.addCookies([parent ? parentSessionCookie() : staffSessionCookie()]);
        const page = await context.newPage();
        await page.goto(address);
        await expect(page.locator("h1, dialog[open] h2").first()).toBeVisible();
        await settle(page);
        const name = `${slug}-${scheme}-${width}`;
        await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
        const contrast = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
        writeFileSync(`${DIR}/${name}.json`, JSON.stringify({
          address: entry, width, scheme, finalUrl: page.url(),
          sidewaysScroll: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
          smallTargets: await smallTargets(page),
          contrast: contrast.violations.flatMap((v) => v.nodes.map((n) => ({ target: n.target.join(" "), summary: n.failureSummary }))),
        }, null, 2));
        await context.close();
      }
    }
  }
});
