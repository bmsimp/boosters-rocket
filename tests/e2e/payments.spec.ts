import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// The seeded session (scripts/seed-e2e.ts) is Zelda's, with the Quetzalcoatl family chosen. The seed stores what that
// family owes as fresh figures: $85.00 with a pay link, $100.00 without one, and $150.00 paid. Nothing here changes
// them, so both passes of the run (phone and desktop width) find them as they were.
const PAY_LINK = "https://connect.intuit.com/t/scs-v1-e2e-quetzalcoatl-1041";

test("an anonymous visitor is sent to sign in, with this page to come back to", async ({ page }) => {
  await page.goto("/payments");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fpayments$/);
});

test("a parent sees what the family owes, each open invoice, the total and what was paid", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto("/payments");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments");

  const owed = page.getByRole("region", { name: "Quetzalcoatl Family" });
  await expect(owed.locator(".amt")).toHaveText("$185.00");
  // The as-of time is in the viewer's own time once the page is live, not the server's UTC fallback.
  await expect(owed.locator(".asof")).toContainText("Owed now. From QuickBooks, as of ");
  await expect(owed.locator(".asof time")).not.toContainText("UTC");
  await expect(owed.locator(".offline-note")).toHaveCount(0);

  const lines = owed.locator(".lines li");
  await expect(lines).toHaveCount(2);
  // Soonest due first: here, the one whose date has passed. Said in words; the color only follows them.
  await expect(lines.nth(0)).toContainText("Invoice QZ-1042");
  await expect(lines.nth(0).locator(".amount")).toHaveText("$100.00");
  await expect(lines.nth(0).locator(".when.late")).toHaveText(/^Was due \S.*\d{4}$/);
  await expect(lines.nth(1)).toContainText("Invoice QZ-1041, Xochitl Quetzalcoatl");
  await expect(lines.nth(1).locator(".amount")).toHaveText("$85.00");
  await expect(lines.nth(1).locator(".when.soon")).toHaveText(/^Due \S.*, in [78] days$/); // 8 by the club's date (UTC here, as the seed counts), or 7 when the run crosses that midnight
  await expect(lines.nth(1)).toContainText("Invoice date ");
  await expect(owed.locator(".sum")).toHaveText("Total$185.00");
  await expect(owed).toContainText("An invoice with no Pay button can't be paid online. The treasurer can tell you how to pay it.");
  await expect(owed).toContainText("Need more time? Ask the treasurer. They're happy to work something out.");

  const paid = page.getByRole("region", { name: "Paid in the last 12 months" });
  await expect(paid.locator(".lines li")).toHaveCount(1);
  await expect(paid).toContainText("Invoice QZ-1017");
  await expect(paid.locator(".amount")).toHaveText("$150.00Paid");
  await expect(paid.getByRole("link")).toHaveCount(0);
});

test("Pay is a plain link to QuickBooks' payment page: one per invoice that has a link, same tab, no referrer", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/payments");
  const pays = page.locator("a.pay");
  await expect(pays).toHaveCount(1); // the invoice with no link has no button
  const pay = page.getByRole("link", { name: "Pay $85.00, invoice QZ-1041 for Xochitl Quetzalcoatl" });
  await expect(pay).toHaveAttribute("href", PAY_LINK);
  await expect(pay).toHaveAttribute("rel", "noopener noreferrer");
  await expect(pay).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(await pay.getAttribute("target")).toBeNull();
  expect(await pay.getAttribute("aria-disabled")).toBeNull();
  const box = (await pay.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44); // a tap target
  // The link is never followed here: the run reaches nothing outside this machine.
});

test("the page fits the screen at this width, and the amounts line up", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/payments");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  const width = page.viewportSize()!.width;
  const [late, soon] = [page.locator(".money .lines li").nth(0), page.locator(".money .lines li").nth(1)];
  const amount = (await soon.locator(".amount").boundingBox())!, otherAmount = (await late.locator(".amount").boundingBox())!;
  const total = (await page.locator(".money .sum .num").boundingBox())!;
  // One right-aligned column of figures that sums to the total (DESIGN.md, Money lines).
  expect(Math.abs(amount.x + amount.width - (otherAmount.x + otherAmount.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(amount.x + amount.width - (total.x + total.width))).toBeLessThanOrEqual(1);
  const pay = (await page.locator("a.pay").boundingBox())!, row = (await soon.boundingBox())!;
  if (width < 760) {
    // Phone: Pay goes full width under its invoice row.
    expect(pay.y).toBeGreaterThan(amount.y + amount.height - 1);
    expect(pay.width).toBeGreaterThan(row.width - 2);
  } else {
    // Desktop: text | Pay | amount, on one line.
    expect(pay.x + pay.width).toBeLessThanOrEqual(amount.x + 1);
    expect(pay.y).toBeLessThan(amount.y + amount.height);
    expect(pay.width).toBeGreaterThanOrEqual(112);
  }
});

test("the Payments tab leads here from another parent page", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/display");
  await page.getByRole("link", { name: "Payments", exact: true }).click();
  await expect(page).toHaveURL(/\/payments$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments");
  await expect(page.getByRole("link", { name: "Payments", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".money .amt")).toHaveText("$185.00");
});

test("showing the seeded figures asked QuickBooks nothing: they are still as the seed stored them", async ({ context, page }) => {
  // The seeded connection has made-up tokens. A page load that found the figures stale would have gone to Intuit's
  // real servers with them, failed, and recorded the failed try on the row.
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/payments");
  await expect(page.locator(".money .amt")).toHaveText("$185.00");
  const rows = await sql`SELECT family_qbo_id, failed_at, failed_code, total_cents, realm_id FROM family_money ORDER BY family_qbo_id`;
  expect(rows.map((r) => [r.family_qbo_id, r.failed_at, r.failed_code, Number(r.total_cents)])).toEqual([[PARENT_SESSION_FAMILY, null, null, 18500], ["E2E-FAMILY-2", null, null, 37666]]);
  const [connection] = await sql`SELECT last_error FROM qbo_connection`;
  expect(connection!.last_error).toBeNull();
});
