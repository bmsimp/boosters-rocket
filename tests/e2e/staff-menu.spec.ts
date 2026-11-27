import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

// The seeded staff member is an Admin, who has every menu entry there is. The menu is grouped: Home, three groups, and
// Settings as one entry (Staff, Roles, the audit log, Health and the design system are under it). From 1200px it is
// M3's expanded navigation rail (the owner's D5 of 2026-11-26): every group's pages under its heading, always open, no
// collapse. Below 1200px the staff tab bar and the group hubs are the menu. Layout and the keyboard are things only a
// browser can show, so they are checked here and not in vitest (tests/integration/staff-menu.test.ts checks who sees what).
const GROUPS: Record<string, string[]> = {
  Families: ["Roster", "Parents", "Accounting links", "Messages"],
  Season: ["Seasons", "Progress", "Signed forms", "Volunteering", "Volunteer credit"],
  Money: ["Balances", "Reconciliation"],
};
const rail = (page: Page) => page.locator("nav.staff-rail");
const ALL = ["Home", ...Object.values(GROUPS).flat(), "Settings"];

for (const width of [1200, 1440]) {
  test(`at ${width}px an Admin's menu is the rail: every group's pages in the open under its heading`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    await page.goto("/staff/settings/health");
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByRole("link")).toHaveText(ALL);
    for (const [name, links] of Object.entries(GROUPS)) {
      const g = rail(page).getByRole("group", { name });
      await expect(g.locator(".rail-heading")).toHaveText(name);
      await expect(g.getByRole("link")).toHaveText(links);
      for (const l of links) await expect(g.getByRole("link", { name: l, exact: true })).toBeVisible();
    }
    // Nothing collapses, nothing is a disclosure, and the bar holds no menu of its own.
    await expect(rail(page).locator("[aria-expanded], button, details")).toHaveCount(0);
    await expect(page.locator("header.bar nav")).toHaveCount(0);
    // Health is a settings page: Settings is the one current entry.
    await expect(rail(page).locator('a[aria-current="page"]')).toHaveText(["Settings"]);
    await expect(page.locator("nav.tabs.staff-tabs")).toBeHidden();

    const measured = await page.evaluate(() => {
      const box = (el: Element) => el.getBoundingClientRect().toJSON() as DOMRect;
      const r = document.querySelector("nav.staff-rail")!, main = document.querySelector("main")!;
      return { rail: box(r), main: box(main), links: [...r.querySelectorAll("a")].map((a) => ({ name: a.textContent ?? "", ...box(a) })),
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
    });
    expect(measured.scrollWidth, "the page scrolls sideways").toBeLessThanOrEqual(measured.clientWidth);
    expect(measured.rail.right, "the rail runs into the page").toBeLessThanOrEqual(measured.main.left + 1);
    for (const l of measured.links) {
      expect(l.height, `${l.name} is at least a 48px target`).toBeGreaterThanOrEqual(48);
      expect(l.left, `${l.name} starts inside the rail`).toBeGreaterThanOrEqual(measured.rail.left - 1);
      expect(l.right, `${l.name} runs past the rail`).toBeLessThanOrEqual(measured.rail.right + 1);
    }
    await context.close();
  });
}

test("the rail works with the keyboard alone: each page is one Tab stop, in order, and Enter goes there", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff");
  await rail(page).getByRole("link", { name: "Home", exact: true }).focus();
  for (const name of ALL.slice(1, 4)) {
    await page.keyboard.press("Tab");
    await expect(rail(page).getByRole("link", { name, exact: true })).toBeFocused();
  }
  // Hovering opens nothing and moves nothing.
  await rail(page).getByRole("link", { name: "Balances" }).hover();
  await expect(rail(page).getByRole("link")).toHaveText(ALL);
  await rail(page).getByRole("link", { name: "Progress" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/staff\/seasons\/progress$/);
  await expect(rail(page).locator('a[aria-current="page"]')).toHaveText(["Progress"]);
  await context.close();
});

test("on a Progress page only Progress is marked current, though its address sits under Seasons", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff/seasons/progress");
  await expect(rail(page).locator('a[aria-current="page"]')).toHaveText(["Progress"]);
  await page.goto("/staff/seasons");
  await expect(rail(page).locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(rail(page).locator('a[aria-current="page"]')).toHaveAttribute("href", "/staff/seasons");
  await context.close();
});

for (const width of [900, 1032]) {
  test(`at ${width}px, under 1200, the tab bar and the hubs are the menu and the rail is not drawn`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    await page.goto("/staff/roster");
    await expect(rail(page)).toBeHidden();
    const tabs = page.locator("nav.tabs.staff-tabs");
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("link")).toHaveText(["Home", "Families", "Season", "Money", "Settings"]);
    await expect(tabs.getByRole("link", { name: "Families" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("p.hub-back").getByRole("link", { name: "Families" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await context.close();
  });
}

test("on a phone the menu is a bottom tab bar: Home, each group, Settings; a group's tab opens its hub, and its pages lead back to it", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff");
  await expect(rail(page)).toBeHidden();
  // The bar keeps the club and the initials only: no Menu button.
  await expect(page.getByRole("button", { name: "Menu" })).toHaveCount(0);
  expect(await page.locator("header.bar .wrap").evaluate((el) => el.getBoundingClientRect().height)).toBe(64); // M3's small top app bar, one row
  const tabs = page.locator("nav.tabs.staff-tabs");
  await expect(tabs.getByRole("link")).toHaveText(["Home", "Families", "Season", "Money", "Settings"]);
  await expect(tabs.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  // Every tab is a 48px target or more, inside the screen, and the page above it clears the bar.
  for (const box of await tabs.getByRole("link").evaluateAll((all) => all.map((a) => a.getBoundingClientRect().toJSON() as DOMRect))) {
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.right).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom))).toBeGreaterThanOrEqual(64);

  // A group's tab opens its hub: its pages as rows, each its own page.
  await tabs.getByRole("link", { name: "Families" }).click();
  await expect(page).toHaveURL(/\/staff\/families$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Families");
  await expect(page.locator("main").getByRole("link")).toHaveText(GROUPS.Families!.map((l) => new RegExp(`^${l}`)));
  await expect(tabs.getByRole("link", { name: "Families" })).toHaveAttribute("aria-current", "page");
  await page.locator("main").getByRole("link", { name: /^Roster/ }).click();
  await expect(page).toHaveURL(/\/staff\/roster$/);
  await expect(tabs.getByRole("link", { name: "Families" })).toHaveAttribute("aria-current", "page");
  // The page leads back to its hub.
  await page.locator("p.hub-back").getByRole("link", { name: "Families" }).click();
  await expect(page).toHaveURL(/\/staff\/families$/);

  // Settings goes straight to Settings, whose rail is its first screen.
  await tabs.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/staff\/settings$/);
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  await page.goto("/staff/settings/health");
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await context.close();
});

test("at 1200px and wider the staff tab bar is hidden and the hub's way back is not drawn", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff/roster");
  await expect(page.locator("nav.tabs.staff-tabs")).toBeHidden();
  await expect(page.locator("p.hub-back")).toBeHidden();
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
