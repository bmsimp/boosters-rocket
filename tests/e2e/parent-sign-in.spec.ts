import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { E2E_SIGNIN, deviceTokenHash } from "./signin-seed";
import { removeZeldaDevicesMadeHere, removeZeldaSessionsMadeHere, resetPasskeyOffer, zeldaDeviceCookie } from "./signin-links";
import { passOffer } from "./journey-helpers";

/**
 * The parent door in the browser, as the sign-in release's slice SI-3b made it: the email and the password on one form,
 * then, on a browser the portal doesn't remember for the person, the 6-digit code it emails; on the one it remembers
 * (the seed's device for Zelda, tests/e2e/signin-seed.ts), the password alone. Every refusal at the password step is one
 * sentence and no mail. Each test clears the codes and counts first, and the sessions and devices its sign-ins made go
 * after (the seed's are kept), so both passes of the run read one seed.
 */
const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;
const PASSWORD_REJECTED = "That email and password didn't work. Check them and try again. If you haven't set up a password yet, or you've forgotten it, you can set up or reset it.";
const CODE_SENT = "To finish signing in on this device, enter the 6-digit code we've emailed you.";

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
test.afterEach(async () => { await removeZeldaSessionsMadeHere(sql); await removeZeldaDevicesMadeHere(sql); await resetPasskeyOffer(sql); });

// A code is mailed after the answer to the password (src/lib/parents/signin-codes.ts), so an earlier test's email can
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

/** A message's bodies as text, whatever transfer encoding the mailer chose for them (as password-request.spec.ts reads them). */
function bodiesOf(raw: string): string {
  const unfolded = raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const base64 = [...raw.matchAll(/\r?\n\r?\n([A-Za-z0-9+/=\r\n]{40,})/g)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ""), "base64").toString("utf8"));
  return [unfolded, ...base64].join("\n");
}

/** The password step, as a parent fills it in. */
async function typePassword(page: Page, email = "zelda@example.com", password: string = E2E_SIGNIN.password) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
/** The password and then the code it emails. */
async function signInByCode(page: Page) {
  await typePassword(page);
  await expect(page.getByRole("status")).toContainText(CODE_SENT);
  await page.getByLabel("6-digit code").fill(await codeFor("zelda@example.com"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
const zeldaDevices = async () => (await sql`SELECT d.token_hash, d.last_used_at FROM parent_device d JOIN parent p ON p.id = d.parent_id WHERE p.email = 'zelda@example.com'`);

test("a parent signs in with a password and an emailed code, switches family, and signs out", async ({ page, baseURL }) => {
  const since = new Date();
  await page.goto("/sign-in");
  await typePassword(page, " Zelda@Example.com ");
  await expect(page.getByRole("status")).toContainText(CODE_SENT);
  await expect(page.getByRole("button", { name: /Resend code/ })).toBeDisabled();
  const code = await codeFor("zelda@example.com");
  // The code's mail names one address: the page to set a new password, for a reader who didn't just sign in.
  expect(bodiesOf(sink.messages.filter((m) => m.to.includes("zelda@example.com")).at(-1)!.raw)).toContain("/sign-in/password");
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(page).toHaveURL(/\/choose-family$/);
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
  // A new browser that proved the code: Home offers a passkey (slice SI-8). Not now.
  await passOffer(page);

  await page.getByRole("link", { name: "Switch family" }).click();
  await page.getByRole("button", { name: "Second Family", exact: true }).click();
  await expect(page.getByText("Viewing Second Family.")).toBeVisible();

  await page.goto("/display");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);

  const actions = (await sql`SELECT action FROM audit_log WHERE door = 'parent' AND at >= ${since} ORDER BY id`).map((r) => r.action as string);
  expect(actions).toEqual(expect.arrayContaining(["signin.second_step_asked", "signin.code_sent", "signin.device_remembered", "signin", "signin.family_switch", "signout"]));
  const audited = JSON.stringify(await sql`SELECT * FROM audit_log WHERE at >= ${since}`);
  expect(audited).not.toContain(code);
  expect(audited).not.toContain(E2E_SIGNIN.password);
  // This browser is remembered now, beside the seed's device.
  expect(await zeldaDevices()).toHaveLength(2);
});

test("an unknown address and a wrong password get the same words, and no email", async ({ page }) => {
  await page.goto("/sign-in");
  for (const [email, password] of [["nobody@example.com", E2E_SIGNIN.password], ["zelda@example.com", "not the password, but long enough"]]) {
    await typePassword(page, email, password);
    await expect(page.getByRole("main").getByRole("alert")).toContainText(PASSWORD_REJECTED);
    await expect(page.getByRole("main").getByRole("alert").getByRole("link", { name: "Set up or reset my password" })).toHaveAttribute("href", "/sign-in/password");
    await expect(page.getByLabel("6-digit code")).toHaveCount(0);
  }
  await page.waitForTimeout(2000);
  expect(sink.messages).toHaveLength(0);
});

test("on the browser the portal remembers for her, the password alone signs her in, and the device is renewed", async ({ context, page, baseURL }) => {
  await context.addCookies([zeldaDeviceCookie(baseURL!)]);
  const [before] = (await zeldaDevices()).filter((d) => d.token_hash === deviceTokenHash(E2E_SIGNIN.zeldaDevice));
  await page.goto("/sign-in");
  await typePassword(page);
  await expect(page).toHaveURL(`${baseURL}/choose-family`);
  await page.waitForTimeout(1000);
  expect(sink.messages).toHaveLength(0);
  const [after] = (await zeldaDevices()).filter((d) => d.token_hash === deviceTokenHash(E2E_SIGNIN.zeldaDevice));
  expect((after!.last_used_at as Date).getTime()).toBeGreaterThanOrEqual((before!.last_used_at as Date).getTime());
  expect(await zeldaDevices()).toHaveLength(1);   // no new device: the one it used
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await page.goto("/display");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

// The code step is kept on the device under this key (src/app/sign-in/code-step.ts).
const CODE_STEP_KEY = "booster.signin.code-step";
const storedStep = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), CODE_STEP_KEY);

test("the code step survives a reload, keeps no address, and the parent lands on the page they asked for", async ({ page, baseURL }) => {
  await page.goto("/sign-in?next=%2Fdisplay");
  await typePassword(page);
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  const kept = (await storedStep(page))!;
  expect(JSON.parse(kept)).toMatchObject({ next: "/display" });
  expect(kept).not.toContain("zelda");

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
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

test("'Start again' forgets the code step, and so does the end of the code's 10 minutes", async ({ page }) => {
  await page.goto("/sign-in");
  await typePassword(page);
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveValue("");
  expect(await storedStep(page)).toBeNull();
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveCount(0);

  // A step whose code has run out is not picked up, and is removed.
  await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ sentAt: Date.now() - 10 * 60 * 1000, next: null })), CODE_STEP_KEY);
  await page.reload();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("6-digit code")).toHaveCount(0);
  await expect.poll(() => storedStep(page)).toBeNull();
});

