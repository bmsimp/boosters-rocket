import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";

const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  // The app sends to the port scripts/seed-e2e.ts wrote into the mail settings: seed and run with the same E2E_MAIL_PORT.
  const [seeded] = await sql`SELECT value FROM setting WHERE key = 'mail'`;
  expect((seeded?.value as { port?: number } | undefined)?.port, "the mail port in the seeded settings; seed again with this run's E2E_MAIL_PORT").toBe(e2eMailPort());
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); await sql.end(); });
test.beforeEach(async () => {
  sink.messages.length = 0;
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
});

// A code is mailed after the answer to "Send code" (src/lib/parents/signin-codes.ts), so an earlier test's email can
// reach the sink after this test emptied it. The code to use is the newest one the database still holds unused, found
// the way the portal stores it (hashSigninCode(): an HMAC keyed with the server secret).
const codeHash = (parentId: string, code: string) => createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`signin-code:${parentId}:${code}`).digest("hex");
async function codeFor(email: string): Promise<string> {
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

test("a parent signs in with an emailed code, switches family, and signs out", async ({ page, baseURL }) => {
  const since = new Date();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(" Zelda@Example.com ");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email belongs to a family in the club, we've sent a 6-digit code.");
  await expect(page.getByRole("button", { name: /Resend code/ })).toBeDisabled();
  const code = await codeFor("zelda@example.com");
  expect(sink.messages.at(-1)!.raw).not.toMatch(/https?:\/\//);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/choose-family$/);
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();

  await page.getByRole("link", { name: "Switch family" }).click();
  await page.getByRole("button", { name: "Second Family", exact: true }).click();
  await expect(page.getByText("Viewing Second Family.")).toBeVisible();

  await page.goto("/display");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);

  const actions = (await sql`SELECT action FROM audit_log WHERE door = 'parent' AND at >= ${since} ORDER BY id`).map((r) => r.action as string);
  expect(actions).toEqual(expect.arrayContaining(["signin.code_sent", "signin", "signin.family_switch", "signout"]));
  expect(JSON.stringify(await sql`SELECT * FROM audit_log WHERE at >= ${since}`)).not.toContain(code);
});

test("an unknown address gets the same answer and no email", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email belongs to a family in the club, we've sent a 6-digit code.");
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("p[role=alert]")).toHaveText("That code didn't work. Check the newest email from us, or request a new code.");
  await page.waitForTimeout(2000);
  expect(sink.messages).toHaveLength(0);
});

// The code step is kept on the device under this key (src/app/sign-in/code-step.ts).
const CODE_STEP_KEY = "booster.signin.code-step";
const storedStep = (page: import("@playwright/test").Page) => page.evaluate((key) => window.localStorage.getItem(key), CODE_STEP_KEY);

test("the code step survives a reload, and the parent lands on the page they asked for", async ({ page, baseURL }) => {
  await page.goto("/sign-in?next=%2Fdisplay");
  await page.getByLabel("Email").fill("zelda@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  expect(JSON.parse((await storedStep(page))!)).toMatchObject({ email: "zelda@example.com", next: "/display" });

  // The parent goes to their mail and the phone reloads the app: the same page first, then the app's start address.
  await page.reload();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Resend code \(\d+ s\)/ })).toBeDisabled();
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  expect(sink.messages.filter((m) => m.to.includes("zelda@example.com"))).toHaveLength(1); // nothing was asked for again

  await page.getByLabel("6-digit code").fill(await codeFor("zelda@example.com"));
  await page.getByRole("button", { name: "Sign in" }).click();
  // Two families: the chooser comes first and carries the page with it.
  await expect(page).toHaveURL(`${baseURL}/choose-family?next=%2Fdisplay`);
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/display`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Display");
  expect(await storedStep(page)).toBeNull();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel("Email")).toBeVisible();   // signed out, and nothing left to pick up
});

test("'Use a different email' forgets the code step, and so does the end of the code's 10 minutes", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("zelda@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(await storedStep(page)).toBeNull();
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveCount(0);

  // A step whose code has run out is not picked up, and is removed.
  await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ email: "zelda@example.com", sentAt: Date.now() - 10 * 60 * 1000, next: null })), CODE_STEP_KEY);
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveCount(0);
  await expect.poll(() => storedStep(page)).toBeNull();
});

test("on a shared device, 'Use a different email' hands the next person nothing of the last one: no address, no page to return to", async ({ page }) => {
  // Somebody asked for a code on this device a minute ago, heading for Payments, and walked away.
  await page.goto("/sign-in");
  await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ email: "someone.else@example.com", sentAt: Date.now() - 60_000, next: "/payments" })), CODE_STEP_KEY);
  await page.reload();
  await expect(page.getByLabel("6-digit code")).toBeVisible(); // their code step, picked up for whoever opens the page
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email")).toHaveValue("");
  expect(await storedStep(page)).toBeNull();
  // The next person signs in from here: their step holds their own address, and no page the other person asked for.
  await page.getByLabel("Email").fill("zelda@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  expect(JSON.parse((await storedStep(page))!)).toMatchObject({ email: "zelda@example.com", next: null });
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email")).toHaveValue("");
});

test("a page to return to that is not a parent page of this site is dropped", async ({ page, baseURL }) => {
  for (const next of ["//evil.example/display", "/staff/roster"]) {
    sink.messages.length = 0;
    await sql`DELETE FROM signin_code`;
    await sql`DELETE FROM rate_limit_event`;
    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
    await page.getByLabel("Email").fill("zelda@example.com");
    await page.getByRole("button", { name: "Send code" }).click();
    await page.getByLabel("6-digit code").fill(await codeFor("zelda@example.com"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${baseURL}/choose-family`);
    await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await page.goto("/display");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
  }
});

// Each parent page passes its own address to its guard (requireParentPage("/display") in src/lib/guards.ts), and the
// parent layout redirects nobody (parentLayoutCtx()): its redirect would come first and could not name the page.
test("a visitor who asks for a parent page signs in and is brought back to it", async ({ page, baseURL }) => {
  await page.goto("/display");
  await expect(page).toHaveURL(`${baseURL}/sign-in?next=%2Fdisplay`);
  await page.getByLabel("Email").fill("zelda@example.com");
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("6-digit code").fill(await codeFor("zelda@example.com"));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${baseURL}/choose-family?next=%2Fdisplay`);
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/display`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
