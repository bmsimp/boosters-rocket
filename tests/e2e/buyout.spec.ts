import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";
import { E2E_BUYOUT } from "./buyout-seed";

// The buy-outs scripts/seed-e2e.ts gives the Quetzalcoatl family (tests/e2e/buyout-seed.ts): "Pit crew hours" offered
// at $25.00, and "Concession help" bought out, its invoice QZ-1042 on Payments. Every customer id in the seed is not
// digits, so the buy-out confirmed here is refused before anything is sent: this run can never reach Intuit. Both passes
// (phone, then desktop) read one seed: the second finds the first's refused buy-out, and may choose again.
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
const payInstead = (page: Page) => page.getByRole("region", { name: "Pay instead of volunteering" });

test.beforeEach(async ({ context }) => { await context.addCookies([parentSessionCookie()]); });

test("a parent opens a buy-out, sees the amount and what will happen, confirms, and is told calmly it couldn't be set up", async ({ page }) => {
  const res = await page.goto("/volunteer");
  expect(res?.status()).toBe(200);
  const offer = payInstead(page).locator(".list-row").filter({ hasText: "Pit crew hours" });
  await expect(offer).toContainText("Your family");
  await expect(offer).toContainText("0 of 2 hours done");
  // The other family's requirement is never shown, not even its title.
  await expect(page.locator("main")).not.toContainText("Rivera");
  await noSidewaysScroll(page);

  await offer.getByRole("link", { name: /^Pay instead of volunteering \(\$25\.00\)/ }).click();
  await expect(page).toHaveURL(new RegExp(`/volunteer/pay-instead/${E2E_BUYOUT.offered}/family$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pay instead of volunteering");
  const cost = page.getByRole("region", { name: "What it costs" });
  await expect(cost).toContainText("2 hours still to do, at $12.50 per hour");
  await expect(cost.locator(".buyout-amount")).toHaveText(E2E_BUYOUT.offeredAmount);
  await expect(cost).toContainText("An invoice from the club for $25.00 will appear on your Payments page");
  await expect(cost).toContainText("volunteering later doesn't lower it");
  await expect(cost).toContainText("switch back to volunteering until it's paid");
  await noSidewaysScroll(page);
  const confirm = page.getByRole("button", { name: "Confirm: invoice me $25.00" });
  const box = await confirm.boundingBox();
  expect(box!.height, "a tap target at least 48px tall").toBeGreaterThanOrEqual(48);

  await confirm.click();
  await expect(cost.getByRole("alert")).toHaveText("Problem Sorry, the club's invoice couldn't be set up, so nothing has been billed. Please ask the club about paying instead.");
  // Refused before anything was sent: the buy-out is recorded as refused and the queue holds nothing waiting for it.
  const rows = await sql`SELECT state, last_code FROM buyout WHERE requirement_id = ${E2E_BUYOUT.offered} ORDER BY created_at DESC LIMIT 1`;
  expect(rows[0]).toMatchObject({ state: "refused", last_code: "bad_id" });
  const waiting = await sql`SELECT count(*)::int AS n FROM write_queue WHERE state IN ('waiting', 'stuck') AND request->>'op' LIKE 'invoice_%'`;
  expect(waiting[0]!.n).toBe(0);
  await page.goto(`/volunteer/pay-instead/${E2E_BUYOUT.offered}/family`);
  await expect(page.getByText("The last time, the club's invoice couldn't be set up")).toBeVisible();
});

test("a buy-out already chosen reads 'Buy-out invoiced', and its invoice is on Payments", async ({ page }) => {
  await page.goto("/volunteer");
  const bought = payInstead(page).locator(".list-row").filter({ hasText: "Concession help" });
  await expect(bought).toContainText("Buy-out invoiced");
  await bought.getByRole("link", { name: /^See your buy-out/ }).click();
  await expect(page).toHaveURL(new RegExp(`/volunteer/pay-instead/${E2E_BUYOUT.invoiced}/family$`));
  const yours = page.getByRole("region", { name: "Your buy-out" });
  await expect(yours).toContainText(`2 shifts at $50.00 per shift: ${E2E_BUYOUT.invoicedAmount}`);
  await expect(yours.getByRole("button", { name: "Volunteer instead" })).toBeVisible();
  await noSidewaysScroll(page);

  await page.goto("/payments");
  const owed = page.getByRole("region", { name: "Quetzalcoatl Family" });
  const line = owed.locator(".list-row").filter({ hasText: `Invoice ${E2E_BUYOUT.invoiceNumber}` });
  await expect(line.locator(".list-amount")).toHaveText(E2E_BUYOUT.invoicedAmount);
});
