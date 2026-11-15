import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// The seeded session (scripts/seed-e2e.ts) is Zelda's, with the Quetzalcoatl family chosen, and her link names her own
// QuickBooks record, E2E-P1. The edit page reads that record from QuickBooks as it opens. This run's QuickBooks
// connection holds made-up tokens, so the page must never ask: it doesn't, because an id that isn't digits is never
// sent to QuickBooks (tests/integration/family-details-page.test.ts proves that against a stub, and covers the form
// and the save; tests/integration/contact-edits.test.ts covers the action). What a browser can check here is the way
// to the page, and the page when the club's books can't be reached. Nothing here changes anything, so both passes of
// the run find the seed as it was.
const CANT_REACH = "We can't reach the club's books right now, so your details can't be changed here just yet. Please try again in a little while.";
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const mainNav = (page: Page) => page.locator(isPhone(page) ? "nav.tabs" : "nav.top-nav");
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

test("the seeded parent's QuickBooks record has an id that is never sent to Intuit", async () => {
  const links = await sql`SELECT g.source_qbo_id FROM guardian g JOIN parent p ON p.id = g.parent_id WHERE p.email = 'zelda@example.com' AND g.family_qbo_id = ${PARENT_SESSION_FAMILY}`;
  expect(links).toHaveLength(1);
  // If this fails, don't change it: a numeric id here makes the edit page call Intuit's real servers from this run.
  expect(links[0]!.source_qbo_id).toBe("E2E-P1");
  expect(links[0]!.source_qbo_id).not.toMatch(/^\d+$/);
});

test("an anonymous visitor is sent to sign in, with this page to come back to", async ({ page }) => {
  await page.goto("/family/details");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ffamily%2Fdetails$/);
});

test.describe("signed in", () => {
  test.beforeEach(async ({ context }) => { await context.addCookies([parentSessionCookie()]); });

  test("Update my details leads from Family to the edit page, which says so kindly when the club's books can't be reached", async ({ page }) => {
    await page.goto("/family");
    const details = page.getByRole("region", { name: "Your details" });
    await expect(details).toContainText("You can change your phone and mailing address yourself.");
    const link = details.getByRole("link", { name: "Update my details" });
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await link.click();

    await expect(page).toHaveURL(/\/family\/details$/);
    await expect(page).toHaveTitle(/^Update your details · /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Update your details");
    await expect(page.locator("main .lede")).toHaveText("Your phone and mailing address, as the club's books have them. A change here goes straight to the club.");
    const who = page.getByRole("region", { name: "You", exact: true });
    await expect(who.locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com"]);
    await expect(who).toContainText("The club changes names and email addresses. Ask the club and they'll update them.");

    // QuickBooks is out of reach for this run: the page says so in words, and offers nothing to fill in.
    const edit = page.getByRole("region", { name: "Phone and mailing address" });
    await expect(edit.getByRole("status")).toHaveText(CANT_REACH);
    await expect(page.locator("main form, main input, main button")).toHaveCount(0);
    // The page belongs to Family: its tab stays marked, and nothing of her second family is here.
    await expect(mainNav(page).getByRole("link", { name: "Family", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("main")).not.toContainText(/Second Family|Wolfgang/);
    await noSidewaysScroll(page);

    const back = edit.getByRole("link", { name: "Back to Family" });
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await back.click();
    await expect(page).toHaveURL(/\/family$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
  });

  test("Home's details box leads there too", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("region", { name: "Your details" }).getByRole("link", { name: "Update my details" }).click();
    await expect(page).toHaveURL(/\/family\/details$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Update your details");
    await noSidewaysScroll(page);
  });

  test("neither the link nor the page sends the browser a QuickBooks id", async ({ page }) => {
    for (const path of ["/family", "/family/details"]) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(200);
      const sent = await res.text();
      expect(sent, path).toContain("Zelda");
      expect(sent, `${path} sent the id of her QuickBooks record`).not.toContain("E2E-P1");
    }
  });
});
