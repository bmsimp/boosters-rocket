import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";
import { E2E_VOLUNTEER } from "./volunteer-seed";
import { parentRoutes } from "./parent-routes";
import { familyPages } from "./family-records";

// Every staff page, opened as the seeded Admin (scripts/seed-e2e.ts) on a phone and on a laptop. The pages are read from
// disk (src/app/staff/(app)), so a new one fails here until it has a way in below. Each must fit its width without the
// page scrolling sideways (a wide table scrolls inside its own region, or stacks), every control on it must have a name
// a screen reader can say, and every link that stands alone on its line, every table's link and every disclosure's
// summary must be a 44px tap target (AGENTS.md, UI: .link-line). Pages whose address holds an id the seed doesn't fix
// are reached by the first link to one, from the page that lists them; a family's pages, addressed by the app's own
// family record, by that record's id read from the seed (./family-records.ts). Nothing here changes data.
/**
 * A page at its address, a family's page at the address `family` gives for the customer the seed gave it, or reached
 * from `from` by following the first link matching each of `links` in turn.
 */
type Visit = { path: string } | { family: (customerId: string) => Promise<string>; customer: string } | { from: string; links: string[] };
const STAFF_DIR = "src/app/staff/(app)";
const SEASON = 'main a[href^="/staff/seasons/"]:not([href^="/staff/seasons/progress"])';

/** Every staff page on disk, by its route, with how it is opened. A static route with no entry is opened at its own address. */
const VISITS: Record<string, Visit[]> = {
  "/staff/roster/[id]": [{ family: familyPages.roster, customer: "E2E-10" }, { family: familyPages.roster, customer: "E2E-FAMILY" }],
  "/staff/parents/[id]": [{ from: "/staff/parents", links: ['main a[href^="/staff/parents/"]'] }],
  "/staff/roster/[id]/buyouts": [{ family: familyPages.buyouts, customer: "E2E-10" }],
  "/staff/balances/[familyId]": [{ family: familyPages.balance, customer: "E2E-FAMILY" }],
  "/staff/seasons/[id]": [{ from: "/staff/seasons", links: [SEASON] }],
  "/staff/seasons/[id]/requirements/[requirementId]": [{ from: "/staff/seasons", links: [SEASON, 'main a[href*="/requirements/"]'] }],
  "/staff/seasons/progress/[requirementId]": [{ from: "/staff/seasons/progress", links: ['main a[href^="/staff/seasons/progress/"]:not([href*="/family/"])'] }],
  "/staff/seasons/progress/family/[familyId]": [{ family: familyPages.progress, customer: "E2E-FAMILY" }],
  "/staff/volunteer/[id]": [{ path: `/staff/volunteer/${E2E_VOLUNTEER.event}` }],
  "/staff/volunteer/check-in/[shiftId]": [{ path: `/staff/volunteer/check-in/${E2E_VOLUNTEER.griddle}` }],
  "/staff/volunteer/credit/[familyId]": [{ family: familyPages.credit, customer: "E2E-FAMILY" }],
  "/staff/forms/evidence/[id]": [{ from: "/staff/forms", links: ['a[href^="/staff/forms/evidence/"]'] }],
  "/staff/forms/requests/[id]": [{ from: "/staff/forms", links: ['a[href^="/staff/forms/requests/"]'] }],
  // A set-up page shows one step at a time: each step is a page of its own.
  "/staff/settings/parents/setup": ["preview", "signins", "welcome"].map((step) => ({ path: `/staff/settings/parents/setup?step=${step}` })),
};

const staffRoutes = () => parentRoutes(STAFF_DIR).map((r) => (r === "/" ? "/staff" : `/staff${r}`));
const visitsOf = (route: string): Visit[] => VISITS[route] ?? (route.includes("[") ? [] : [{ path: route }]);

// A control in the page's accessibility tree, as Playwright writes it, with no name: `- button`, `- link:`, `- textbox`.
const CONTROLS = "button|link|textbox|searchbox|checkbox|radio|combobox|listbox|spinbutton|slider|switch|tab|menuitem";
const UNNAMED = new RegExp(`^\\s*- (${CONTROLS})(?: \\[[^\\]]*\\])*:?\\s*$`);

async function open(page: Page, visit: Visit): Promise<string> {
  if ("path" in visit || "family" in visit) {
    const path = "path" in visit ? visit.path : await visit.family(visit.customer);
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    return path;
  }
  let at = visit.from;
  await page.goto(at);
  for (const link of visit.links) {
    const found = page.locator(link).first();
    await expect(found, `a link to follow on ${at}: ${link}`).toBeAttached();
    at = (await found.getAttribute("href"))!;
    const res = await page.goto(at);
    expect(res?.status(), at).toBe(200);
  }
  return at;
}

