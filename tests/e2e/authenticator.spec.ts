import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { codeFor } from "./journey-helpers";
import { PARENT_SESSION_TOKEN, parentSessionCookie } from "./parent-session";
import { E2E_SIGNIN } from "./signin-seed";
import { APP_REJECTED, APP_STEP_OVER } from "../../src/lib/parents/signin-copy";
import { ZELDA_EMAIL, removeZeldaDevicesMadeHere, removeZeldaSessionsMadeHere } from "./signin-links";
import { clearZeldaCounts, keepZeldaProof, nextAppCode, removeZeldaSecondSteps, setUpAppOnPage } from "./authenticator-steps";

/**
 * An authenticator app through the server, in the browser (the sign-in release, slice SI-6b, and the journey SI-6a's
 * reviews asked for): Zelda shows it's her on /family/sign-in with her password and the code emailed to her, sets an
 * app up (the key the page shows is all the test knows, and it works the app's code out from it by RFC 6238 at the
 * page's own clock), reads her ten backup codes once, then signs in on a new browser with her password and the app's
 * code, and on another with a backup code typed as shown; last, she turns the app off through the page. Nothing of it
 * stays: her app, backup codes, the sessions and devices the sign-ins made, her emailed codes and her counts are
 * removed after (and before, for a run cut off midway), and the seeded session's proof is put back, so both passes,
 * phone then desktop, read one seed.
 */
const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;
let putProofBack: () => Promise<void> = async () => undefined;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const [seeded] = await sql`SELECT value FROM setting WHERE key = 'mail'`;
  expect((seeded?.value as { port?: number } | undefined)?.port, "the mail port in the seeded settings; seed again with this run's E2E_MAIL_PORT").toBe(e2eMailPort());
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
  await removeZeldaSecondSteps(sql);
  await clearZeldaCounts(sql);
  // A run cut off midway may have left the sessions and devices its sign-ins made: the seeded ones are kept.
  await removeZeldaSessionsMadeHere(sql);
  await removeZeldaDevicesMadeHere(sql);
  putProofBack = await keepZeldaProof(sql);
});
test.afterAll(async () => {
  await removeZeldaSecondSteps(sql);
  await removeZeldaSessionsMadeHere(sql);
  await removeZeldaDevicesMadeHere(sql);
  await clearZeldaCounts(sql);
  await putProofBack();
  await sink.close();
  await sql.end();
});

/** A browser with nothing of Zelda's (no session, no device cookie), at the sign-in page with her password typed and sent. */
async function newDevice(browser: Browser, baseURL: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ZELDA_EMAIL);
  await page.getByLabel("Password").fill(E2E_SIGNIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  // Asked for the app, never for an emailed code.
  await expect(page.getByRole("status")).toContainText("enter the 6-digit code from your authenticator app");
  return { page, close: () => context.close() };
}
/** The second step's one field and Confirm, then the family chooser to Home. */
async function finishTo(page: Page, code: string, baseURL: string) {
  await page.getByLabel("Code from your authenticator app, or a backup code").fill(code);
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/choose-family$/);
  await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
}

