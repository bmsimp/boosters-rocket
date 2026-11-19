import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { mintZeldaLink, NO_SUCH_LINK, removeZeldaLinks, removeZeldaSessionsMadeHere } from "./signin-links";

/**
 * A set-up link in the browser (the sign-in release, slices SI-2 and SI-3a): opened, a password chosen and set, and,
 * the seed's club being at Standard, Zelda signed in: she has two families, so she lands on the chooser. The password
 * is long and random, so it passes the breach check whether the real service answers or can't be reached (both
 * outcomes are asserted against a stub in tests/integration/password-links.test.ts). Zelda's link, the password and
 * the session it signed her in with are removed after, so the seed is as it was for the next pass and the next spec.
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterEach(async () => { await removeZeldaLinks(sql); await removeZeldaSessionsMadeHere(sql); });
test.afterAll(async () => { await sql.end(); });
/** Zelda's sessions still choosing a family: a sign-in into two families makes one. */
const choosingSessions = async () => (await sql`SELECT count(*)::int AS n FROM parent_auth_session s JOIN parent_auth_user u ON u.id = s.user_id
  JOIN parent p ON p.id = u.parent_id WHERE p.email = 'zelda@example.com' AND s.family_id IS NULL`)[0]!.n as number;

test("a set-up link sets a password and signs the parent in, landing on the chooser", async ({ page }) => {
  const token = await mintZeldaLink(sql, "setup");
  const before = await choosingSessions();
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
  // Signed in: Zelda is a guardian of two families, so the portal sends her to choose one.
  await expect(page).toHaveURL(/\/choose-family$/);
  expect(await choosingSessions()).toBe(before + 1);
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
