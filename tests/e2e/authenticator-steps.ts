import { expect, type Locator, type Page } from "@playwright/test";
import type postgres from "postgres";
// The time-based code is pure (it imports node:crypto alone), so the browser run works an app's code out by the very
// rule the portal checks it by (RFC 6238), from the key the page shows, as the app on a parent's phone would.
import { base32Decode, totp, totpStep, TOTP_STEP_SECONDS } from "../../src/lib/parents/totp";
import { PARENT_SESSION_TOKEN } from "./parent-session";
import { ZELDA_EMAIL } from "./signin-links";

/**
 * Zelda's authenticator app in the browser run (the sign-in release, slice SI-6b). scripts/seed-e2e.ts gives nobody an
 * app, so a spec sets one up through /family/sign-in's own presses (setUpAppOnPage()) and removes what it made after
 * (removeZeldaSecondSteps(), which leaves nothing of an app or a backup code for her, as the seed has none), with the
 * counts its presses and tries took for her (clearZeldaCounts()) and the seeded session's proof put back as it was
 * (keepZeldaProof()). The seeded password, device and session are never changed.
 */

/** Removes Zelda's authenticator app, any unfinished set-up and every backup code of hers: the seed has none. */
export async function removeZeldaSecondSteps(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM parent_backup_code WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`;
  await sql`DELETE FROM parent_authenticator WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`;
}

/**
 * The per-person counts a spec's presses and tries took for Zelda (the settings' presses, the app's tries, asking
 * again's password tries against her or one of her devices), and her emailed codes, so the next spec finds them as the
 * seed left them (it has none).
 */
export async function clearZeldaCounts(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM rate_limit_event WHERE kind IN ('signin_settings_parent', 'second_step_parent', 'password_reask_parent', 'password_try_device')
    AND subject IN (SELECT id::text FROM parent WHERE email = ${ZELDA_EMAIL}
      UNION SELECT d.id::text FROM parent_device d JOIN parent p ON p.id = d.parent_id WHERE p.email = ${ZELDA_EMAIL})`;
  await sql`DELETE FROM signin_code WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`;
}

/** The seeded session's proof (`strong_at`) as it is now, and a way to put it back. */
export async function keepZeldaProof(sql: postgres.Sql): Promise<() => Promise<void>> {
  const was = ((await sql`SELECT strong_at FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`)[0]?.strong_at ?? null) as Date | null;
  return async () => { await sql`UPDATE parent_auth_session SET strong_at = ${was} WHERE token = ${PARENT_SESSION_TOKEN}`; };
}

/** Stamps the seeded session as proved just now (asking again's window), or takes its proof away. */
export async function setZeldaProof(sql: postgres.Sql, proved: boolean): Promise<void> {
  if (proved) await sql`UPDATE parent_auth_session SET strong_at = now() WHERE token = ${PARENT_SESSION_TOKEN}`;
  else await sql`UPDATE parent_auth_session SET strong_at = NULL WHERE token = ${PARENT_SESSION_TOKEN}`;
}

/**
 * Stamps the seeded session as proved at the moment Zelda's app came into force: a proof made before it no longer counts
 * (slice SI-6b's second read), so a page drawn after a set-up asks again unless the proof is at least that new. Read from
 * the app's own row, so the two clocks (the database's and the app's) never disagree.
 */
export async function proveZeldaSinceHerApp(sql: postgres.Sql): Promise<void> {
  await sql`UPDATE parent_auth_session SET strong_at = (SELECT a.confirmed_at FROM parent_authenticator a JOIN parent p ON p.id = a.parent_id
    WHERE p.email = ${ZELDA_EMAIL} AND a.confirmed_at IS NOT NULL) WHERE token = ${PARENT_SESSION_TOKEN}`;
}

/** The key as the page shows it (groups of four), as the bytes an app is given. */
const secretOf = (key: string) => base32Decode(key.replace(/\s+/g, ""))!;

/** The app's code for the step `atMs` falls in, `steps` steps on. */
export const appCodeAt = (key: string, atMs: number, steps = 0): string => totp(secretOf(key), atMs + steps * TOTP_STEP_SECONDS * 1000);

/**
 * A code the portal takes now for an app whose newest taken code was for the step `lastMs` fell in: the code of the
 * step the page's clock is in, or, while that is still the step taken, of the step after (the check takes a step
 * either way, and never the same step twice). `page` is any page of the run: its clock is the server's machine's.
 */
export async function nextAppCode(page: Page, key: string, lastMs: number): Promise<string> {
  const now = await page.evaluate(() => Date.now());
  return totpStep(now) > totpStep(lastMs) ? appCodeAt(key, now) : appCodeAt(key, lastMs, 1);
}

/**
 * A code the portal takes now for an app whose newest taken code was for the step `lastStep`, and its step: the step
 * the page's clock is in, or the one after `lastStep` once the clock is near enough for the check to take it (a step
 * either way of now). While the clock is still two steps short, it waits for the clock itself (at most one step).
 */
export async function appCodeAfter(page: Page, key: string, lastStep: number): Promise<{ code: string; step: number }> {
  let now = 0;
  await expect.poll(async () => { now = await page.evaluate(() => Date.now()); return totpStep(now) + 1 > lastStep; },
    { timeout: (TOTP_STEP_SECONDS + 10) * 1000 }).toBe(true);
  const step = Math.max(totpStep(now), lastStep + 1);
  return { code: totp(secretOf(key), step * TOTP_STEP_SECONDS * 1000), step };
}

/**
 * Sets an app up through the "Authenticator app" box of /family/sign-in (the page already open, its session proved):
 * "Set up an authenticator app", the key read as the page shows it, the app's code worked out from it at the page's own
 * clock, "Finish setting up". Returns the key, when its code was worked out, and the ten backup codes as shown.
 */
export async function setUpAppOnPage(page: Page, box: Locator): Promise<{ key: string; at: number; codes: string[] }> {
  await box.getByRole("button", { name: "Set up an authenticator app", exact: true }).click();
  await expect(box.getByRole("img", { name: "QR code to scan with your authenticator app" })).toBeVisible();
  const key = ((await box.locator(".app-key").textContent()) ?? "").trim();
  expect(key).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
  const at = await page.evaluate(() => Date.now());
  await box.getByLabel("Code from your authenticator app", { exact: true }).fill(appCodeAt(key, at));
  await box.getByRole("button", { name: "Finish setting up" }).click();
  const listed = box.getByRole("list", { name: "Your backup codes" }).getByRole("listitem");
  await expect(listed).toHaveCount(10);
  return { key, at, codes: (await listed.allTextContents()).map((c) => c.trim()) };
}
