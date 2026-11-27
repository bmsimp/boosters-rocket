import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { LINKS, seedLinks } from "./links-seed";

/**
 * Accounting links (the redesign the owner approved on 2026-11-27), at each project's width (390 and 1440), with axe:
 * the compact list, Show details opening and closing its row in place (aria-expanded, the comparison loaded for that
 * family and audited), the family's Review drawer by its own address, the Pick drawer, and Unlink from the books
 * asking first. On data tests/e2e/links-seed.ts adds and takes away; no press that changes anything is made.
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
async function checked(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(["color-contrast"]).analyze();
  expect(results.violations.flatMap((v) => v.nodes.map((n) => `${where} · ${n.target.join(" ")}: ${v.id} (${v.help})`))).toEqual([]);
}
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
/** A button's name: its words, then whom it is about, read from visually hidden text (a screen reader may put a space before the colon). */
const about = (words: string, who: string) => new RegExp(`^${words}\\s*:\\s*${who}$`);
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));

test("the list, Show details, the Review and Pick drawers, and Unlink asking first", async ({ page }, info) => {
  const { drop } = await seedLinks(sql);
  try {
    await page.goto("/staff/links");
    await expect(page.getByText("Connected to QuickBooks")).toBeVisible();
    const families = page.getByRole("region", { name: "Families" });
    const row = families.getByRole("row").filter({ hasText: LINKS.family }).first();
    await expect(row).toContainText(`${LINKS.linkName}Suggested by email`);
    await expect(row.getByRole("button", { name: about("Confirm link", LINKS.family) })).toBeVisible();
    // The list carries no phone: Show details asks for it.
    expect(await page.content()).not.toContain(LINKS.phone);
    await checked(page, "the list");
    await noSidewaysScroll(page);
    if (info.project.name === "desktop") {
      // Every row keeps Show details and its main press side by side, Settle N differences the longest, beside the rail too.
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        const offLine = await families.locator(".links-acts-cell").evaluateAll((cells) => cells.filter((c) => {
          const tops = [...c.querySelectorAll(":scope > .btn")].map((b) => Math.round(b.getBoundingClientRect().top));
          return new Set(tops).size > 1;
        }).length);
        expect(offLine, `rows whose buttons wrap at ${width}`).toBe(0);
        await noSidewaysScroll(page);
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }

    // Show details opens the row in place, loads that family's comparison, and writes one audit row for it.
    const before = (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'accounting.link.details.read'`)[0]!.n as number;
    const toggle = row.getByRole("button", { name: about("Show details", LINKS.family) });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    const hide = families.getByRole("button", { name: about("Hide details", LINKS.family) });
    await expect(hide).toHaveAttribute("aria-expanded", "true");
    const panel = page.getByRole("region", { name: `Details: ${LINKS.family}` });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("region", { name: "In the portal" })).toContainText(LINKS.phone);
    await expect(panel.getByRole("region", { name: "In your books" })).toContainText(LINKS.booksPhone);
    await expect(panel).toContainText("Matched");
    await expect(panel).toContainText("Differs");
    expect(await hide.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
    expect((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'accounting.link.details.read'`)[0]!.n).toBe(before + 1);
    await checked(page, "Show details open");
    await noSidewaysScroll(page);

    // Review opens the family's drawer by its own address; Esc closes it and takes the address back.
    await panel.getByRole("link", { name: `Review ${LINKS.family}` }).click();
    const review = page.getByRole("dialog", { name: `Review ${LINKS.family}` });
    await expect(review).toBeVisible();
    await expect(page).toHaveURL(/[?&]review=/);
    await expect(review.getByRole("button", { name: about("Confirm link", LINKS.family) })).toBeVisible();
    await expect(review).toContainText("Its guardians will see Bulkley Family's invoices, so check it's the right household.");
    await expect(review.getByRole("button", { name: about("Leave unlinked", LINKS.family) })).toBeVisible();
    await settled(page);
    await checked(page, "the Review drawer");
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]review=/);

    // Hide details closes the row again.
    await hide.click();
    await expect(families.getByRole("button", { name: about("Show details", LINKS.family) })).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toBeHidden();

    // Pick a customer is its own drawer, by its own address.
    await families.getByRole("row").filter({ hasText: LINKS.nomatch }).first().getByRole("link", { name: about("Pick a customer", LINKS.nomatch) }).click();
    const pick = page.getByRole("dialog", { name: `Pick a customer for ${LINKS.nomatch}` });
    await expect(pick).toBeVisible();
    await expect(page).toHaveURL(/[?&]pick=/);
    await expect(pick.getByRole("searchbox", { name: "Customer name or email address" })).toBeVisible();
    await settled(page);
    await checked(page, "the Pick drawer");
    await page.keyboard.press("Escape");
    await expect(pick).toBeHidden();

    // Unlink from the books asks first, in a ConfirmDialog, from a linked family's Review drawer; Cancel changes nothing.
    const [rivera] = await sql`SELECT family_id FROM accounting_link WHERE customer_id = 'E2E-10' AND family_id IS NOT NULL`;
    await page.goto(`/staff/links?review=${rivera!.family_id}`);
    const riveraReview = page.getByRole("dialog", { name: "Review Rivera Family" });
    await expect(riveraReview).toBeVisible();
    await riveraReview.getByRole("button", { name: about("Unlink from the books", "Rivera Family") }).click();
    const confirm = page.getByRole("dialog", { name: "Unlink Rivera Family from the books?" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(confirm).toContainText("Its guardians see no invoices until it's linked again.");
    await settled(page);
    await checked(page, "Unlink asking first");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    expect(await sql`SELECT 1 FROM accounting_link WHERE customer_id = 'E2E-10' AND family_id IS NOT NULL`).toHaveLength(1);
  } finally {
    await drop();
  }
});

test("from 1600px the Review and Pick drawers dock beside the table at their own address; with none chosen the table takes the width", async ({ browser }, info) => {
  test.skip(info.project.name === "phone", "a phone never docks");
  const { drop } = await seedLinks(sql);
  const context = await browser.newContext({ viewport: { width: 2560, height: 1300 } });
  await context.addCookies([staffSessionCookie()]);
  const page = await context.newPage();
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    const wide = await families.evaluate((el) => el.getBoundingClientRect().right);
    const [rivera] = await sql`SELECT family_id FROM accounting_link WHERE customer_id = 'E2E-10' AND family_id IS NOT NULL`;
    await page.goto(`/staff/links?review=${rivera!.family_id}`);
    const review = page.getByRole("dialog", { name: "Review Rivera Family" });
    await expect(review).toBeVisible();
    expect(await review.evaluate((el) => el.matches(":modal")), "docked, not modal").toBe(false);
    await expect(page.locator("html")).not.toHaveClass(/sheet-open/);
    const box = (await review.boundingBox())!;
    const right = await families.evaluate((el) => el.getBoundingClientRect().right);
    expect(right, "the table makes room beside the pane").toBeLessThanOrEqual(box.x);
    expect(right, "and is narrower than with nothing chosen").toBeLessThan(wide);
    await noSidewaysScroll(page);
    await settled(page);
    await checked(page, "the Review drawer, docked");
    await review.getByRole("link", { name: "Close" }).click();
    await expect(review).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]review=/);
    expect(await families.evaluate((el) => el.getBoundingClientRect().right), "the table takes the width again").toBeCloseTo(wide, 0);
  } finally {
    await context.close();
    await drop();
  }
});
