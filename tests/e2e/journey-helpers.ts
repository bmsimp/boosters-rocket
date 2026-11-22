import { expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";
import type { MailSink } from "../helpers/mail-sink";

/**
 * What the journey specs (journey-parent.spec.ts, journey-staff.spec.ts) share: each walks one person's visit from start
 * to finish by what they would tap, at the width of the pass it runs in, and leaves the seed as it found it.
 */

/** The page never scrolls sideways at this width. */
export async function noSidewaysScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
}

/**
 * A picture of the page as the walk saw it, for docs/walkthrough.md: taken only when WALK_SHOTS names a folder, so an
 * ordinary run writes nothing. The folder is the person's own choice, outside the repository.
 */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.WALK_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: path.join(dir, `${name}-${width}.png`), fullPage: true });
}

const codeHash = (parentId: string, code: string) => createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`signin-code:${parentId}:${code}`).digest("hex");

/**
 * The newest sign-in code mailed to `email` that the portal still holds unused, read from the mail sink and matched the
 * way the portal stores it (an HMAC keyed with the server secret), as tests/e2e/parent-sign-in.spec.ts does.
 */
export async function codeFor(sql: postgres.Sql, sink: MailSink, email: string): Promise<string> {
  let found = "";
  await expect.poll(async () => {
    const live = await sql`SELECT c.parent_id, c.code_hash FROM signin_code c JOIN parent p ON p.id = c.parent_id WHERE p.email = ${email} AND c.used_at IS NULL`;
    for (const m of sink.messages.filter((x) => x.to.includes(email)).reverse()) {
      const code = /^Subject: .*sign-in code: (\d{6})/m.exec(m.raw)?.[1];
      if (code && live.some((r) => r.code_hash === codeHash(r.parent_id as string, code))) { found = code; return true; }
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  return found;
}

/** Opens one group of the staff menu (or the phone's Menu first) and follows one of its entries, as a person would. */
export async function staffMenuTo(page: Page, group: string | null, entry: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 760) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator("#mobile-menu").getByRole("link", { name: entry, exact: true }).click();
    return;
  }
  const nav = page.locator("header.bar nav.top-nav");
  if (group) await nav.getByRole("button", { name: new RegExp(`^${group}`) }).click();
  await nav.getByRole("link", { name: entry, exact: true }).click();
}

/** From Settings, opens one item of its rail (on a phone the rail is the first screen of Settings). */
export async function settingsTo(page: Page, item: string): Promise<void> {
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: new RegExp(`^${item}`) }).click();
}

/**
 * Presses "Not now" on the passkey offer on Home (the sign-in release, slice SI-8) when Home drew it, and waits for its
 * answer: every spec that signs Zelda in by her password and the emailed code lands on Home with the offer, since that
 * sign-in proved a second step on a new device. Call it once Home has loaded; with no offer drawn it does nothing. The
 * box reads the browser first (an empty placeholder until then, `data-passkey-offer="pending"`), so this waits for that
 * reading, never for a guessed time. Put Zelda's count back after the spec with resetPasskeyOffer() (signin-links.ts).
 */
export async function passOffer(page: Page): Promise<void> {
  const offer = page.locator("[data-passkey-offer]");
  if ((await offer.count()) === 0) return;
  await expect(page.locator('[data-passkey-offer="pending"]')).toHaveCount(0);
  const shown = page.locator('[data-passkey-offer="shown"]');
  if ((await shown.count()) === 0) return;
  await shown.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(page.locator('[data-passkey-offer="said"]').getByRole("status")).toBeVisible();
}