test("a parent sets an authenticator app up, signs in on new browsers with its code and with a backup code, and turns it off while a browser is at its step", async ({ browser, context, page, baseURL }) => {
  test.setTimeout(180_000);
  await sql`UPDATE parent_auth_session SET strong_at = NULL WHERE token = ${PARENT_SESSION_TOKEN}`;
  sink.messages.length = 0;
  await context.addCookies([parentSessionCookie()]);
  await page.goto("/family/sign-in");
  const box = page.getByRole("region", { name: "Authenticator app" });
  await expect(box).toContainText("An authenticator app on your phone");

  // Shown it's her first: her password, then the code emailed to her (she has no app yet).
  await box.getByLabel("Your password").fill(E2E_SIGNIN.password);
  await box.getByRole("button", { name: "Continue" }).click();
  await expect(box.getByRole("status")).toContainText("We've emailed you a 6-digit code.");
  await box.getByLabel("6-digit code").fill(await codeFor(sql, sink, ZELDA_EMAIL));
  await box.getByRole("button", { name: "Confirm" }).click();
  await expect(box.getByText("Thank you, that's you.")).toBeVisible();

  // The set-up: the QR code and the key, then the app's code; the ten backup codes, once.
  const app = await setUpAppOnPage(page, box);
  await expect(box.getByText("Your authenticator app is set up.").first()).toBeVisible();
  expect(new Set(app.codes).size).toBe(10);
  for (const c of app.codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  // Drawn again, the page holds neither the key nor a code: they were in the presses' answers alone.
  await page.reload();
  await expect(box.getByText("Your authenticator app is set up.")).toBeVisible();
  await expect(box.getByRole("list", { name: "Your backup codes" })).toHaveCount(0);
  const html = await page.content();
  for (const v of [app.key, app.key.replace(/ /g, ""), ...app.codes]) expect(html).not.toContain(v);
  const [row] = await sql`SELECT a.confirmed_at, a.last_used_step FROM parent_authenticator a JOIN parent p ON p.id = a.parent_id WHERE p.email = ${ZELDA_EMAIL}`;
  expect(row?.confirmed_at).not.toBeNull();

  // A new browser: the password, then the app's code for a step after the one the set-up took.
  const first = await newDevice(browser, baseURL!);
  try {
    await finishTo(first.page, await nextAppCode(first.page, app.key, app.at), baseURL!);
  } finally { await first.close(); }
  // Another new browser: a backup code, typed as shown, with its dash.
  const second = await newDevice(browser, baseURL!);
  try {
    await finishTo(second.page, app.codes[0]!, baseURL!);
  } finally { await second.close(); }
  const spent = await sql`SELECT used_at FROM parent_backup_code c JOIN parent p ON p.id = c.parent_id WHERE p.email = ${ZELDA_EMAIL} AND used_at IS NOT NULL`;
  expect(spent).toHaveLength(1);

  // Last, turned off through the page (the proof from the start is still within its 10 minutes), while a third new
  // browser is at the app's step (decision 10 of SI-6b): its code then ends the step, and it is back at the password.
  const third = await newDevice(browser, baseURL!);
  try {
    await page.reload();
    await expect(box.getByText("your backup codes stop working too")).toBeVisible();
    await box.getByRole("button", { name: "Turn off the authenticator app" }).click();
    await expect(box.getByRole("status").filter({ hasText: "Your authenticator app is turned off" })).toBeVisible();
    await expect(box.getByRole("button", { name: "Set up an authenticator app", exact: true })).toBeVisible();
    await third.page.getByLabel("Code from your authenticator app, or a backup code").fill(await nextAppCode(third.page, app.key, app.at));
    await third.page.getByRole("button", { name: "Confirm" }).click();
    await expect(third.page.getByRole("alert")).toContainText(`${APP_REJECTED} ${APP_STEP_OVER}`);
    await expect(third.page.getByLabel("Password")).toHaveValue("");
    await expect(third.page.getByLabel("Code from your authenticator app, or a backup code")).toHaveCount(0);
    await expect(third.page).toHaveURL(/\/sign-in/);
  } finally { await third.close(); }
  expect(await sql`SELECT id FROM parent_authenticator a WHERE a.parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`).toHaveLength(0);
  expect(await sql`SELECT id FROM parent_backup_code c WHERE c.parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`).toHaveLength(0);
  // No row of the audit log holds the key or a code.
  const audited = JSON.stringify(await sql`SELECT * FROM audit_log WHERE action LIKE 'parent.authenticator.%' OR action LIKE 'parent.backup_codes.%' OR action LIKE 'signin%'`);
  for (const v of [app.key.replace(/ /g, ""), ...app.codes, ...app.codes.map((c) => c.replace("-", ""))]) expect(audited).not.toContain(v);
});
