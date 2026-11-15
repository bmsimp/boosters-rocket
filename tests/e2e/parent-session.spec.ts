import { test, expect } from "@playwright/test";
import { parentSessionCookie } from "./parent-session";

// The seeded session (scripts/seed-e2e.ts) is Zelda's, with the Quetzalcoatl family chosen. Nothing here changes it,
// so both passes of the run, and a run without a new seed, find it as it was.

test("the seeded parent session opens the parent home, not the sign-in page", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/localhost:3100\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
  await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
  await page.goto("/display");
  await expect(page).toHaveURL(/\/display$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Display");
});

test("a cookie signed with another secret, or for a session that doesn't exist, is sent to sign in", async ({ browser }) => {
  const real = parentSessionCookie();
  const [token] = decodeURIComponent(real.value).split(".");
  const forged = { ...real, value: encodeURIComponent(`${token}.${Buffer.from("not the signature").toString("base64")}`) };
  for (const cookie of [forged, parentSessionCookie("no-such-session-token")]) {
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
    await context.close();
  }
});
