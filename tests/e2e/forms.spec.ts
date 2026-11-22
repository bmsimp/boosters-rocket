import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// Forms as scripts/seed-e2e.ts leaves them: NOT set up (no Documenso address or token is stored), so nothing in this
// run can call a Documenso, and every page shows what the portal has stored. The Quetzalcoatl family has a signed
// Travel consent; each of its students has a Medical release with no template yet; a Trailer towing agreement is
// asked of Zelda's second family alone. Nothing here changes what the seed stored, so both passes find it the same.
const OWN_FORM = "e2e00000-0000-4000-8000-000000000001", OTHER_FAMILYS_FORM = "e2e00000-0000-4000-8000-000000000002";
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

test("the browser run can't reach a Documenso: forms are not set up in the seed", async () => {
  expect(await sql`SELECT key FROM setting WHERE key IN ('forms', 'forms.status')`).toHaveLength(0);
});

test("a parent sees this season's forms for the family and each student, with each one's state in words", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto("/forms");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/^Forms · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Forms");
  await expect(page.locator("main p[role=status]")).toContainText("Some forms aren't ready to sign yet. You can sign them here once they are.");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Your family", "Xochitl Quetzalcoatl", "Yaretzi Quetzalcoatl"]);
  const family = page.getByRole("region", { name: "Your family" });
  await expect(family.locator(".list-row")).toHaveCount(1);
  await expect(family).toContainText("Travel consent (optional)");
  await expect(family.locator(".list-status")).toHaveText("Signed");
  for (const student of ["Xochitl Quetzalcoatl", "Yaretzi Quetzalcoatl"]) {
    const box = page.getByRole("region", { name: student });
    await expect(box).toContainText("Medical release (optional)");
    await expect(box.locator(".list-status")).toHaveText("Not ready yet");
    await expect(box.getByRole("link")).toHaveCount(0); // nothing behind it yet, so no way in
  }
  // Nothing of the form asked of another family alone.
  await expect(page.locator("body")).not.toContainText(/Trailer towing|Wilhelmina|Second Family/);
  await noSidewaysScroll(page);

  // The way to the signed form is big enough to tap, and its page says it is signed. No signing frame: it is finished.
  const open = family.getByRole("link", { name: /Open/ });
  expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/forms/${OWN_FORM}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Travel consent");
  await expect(page.getByRole("main")).toContainText("For your family, Quetzalcoatl Family · Join");
  await expect(page.getByRole("main")).toContainText("SignedThank you! There's nothing more to do for this form.");
  await expect(page.getByRole("main")).toContainText("Zelda Quetzalcoatl (you)Has signed");
  await expect(page.locator("iframe")).toHaveCount(0);
  await noSidewaysScroll(page);
  await page.getByRole("link", { name: "Back to Forms" }).click();
  await expect(page).toHaveURL(/\/forms$/);
});

test("another family's form, and an id that is nobody's, answer the same plain 404", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  for (const id of [OTHER_FAMILYS_FORM, "e2e00000-0000-4000-8000-00000000ffff", "not-an-id"]) {
    const res = await page.goto(`/forms/${id}`);
    expect(res?.status(), id).toBe(404);
    await expect(page.locator("body")).not.toContainText(/Second Family|Wilhelmina|Travel consent/);
  }
});

test("a visitor who isn't signed in is sent to sign in, and brought back to Forms", async ({ page }) => {
  await page.goto("/forms");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fforms$/);
  await page.goto(`/forms/${OWN_FORM}`);
  await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=%2Fforms%2F${OWN_FORM}$`));
});

test("the season's lines show a form's state in the same words", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/season");
  const join = page.getByRole("region", { name: "1. Join" });
  await expect(join).toContainText("Travel consent (optional)Signed");
  await expect(join).toContainText("Medical release (optional)Not ready yet");
  await expect(page.locator("body")).not.toContainText("Trailer towing");
});

test("an Admin finds Forms settings not set up, with the webhook address on the portal's own address", async ({ context, page, baseURL }) => {
  await context.addCookies([staffSessionCookie()]);
  const res = await page.goto("/staff/settings/forms");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Documenso");
  await expect(page.getByRole("region", { name: "Connection", exact: true })).toContainText("Forms aren't set up yet.");
  // The steps are on their own page, opened from the plain view.
  await page.getByRole("region", { name: "Set up", exact: true }).getByRole("link", { name: "Set up" }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/forms\/setup$/);
  await expect(page.getByLabel("Webhook URL")).toHaveValue(`${baseURL}/api/documenso/webhook`);
  // Checking a connection that isn't saved calls nothing and says what to do first.
  await page.getByRole("button", { name: "Check the connection" }).click();
  await expect(page.getByRole("region", { name: "2. Check the connection" }).getByRole("alert")).toContainText("Save Documenso's address and API token first.");
  await noSidewaysScroll(page);
  // The Health page says the same, and leads here.
  await page.goto("/staff/settings/health");
  const line = page.locator('li[data-health="forms"]');
  await expect(line).toContainText("Forms (Documenso)");
  await expect(line).toContainText("Not set up");
  await expect(line.getByRole("link", { name: "Open Forms settings" })).toHaveAttribute("href", "/staff/settings/forms");
});

test("the webhook address answers a bare 404 to anyone without the secret", async ({ request }) => {
  const res = await request.post("/api/documenso/webhook", { data: { event: "DOCUMENT_COMPLETED", payload: { externalId: OWN_FORM } }, headers: { "x-documenso-secret": "guess" } });
  expect(res.status()).toBe(404);
  expect(await res.text()).toBe('{"ok":false}');
  expect((await request.get("/api/documenso/webhook")).status()).toBe(404);
  const [row] = await sql`SELECT state FROM signature_request WHERE id = ${OWN_FORM}`;
  expect(row!.state).toBe("complete");
});

test("a staff member sees the form part of a form requirement, and that forms must be set up before a template is attached", async ({ context, page }) => {
  await context.addCookies([staffSessionCookie()]);
  await page.goto("/staff/seasons");
  await page.getByRole("link", { name: "Fall 2026" }).click();
  await page.getByRole("link", { name: "Medical release" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Medical release");
  const box = page.getByRole("region", { name: "The form to sign" });
  await expect(box).toContainText("No template is attached yet, so parents read that this form isn't ready.");
  await expect(box).toContainText("Forms aren't set up yet.");
  await expect(box.getByRole("link", { name: "Forms settings" })).toHaveAttribute("href", "/staff/settings/forms");
  await noSidewaysScroll(page);
});
