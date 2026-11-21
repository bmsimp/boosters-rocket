import { test, expect, type Browser, type Page } from "@playwright/test";
import postgres from "postgres";
import { ENROLMENT_COPY as WORDS } from "../../src/lib/parents/enrolment-copy";
import { SIGNIN_SETTINGS_COPY as SETTINGS } from "../../src/lib/parents/signin-settings-copy";
import { appCodeAt } from "./authenticator-steps";
import { STRICT_PARENT, makeStrictParent, removeStrictParent, storeLevel } from "./strict-seed";

/**
 * Strict's enrolment in the browser (the sign-in release, slice SI-10a): with the club at Strict, a guardian with
 * neither a passkey nor an authenticator app signs in with her password and lands on /one-more-step, and a family page
 * asked for sends her back there; she sets an app up there (its code worked out from the key the page shows, as
 * tests/e2e/authenticator.spec.ts does), reads her ten backup codes, is asked to tick that she saved them, ticks it,
 * presses Continue and is home; and, as another guardian afresh, adds a passkey with Playwright's own authenticator (as
 * tests/e2e/passkeys.spec.ts installs it) and goes on the same way. Since slice SI-10b, on Sign-in settings at Strict,
 * the new backup codes she makes stay until she ticks that she saved them and presses Done. Strict is stored at the start and Standard put back
 * after; the guardian is the spec's own, never Zelda (tests/e2e/strict-seed.ts), and goes with everything she made.
 * What Playwright's own authenticator can't show (a real phone's passkey at /one-more-step, the installed app) is the
 * owner's check 44 (docs/runbooks/before-the-first-family.md). The Admin's switch to Strict is pressed by no browser
 * spec: it would sign out the seeded parents later specs use (tests/integration/parents-switches.test.ts proves it).
 */
const sql = postgres(process.env.DATABASE_URL!);

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await removeStrictParent(sql);
  await storeLevel(sql, "strict");
});
test.afterAll(async () => {
  await removeStrictParent(sql);
  await storeLevel(sql, "standard");
  await sql.end();
});
test.beforeEach(async () => { await makeStrictParent(sql); });

/** A fresh browser, at the address asked for, sent to sign in, and signed in there with the guardian's password alone. */
async function signInAt(browser: Browser, baseURL: string, address: string, o: { passkeys?: boolean } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL });
  if (o.passkeys) await context.credentials.install();
  const page = await context.newPage();
  await page.goto(address);
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel("Email").fill(STRICT_PARENT.email);
  await page.getByLabel("Password").fill(STRICT_PARENT.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  return { page, close: () => context.close() };
}

/** Under the backup codes: Continue unticked asks for the tick and goes nowhere; ticked, it goes on to `to`. */
async function confirmSavedAndGoOn(page: Page, to: string) {
  await expect(page.getByRole("list", { name: "Your backup codes" }).getByRole("listitem")).toHaveCount(10);
  const go = page.getByRole("button", { name: WORDS.continue });
  await expect(go).toHaveAttribute("aria-disabled", "true");
  // Pressed while it says it isn't ready (Playwright's click won't press an aria-disabled button): the form says why.
  await go.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(WORDS.tickFirst)).toBeVisible();
  await expect(page).toHaveURL(/\/one-more-step/);
  await page.getByLabel(WORDS.saved).check();
  await expect(go).not.toHaveAttribute("aria-disabled", "true");
  await go.click();
  await expect(page).toHaveURL(to);
}

