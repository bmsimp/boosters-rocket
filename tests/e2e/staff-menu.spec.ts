import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

// The seeded staff member is an Admin, who has every menu entry there is. The menu is grouped: Home, three groups behind
// buttons, and Settings as one entry (Staff, Roles, the audit log, Health and the design system are under it). Layout and the keyboard are things only a browser can show, so they are checked
// here and not in vitest (tests/integration/staff-menu.test.ts checks who sees what).
const TOP = ["Home", "Families", "Season", "Money", "Settings"];
const GROUPS: Record<string, string[]> = {
  Families: ["Roster", "Parents", "Accounting links"],
  Season: ["Seasons", "Progress", "Signed forms", "Volunteering", "Volunteer credit"],
  Money: ["Balances", "Reconciliation"],
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
    await page.goto("/staff/settings/health");
    await expect(nav(page)).toBeVisible();
    // Health is a settings page: Settings is the current entry, and no group is.
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
    // The row is 56px; the bar under it draws a 1px hairline (the bar's bottom border).
    if (width >= 900) expect(measured.wrap.height).toBe(56);

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
    // Health, the page this is, is under Settings, which is current; no group says it holds the page.
    await group(page, "Money").click();
    await expect(group(page, "Money")).toHaveAttribute("aria-expanded", "false");
    await expect(nav(page).locator(":scope > a", { hasText: "Settings" })).toHaveAttribute("aria-current", "page");
    for (const name of Object.keys(GROUPS)) await expect(group(page, name)).not.toHaveAccessibleName(/current section/);
    await group(page, "Money").click();
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
  await page.goto("/staff/settings/health");
  await expect(nav(page)).toBeHidden();
  expect(await page.locator("header.bar .wrap").evaluate((el) => el.getBoundingClientRect().height)).toBe(56); // the one row, above the hairline
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  const panel = page.locator("#mobile-menu");
  await expect(panel.getByRole("link")).toHaveText(["Home", ...GROUPS.Families!, ...GROUPS.Season!, ...GROUPS.Money!, "Settings"]);
  for (const name of Object.keys(GROUPS)) await expect(panel.getByRole("group", { name })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
  await page.getByRole("button", { name: "Menu" }).click();
  await page.locator("#mobile-menu").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/staff\/settings$/);
  await context.close();
});

test("the initials at the end of the bar open the staff member's own account page: name, display and sign out", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff");
  // The staff home no longer holds the name or Sign out: they are on the account page.
  await expect(page.locator("main").getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await expect(page.locator("main").getByRole("button", { name: "Change my name" })).toHaveCount(0);
  const account = page.locator("header.bar a.account");
  await expect(account).toHaveAccessibleName(/^[A-Z]{1,2}: Your account and display settings, signed in as /);
  await account.click();
  await expect(page).toHaveURL(/\/staff\/account$/);
  await expect(page.locator("header.bar a.account")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your account");
  await expect(page.getByRole("button", { name: "Change my name" })).toBeVisible();
  for (const legend of ["Appearance", "Contrast", "Text size", "Motion"]) await expect(page.getByRole("group", { name: new RegExp(`^${legend}`) })).toBeVisible();
  // The same device choice as the parent's Display page: Dark sets the attribute, Match my device takes it off.
  await page.getByRole("radio", { name: /^Dark/ }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: /^Match my device/ }).first().check();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await context.close();
});