test("on a shared device, a code step someone else left signs nobody in, and 'Start again' hands the next person nothing of it", async ({ page }) => {
  // Somebody got as far as the code on this device a minute ago, heading for Payments, and walked away. Their pending
  // step was the server's, in a cookie of their browser session; this one has none, so their code step signs nobody in.
  await page.goto("/sign-in");
  await page.evaluate((key) => window.localStorage.setItem(key, JSON.stringify({ sentAt: Date.now() - 60_000, next: "/payments" })), CODE_STEP_KEY);
  await page.reload();
  await expect(page.getByLabel("6-digit code")).toBeVisible(); // their code step, picked up for whoever opens the page
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("That code didn't work. Check the newest email from us and try again, or start again with your email and password.");
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.getByLabel("Email")).toHaveValue("");
  expect(await storedStep(page)).toBeNull();
  // The next person signs in from here: their step holds no page the other person asked for.
  await typePassword(page);
  await expect(page.getByLabel("6-digit code")).toBeVisible();
  expect(JSON.parse((await storedStep(page))!)).toMatchObject({ next: null });
  await page.getByRole("button", { name: "Start again" }).click();
  await expect(page.getByLabel("Email")).toHaveValue("");
});

test("a page to return to that is not a parent page of this site is dropped", async ({ page, baseURL }) => {
  for (const next of ["//evil.example/display", "/staff/roster"]) {
    sink.messages.length = 0;
    await sql`DELETE FROM signin_code`;
    await sql`DELETE FROM rate_limit_event`;
    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
    // The first round remembers this browser; the second then signs in by the password alone.
    if (next === "//evil.example/display") await signInByCode(page);
    else await typePassword(page);
    await expect(page).toHaveURL(`${baseURL}/choose-family`);
    await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
    await passOffer(page);
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
  await signInByCode(page);
  await expect(page).toHaveURL(`${baseURL}/choose-family?next=%2Fdisplay`);
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/display`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});
