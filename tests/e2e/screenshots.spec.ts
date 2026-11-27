import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { parentSessionCookie } from "./parent-session";
import { BULK, seedBulk } from "./bulk-seed";
import { LINKS, seedLinks } from "./links-seed";

/**
 * Pictures for the owner to look at, not a check of pixels: the QuickBooks settings page and its Disconnect asking first, a
 * Drawer and a ConfirmDialog on the design-system gallery, step 2 of setup asking which
 * company with "A different company" chosen (the owner's finding of 2026-11-25), and the switch page, at each project's
 * width (390 and 1440). Each is saved under test-results/screenshots/, which the focused run uploads as the artifact
 * "screenshots" (.github/workflows/focused.yml). The seed's connection is hidden for step 2 and the switch page, its
 * company kept for the roster, and put back; no press is ever selected. And a bulk action's Drawer on Accounting links
 * (Link to their suggested families, before its press), on data tests/e2e/bulk-seed.ts adds and takes away.
 *
 * And the Material 3 Expressive review set (the owner's of 2026-11-26): the parent's Home on a phone, the staff Home (the
 * rail) and Settings › QuickBooks (the list pane) on a desktop, each in light and in dark; Accounting links with a row
 * ticked (the floating toolbar) and its bulk sheet open, at both widths.
 *
 * And the Accounting links redesign (the owner's approval of 2026-11-27): the list with one row's details open and two
 * rows ticked, and a family's Review drawer, at both widths (390: the phone's list and its full-screen drawer).
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const REALM = "9130000000000001";
const shot = (name: string, project: string) => ({ path: `test-results/screenshots/${name}-${project}.png`, fullPage: true });
const SCHEMES = ["light", "dark"] as const;
/** Every animation on the page that ends run to its end (a spring caught midway is not the look). */
const settle = (page: import("@playwright/test").Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) // a busy spinner turns for ever
  .map((a) => a.finished.catch(() => undefined))));

test("the parent's Home on a phone, light and dark, for the owner to look at", async ({ page, context }, info) => {
  test.skip(info.project.name !== "phone", "the phone's picture");
  await context.addCookies([parentSessionCookie()]);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settle(page);
    await page.screenshot(shot(`parent-home-${scheme}`, info.project.name));
  }
});

test("the staff Home and Settings › QuickBooks on a desktop, light and dark, for the owner to look at", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the desktop's pictures: the rail and the list pane");
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/staff");
    await expect(page.locator("nav.staff-rail")).toBeVisible();
    await settle(page);
    await page.screenshot(shot(`staff-home-${scheme}`, info.project.name));
    await page.goto("/staff/settings/quickbooks");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("QuickBooks");
    await settle(page);
    await page.screenshot(shot(`quickbooks-settings-${scheme}`, info.project.name));
  }
});

test("the QuickBooks pages, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/quickbooks");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("QuickBooks");
  await page.screenshot(shot("quickbooks-settings", info.project.name));

  await sql`UPDATE qbo_connection SET realm_id = NULL`;
  try {
    // The club's app is set to a sandbox and the families came from the real books: "A different company" is chosen.
    await sql`UPDATE setting SET value = ${sql.json({ realmId: REALM, companyName: "E2E Sandbox Company", environment: "production" })} WHERE key = 'roster.source'`;
    await page.goto("/staff/settings/quickbooks/setup?step=connect");
    await expect(page.getByRole("radio", { name: /^A different company/ })).toBeChecked();
    await expect(page.getByRole("heading", { name: "What a switch ends" })).toBeVisible();
    await page.screenshot(shot("setup-step-2-different-company", info.project.name));

    await page.goto("/staff/settings/quickbooks/switch");
    await expect(page.getByRole("button", { name: "Switch companies: sign in to Intuit" })).toBeVisible();
    await page.screenshot(shot("switch-page", info.project.name));
  } finally {
    await sql`UPDATE setting SET value = ${sql.json({ realmId: REALM })} WHERE key = 'roster.source'`;
    await sql`UPDATE qbo_connection SET realm_id = ${REALM}`;
  }
});

test("a Drawer and a ConfirmDialog, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/design-system?ds-drawer=1");
  const drawer = page.getByRole("dialog", { name: "Change the event" });
  await expect(drawer).toBeVisible();
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // slid all the way in, not caught mid-slide
  await page.screenshot({ path: `test-results/screenshots/drawer-${info.project.name}.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toBeVisible();
  await settle(page); // sprung all the way in, not caught mid-fade
  await page.screenshot({ path: `test-results/screenshots/confirm-dialog-${info.project.name}.png` });
});

test("QuickBooks settings' Disconnect, asking first, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/quickbooks");
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toBeVisible();
  await settle(page); // sprung all the way in, not caught mid-fade
  await page.screenshot({ path: `test-results/screenshots/quickbooks-disconnect-${info.project.name}.png` });
});

test("a bulk action's Drawer on Accounting links, for the owner to look at", async ({ page }, info) => {
  const { drop } = await seedBulk(sql);
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    await families.getByRole("checkbox", { name: `Select ${BULK.family}` }).check();
    await settle(page);
    await page.screenshot({ path: `test-results/screenshots/links-ticked-${info.project.name}.png` });
    const label = "Link 1 to its suggested family";
    if (info.project.name === "phone") {
      await families.getByRole("button", { name: "1 selected · Actions" }).click();
      await page.getByRole("dialog", { name: "1 family selected" }).getByRole("button", { name: label }).click();
    } else {
      await families.locator(".bulk-bar").getByRole("button", { name: label }).click();
    }
    const drawer = page.getByRole("dialog", { name: label });
    await expect(drawer).toContainText(`“${BULK.linkName}” to ${BULK.family}`);
    await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/screenshots/bulk-link-drawer-${info.project.name}.png` });
  } finally {
    await drop();
  }
});

test("Accounting links with a row's details open and two rows ticked, and a Review drawer, for the owner to look at", async ({ page }, info) => {
  const { drop } = await seedLinks(sql);
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    await families.getByRole("checkbox", { name: `Select ${LINKS.family}` }).check();
    await families.getByRole("checkbox", { name: `Select ${LINKS.other}` }).check();
    await families.getByRole("button", { name: new RegExp(`^Show details\\s*:\\s*${LINKS.family}$`) }).click();
    const panel = page.getByRole("region", { name: `Details: ${LINKS.family}` });
    await expect(panel.getByRole("region", { name: "In your books" })).toContainText(LINKS.booksPhone);
    await settle(page);
    await page.screenshot(shot("links-details-ticked", info.project.name));
    await panel.getByRole("link", { name: `Review ${LINKS.family}` }).click();
    const review = page.getByRole("dialog", { name: `Review ${LINKS.family}` });
    await expect(review).toBeVisible();
    await review.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/screenshots/links-review-drawer-${info.project.name}.png` });
  } finally {
    await drop();
  }
});
