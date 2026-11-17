import { test, expect } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

// The check of the portal's requests (roadmap step 7) sends every request the portal makes to the connected company.
// The browser seed's connection is made up: its roster's ids are not digits and its tokens reach no company, so the page
// must say it can't be run here, and offer no button. That is what keeps this run from ever reaching Intuit.
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

test("an Admin opens the check from QuickBooks settings, and is told it can't run against the browser run's made-up connection", async ({ page }) => {
  const toIntuit: string[] = [];
  page.on("request", (r) => { if (/intuit\.com/i.test(r.url())) toIntuit.push(r.url()); });
  await page.goto("/staff/settings/quickbooks");
  const section = page.getByRole("region", { name: "The portal's requests" });
  await expect(section).toContainText("haven't been checked against a company yet");
  await section.getByRole("link", { name: "Check the portal's requests" }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/quickbooks\/check$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check the portal's requests");
  const run = page.getByRole("region", { name: "Run the check" });
  await expect(run).toContainText("This connection can't be checked");
  await expect(page.getByRole("button", { name: "Run the check" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page scrolls sideways").toBe(true);
  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page).toHaveURL(/\/staff\/settings$/);
  expect(toIntuit).toEqual([]);
});
