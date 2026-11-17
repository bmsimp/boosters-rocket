import { test, expect } from "@playwright/test";

const PUBLIC = ["/sign-in", "/staff/sign-in", "/refused"];

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
  await page.goto("/staff/roles");
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
