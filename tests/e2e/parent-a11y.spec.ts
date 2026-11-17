import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";
import { addressOf, isDynamic, parentRoutes } from "./parent-routes";
import { PARAMS } from "./parent-params";
import { MIN_TARGET, focusStop, layoutProblems } from "./a11y-checks";

/**
 * Every page a parent sees, in every display mode, at a phone's width and a desktop's (step 6 of the roadmap; PRODUCT.md:
 * WCAG 2.2 AA, on older phones, at any age). The parent pages are read from disk (tests/e2e/parent-routes.ts), so a new
 * one is checked without being listed; a page with a dynamic segment is opened with its seeded ids from PARAMS, and
 * fails here until it has them. Each page is opened once per width and club color, then drawn in each mode by setting
 * the attributes the Display page sets (data-theme, data-contrast, data-text on <html>) and the matching media
 * features, so a page's own state is checked in every mode without loading it again.
 *
 * It fails on: the page scrolling sideways, text clipped by its box or drawn over other text, a tap target under
 * 44 by 44 (a link inside a sentence excepted), and everything axe-core finds for WCAG 2.0, 2.1 and 2.2 A and AA
 * (which includes every control and image without an accessible name). Color contrast is checked in every mode but
 * forced colors, where the system draws the colors. Each failure names the page, the width, the mode and the element.
 *
 * It runs in the desktop project only, at its own two widths: the phone project would do the same work again.
 * It changes nothing but the club's color, for the gold pass, and puts that back.
 */
const sql = postgres(process.env.DATABASE_URL!);

const WIDTHS = [360, 1440] as const;
const HEIGHT = 900;

