import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";

/**
 * Pictures for the owner to look at, not a check of pixels: the QuickBooks settings page, step 2 of setup asking which
 * company with "A different company" chosen (the owner's finding of 2026-11-25), and the switch page, at each project's
 * width (390 and 1440). Each is saved under test-results/screenshots/, which the focused run uploads as the artifact
 * "screenshots" (.github/workflows/focused.yml). The seed's connection is hidden for step 2 and the switch page, its
 * company kept for the roster, and put back; no press is ever selected.
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
