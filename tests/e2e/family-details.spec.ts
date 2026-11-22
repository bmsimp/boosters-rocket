import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DETAILS } from "./details-seed";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";

const sql = postgres(process.env.DATABASE_URL!);

// The seeded session (scripts/seed-e2e.ts) is Zelda's, with the Quetzalcoatl family chosen. Her phone and mailing
// address are the portal's own (stage 3's slice 11a), on her person row (E2E_DETAILS): the page shows them in its form,
// and a save changes the portal alone, sending nothing to QuickBooks (tests/integration/contact-edits.test.ts proves
// that against a stub). The save here changes her details, so each test that saves puts the seeded ones back after
// it, and both passes of the run find the seed as it was.
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const mainNav = (page: Page) => page.locator(isPhone(page) ? "nav.tabs" : "nav.top-nav");
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
/** Her details as the seed stores them, and the version nobody has changed. */
const putBack = () => sql`UPDATE parent SET phone = ${E2E_DETAILS.phone}, address_line1 = ${E2E_DETAILS.line1}, address_line2 = null, address_city = ${E2E_DETAILS.city},
  address_region = ${E2E_DETAILS.region}, address_postal_code = ${E2E_DETAILS.postalCode}, address_country = null, contact_version = 0 WHERE email = 'zelda@example.com'`;
test.afterAll(async () => { await putBack(); await sql.end(); });

test("the seeded parent's QuickBooks record has an id that is never sent to Intuit", async () => {
  // Her row's own link (stage 3's slice 12b1: the record her sign-in came from), in the family whose customer the session names.
  const links = await sql`SELECT l.customer_id AS source_qbo_id FROM guardian g JOIN parent p ON p.id = g.parent_id
    JOIN accounting_link fl ON fl.family_id = g.family_id JOIN accounting_link l ON l.guardian_id = g.id
    WHERE p.email = 'zelda@example.com' AND fl.customer_id = ${PARENT_SESSION_FAMILY}`;
  expect(links).toHaveLength(1);
  // If this fails, don't change it: a numeric id here could send this run's requests to Intuit's real servers.
  expect(links[0]!.source_qbo_id).toBe("E2E-P1");
  expect(links[0]!.source_qbo_id).not.toMatch(/^\d+$/);
});

test("no seeded customer or customer type has an id that is digits, so no staff change in this run can reach Intuit", async () => {
  // A staff change to the roster names a customer, or for a new one its customer type and its family; each is refused
  // before anything is sent unless it is digits (isQboId in src/lib/quickbooks/client.ts). If this fails, don't change
  // it: give the seeded row an id that isn't a number (scripts/seed-e2e.ts), or this run's made-up tokens go to Intuit.
  const customers = await sql`SELECT qbo_id FROM qbo_customer`, types = await sql`SELECT qbo_id FROM qbo_customer_type`;
  expect(customers.length).toBeGreaterThan(10);
  expect(types.length).toBeGreaterThan(2);
  expect([...customers, ...types].map((r) => r.qbo_id as string).filter((id) => /^\d+$/.test(id))).toEqual([]);
  const [shape] = await sql`SELECT value FROM setting WHERE key = 'membership.shape'`;
  expect(Object.values(shape!.value as Record<string, unknown>).filter((v) => typeof v === "string" && /^\d+$/.test(v))).toEqual([]);
});

test("an anonymous visitor is sent to sign in, with this page to come back to", async ({ page }) => {
  await page.goto("/family/details");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Ffamily%2Fdetails$/);
});

test.describe("signed in", () => {
  test.beforeEach(async ({ context }) => { await context.addCookies([parentSessionCookie()]); });
  test.afterEach(async () => { await putBack(); });

  test("Update my details leads from Family to the edit page, whose form holds the portal's own details", async ({ page }) => {
    await page.goto("/family");
    const details = page.getByRole("region", { name: "Your details" });
    await expect(details).toContainText("You can change your phone, mailing address and sign-in email below. To change your name, ask the club.");
    await expect(details.locator("dd")).toHaveText(["Zelda Quetzalcoatl", E2E_DETAILS.phone]);
    const link = details.getByRole("link", { name: "Update my details" });
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await link.click();

    await expect(page).toHaveURL(/\/family\/details$/);
    await expect(page).toHaveTitle(/^Update your details · /);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Update your details");
    await expect(page.locator("main .lede")).toHaveText("These are the details the club uses to reach you.");
    // Nothing on the page speaks of the club's books.
    await expect(page.getByRole("main")).not.toContainText(/club's books|QuickBooks/);
    const who = page.getByRole("region", { name: "You", exact: true });
    await expect(who.locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com"]);
    // Her sign-in email is hers to change, though she is in two families (stage 3's slice 11d).
    await expect(who).toContainText("You can change your sign-in email below. To change your name, ask the club.");

    const edit = page.getByRole("region", { name: "Phone and mailing address" });
    await expect(edit.getByLabel("Phone")).toHaveValue(E2E_DETAILS.phone);
    await expect(edit.getByLabel("Address line 1")).toHaveValue(E2E_DETAILS.line1);
    await expect(edit.getByLabel("City")).toHaveValue(E2E_DETAILS.city);
    await expect(edit.getByLabel("State or region")).toHaveValue(E2E_DETAILS.region);
    await expect(edit.getByLabel("ZIP or postal code")).toHaveValue(E2E_DETAILS.postalCode);
    await expect(edit.getByRole("button", { name: "Save my details" })).toBeVisible();
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

  test("a change is saved in the portal, said in words, and shown on Family", async ({ page }) => {
    await page.goto("/family/details");
    const edit = page.getByRole("region", { name: "Phone and mailing address" });
    await edit.getByLabel("Phone").fill("505-555-0199");
    await edit.getByLabel("City").fill("Santa Fe");
    await edit.getByRole("button", { name: "Save my details" }).click();
    // The answer speaks of the portal only.
    const saved = edit.getByRole("status");
    await expect(saved).toHaveText("Done Saved. These are your details now.");
    await expect(edit.getByLabel("Phone")).toHaveValue("505-555-0199");
    const [row] = await sql`SELECT phone, address_city, contact_version FROM parent WHERE email = 'zelda@example.com'`;
    expect(row).toEqual({ phone: "505-555-0199", address_city: "Santa Fe", contact_version: 1 });
    await noSidewaysScroll(page);

    await page.goto("/family");
    await expect(page.getByRole("region", { name: "Your details" }).locator("dd")).toHaveText(["Zelda Quetzalcoatl", "505-555-0199"]);
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
