import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// What scripts/seed-e2e.ts stores: the Quetzalcoatl family owes $185.00 (QZ-1042 and QZ-1041) and paid QZ-1017, which
// carries the band fee; the second family owes $376.66, and the worker's last check found its student owing $50.00
// more in QuickBooks than his open invoices. Families 10, 40 and 50 have nothing read yet. The worker isn't running in
// the browser run, so a read of every family asked for here is never started: the test takes the ask back afterwards,
// and both passes (phone, then desktop) find the page as the seed left it.
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
const takeBackTheAsk = () => sql`DELETE FROM setting WHERE key = 'money.run'`;

test.describe("staff", () => {
  test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); await takeBackTheAsk(); });
  test.afterEach(takeBackTheAsk);

  test("the Balances page lists every family with what it owes, and the families worth a look", async ({ page }) => {
    const res = await page.goto("/staff/balances");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Balances");
    const families = page.getByRole("region", { name: "Families" });
    const quetzalcoatl = families.locator("tbody tr").filter({ hasText: "Quetzalcoatl Family" });
    await expect(quetzalcoatl.locator(".amount")).toHaveText("$185.00");
    await expect(quetzalcoatl).toContainText("2 open invoices, oldest due ");
    await expect(quetzalcoatl.locator("time").last()).not.toContainText("UTC"); // the viewer's own time once the page is live
    await expect(families.locator("tbody tr").filter({ hasText: "Second Family" }).locator(".amount")).toHaveText("$376.66");
    await expect(families.locator("tbody tr").filter({ hasText: "Rivera Family" })).toContainText("Not read from QuickBooks yet");
    // QuickBooks text is text: a family named with markup shows its name, and runs nothing.
    await expect(families.getByText("<img src=x onerror=alert(1)> Family")).toBeVisible();

    const look = page.getByRole("region", { name: "Worth a look" });
    await expect(look).toContainText("Second Family");
    const wolfgang = look.getByRole("row").filter({ hasText: "Wolfgang Secondborn" }); // QuickBooks' balance beside what the open invoices add up to
    await expect(wolfgang.getByRole("cell")).toContainText(["Wolfgang Secondborn", "$362.47", "$312.47"]);
    await expect(look).not.toContainText("Quetzalcoatl");
    await noSidewaysScroll(page);
  });

  test("filters to the families that owe, finds one by a student's name, and opens its invoices", async ({ page }) => {
    await page.goto("/staff/balances");
    const families = page.getByRole("region", { name: "Families" });
    await families.getByLabel("Only families that owe something").check();
    await families.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/owing=1/);
    await expect(families.locator("tbody tr")).toHaveCount(2);
    await expect(families).not.toContainText("Rivera Family");

    await families.getByLabel("Find a family or a student").fill("xochitl");
    await families.getByLabel("Only families that owe something").uncheck();
    await families.getByRole("button", { name: "Show" }).click();
    await expect(families.locator("tbody tr")).toHaveCount(1);
    await families.getByRole("link", { name: "Quetzalcoatl Family" }).click();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    const owed = page.getByRole("region", { name: "Owed now" });
    await expect(owed.locator(".amt")).toHaveText("$185.00");
    await expect(owed.locator(".list-row")).toHaveCount(2);
    await expect(owed).toContainText("Invoice QZ-1041, Xochitl Quetzalcoatl");
    await expect(page.getByRole("region", { name: "Paid in the last 12 months" })).toContainText("Invoice QZ-1017");
    await noSidewaysScroll(page);
    // Opening one family's money is recorded, as every staff read of a family is, naming the app's family record.
    const [read] = await sql`SELECT action, target_type, target_id FROM audit_log WHERE action = 'money.family.read' ORDER BY id DESC LIMIT 1`;
    const [record] = await sql`SELECT family_id::text AS id FROM accounting_link
      WHERE customer_id = 'E2E-FAMILY' AND family_id IS NOT NULL
        AND realm_id = (SELECT value->>'realmId' FROM setting WHERE key = 'roster.source')`;
    expect(record?.id).toBeTruthy();
    expect(read).toMatchObject({ action: "money.family.read", target_type: "family", target_id: record!.id });
  });

  test("asks the worker to read every family, and says so", async ({ page }) => {
    await page.goto("/staff/balances");
    const run = page.getByRole("region", { name: "Reading from QuickBooks" });
    await run.getByRole("button", { name: "Read every family now" }).click();
    // The page is drawn again with the ask in it: the button gives way to the words.
    await expect(run).toContainText("A read of every family is asked for.");
    await expect(run.getByRole("button", { name: "Read every family now" })).toHaveCount(0);
  });
});

test("a parent sees a payment requirement as Paid once the invoice carrying it is paid", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/season");
  const wrapUp = page.getByRole("region", { name: "4. Wrap-up" });
  await expect(wrapUp.locator(".reqs li").filter({ hasText: "Band fee" })).toContainText("Paid");
  await expect(wrapUp.locator(".reqs li").filter({ hasText: "Band fee" })).not.toContainText("Not paid");
});