test("at Strict a password with no second factor leads only to /one-more-step, and a family page asked for sends back there", async ({ browser, baseURL }) => {
  const { page, close } = await signInAt(browser, baseURL!, "/payments");
  try {
    await expect(page).toHaveURL(/\/one-more-step\?next=%2Fpayments$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(WORDS.title);
    await expect(page.getByText(WORDS.lede)).toBeVisible();
    for (const address of ["/season", "/family", "/"]) {
      await page.goto(address);
      await expect(page).toHaveURL(/\/one-more-step/);
    }
    await page.goto("/choose-family");
    await expect(page).toHaveURL(/\/one-more-step$/);
    // Nothing of a family or of her on the page.
    const html = await page.content();
    for (const words of ["Quetzalcoatl", STRICT_PARENT.email, STRICT_PARENT.name]) expect(html).not.toContain(words);
  } finally { await close(); }
});

test("she sets an authenticator app up there, ticks that she saved her backup codes, and Continue takes her to the page she asked for", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { page, close } = await signInAt(browser, baseURL!, "/payments");
  try {
    await expect(page).toHaveURL(/\/one-more-step\?next=%2Fpayments$/);
    const box = page.getByRole("region", { name: WORDS.appTitle });
    await box.getByRole("button", { name: WORDS.appSetUp, exact: true }).click();
    await expect(box.getByRole("img", { name: "QR code to scan with your authenticator app" })).toBeVisible();
    const key = ((await box.locator(".app-key").textContent()) ?? "").trim();
    expect(key).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
    await box.getByLabel("Code from your authenticator app", { exact: true }).fill(appCodeAt(key, await page.evaluate(() => Date.now())));
    await box.getByRole("button", { name: "Finish setting up" }).click();
    await expect(page.getByText(WORDS.doneApp)).toBeVisible();
    await confirmSavedAndGoOn(page, `${baseURL}/payments`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // Whole now: Home is hers, and asks nothing more.
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Hi, ${STRICT_PARENT.first}`);
    // Sign-in settings at Strict (slice SI-10b), within the 10 minutes her enrolment proved: new backup codes, shown
    // once, stay until she ticks that she saved them and presses Done; then they're gone, and the box says so.
    await page.goto("/family/sign-in");
    const settings = page.getByRole("region", { name: SETTINGS.appTitle, exact: true });
    await settings.getByRole("button", { name: SETTINGS.newCodes }).click();
    const codes = settings.getByRole("list", { name: SETTINGS.backupCodesTitle });
    await expect(codes.getByRole("listitem")).toHaveCount(10);
    const done = settings.getByRole("button", { name: SETTINGS.codesDone, exact: true });
    await expect(done).toHaveAttribute("aria-disabled", "true");
    // Pressed while it says it isn't ready (Playwright's click won't press an aria-disabled button): the box says why.
    await done.focus();
    await page.keyboard.press("Enter");
    await expect(settings.getByText(WORDS.tickFirst)).toBeVisible();
    await expect(done).toBeFocused();
    await expect(codes.getByRole("listitem")).toHaveCount(10);
    await settings.getByLabel(WORDS.saved).check();
    await expect(done).not.toHaveAttribute("aria-disabled", "true");
    await done.click();
    await expect(codes).toHaveCount(0);
    await expect(settings.getByText(SETTINGS.codesPutAway)).toBeVisible();
    await expect(page.locator(":focus")).toContainText(SETTINGS.codesPutAway);
  } finally { await close(); }
});

test("she adds a passkey there instead, and goes home the same way", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { page, close } = await signInAt(browser, baseURL!, "/", { passkeys: true });
  try {
    await expect(page).toHaveURL(/\/one-more-step$/);
    const paths: string[] = [];
    page.on("request", (r) => paths.push(new URL(r.url()).pathname));
    await page.getByRole("region", { name: WORDS.passkeyTitle }).getByRole("button", { name: WORDS.passkeyAdd }).click();
    await expect(page.getByText(WORDS.donePasskey)).toBeVisible();
    expect(paths).toContain("/api/auth/parent/portal-passkey/add");
    expect(paths).not.toContain("/api/auth/parent/passkey/verify-registration");
    await confirmSavedAndGoOn(page, `${baseURL}/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Hi, ${STRICT_PARENT.first}`);
  } finally { await close(); }
});
