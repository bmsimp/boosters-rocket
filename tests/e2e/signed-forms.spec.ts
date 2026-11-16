import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";
import { E2E_SIGNED_FORM, E2E_SIGNED_PDF } from "./signed-forms-seed";

// Signed forms as scripts/seed-e2e.ts leaves them: forms NOT set up, so nothing here can call a Documenso. The
// Quetzalcoatl family's Travel consent is signed and its evidence kept (made-up PDF bytes, E2E_SIGNED_PDF); Zelda's
// second family has one waiting for a guardian. Nothing here changes what the seed stored, so both passes find it the same.
const OTHER_FAMILYS_FORM = "e2e00000-0000-4000-8000-000000000002";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

test("staff open the matrix, filter it, open one signed form's evidence and download the sealed PDF", async ({ context, page }) => {
  await context.addCookies([staffSessionCookie()]);
  const res = await page.goto("/staff/forms");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/^Signed forms · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Signed forms");
  const forms = page.getByRole("region", { name: "Fall 2026: the forms" });
  await expect(forms).toContainText("Travel consent");
  const matrix = page.getByRole("region", { name: "Who has signed" }).locator("table.matrix");
  await expect(matrix.locator("thead th")).toContainText(["Family and students", "Travel consent"]);
  await expect(matrix).toContainText("Quetzalcoatl Family");
  await expect(matrix).toContainText("Signed");
  await expect(matrix).toContainText("Waiting for a guardian");
  await noSidewaysScroll(page);

  // Filter: one form, the signed ones.
  await page.getByLabel("Form", { exact: true }).selectOption({ label: "Travel consent" });
  await page.getByLabel("Where it stands").selectOption({ label: "Signed" });
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/\/staff\/forms\?form=[0-9a-f-]{36}&state=signed&q=$/);
  await expect(matrix.locator("thead th")).toHaveText(["Family and students", "Travel consent"]);
  await expect(matrix).not.toContainText("Waiting for a guardian");
  await expect(page.getByRole("link", { name: "Show everyone" })).toBeVisible();
  // Search by name.
  await page.goto("/staff/forms?q=quetzal");
  await expect(matrix.locator("tbody .matrix-family th > span")).toHaveText(["Quetzalcoatl Family"]);

  // The signed cell leads to the form's evidence.
  await matrix.getByRole("link", { name: /Signed: Travel consent for/ }).first().click();
  await expect(page).toHaveURL(/\/staff\/forms\/evidence\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Travel consent");
  await expect(page.getByRole("main")).toContainText("Zelda Quetzalcoatl");
  await expect(page.getByRole("main")).toContainText(`SHA-256 ${sha(E2E_SIGNED_PDF)}`);
  await noSidewaysScroll(page);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Signed form (sealed PDF)" }).click()]);
  expect(download.suggestedFilename()).toBe("signed-form.pdf");
  const bytes = await readFile((await download.path())!);
  expect(sha(bytes)).toBe(sha(E2E_SIGNED_PDF));
});

test("a parent downloads their own family's signed form, and nobody else's", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/forms");
  const family = page.getByRole("region", { name: "Your family" });
  const link = family.getByRole("link", { name: /Download/ });
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  expect(download.suggestedFilename()).toBe("signed-form.pdf");
  expect(sha(await readFile((await download.path())!))).toBe(sha(E2E_SIGNED_PDF));
  await noSidewaysScroll(page);

  // The signed form's page offers it too.
  await page.goto(`/forms/${E2E_SIGNED_FORM}`);
  await expect(page.getByRole("link", { name: "Download the signed form" })).toHaveAttribute("href", `/forms/${E2E_SIGNED_FORM}/signed`);

  // Another family's form, an id that is nobody's, and one that isn't an id: the same 404, never a PDF, never cached.
  const answers = [];
  for (const id of [OTHER_FAMILYS_FORM, "e2e00000-0000-4000-8000-00000000ffff", "not-an-id"]) {
    const r = await context.request.get(`/forms/${id}/signed`, { maxRedirects: 0 });
    answers.push([r.status(), r.headers()["content-type"], r.headers()["cache-control"], await r.text()]);
  }
  expect(answers).toEqual(Array(3).fill([404, "text/plain; charset=utf-8", "no-store", "Not found"]));
  const own = await context.request.get(`/forms/${E2E_SIGNED_FORM}/signed`);
  expect([own.status(), own.headers()["content-type"], own.headers()["cache-control"]]).toEqual([200, "application/pdf", "no-store"]);
});

test("a visitor who isn't signed in gets no PDF: they are sent to sign in and back", async ({ page }) => {
  await page.goto(`/forms/${E2E_SIGNED_FORM}/signed`);
  await expect(page).toHaveURL(new RegExp(`/sign-in\\?next=%2Fforms%2F${E2E_SIGNED_FORM}%2Fsigned$`));
});
