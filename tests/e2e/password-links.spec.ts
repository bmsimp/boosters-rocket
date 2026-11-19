import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { mintZeldaLink, NO_SUCH_LINK, removeZeldaLinks } from "./signin-links";

/**
 * A set-up link in the browser (the sign-in release, slice SI-2): opened, a password chosen and set. The password is
 * long and random, so it passes the breach check whether the real service answers or can't be reached (both outcomes
 * are asserted against a stub in tests/integration/password-links.test.ts). Zelda's link and the password are removed
 * after, so the seed is as it was for the next pass and the next spec. Nothing links to these pages yet.
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterEach(async () => { await removeZeldaLinks(sql); });
test.afterAll(async () => { await sql.end(); });

test("a set-up link sets a password, and says so", async ({ page }) => {
  const token = await mintZeldaLink(sql, "setup");
  const res = await page.goto(`/sign-in/set-up/${token}`);
  expect(res?.headers()["cache-control"]).toContain("no-store");
  // The token is in the address: the answer itself says to send no referrer, before any of the page's own requests.
  expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choose a password");
  // Nothing of the person or family is on the page.
  for (const text of ["Zelda", "zelda@example.com", "Quetzalcoatl", "E2E-FAMILY"]) expect(await page.content()).not.toContain(text);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  const password = randomBytes(24).toString("base64url");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Type it again").fill(password);
  await page.getByRole("button", { name: "Save my password" }).click();
  await expect(page.getByText("Your password is set.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/sign-in");
  const [row] = await sql`SELECT count(*)::int AS n FROM parent_auth_account a JOIN parent_auth_user u ON u.id = a.user_id
    JOIN parent p ON p.id = u.parent_id WHERE p.email = 'zelda@example.com' AND a.provider_id = 'credential'`;
  expect(row!.n).toBe(1);
  // The link is spent: opening it again says it can't be used.
  await page.goto(`/sign-in/set-up/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link can't be used");
});

test("a link that names nothing says it can't be used, and is sent no-store", async ({ page }) => {
  for (const path of [`/sign-in/set-up/${NO_SUCH_LINK}`, `/sign-in/reset/${NO_SUCH_LINK}`, "/sign-in/set-up/not-a-token"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    expect(res?.headers()["cache-control"], path).toContain("no-store");
    expect(res?.headers()["referrer-policy"], path).toBe("no-referrer");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This link can't be used");
    await expect(page.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/sign-in");
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  }
});