type Mode = {
  name: string;
  attrs: { theme: "light" | "dark"; contrast?: "more"; text?: "larger" };
  forcedColors?: boolean;
};
const MODES: Mode[] = [
  { name: "light", attrs: { theme: "light" } },
  { name: "dark", attrs: { theme: "dark" } },
  { name: "high contrast light", attrs: { theme: "light", contrast: "more" } },
  { name: "high contrast dark", attrs: { theme: "dark", contrast: "more" } },
  { name: "larger text", attrs: { theme: "light", text: "larger" } },
  { name: "forced colors", attrs: { theme: "light" }, forcedColors: true },
];
/** DESIGN.md's gold demo: a light club color, where white on the fill fails and the app must derive darker text. */
const GOLD = "#f2c200";
const GOLD_MODES: Mode[] = [
  { name: "gold club, light", attrs: { theme: "light" } },
  { name: "gold club, dark", attrs: { theme: "dark" } },
];
/** The color scripts/seed-e2e.ts gives the club. */
const SEEDED_COLOR = "#5b2a86";

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
/** Drawn decoration that holds no words, taken away while contrast is measured (findProblems). */
const DECORATION = ".sets li::after";
const summary = (text: string | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

/** A page to open: where, signed in as the seeded parent or not, and anything the device holds before it loads. */
type Target = { label: string; address: string; signedIn: boolean; deviceStore?: Record<string, string>; status?: number };

/** The parent pages, from disk. A dynamic one is opened with its `own` params: the seeded family's thing. */
function parentTargets(): Target[] {
  return parentRoutes().map((route) => {
    const params = isDynamic(route) ? PARAMS[route]?.own : undefined;
    return { label: route, address: isDynamic(route) && params ? addressOf(route, params) : route, signedIn: true };
  });
}

/**
 * The pages a parent sees before the parent pages: the sign-in page (both its steps: the code step is the one the
 * device keeps while a code is live, src/app/sign-in/code-step.ts, so no code is sent), the family chooser (Zelda has
 * two families), the refusal, the page the service worker shows offline, and the page for an address with no page.
 */
const BEFORE_SIGN_IN: Target[] = [
  { label: "/sign-in", address: "/sign-in", signedIn: false },
  { label: "/sign-in (code step)", address: "/sign-in", signedIn: false,
    deviceStore: { "booster.signin.code-step": JSON.stringify({ email: "zelda@example.com", sentAt: 0, next: null }) } },
  { label: "/choose-family", address: "/choose-family", signedIn: true },
  { label: "/refused", address: "/refused", signedIn: false },
  { label: "/offline.html", address: "/offline.html", signedIn: false },
  // An address with no page: a signed-in parent keeps the frame around it (src/app/not-found.tsx), anyone else gets it plain.
  { label: "not found, signed in", address: "/no-such-page", signedIn: true, status: 404 },
  { label: "not found, signed out", address: "/no-such-page", signedIn: false, status: 404 },
];

const TARGETS = [...parentTargets(), ...BEFORE_SIGN_IN];

test.skip(({ viewport }) => (viewport?.width ?? 0) < 760, "one pass, in the desktop project, at its own widths: the phone project would repeat it");
test.describe.configure({ timeout: 120_000 });
test.afterAll(async () => { await sql.end(); });
// A run cut off in the gold pass leaves the club gold: put the seeded color back first.
test.beforeAll(async () => {
  await sql`UPDATE setting SET value = jsonb_set(value, '{color}', to_jsonb(${SEEDED_COLOR}::text)) WHERE key = 'club' AND value->>'color' = ${GOLD}`;
});

/** Opens a target in a context of its own, as the seeded parent or nobody, and waits for its fonts. */
async function open(browser: Browser, target: Target, width: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: HEIGHT } });
  if (target.signedIn) await context.addCookies([parentSessionCookie()]);
  if (target.deviceStore) {
    // A code step must be live to be picked up: give it the time it is opened at.
    await context.addInitScript((store) => {
      for (const [k, v] of Object.entries(store)) {
        const value = k === "booster.signin.code-step" ? JSON.stringify({ ...JSON.parse(v), sentAt: Date.now() - 1000 }) : v;
        window.localStorage.setItem(k, value);
      }
    }, target.deviceStore);
  }
  const page = await context.newPage();
  const res = await page.goto(target.address);
  expect(res?.status(), `${target.label} answered ${res?.status()} at ${target.address}: it can't be checked with the seeded data. `
    + `A dynamic parent page needs its ids in PARAMS (tests/e2e/parent-params.ts).`).toBe(target.status ?? 200);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return { page, close: () => context.close() };
}

/** Draws the page in a mode: the Display page's attributes on <html>, and the media features that match them. */
async function drawIn(page: Page, mode: Mode) {
  await page.emulateMedia({
    colorScheme: mode.attrs.theme, contrast: mode.attrs.contrast ?? "no-preference",
    forcedColors: mode.forcedColors ? "active" : "none",
    // Color transitions (150ms on buttons) would be measured half-way: motion is reduced for every mode.
    reducedMotion: "reduce",
  });
  await page.evaluate((attrs) => {
    const root = document.documentElement;
    for (const key of ["theme", "contrast", "text"] as const) {
      const value = (attrs as Record<string, string | undefined>)[key];
      if (value) root.setAttribute(`data-${key}`, value); else root.removeAttribute(`data-${key}`);
    }
    return new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  }, mode.attrs);
}

