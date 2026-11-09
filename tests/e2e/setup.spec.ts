import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { createSecretBox } from "../../src/lib/crypto/secret-box";

const sql = postgres(process.env.DATABASE_URL!);
const finishedState = { status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" };

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
  await sql.end();
});

function reopen(): string {
  const out = execFileSync("node", ["scripts/setup-code.mjs", "--reopen"], { encoding: "utf8", env: process.env });
  return /Setup code: (\S+)/.exec(out)![1]!;
}

test("while setup is open, every page goes to /setup, and a wrong code is refused", async ({ page }) => {
  reopen();
  for (const path of ["/", "/sign-in", "/staff", "/staff/roles"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/setup$/);
  }
  await page.getByLabel("Setup code").fill("AAAA-AAAA-AAAA");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("p[role=alert]")).toContainText("isn't right");
});

test("the right code unlocks the staff step with the redirect URI to copy", async ({ page }) => {
  const code = reopen();
  await page.goto("/setup");
  await page.getByLabel("Setup code").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Step 1: Staff sign-in" })).toBeVisible();
  await expect(page.getByLabel("Redirect URI").first()).toHaveValue("http://localhost:3100/api/auth/staff/callback/microsoft");
  expect(await page.content()).not.toContain("ci-fake");
});

test("a saved client secret is never rendered into the setup page", async ({ page }) => {
  const marker = "e2e-marker-secret-do-not-render";
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal(marker, "staff-microsoft");
  const config = { tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e", clientId: "11111111-2222-3333-4444-555555555555" };
  await sql`INSERT INTO auth_provider (key, config, secret_ciphertext, secret_key_id)
            VALUES ('staff-microsoft', ${sql.json(config)}, ${sealed.ciphertext}, ${sealed.keyId})
            ON CONFLICT (key) DO UPDATE SET config = EXCLUDED.config, secret_ciphertext = EXCLUDED.secret_ciphertext, secret_key_id = EXCLUDED.secret_key_id`;
  try {
    const code = reopen();
    await page.goto("/setup");
    await page.getByLabel("Setup code").fill(code);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("heading", { name: "Step 1: Staff sign-in" })).toBeVisible();
    // The saved row is on the page (so this check can fail), but its secret is not.
    await expect(page.getByText(/Secret saved/)).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(marker);
    expect(html).not.toContain(sealed.ciphertext);
  } finally {
    await sql`DELETE FROM auth_provider WHERE key = 'staff-microsoft'`;
  }
});
test("a failed staff sign-in shows its message even when Better Auth adds its own error param", async ({ page }) => {
  const code = reopen();
  await page.goto("/setup");
  await page.getByLabel("Setup code").fill(code);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Step 1: Staff sign-in" })).toBeVisible();
  await page.goto("/setup?step=admin");
  await page.getByLabel("Admin email").fill("admin@example.com");
  await page.getByRole("button", { name: "Save email" }).click();
  await page.goto("/setup?step=admin&signin=failed&error=access_denied");
  await expect(page.locator("p[role=alert]")).toContainText("didn't complete");
  await expect(page.getByRole("button", { name: "Sign out and try again" })).toBeVisible();
});

test("the health check and sign-in API stay reachable while setup is open", async ({ request }) => {
  reopen();
  expect((await request.get("/api/health")).status()).toBe(200);
  expect((await request.get("/api/auth/staff/ok")).status()).toBeLessThan(500);
});

test("after setup is finished, /setup is not found", async ({ page }) => {
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
  const res = await page.goto("/setup");
  expect(res?.status()).toBe(404);
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/sign-in$/);
});
