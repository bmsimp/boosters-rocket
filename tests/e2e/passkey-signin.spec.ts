import { test, expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import postgres from "postgres";
import { makePasskeyKey } from "../helpers/passkey-keys";
import { E2E_SIGNIN } from "./signin-seed";
import { ZELDA_EMAIL, removeZeldaDevicesMadeHere, removeZeldaSessionsMadeHere } from "./signin-links";
import { clearZeldaCounts } from "./authenticator-steps";
import { PASSKEY_ASKED, PASSKEY_BUTTON, PASSKEY_ONLY, PASSKEY_USE } from "../../src/lib/parents/signin-copy";

/**
 * A passkey at the door, in the browser (the sign-in release, slice SI-7a): Zelda signs in with "Sign in with a
 * passkey" on a browser that has nothing of hers, typing no address, and on another her password asks for the passkey,
 * which finishes the sign-in. The browser's authenticator is Playwright's own (`context.credentials`: a script it
 * injects that answers navigator.credentials.get(), no DevTools protocol, so it runs in both projects, phone and
 * desktop, each drawn at its own project's size: the context made by hand takes the test's option fixtures), holding
 * a key this spec made by the software authenticator's keys (tests/helpers/passkey-keys.ts), whose
 * public key it stores in a passkey row of Zelda's as the passkey library stores one. The page runs the library's own
 * ceremony, and the spec watches its one verify request reach the portal's check, never the library's verify path.
 * Nothing of it stays: the passkey row, the sessions and devices its sign-ins made and Zelda's counts are removed
 * before (for a run cut off midway) and after, so both passes read one seed; Zelda's seeded password, device and session
 * are never touched.
 *
 * What this cannot prove, which real devices must (SI-7b puts each on the owner's list): a real authenticator (a
 * phone's Face ID or fingerprint, Windows Hello, a Mac's Touch ID), a password manager's passkey (Bitwarden), a
 * passkey synced between devices, a phone's passkey used on a computer by its QR code, a security key, the installed
 * app, Safari and Firefox (both projects are Chromium), and the browser's own passkey suggestions on the email field
 * and its account picker, which Playwright's authenticator doesn't answer.
 */
const sql = postgres(process.env.DATABASE_URL!);
const key = makePasskeyKey();

const ZELDA_USER = () => sql`(SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL}))`;
/** Removes every passkey of Zelda's: the seed gives her none. */
async function removeZeldaPasskeys() {
  await sql`DELETE FROM parent_auth_passkey WHERE user_id = ${ZELDA_USER()}`;
}
async function cleanUp() {
  await removeZeldaPasskeys();
  await removeZeldaSessionsMadeHere(sql);
  await removeZeldaDevicesMadeHere(sql);
  await clearZeldaCounts(sql);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await cleanUp();
  // Zelda's passkey, as the library stores one: the COSE public key, standard base64, and the base64url credential id.
  await sql`INSERT INTO parent_auth_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, created_at)
    VALUES (gen_random_uuid()::text, NULL, ${key.publicKey}, ${ZELDA_USER()}, ${key.id}, 0, 'multiDevice', true, 'internal,hybrid', now() - interval '1 hour')`;
});
test.afterAll(async () => {
  await cleanUp();
  await sql.end();
});

/** The counter the portal last saw for Zelda's passkey, so a new browser's authenticator goes on from it. */
const counterNow = async () => Number((await sql`SELECT counter FROM parent_auth_passkey WHERE credential_id = ${key.id}`)[0]?.counter ?? 0);

/**
 * What the project sets for a browser context (playwright.config.ts: the phone's or the desktop's viewport), which a
 * context made by hand from the `browser` fixture doesn't get by itself: the test passes its own option fixtures.
 */
type ProjectContext = Pick<BrowserContextOptions, "baseURL" | "viewport" | "isMobile" | "hasTouch" | "deviceScaleFactor" | "userAgent" | "locale" | "colorScheme">;

/**
 * A browser with nothing of Zelda's but her passkey in its authenticator, installed before the page first touches
 * navigator.credentials, at the sign-in page, drawn at the project's size; and every request path it makes.
 */
async function browserWithPasskey(browser: Browser, project: ProjectContext): Promise<{ page: Page; paths: string[]; close: () => Promise<void> }> {
  const baseURL = project.baseURL!;
  const context = await browser.newContext(project);
  await context.credentials.install();
  await context.credentials.create(new URL(baseURL).hostname, { id: key.id, privateKey: key.pkcs8, publicKey: key.spki, userHandle: key.userHandle, signCount: await counterNow() });
  const page = await context.newPage();
  const paths: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  await page.goto("/sign-in");
  return { page, paths, close: () => context.close() };
}

/** The passkey's verify request reached the portal's check, and never the library's own verify path. */
function wentToThePortal(paths: string[]) {
  expect(paths).toContain("/api/auth/parent/passkey/generate-authenticate-options");
  expect(paths).toContain("/api/auth/parent/portal-passkey/check");
  expect(paths).not.toContain("/api/auth/parent/passkey/verify-authentication");
}

test("Sign in with a passkey signs Zelda in on a new browser with no address typed", async ({ browser, baseURL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, locale, colorScheme }, testInfo) => {
  const { page, paths, close } = await browserWithPasskey(browser, { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, locale, colorScheme });
  // The project's own size: the phone pass is drawn at the phone's width.
  expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
  await expect(page.getByLabel("Email")).toHaveValue("");
  await page.getByRole("button", { name: PASSKEY_BUTTON }).click();
  // Two families: the chooser, as after any sign-in.
  await expect(page).toHaveURL(/\/choose-family$/);
  wentToThePortal(paths);
  expect(await counterNow()).toBeGreaterThan(0);
  await close();
});

test("her password on a new browser asks for the passkey, never an emailed code, and the passkey finishes it", async ({ browser, baseURL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, locale, colorScheme }, testInfo) => {
  const { page, paths, close } = await browserWithPasskey(browser, { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor, userAgent, locale, colorScheme });
  expect(page.viewportSize()).toEqual(testInfo.project.use.viewport);
  await page.getByLabel("Email").fill(ZELDA_EMAIL);
  await page.getByLabel("Password").fill(E2E_SIGNIN.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(`${PASSKEY_ASKED} ${PASSKEY_ONLY}`);
  await expect(page.getByRole("button", { name: PASSKEY_USE })).toBeFocused();
  await page.getByRole("button", { name: PASSKEY_USE }).click();
  await expect(page).toHaveURL(/\/choose-family$/);
  wentToThePortal(paths);
  expect(Number((await sql`SELECT count(*) AS n FROM signin_code WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`)[0]!.n)).toBe(0);
  await close();
});
