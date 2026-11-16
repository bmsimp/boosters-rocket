import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";
import { E2E_VOLUNTEER } from "./volunteer-seed";

// Every staff page the design pass changed, opened as the seeded Admin (scripts/seed-e2e.ts) on a phone and on a laptop.
// Each must fit its width without the page scrolling sideways (a wide table scrolls inside its own region, or stacks),
// and every control on it must have a name a screen reader can say. Pages whose address holds an id the seed doesn't
// fix are reached by the first link to one, from the page that lists them. Nothing here changes data.
type Visit = { path: string } | { from: string; link: string };
const PAGES: Visit[] = [
  { path: "/staff" },
  { path: "/staff/roster" },
  { path: "/staff/roster/E2E-10" },
  { path: "/staff/reconciliation" },
  { path: "/staff/parents" },
  { from: "/staff/parents", link: 'a[href^="/staff/parents/"]' },
  { path: "/staff/balances" },
  { path: "/staff/balances/E2E-FAMILY" },
  { path: "/staff/audit" },
  { path: "/staff/health" },
  { path: "/staff/seasons" },
  { from: "/staff/seasons", link: 'a[href^="/staff/seasons/"]:not([href^="/staff/seasons/progress"])' },
  { from: "/staff/seasons/progress", link: 'main a[href^="/staff/seasons/progress/"]:not([href*="/family/"])' },
  { path: "/staff/seasons/progress" },
  { path: "/staff/seasons/progress/family/E2E-FAMILY" },
  { path: "/staff/volunteer" },
  { path: `/staff/volunteer/${E2E_VOLUNTEER.event}` },
  { path: `/staff/volunteer/check-in/${E2E_VOLUNTEER.griddle}` },
  { path: "/staff/volunteer/credit" },
  { path: "/staff/volunteer/credit/E2E-FAMILY" },
  { path: "/staff/forms" },
  { from: "/staff/forms", link: 'a[href^="/staff/forms/evidence/"]' },
  { from: "/staff/forms", link: 'a[href^="/staff/forms/requests/"]' },
];

// A control in the page's accessibility tree, as Playwright writes it, with no name: `- button`, `- link:`, `- textbox`.
const CONTROLS = "button|link|textbox|searchbox|checkbox|radio|combobox|listbox|spinbutton|slider|switch|tab|menuitem";
const UNNAMED = new RegExp(`^\\s*- (${CONTROLS})(?: \\[[^\\]]*\\])*:?\\s*$`);

async function open(page: Page, visit: Visit): Promise<string> {
  if ("path" in visit) {
    const res = await page.goto(visit.path);
    expect(res?.status(), visit.path).toBe(200);
    return visit.path;
  }
  await page.goto(visit.from);
  const href = await page.locator(visit.link).first().getAttribute("href");
  expect(href, `a link to follow on ${visit.from}`).toBeTruthy();
  const res = await page.goto(href!);
  expect(res?.status(), href!).toBe(200);
  return href!;
}

for (const width of [390, 1280]) {
  test(`every staff page fits ${width}px with no sideways scroll, and every control has a name`, async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    for (const visit of PAGES) {
      const where = await open(page, visit);
      await expect(page.getByRole("heading", { level: 1 }), where).toBeVisible();
      // Open every folded section, so the controls inside are drawn and named too.
      for (const d of await page.locator("main details:not([open]) > summary").all()) await d.click();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, `${where} scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
      const tree = await page.locator("body").ariaSnapshot();
      const unnamed = tree.split("\n").filter((line) => UNNAMED.test(line));
      expect(unnamed, `${where} has controls with no accessible name at ${width}px`).toEqual([]);
    }
    await context.close();
  });
}
