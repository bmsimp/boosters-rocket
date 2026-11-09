import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { createSecretBox } from "../../src/lib/crypto/secret-box";
import { generateCertificate } from "../../src/lib/auth/certificate-crypto";

const sql = postgres(process.env.DATABASE_URL!);
const finishedState = { status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" };

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
  await sql`DELETE FROM provider_certificate`;
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
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal(marker, "staff-google");
  const config = { clientId: "11111111-2222-3333-4444-555555555555.apps.googleusercontent.com" };
  await sql`INSERT INTO auth_provider (key, config, secret_ciphertext, secret_key_id)
            VALUES ('staff-google', ${sql.json(config)}, ${sealed.ciphertext}, ${sealed.keyId})
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
    await sql`DELETE FROM auth_provider WHERE key = 'staff-google'`;
  }
});
test("Microsoft sign-in uses a certificate: no secret field, and the same certificate on every download", async ({ page, request }) => {
  const code = reopen();
  await page.goto("/setup");
  await page.getByLabel("Setup code").fill(code);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Step 1: Staff sign-in" })).toBeVisible();
  const ms = page.getByRole("region", { name: "Staff sign-in with Microsoft" });
  await expect(ms.getByLabel(/Client secret/)).toHaveCount(0);
  await expect(ms.getByRole("link", { name: "Download certificate (.cer)" })).toBeVisible();
  const cookies = await page.context().cookies();
  const headers = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  const a = await (await request.get("/setup/certificates/booster-rocket-staff.cer", { headers })).body();
  const b = await (await request.get("/setup/certificates/booster-rocket-staff.cer", { headers })).body();
  expect(a.length).toBeGreaterThan(500);
  expect(Buffer.compare(a, b)).toBe(0);
  await page.reload();
  await expect(ms.getByText(/Thumbprint/)).toBeVisible();
  const google = page.getByRole("region", { name: "Staff sign-in with Google" });
  await expect(google.getByLabel(/Client secret/)).toBeVisible();
});

test("in a reopened setup, Replace certificate makes a new pending certificate beside the active one, and Discard drops it", async ({ page }) => {
  await sql`DELETE FROM provider_certificate`;
  const g = await generateCertificate("e2e active");
  const id = crypto.randomUUID();
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal(g.privateKeyPem, `certificate:${id}`);
  await sql`INSERT INTO provider_certificate (id, provider_key, status, certificate_pem, thumbprint_s256, thumbprint_sha1, not_after,
              private_key_ciphertext, private_key_key_id, activated_at)
            VALUES (${id}, 'staff-microsoft', 'active', ${g.certificatePem}, ${g.thumbprintS256}, ${g.thumbprintSha1}, ${g.notAfter},
              ${sealed.ciphertext}, ${sealed.keyId}, now())`;
  await sql`INSERT INTO auth_provider (key, config) VALUES ('staff-microsoft', ${sql.json({ tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e", clientId: "11111111-2222-3333-4444-555555555555" })})`;
  try {
    const code = reopen();
    await page.goto("/setup");
    await page.getByLabel("Setup code").fill(code);
    await page.getByRole("button", { name: "Unlock" }).click();
    const ms = page.getByRole("region", { name: "Staff sign-in with Microsoft" });
    await expect(ms.getByText(g.thumbprintSha1)).toBeVisible();
    await ms.getByRole("button", { name: "Replace certificate" }).click();
    await expect(ms.getByText(/Replacement ready to add/)).toBeVisible();
    const pending = await sql`SELECT thumbprint_sha1 FROM provider_certificate WHERE provider_key = 'staff-microsoft' AND status = 'pending'`;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.thumbprint_sha1).not.toBe(g.thumbprintSha1);
    await expect(ms.getByText(pending[0]!.thumbprint_sha1 as string)).toBeVisible();
    await expect(ms.getByRole("button", { name: "Replace certificate" })).toHaveCount(0);
    await expect(ms.getByRole("button", { name: "Check and switch" })).toBeVisible();
    page.once("dialog", (d) => d.accept());
    await ms.getByRole("button", { name: "Discard replacement" }).click();
    await expect(ms.getByRole("button", { name: "Replace certificate" })).toBeVisible();
    const left = await sql`SELECT status, private_key_ciphertext FROM provider_certificate WHERE provider_key = 'staff-microsoft' ORDER BY created_at`;
    expect(left.map((r) => r.status).sort()).toEqual(["active", "retired"]);
    expect(left.find((r) => r.status === "retired")!.private_key_ciphertext).toBeNull();
  } finally {
    await sql`DELETE FROM auth_provider WHERE key = 'staff-microsoft'`;
    await sql`DELETE FROM provider_certificate`;
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
