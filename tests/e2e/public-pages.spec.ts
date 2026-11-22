import { test, expect } from "@playwright/test";
import { NO_SUCH_LINK } from "./signin-links";

// The pages a set-up or reset link opens, with a token that names no link (tests/e2e/password-links.spec.ts opens a live one).
const PUBLIC = ["/sign-in", "/staff/sign-in", "/refused", `/sign-in/set-up/${NO_SUCH_LINK}`, `/sign-in/reset/${NO_SUCH_LINK}`, "/sign-in/password"];

for (const path of PUBLIC) {
  test(`${path} shows no family data to an anonymous visitor`, async ({ page }) => {
    await page.goto(path);
    const html = await page.content();
    expect(html).not.toContain("Zelda");
    expect(html).not.toContain("Quetzalcoatl");
    expect(html).not.toContain("E2E-FAMILY");
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  });
}

test("parent and staff pages send an anonymous visitor to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/display");
  // A parent page passes its own address along, so the parent is brought back to it after signing in.
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fdisplay$/);
  await page.goto("/staff/settings/roles");
  await expect(page).toHaveURL(/\/staff\/sign-in$/);
});

test("no horizontal scroll on the sign-in page", async ({ page }) => {
  await page.goto("/sign-in");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("an address with no page gets the portal's own not-found page, not the framework default", async ({ page }) => {
  for (const path of ["/no-such-page"]) {
    const res = await page.goto(path);
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("We can't find that page");
    expect(await page.content()).not.toContain("Zelda");
  }
});
