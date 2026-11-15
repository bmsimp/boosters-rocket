import { test, expect } from "@playwright/test";

// Both doors carry the club bar, so they look like the rest of the portal: the club's name and monogram, and no menu
// (the club's name is set by scripts/seed-e2e.ts).
for (const [path, heading] of [["/sign-in", "Sign in"], ["/staff/sign-in", "Staff sign in"]] as const) {
  test(`${path} carries the club bar, with no menu`, async ({ page }) => {
    await page.goto(path);
    const bar = page.locator("header.bar");
    await expect(bar).toHaveCount(1);
    await expect(bar.locator(".club")).toHaveText("E2E Boosters");
    await expect(bar.locator(".monogram")).toHaveText("E2E");
    await expect(bar.getByRole("link")).toHaveCount(0);
    await expect(bar.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    // The bar spans the page and nothing spills sideways, on a phone as on a desktop.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    const box = await bar.boundingBox();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(page.viewportSize()!.width);
  });
}

test("the parent door promises what a parent finds today: their students and what's owed, and no forms yet", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.locator("main .lede").first()).toHaveText("Sign in to see your students and what's owed. We'll email you a 6-digit code.");
  await expect(page.getByRole("main")).not.toContainText(/forms/i);
});