/** Everything wrong with the page as it is drawn now, one line each. */
async function findProblems(page: Page, where: string, mode: Mode): Promise<string[]> {
  const found: string[] = [];
  for (const p of await page.evaluate(layoutProblems, MIN_TARGET)) found.push(`${where} · ${p.element}: ${p.problem}`);

  // Every WCAG A and AA rule but contrast, which is measured next, on the paper as it really is behind the words.
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(["color-contrast"]).analyze();
  for (const v of results.violations) {
    for (const node of v.nodes) found.push(`${where} · ${node.target.join(" ")}: ${v.id} (${v.help}). ${summary(node.failureSummary)}`);
  }
  if (mode.forcedColors) return found; // the system draws the colors

  // Contrast. axe can't tell what is behind words drawn straight on the chart paper, because the paper's grid is a
  // background image, nor behind the set ruler's cells, whose yard-line ticks are a pseudo-element. Both are 1-2px
  // decoration that no word sits on (DESIGN.md: the grid is "decoration only", and gone in high contrast), so they are
  // taken away while contrast is measured, and every word is measured against the paper or fill it is really on.
  // Anything axe still can't measure is a finding: a new kind of background has to be measured, not skipped.
  await page.evaluate((css) => {
    const style = document.createElement("style");
    style.dataset.a11yCheck = "";
    style.textContent = css;
    document.head.append(style);
  }, `html body { background-image: none !important; } ${DECORATION} { content: none !important; display: none !important; }`);
  const contrast = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
  await page.evaluate(() => document.querySelectorAll("style[data-a11y-check]").forEach((s) => s.remove()));
  for (const node of contrast.violations.flatMap((v) => v.nodes)) {
    found.push(`${where} · ${node.target.join(" ")}: color-contrast (Elements must meet minimum color contrast ratio thresholds). ${summary(node.failureSummary)}`);
  }
  for (const node of contrast.incomplete.flatMap((v) => v.nodes)) {
    found.push(`${where} · ${node.target.join(" ")}: color-contrast could not be measured. ${node.any.map((c) => c.message).join(" ")}`);
  }
  return found;
}

/**
 * The keyboard's way through the page: Tab from the top until the focus leaves the last control (or comes round to
 * the first), and at each stop a visible focus ring, and the control not left under the phone's fixed tab bar.
 * Walked where it can differ, not in every mode, to keep the run short: KEYBOARD_WALKS.
 */
async function keyboardProblems(page: Page, where: string): Promise<string[]> {
  await page.evaluate(() => {
    // Start from the top of the page: a focused element put first and taken away again leaves the Tab order's start there.
    const start = document.createElement("div");
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus();
    start.remove();
    window.scrollTo(0, 0);
  });
  const found: string[] = [];
  let first: string | null = null;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(focusStop);
    if (!stop || stop.element === first) break;
    first ??= stop.element;
    for (const problem of stop.problems) found.push(`${where} · Tab stop ${i + 1}, ${stop.element}: ${problem}`);
  }
  if (first === null) found.push(`${where} · the keyboard reaches nothing on the page`);
  return found;
}
/** Where the Tab walk is made: every mode on a phone, where the tab bar is, and the plain one on a desktop. */
const KEYBOARD_WALKS: Record<number, string[]> = { 360: MODES.map((m) => m.name), 1440: ["light", "gold club, light"] };

async function checkTarget(browser: Browser, target: Target, modes: Mode[]) {
  const found: string[] = [];
  for (const width of WIDTHS) {
    const { page, close } = await open(browser, target, width);
    try {
      for (const mode of modes) {
        await drawIn(page, mode);
        const where = `${target.label} · ${width}px · ${mode.name}`;
        found.push(...await findProblems(page, where, mode));
        if (KEYBOARD_WALKS[width]?.includes(mode.name)) found.push(...await keyboardProblems(page, where));
      }
    } finally { await close(); }
  }
  expect(found, `${found.length} accessibility problems:\n${found.join("\n")}`).toEqual([]);
}

test("every parent page is checked, each dynamic one with seeded ids", () => {
  const unopenable = parentRoutes().filter((route) => isDynamic(route) && !PARAMS[route]);
  expect(unopenable, `These parent pages have a dynamic segment and no ids to open them with: ${unopenable.join(", ")}. `
    + `Add them to PARAMS in tests/e2e/parent-params.ts with ids from scripts/seed-e2e.ts.`).toEqual([]);
  expect(TARGETS.length).toBeGreaterThan(10);
});

