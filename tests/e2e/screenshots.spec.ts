import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { BULK, seedBulk } from "./bulk-seed";

/**
 * Pictures for the owner to look at, not a check of pixels: the QuickBooks settings page and its Disconnect asking first, a
 * Drawer and a ConfirmDialog on the design-system gallery, step 2 of setup asking which
 * company with "A different company" chosen (the owner's finding of 2026-11-25), and the switch page, at each project's
 * width (390 and 1440). Each is saved under test-results/screenshots/, which the focused run uploads as the artifact
 * "screenshots" (.github/workflows/focused.yml). The seed's connection is hidden for step 2 and the switch page, its
 * company kept for the roster, and put back; no press is ever selected. And a bulk action's Drawer on Accounting links
 * (Link to their suggested families, before its press), on data tests/e2e/bulk-seed.ts adds and takes away.
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const REALM = "9130000000000001";
const shot = (name: string, project: string) => ({ path: `test-results/screenshots/${name}-${project}.png`, fullPage: true });

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
  await page.screenshot({ path: `test-results/screenshots/confirm-dialog-${info.project.name}.png` });
});

test("QuickBooks settings' Disconnect, asking first, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/quickbooks");
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toBeVisible();
  await page.screenshot({ path: `test-results/screenshots/quickbooks-disconnect-${info.project.name}.png` });
});

test("a bulk action's Drawer on Accounting links, for the owner to look at", async ({ page }, info) => {
  const { drop } = await seedBulk(sql);
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    await families.getByRole("checkbox", { name: `Select ${BULK.family}` }).check();
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
