import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

// The seeded staff member is an Admin, who has every menu entry there is. The menu is grouped: Home, four groups behind
// buttons, and Settings as one entry. Layout and the keyboard are things only a browser can show, so they are checked
// here and not in vitest (tests/integration/staff-menu.test.ts checks who sees what).
const TOP = ["Home", "Families", "Season", "Money", "Settings", "Admin"];
const GROUPS: Record<string, string[]> = {
  Families: ["Roster", "Parents", "Accounting links"],
  Season: ["Seasons", "Progress", "Signed forms", "Volunteering", "Volunteer credit"],
  Money: ["Balances", "Reconciliation"],
  Admin: ["Staff", "Roles", "Audit", "Health", "Design system"],
};
const nav = (page: Page) => page.locator("header.bar nav.top-nav");
/** The menu's own entries, in order: the links and group buttons of the bar, not the links inside a group. */
const topEntries = (page: Page) => nav(page).locator(":scope > a, :scope > .nav-group > button");
const group = (page: Page, name: string) => nav(page).getByRole("button", { name: new RegExp(`^${name}`) });

for (const width of [760, 900, 1032, 1440]) {
  test(`an Admin's grouped menu fits the club bar at ${width}px, and each group opens inside the page`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    await page.goto("/staff/health");
    await expect(nav(page)).toBeVisible();
    // A group's button carries ", current section" for a screen reader when the page is in it (Admin, for Health).
    await expect(topEntries(page)).toHaveText(TOP.map((t) => new RegExp(`^${t}`)));
    await expect(page.locator("header.bar .club")).toBeVisible();

    const measured = await page.evaluate(() => {
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
      const bar = document.querySelector("header.bar")!, wrap = bar.querySelector(".wrap")!;
      return {
        bar: box(bar), wrap: box(wrap), club: box(bar.querySelector(".club")!), account: box(bar.querySelector(".account")!),
        entries: [...bar.querySelectorAll("nav.top-nav > a, nav.top-nav > .nav-group > button")].map((a) => ({ name: a.textContent ?? "", ...box(a) })),
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(measured.scrollWidth, "the page scrolls sideways").toBeLessThanOrEqual(measured.clientWidth);
    for (const e of measured.entries) {
      expect(e.left, `${e.name} starts left of the bar's column`).toBeGreaterThanOrEqual(measured.wrap.left - 1);
      expect(e.right, `${e.name} runs past the bar's column`).toBeLessThanOrEqual(measured.wrap.right + 1);
      expect(e.top, `${e.name} sticks out above the bar`).toBeGreaterThanOrEqual(measured.bar.top - 1);
      expect(e.bottom, `${e.name} hangs below the bar`).toBeLessThanOrEqual(measured.bar.bottom + 1);
      expect(e.height, `${e.name} is at least a tap target tall`).toBeGreaterThanOrEqual(44);
      expect(e.height, `${e.name} broke onto a second line`).toBeLessThan(60);
    }
    for (const [i, a] of measured.entries.entries()) {
      for (const b of measured.entries.slice(i + 1)) {
        const apart = a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
        expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
      }
    }
    expect(measured.club.width, "the club's name was squeezed out").toBeGreaterThan(60);
    expect(measured.account.right).toBeLessThanOrEqual(measured.wrap.right + 1);
    // With so few entries the bar is the one row it is for parents, wherever the club's name leaves room.
    if (width >= 900) expect(measured.bar.height).toBe(56);

    // Each group opens below the bar with its links, inside the page, and one at a time.
    for (const [name, links] of Object.entries(GROUPS)) {
      await group(page, name).click();
      await expect(group(page, name)).toHaveAttribute("aria-expanded", "true");
      const panel = page.locator(`#${await group(page, name).getAttribute("aria-controls")}`);
      await expect(panel.getByRole("link")).toHaveText(links);
      const r = (await panel.boundingBox())!;
      expect(r.x, `${name}'s links start off the page`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `${name}'s links run off the page`).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${name} open makes the page scroll sideways`).toBe(true);
      await expect(nav(page).locator(".nav-panel:not([hidden])")).toHaveCount(1);
    }
    // Health, the page this is, is current inside its group, and the group says so.
    await group(page, "Admin").click();
    await expect(group(page, "Admin")).toHaveAttribute("aria-expanded", "false");
    await expect(group(page, "Admin")).toHaveAccessibleName(/Admin, current section/);
    await group(page, "Admin").click();
    await expect(nav(page).getByRole("link", { name: "Health" })).toHaveAttribute("aria-current", "page");
    // A press outside the menu closes it.
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await expect(nav(page).locator(".nav-panel:not([hidden])")).toHaveCount(0);
    await context.close();
  });
}

test("the grouped menu works with the keyboard alone: a group is a button, Escape closes it and gives focus back", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff");
  const families = group(page, "Families");
  await families.focus();
  await expect(families).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(families).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(nav(page).getByRole("link", { name: "Roster" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(families).toHaveAttribute("aria-expanded", "false");
  await expect(families).toBeFocused();
  // Space opens it too, and tabbing on past its last link closes it: one Tab per link of the group, and one more.
  await page.keyboard.press("Space");
  await expect(families).toHaveAttribute("aria-expanded", "true");
  for (let i = 0; i <= GROUPS.Families!.length; i++) await page.keyboard.press("Tab");
  await expect(group(page, "Season")).toBeFocused();
  await expect(families).toHaveAttribute("aria-expanded", "false");
  // Hovering opens nothing.
  await group(page, "Money").hover();
  await expect(group(page, "Money")).toHaveAttribute("aria-expanded", "false");
  // Enter on a link inside a group goes there.
  await group(page, "Season").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await expect(nav(page).getByRole("link", { name: "Progress" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/staff\/seasons\/progress$/);
  await expect(group(page, "Season")).toHaveAccessibleName(/Season, current section/);
  await expect(group(page, "Season")).toHaveAttribute("aria-expanded", "false");
  await context.close();
});

test("on a Progress page only Progress is marked current, though its address sits under Seasons", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff/seasons/progress");
  await expect(page.locator('header.bar nav.top-nav a[aria-current="page"]')).toHaveText(["Progress"]);
  await page.goto("/staff/seasons");
  await expect(nav(page).locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(nav(page).locator('a[aria-current="page"]')).toHaveAttribute("href", "/staff/seasons");
  await context.close();
});

test("on a phone the same entries are behind the Menu button, each group under its name, and the bar keeps its one row", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff/health");
  await expect(nav(page)).toBeHidden();
  expect(await page.locator("header.bar").evaluate((el) => el.getBoundingClientRect().height)).toBe(56);
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  const panel = page.locator("#mobile-menu");
  await expect(panel.getByRole("link")).toHaveText(["Home", ...GROUPS.Families!, ...GROUPS.Season!, ...GROUPS.Money!, "Settings", ...GROUPS.Admin!]);
  for (const name of Object.keys(GROUPS)) await expect(panel.getByRole("group", { name })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Health" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
  await page.getByRole("button", { name: "Menu" }).click();
  await page.locator("#mobile-menu").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/staff\/settings$/);
  await context.close();
});