test("the page checks find what they look for, and leave alone what they should", async ({ page }) => {
  // A check that never fails proves nothing: here each one meets the thing it is for, on a page made up for it.
  await page.setViewportSize({ width: 360, height: 600 });
  await page.setContent(`<!doctype html><html lang="en"><body style="margin:0;font:16px/1.4 sans-serif">
    <p id="wide" style="width:500px">Too wide for a phone</p>
    <div id="clip" style="width:60px;height:20px;overflow:hidden;white-space:nowrap">A long line of words, clipped</div>
    <div style="position:relative;height:40px"><span id="a" style="position:absolute;top:0;left:0">First words</span><span id="b" style="position:absolute;top:3px;left:6px">Second words</span></div>
    <button id="small" style="width:30px;height:30px">S</button>
    <p>A sentence with <a href="/x" id="inline">a link</a> inside it.</p>
    <p><a href="/y" id="lone">A link alone</a></p>
    <label id="choice" style="display:block;height:30px"><input type="radio" name="r" style="position:absolute;opacity:0;width:1px;height:1px">One</label>
    <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Hidden words for a screen reader</span>
    <div id="ellipsis" style="width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Cut short on purpose</div>
    <button id="ringless" style="outline:none;width:60px;height:60px">No ring</button>
    <nav id="tabs" style="position:fixed;bottom:0;left:0;right:0;height:50px;background:#fff">Tabs</nav>
    <div style="height:700px"></div><p id="last">The last words, left under the tabs</p>
  </body></html>`);
  const found = (await page.evaluate(layoutProblems, MIN_TARGET)).map((p) => `${p.element}: ${p.problem}`);
  const about = (what: string) => found.filter((f) => f.includes(what));
  expect(about("scrolls sideways"), found.join("\n")).toHaveLength(1);
  expect(about("div#clip"), found.join("\n")).toEqual([expect.stringContaining("is clipped by")]);
  expect(about("overlaps"), found.join("\n")).toEqual([expect.stringMatching(/span#a .*overlaps the text of span#b/)]);
  expect(about("button#small"), found.join("\n")).toEqual([expect.stringContaining("30 by 30px")]);
  expect(about("a#lone"), found.join("\n")).toHaveLength(1);
  expect(about("label#choice"), found.join("\n")).toHaveLength(1); // a hidden radio is measured by its label
  expect(about("p#last"), found.join("\n")).toEqual([expect.stringContaining("still under nav#tabs")]);
  expect(found.filter((f) => /a#inline|Hidden words|div#ellipsis/.test(f)), found.join("\n")).toEqual([]);

  // The keyboard: a control with its ring taken away, and one the focus leaves under the fixed bar.
  await page.locator("#ringless").focus();
  expect((await page.evaluate(focusStop))?.problems).toEqual([expect.stringContaining("no visible focus ring")]);
  await page.locator("#last").evaluate((p) => {
    p.tabIndex = 0; p.style.outline = "3px solid black";
    window.scrollTo(0, document.documentElement.scrollHeight);
    p.focus({ preventScroll: true });
  });
  expect((await page.evaluate(focusStop))?.problems).toEqual([expect.stringContaining("partly hidden under nav")]);
});

test.describe("in the seeded club color", () => {
  for (const target of TARGETS) {
    test(`${target.label}, at ${WIDTHS.join(" and ")}px, in every mode`, async ({ browser }) => {
      await checkTarget(browser, target, MODES);
    });
  }
});

test.describe("in a light club color", () => {
  test.beforeAll(async () => {
    await sql`UPDATE setting SET value = jsonb_set(value, '{color}', to_jsonb(${GOLD}::text)) WHERE key = 'club'`;
  });
  test.afterAll(async () => {
    await sql`UPDATE setting SET value = jsonb_set(value, '{color}', to_jsonb(${SEEDED_COLOR}::text)) WHERE key = 'club'`;
  });
  for (const target of TARGETS) {
    test(`${target.label}, at ${WIDTHS.join(" and ")}px, gold in light and dark`, async ({ browser }) => {
      await checkTarget(browser, target, GOLD_MODES);
    });
  }
});
