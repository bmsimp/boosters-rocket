import { test, expect } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

// The seeded staff member is an Admin, who has every menu entry there is: more than one row of the club bar holds.
// The entries must all stay inside the bar and readable at every width, and the page must never scroll sideways.
// Layout is something only a browser can show, so this is checked here and not in vitest.
const ENTRIES = ["Home", "Roster", "Reconciliation", "Parents", "Seasons", "Progress", "Balances", "Volunteering", "Volunteer credit", "Signed forms", "Staff", "Roles", "Club", "Sign-in", "Mail", "QuickBooks", "Forms", "Parent sign-ins", "Audit", "Health"];

for (const width of [760, 900, 1032, 1440]) {
  test(`an Admin's menu fits the club bar at ${width}px: every entry inside it, on one line of its own, and no sideways scroll`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    await page.goto("/staff/health");
    const nav = page.locator("header.bar nav.top-nav");
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link")).toHaveText(ENTRIES);
    await expect(nav.getByRole("link", { name: "Health" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator("header.bar .club")).toBeVisible();

    const measured = await page.evaluate(() => {
      const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, width: r.width }; };
      const bar = document.querySelector("header.bar")!, wrap = bar.querySelector(".wrap")!;
      return {
        bar: box(bar), wrap: box(wrap), club: box(bar.querySelector(".club")!), account: box(bar.querySelector(".account")!),
        links: [...bar.querySelectorAll("nav.top-nav a")].map((a) => ({ name: a.textContent ?? "", ...box(a) })),
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(measured.scrollWidth, "the page scrolls sideways").toBeLessThanOrEqual(measured.clientWidth);
    for (const link of measured.links) {
      // Inside the bar's own column, and inside the bar from top to bottom.
      expect(link.left, `${link.name} starts left of the bar's column`).toBeGreaterThanOrEqual(measured.wrap.left - 1);
      expect(link.right, `${link.name} runs past the bar's column`).toBeLessThanOrEqual(measured.wrap.right + 1);
      expect(link.top, `${link.name} sticks out above the bar`).toBeGreaterThanOrEqual(measured.bar.top - 1);
      expect(link.bottom, `${link.name} hangs below the bar`).toBeLessThanOrEqual(measured.bar.bottom + 1);
      // Its words on one line: a link whose words broke would be taller than a tap target and a half.
      expect(link.height, `${link.name} is at least a tap target tall`).toBeGreaterThanOrEqual(44);
      expect(link.height, `${link.name} broke onto a second line`).toBeLessThan(60);
    }
    // No two entries on top of each other.
    for (const [i, a] of measured.links.entries()) {
      for (const b of measured.links.slice(i + 1)) {
        const apart = a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1;
        expect(apart, `${a.name} and ${b.name} overlap`).toBe(true);
      }
    }
    // The club's name keeps room to be read, and the account control stays inside the column.
    expect(measured.club.width, "the club's name was squeezed out").toBeGreaterThan(60);
    expect(measured.account.right).toBeLessThanOrEqual(measured.wrap.right + 1);
    await context.close();
  });
}

test("on a Progress page only Progress is marked current, though its address sits under Seasons", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff/seasons/progress");
  await expect(page.locator('header.bar nav.top-nav a[aria-current="page"]')).toHaveText(["Progress"]);
  await page.goto("/staff/seasons");
  await expect(page.locator('header.bar nav.top-nav a[aria-current="page"]')).toHaveText(["Seasons"]);
  await context.close();
});

test("on a phone the same entries are behind the Menu button, and the bar keeps its one row", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  await page.goto("/staff/health");
  await expect(page.locator("header.bar nav.top-nav")).toBeHidden();
  expect(await page.locator("header.bar").evaluate((el) => el.getBoundingClientRect().height)).toBe(56);
  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.locator("#mobile-menu").getByRole("link")).toHaveText(ENTRIES);
  await context.close();
});
