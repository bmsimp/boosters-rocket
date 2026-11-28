import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { createHmac } from "node:crypto";
import { staffSessionCookie } from "./staff-session";
import { parentSessionCookie } from "./parent-session";
import { BULK, seedBulk } from "./bulk-seed";
import { LINKS, seedLinks } from "./links-seed";

/**
 * Pictures for the owner to look at, not a check of pixels: the QuickBooks settings page and its Disconnect asking first, a
 * Drawer and a ConfirmDialog on the design-system gallery, step 2 of setup asking which
 * company with "A different company" chosen (the owner's finding of 2026-11-25), and the switch page, at each project's
 * width (390 and 1440). Each is saved under test-results/screenshots/, which the focused run uploads as the artifact
 * "screenshots" (.github/workflows/focused.yml). The seed's connection is hidden for step 2 and the switch page, its
 * company kept for the roster, and put back; no press is ever selected. And a bulk action's Drawer on Accounting links
 * (Link to their suggested families, before its press), on data tests/e2e/bulk-seed.ts adds and takes away.
 *
 * And the Material 3 Expressive review set (the owner's of 2026-11-26): the parent's Home on a phone, the staff Home (the
 * rail) and Settings › QuickBooks (the list pane) on a desktop, each in light and in dark; Accounting links with a row
 * ticked (the floating toolbar) and its bulk sheet open, at both widths.
 *
 * And the Accounting links redesign (the owner's approval of 2026-11-27): the list with one row's details open and two
 * rows ticked, and a family's Review drawer, at both widths (390: the phone's list and its full-screen drawer).
 *
 * And the Families pages with no books (stage 5's slice P2), at both widths.
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const REALM = "9130000000000001";
const shot = (name: string, project: string) => ({ path: `test-results/screenshots/${name}-${project}.png`, fullPage: true });
const SCHEMES = ["light", "dark"] as const;
/** Every animation on the page that ends run to its end (a spring caught midway is not the look). */
const settle = (page: import("@playwright/test").Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) // a busy spinner turns for ever
  .map((a) => a.finished.catch(() => undefined))));

test("the parent's Home on a phone, light and dark, for the owner to look at", async ({ page, context }, info) => {
  test.skip(info.project.name !== "phone", "the phone's picture");
  await context.addCookies([parentSessionCookie()]);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settle(page);
    await page.screenshot(shot(`parent-home-${scheme}`, info.project.name));
  }
});

test("the staff Home and Settings › QuickBooks on a desktop, light and dark, for the owner to look at", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the desktop's pictures: the rail and the list pane");
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/staff");
    await expect(page.locator("nav.staff-rail")).toBeVisible();
    await settle(page);
    await page.screenshot(shot(`staff-home-${scheme}`, info.project.name));
    await page.goto("/staff/settings/quickbooks");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("QuickBooks");
    await settle(page);
    await page.screenshot(shot(`quickbooks-settings-${scheme}`, info.project.name));
  }
});

test("the QuickBooks pages, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/quickbooks");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("QuickBooks");
  await page.screenshot(shot("quickbooks-settings", info.project.name));

  await sql`UPDATE qbo_connection SET realm_id = NULL`;
  try {
    // The club's app is set to a sandbox and the families came from the real books: "A different company" is chosen.
    await sql`UPDATE setting SET value = ${sql.json({ realmId: REALM, companyName: "E2E Sandbox Company", environment: "production" })} WHERE key = 'roster.source'`;
    await page.goto("/staff/settings/quickbooks/setup?step=connect");
    await expect(page.getByRole("radio", { name: /^A different company/ })).toBeChecked();
    await expect(page.getByRole("heading", { name: "What a switch ends" })).toBeVisible();
    await page.screenshot(shot("setup-step-2-different-company", info.project.name));

    await page.goto("/staff/settings/quickbooks/switch");
    await expect(page.getByRole("button", { name: "Switch companies: sign in to Intuit" })).toBeVisible();
    await page.screenshot(shot("switch-page", info.project.name));
  } finally {
    await sql`UPDATE setting SET value = ${sql.json({ realmId: REALM })} WHERE key = 'roster.source'`;
    await sql`UPDATE qbo_connection SET realm_id = ${REALM}`;
  }
});

/**
 * The Families pages with no books (stage 5's slice P2): QuickBooks is turned off for the pictures (`plugins.on` empty)
 * and turned on again after. The roster, a family's page, and its Add a student drawer, at each project's width.
 */
