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
    await expect(page.getByRole("navigation")).toHaveCount(0); // no empty landmark for a screen reader to announce
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
    // The bar spans the page and nothing spills sideways, on a phone as on a desktop.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    const box = await bar.boundingBox();
    expect(box!.x).toBe(0);
    expect(box!.width).toBe(page.viewportSize()!.width);
  });
}

test("the parent door promises what a parent finds today: their students, what's owed, forms and volunteer shifts", async ({ page }) => {
  await page.goto("/sign-in");
  // Since the sign-in release's slice SI-3b: the email and password, and one more thing only on a device the portal
  // doesn't know (since SI-7a it never says which: a code, the app or a passkey).
  await expect(page.locator("main .lede").first()).toHaveText("Sign in with your email and password. On a new device, we'll ask for one more thing to be sure it's you.");
});
