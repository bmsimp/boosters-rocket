import { test, expect, type Page } from "@playwright/test";
import { parentSessionCookie } from "./parent-session";
import { E2E_VOLUNTEER } from "./volunteer-seed";

// Checking in with a shift's code (v1 spec §11.4). scripts/seed-e2e.ts gives Zelda a place on "Concession stand",
// whose window is open for hours after the seed, and on "Car wash", which ended yesterday. Both passes of the run
// (phone, then desktop) read one seed, so the first test passes whether Zelda is checked in already or not.
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

test("a parent opens the check-in address of a shift that is open now, checks in, and sees Checked in", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto(`/volunteer/check-in/${E2E_VOLUNTEER.openCode}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check in");
  await expect(page.locator(".lede")).toContainText("Concession stand, Popcorn");
  const me = page.locator(".lines li").first();
  await expect(me).toContainText("You");
  await noSidewaysScroll(page);
  const button = page.getByRole("button", { name: "Check me in" });
  if (await button.isVisible()) {
    await expect(me).toContainText("Not checked in yet");
    await button.click();
  }
  await expect(me).toContainText("Checked in");
  await expect(page.getByRole("button", { name: "Check me in" })).toHaveCount(0);
  await expect(page.getByText("Everyone here is checked in. Thank you for helping!")).toBeVisible();
  // Nothing of another family: the shift is the only thing on the page that isn't Zelda's.
  await expect(page.locator("main")).not.toContainText("Rivera");
  await noSidewaysScroll(page);

  // On the Volunteer page, the place reads "Checked in", and it is listed among what the family has done.
  await page.goto("/volunteer");
  const mine = page.locator("section", { has: page.getByRole("heading", { name: "Your sign-ups" }) });
  await expect(mine.locator("li", { hasText: "Concession stand" })).toContainText("Checked in");
  const done = page.locator("section", { has: page.getByRole("heading", { name: "Done so far" }) });
  await expect(done).toContainText("Concession stand, Popcorn");
  await noSidewaysScroll(page);
});

test("a check-in address outside its window says so, and offers no button", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto(`/volunteer/check-in/${E2E_VOLUNTEER.closedCode}`);
  expect(res?.status()).toBe(200);
  await expect(page.locator(".lede")).toContainText("Car wash, Rinse crew");
  await expect(page.getByText("Check-in for this shift has closed: it's over.")).toBeVisible();
  await expect(page.locator(".lines li").first()).toContainText("Not checked in yet");
  await expect(page.getByRole("button", { name: /Check (me|everyone) in/ })).toHaveCount(0);
  await noSidewaysScroll(page);
});

test("a code that opens nothing is not found, and a guardian who must sign in first is brought back to the address", async ({ page }) => {
  const missing = await page.context().request.get(`/volunteer/check-in/${"x".repeat(40)}`, { headers: { cookie: `${parentSessionCookie().name}=${parentSessionCookie().value}` } });
  expect(missing.status()).toBe(404);
  await page.goto(`/volunteer/check-in/${E2E_VOLUNTEER.openCode}`);
  await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=${encodeURIComponent(`/volunteer/check-in/${E2E_VOLUNTEER.openCode}`)}$`));
});
