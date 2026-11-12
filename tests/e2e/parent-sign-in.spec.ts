import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";

const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  sink = await startMailSink({ secure: true, port: 2465, key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); await sql.end(); });
test.beforeEach(async () => {
  sink.messages.length = 0;
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
});

async function codeFor(email: string): Promise<string> {
  await expect.poll(() => sink.messages.filter((m) => m.to.includes(email)).length, { timeout: 15_000 }).toBeGreaterThan(0);
  const raw = sink.messages.filter((m) => m.to.includes(email)).at(-1)!.raw;
  return /^Subject: .*sign-in code: (\d{6})/m.exec(raw)![1]!;
}

test("a parent signs in with an emailed code, switches family, and signs out", async ({ page }) => {
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
  await expect(page).toHaveURL(/localhost:3100\/$/);
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