test("the Families pages with no books, for the owner to look at", async ({ page }, info) => {
  const [family] = await sql`SELECT family_id FROM accounting_link WHERE customer_id = 'E2E-FAMILY' AND family_id IS NOT NULL`;
  await sql`UPDATE setting SET value = ${sql.json([])} WHERE key = 'plugins.on'`;
  try {
    await page.goto("/staff/roster");
    await expect(page.getByRole("heading", { name: "Add a family" })).toBeVisible();
    await settle(page);
    await page.screenshot(shot("no-books-roster", info.project.name));
    await page.goto(`/staff/roster/${family!.family_id as string}`);
    await expect(page.getByRole("heading", { name: "Change the family" })).toBeVisible();
    await settle(page);
    await page.screenshot(shot("no-books-family", info.project.name));
    await page.goto(`/staff/roster/${family!.family_id as string}?add-student-here=1`);
    const drawer = page.getByRole("dialog", { name: "Add a student" });
    await expect(drawer).toBeVisible();
    await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/screenshots/no-books-add-student-${info.project.name}.png` });
  } finally {
    await sql`UPDATE setting SET value = ${sql.json(["quickbooks"])} WHERE key = 'plugins.on'`;
  }
});

test("a Drawer and a ConfirmDialog, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/design-system?ds-drawer=1");
  const drawer = page.getByRole("dialog", { name: "Change the event" });
  await expect(drawer).toBeVisible();
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // slid all the way in, not caught mid-slide
  await page.screenshot({ path: `test-results/screenshots/drawer-${info.project.name}.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toBeVisible();
  await settle(page); // sprung all the way in, not caught mid-fade
  await page.screenshot({ path: `test-results/screenshots/confirm-dialog-${info.project.name}.png` });
});

test("QuickBooks settings' Disconnect, asking first, for the owner to look at", async ({ page }, info) => {
  await page.goto("/staff/settings/quickbooks");
  await page.getByRole("button", { name: "Disconnect QuickBooks" }).click();
  await expect(page.getByRole("dialog", { name: "Disconnect QuickBooks?" })).toBeVisible();
  await settle(page); // sprung all the way in, not caught mid-fade
  await page.screenshot({ path: `test-results/screenshots/quickbooks-disconnect-${info.project.name}.png` });
});

test("a bulk action's Drawer on Accounting links, for the owner to look at", async ({ page }, info) => {
  const { drop } = await seedBulk(sql);
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    await families.getByRole("checkbox", { name: `Select ${BULK.family}` }).check();
    await settle(page);
    await page.screenshot({ path: `test-results/screenshots/links-ticked-${info.project.name}.png` });
    const label = "Link 1 to its suggested family";
    if (info.project.name === "phone") {
      await families.getByRole("button", { name: "1 selected · Actions" }).click();
      await page.getByRole("dialog", { name: "1 family selected" }).getByRole("button", { name: label }).click();
    } else {
      await families.locator(".bulk-bar").getByRole("button", { name: label }).click();
    }
    const drawer = page.getByRole("dialog", { name: label });
    await expect(drawer).toContainText(`“${BULK.linkName}” to ${BULK.family}`);
    await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/screenshots/bulk-link-drawer-${info.project.name}.png` });
  } finally {
    await drop();
  }
});

/**
 * The large-screen layout (the owner's approval of 2026-11-27): the Settings Overview's status cards at 1440 (two
 * across beside the compact rail and the list) and 2560 (four across), QuickBooks at 2560 (its cards in columns), and a
 * page with no list pane at 2560 (the expanded rail, the page starting at its pane's edge), in light.
 */
test("the large-screen layout, at 1440 and 2560, for the owner to look at", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "the desktop's pictures");
  const at = async (width: number, address: string, name: string, ready: (page: import("@playwright/test").Page) => Promise<void>) => {
    const context = await browser.newContext({ viewport: { width, height: width >= 2000 ? 1300 : 900 }, colorScheme: "light" });
    await context.addCookies([staffSessionCookie()]);
    const page = await context.newPage();
    await page.goto(address);
    await ready(page);
    await settle(page);
    await page.screenshot({ path: `test-results/screenshots/${name}-${width}.png`, fullPage: !name.endsWith("docked") });
    await context.close();
  };
  const overview = async (page: import("@playwright/test").Page) => {
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    await expect(page.locator("nav.compact-rail")).toBeVisible();
  };
  await at(1440, "/staff/settings", "settings-overview", overview);
  await at(2560, "/staff/settings", "settings-overview", overview);
  await at(2560, "/staff/settings/quickbooks", "quickbooks-settings", async (page) => { await expect(page.getByRole("heading", { level: 1 })).toHaveText("QuickBooks"); });
  await at(2560, "/staff/roster", "roster", async (page) => { await expect(page.locator("nav.staff-rail")).toBeVisible(); });
  const { drop } = await seedLinks(sql);
  try {
    const [rivera] = await sql`SELECT family_id FROM accounting_link WHERE customer_id = 'E2E-10' AND family_id IS NOT NULL`;
    await at(2560, `/staff/links?review=${rivera!.family_id}`, "links-review-docked", async (page) => { await expect(page.getByRole("dialog", { name: "Review Rivera Family" })).toBeVisible(); });
  } finally {
    await drop();
  }
  await at(2560, "/staff/settings/design-system?ds-dock=1", "drawer-docked", async (page) => { await expect(page.getByRole("dialog", { name: "Change the shift" })).toBeVisible(); });
});

test("Accounting links with a row's details open and two rows ticked, and a Review drawer, for the owner to look at", async ({ page }, info) => {
  const { drop } = await seedLinks(sql);
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    await families.getByRole("checkbox", { name: `Select ${LINKS.family}` }).check();
    await families.getByRole("checkbox", { name: `Select ${LINKS.other}` }).check();
    await families.getByRole("button", { name: new RegExp(`^Show details\\s*:\\s*${LINKS.family}$`) }).click();
    const panel = page.getByRole("region", { name: `Details: ${LINKS.family}` });
    await expect(panel.getByRole("region", { name: "In your books" })).toContainText(LINKS.booksPhone);
    await settle(page);
    await page.screenshot(shot("links-details-ticked", info.project.name));
    if (info.project.name === "desktop") {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await settle(page);
      await page.screenshot(shot("links-details-ticked-1280", info.project.name));
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await panel.getByRole("link", { name: `Review ${LINKS.family}` }).click();
    const review = page.getByRole("dialog", { name: `Review ${LINKS.family}` });
    await expect(review).toBeVisible();
    await review.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/screenshots/links-review-drawer-${info.project.name}.png` });
  } finally {
    await drop();
  }
});