/**
 * The tap targets on the page that are under 44px tall: a table's links, every summary, and every link that stands
 * alone on its line, which is one not inside a sentence (the words of the block it sits in are its own words alone).
 * Runs in the browser: self-contained.
 */
function shortTargets(main: Element) {
  const hidden = (el: Element) => {
    for (let e: Element | null = el; e && e !== main; e = e.parentElement) {
      const s = getComputedStyle(e), r = e.getBoundingClientRect();
      if (s.visibility === "hidden" || s.display === "none" || (s.position === "absolute" && r.width <= 1 && r.height <= 1)) return true;
    }
    return false;
  };
  // A link is in a sentence when the block it sits in has words of its own, beside its links: a line of links
  // ("Next: welcome emails · Back to Parent sign-ins") is links alone, each a target of its own.
  const alone = (a: HTMLElement) => {
    if (getComputedStyle(a).display !== "inline") return true; // a block, flex or inline-flex link is a box of its own
    let block: Element | null = a.parentElement;
    while (block && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    if (!block) return true;
    const copy = block.cloneNode(true) as Element;
    copy.querySelectorAll("a, button, .visually-hidden").forEach((x) => x.remove());
    return (copy.textContent ?? "").replace(/[\s·•|,;:–—-]/g, "") === "";
  };
  const found: { what: string; h: number }[] = [];
  for (const e of main.querySelectorAll<HTMLElement>("a[href], summary")) {
    const h = e.getBoundingClientRect().height;
    if (h === 0 || hidden(e)) continue;
    const kind = e.tagName === "SUMMARY" ? "summary" : e.closest(".table") ? "table link" : alone(e) ? "lone link" : null;
    if (kind && h < 44) found.push({ what: `${kind} "${(e.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50)}"`, h: Math.round(h) });
  }
  return found;
}

test("every staff page on disk has a way in here", () => {
  const routes = staffRoutes();
  expect(routes.length).toBeGreaterThan(30);
  const none = routes.filter((r) => visitsOf(r).length === 0);
  expect(none, `These staff pages have a dynamic segment and no way in: add them to VISITS in tests/e2e/staff-pages.spec.ts`).toEqual([]);
  const gone = Object.keys(VISITS).filter((r) => !routes.includes(r));
  expect(gone, "VISITS names pages that are no longer on disk").toEqual([]);
});

test("the lone-link measure finds a short lone link, and leaves a link in a sentence alone", async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><body style="font:16px/1.4 sans-serif"><main>
    <p><a href="/a">A link alone</a></p>
    <p>A sentence with <a href="/b">a link</a> inside it.</p>
    <p><a href="/c" style="display:inline-flex;align-items:center;min-height:44px">A link line</a></p>
    <p><a href="/d">One of a line of links</a> · <a href="/e" style="display:inline-flex;min-height:44px">Another</a></p>
    <details><summary>Short summary</summary></details>
  </main></body></html>`);
  const found = await page.locator("main").evaluate(shortTargets);
  expect(found.map((f) => f.what)).toEqual(['lone link "A link alone"', 'lone link "One of a line of links"', 'summary "Short summary"']);
});

for (const width of [390, 1280]) {
  test(`every staff page fits ${width}px with no sideways scroll, every control has a name, and every lone link is a tap target`, async ({ browser }) => {
    test.setTimeout(360_000);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    const problems: string[] = [];
    for (const visit of staffRoutes().flatMap(visitsOf)) {
      const where = await open(page, visit);
      await expect(page.getByRole("heading", { level: 1 }), where).toBeVisible();
      // Open every folded section, so the controls inside are drawn, named and measured too.
      await page.locator("main").evaluate((main) => main.querySelectorAll("details").forEach((d) => { d.open = true; }));
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (sideways > 0) problems.push(`${where} scrolls sideways by ${sideways}px`);
      const tree = await page.locator("body").ariaSnapshot();
      for (const line of tree.split("\n").filter((l) => UNNAMED.test(l))) problems.push(`${where} has a control with no accessible name: ${line.trim()}`);
      for (const s of await page.locator("main").evaluate(shortTargets)) problems.push(`${where}: the ${s.what} is ${s.h}px tall, under 44`);
    }
    expect(problems, `at ${width}px:\n${problems.join("\n")}`).toEqual([]);
    await context.close();
  });
}
