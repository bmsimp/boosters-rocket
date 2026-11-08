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
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/staff/roles");
  await expect(page).toHaveURL(/\/staff\/sign-in$/);
});

test("no horizontal scroll on the sign-in page", async ({ page }) => {
  await page.goto("/sign-in");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