/**
 * The row of an open Review drawer, marked current as a ticked row is (2026-11-28), as the person sees it: at 390 (the
 * drawer fills the phone's screen), at 1440 (the modal sheet over the table, the row under the scrim) and at 2560
 * (docked beside the table), in light and in dark, for the design review (.claude/agents/design-review.md).
 */
test("Accounting links' current row while a Review drawer is open, at 390, 1440 and 2560, light and dark, for the owner to look at", async ({ browser }, info) => {
  const widths = info.project.name === "phone" ? [390] : [1440, 2560];
  const { drop } = await seedLinks(sql);
  try {
    const [rivera] = await sql`SELECT family_id FROM accounting_link WHERE customer_id = 'E2E-10' AND family_id IS NOT NULL`;
    for (const width of widths) {
      for (const scheme of SCHEMES) {
        const context = await browser.newContext({ viewport: { width, height: width >= 2000 ? 1300 : 900 }, colorScheme: scheme, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
        await context.addCookies([staffSessionCookie()]);
        const page = await context.newPage();
        await page.goto(`/staff/links?review=${rivera!.family_id}`);
        await expect(page.getByRole("dialog", { name: "Review Rivera Family" })).toBeVisible();
        await expect(page.locator('tr[aria-current="true"]')).toHaveCount(1);
        await settle(page);
        await page.screenshot({ path: `test-results/screenshots/links-current-row-${scheme}-${width}.png` });
        await context.close();
      }
    }
  } finally {
    await drop();
  }
});

/**
 * Settings › Backups (in-app backups, PR 110), for the owner to look at before it merges: a few backups on the server
 * with off-site copies off, a row's Restore this backup asking first, the off-site set-up Drawer, and what a staff member
 * with the widest custom role gets (the page is Admin only: Admin.Backups.ReadWrite is both its see and its change, so
 * there is no read-only view, and they are refused). The backup service is stood in for by the rows it writes: a fresh
 * heartbeat, three backups of the running schema and the last good backup. All of it is taken away after.
 */
test("Settings › Backups, for the owner to look at", async ({ page, browser }, info) => {
  const stamps = ["20261127T030000Z", "20261126T030000Z", "20261125T030000Z"];
  const beat = () => sql`INSERT INTO setting (key, value) VALUES ('backup.agent', ${sql.json({ at: new Date().toISOString(), version: 1, freeBytes: 41 * 1024 ** 3, nextAt: "2026-11-28T09:00:00Z", schedule: "03:00", keep: 14, zone: "America/Chicago" })})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  const m = (await sql<{ m: string }[]>`SELECT max(created_at)::text AS m FROM drizzle.__drizzle_migrations`)[0]!.m;
  for (const [i, s] of stamps.entries()) {
    await sql`INSERT INTO backup_file (backup_at, portal_bytes, documenso_bytes, schema_at) VALUES (${s}, ${3_200_000 + i * 40_000}, ${11_500_000 + i * 90_000}, ${m}) ON CONFLICT (backup_at) DO NOTHING`;
  }
  await sql`INSERT INTO setting (key, value) VALUES ('backup.last_success', ${sql.json({ at: "2026-11-27T03:00:00Z", file: `booster-rocket-${stamps[0]}.dump`, bytes: 3_200_000, documenso: { file: `documenso-${stamps[0]}.dump`, bytes: 11_500_000 } })})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
  const wideId = "e2e-backups-wide";
  try {
    await beat();
    await page.goto("/staff/settings/backups");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Backups");
    await expect(page.getByRole("button", { name: "Back up now" })).toBeVisible();
    await settle(page);
    await page.screenshot(shot("backups-list", info.project.name));

    await page.getByRole("button", { name: /^Restore this backup/ }).first().click();
    const restore = page.getByRole("dialog", { name: "Restore this backup?" });
    await expect(restore).toContainText("is lost");
    await settle(page);
    await page.screenshot({ path: `test-results/screenshots/backups-restore-confirm-${info.project.name}.png` });
    await page.keyboard.press("Escape");

    await beat();
    await page.goto("/staff/settings/backups?offsite=1");
    const drawer = page.getByRole("dialog", { name: "Set up off-site copies" });
    await expect(drawer).toBeVisible();
    await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/screenshots/backups-offsite-drawer-${info.project.name}.png` });

    // A staff member whose role holds every permission a custom role can: the page is refused to them.
    const [roleRow] = await sql`INSERT INTO role (key, name) VALUES ('e2e-backups-wide', 'Everything a role can have') RETURNING id`;
    await sql`INSERT INTO role_rule (role_id, kind, pattern) VALUES (${roleRow!.id}, 'include', '*')`;
    const [staff] = await sql`INSERT INTO staff_user (email, name, status, auth_user_id) VALUES ('e2e-wide@example.org', 'Wren Wide', 'active', ${wideId}) RETURNING id`;
    await sql`INSERT INTO staff_auth_user (id, name, email, email_verified) VALUES (${wideId}, 'Wren Wide', 'e2e-wide@example.org', true)`;
    await sql`INSERT INTO role_assignment (role_id, staff_user_id) VALUES (${roleRow!.id}, ${staff!.id})`;
    await sql`INSERT INTO staff_auth_session (id, token, user_id, expires_at) VALUES (${wideId}, 'e2e-backups-wide-token', ${wideId}, now() + interval '1 hour')`;
    const context = await browser.newContext({ viewport: page.viewportSize() ?? undefined });
    const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update("e2e-backups-wide-token").digest("base64");
    await context.addCookies([{ ...staffSessionCookie(), value: encodeURIComponent(`e2e-backups-wide-token.${signature}`) }]);
    const wide = await context.newPage();
    await wide.goto("/staff/settings/backups");
    await settle(wide);
    await wide.screenshot(shot("backups-without-permission", info.project.name));
    await context.close();
  } finally {
    await sql`DELETE FROM staff_auth_session WHERE id = ${wideId}`;
    await sql`DELETE FROM role_assignment WHERE staff_user_id IN (SELECT id FROM staff_user WHERE auth_user_id = ${wideId})`;
    await sql`DELETE FROM staff_user WHERE auth_user_id = ${wideId}`;
    await sql`DELETE FROM staff_auth_user WHERE id = ${wideId}`;
    await sql`DELETE FROM role WHERE key = 'e2e-backups-wide'`;
    await sql`DELETE FROM backup_file WHERE backup_at IN ${sql(stamps)}`;
    await sql`DELETE FROM setting WHERE key IN ('backup.agent', 'backup.last_success')`;
  }
});
