import { test, expect, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { codeFor } from "./journey-helpers";
import { PARENT_SESSION_TOKEN, parentSessionCookie } from "./parent-session";
import { E2E_SIGNIN } from "./signin-seed";
import { ZELDA_EMAIL, removeZeldaDevicesMadeHere, removeZeldaSessionsMadeHere } from "./signin-links";
import { clearZeldaCounts, keepZeldaProof, removeZeldaSecondSteps } from "./authenticator-steps";
import { PASSKEY_BUTTON } from "../../src/lib/parents/signin-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "../../src/lib/parents/signin-settings-copy";

/**
 * Passkeys on Sign-in settings, in the browser (the sign-in release, slice SI-7b): Zelda shows it's her with her seeded
 * password and the code from the mail sink, adds a passkey with Playwright's own authenticator (`context.credentials`,
 * installed before the page first touches navigator.credentials: it answers navigator.credentials.create() with user
 * present and verified set), reads her ten backup codes once, renames the passkey, asks again with it, signs in with it
 * alone on a fresh browser (the credential read back with credentials.get() and created there), and removes it. The
 * page runs the library's own ceremonies, and the spec watches their verify requests reach the portal's own add and
 * asking again, never the library's verify paths. Nothing of it stays: Zelda's passkeys and backup codes, the sessions
 * and devices its sign-ins made, her counts and her session's proof are put back before (for a run cut off midway) and
 * after, so both passes read one seed.
 */
const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;
let putProofBack: () => Promise<void> = async () => undefined;

const ZELDA_USER = () => sql`(SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL}))`;
async function cleanUp() {
  await sql`DELETE FROM parent_auth_passkey WHERE user_id = ${ZELDA_USER()}`;
  await removeZeldaSecondSteps(sql);
  await removeZeldaSessionsMadeHere(sql);
  await removeZeldaDevicesMadeHere(sql);
  await clearZeldaCounts(sql);
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
  await cleanUp();
  putProofBack = await keepZeldaProof(sql);
});
test.afterAll(async () => {
  await cleanUp();
  await putProofBack();
  await sink.close();
  await sql.end();
});

/** Shows it's her in a box: her password, then the code we email her. */
async function showItsHer(box: Locator) {
  await box.getByLabel("Your password").fill(E2E_SIGNIN.password);
  await box.getByRole("button", { name: "Continue" }).click();
  await expect(box.getByRole("status")).toContainText("We've emailed you a 6-digit code.");
  await box.getByLabel("6-digit code").fill(await codeFor(sql, sink, ZELDA_EMAIL));
  await box.getByRole("button", { name: "Confirm" }).click();
  await expect(box.getByText("Thank you, that's you.")).toBeVisible();
}

test("Zelda adds a passkey, reads her backup codes once, renames it, asks again and signs in with it, then removes it", async ({ browser, context, page, baseURL }) => {
  test.setTimeout(180_000);
  await sql`UPDATE parent_auth_session SET strong_at = NULL WHERE token = ${PARENT_SESSION_TOKEN}`;
  sink.messages.length = 0;
  await context.credentials.install();
  await context.addCookies([parentSessionCookie()]);
  const paths: string[] = [];
  page.on("request", (r) => paths.push(new URL(r.url()).pathname));
  await page.goto("/family/sign-in");
  const box = page.getByRole("region", { name: COPY.passkeysTitle });
  await expect(box).toContainText(COPY.passkeysNone);
  await showItsHer(box);

  // Added, with a name: the library's options, then the portal's own add.
  await box.getByLabel(COPY.passkeyName).fill("Zelda's test browser");
  await box.getByRole("button", { name: COPY.passkeyAdd }).click();
  await expect(box.getByText(COPY.passkeyCodesMade)).toBeVisible();
  const codes = (await box.getByRole("list", { name: COPY.backupCodesTitle }).getByRole("listitem").allTextContents()).map((c) => c.trim());
  expect(new Set(codes).size).toBe(10);
  expect(paths).toContain("/api/auth/parent/passkey/generate-register-options");
  expect(paths).toContain("/api/auth/parent/portal-passkey/add");
  expect(paths).not.toContain("/api/auth/parent/passkey/verify-registration");
  await expect(box.getByText("Zelda's test browser").first()).toBeVisible();
  await expect(box.getByText(COPY.passkeyNotUsed)).toBeVisible();

  // Drawn again: no backup code, credential id or key in the page; renamed without asking again.
  await page.reload();
  const html = await page.content();
  for (const c of codes) expect(html).not.toContain(c);
  const [stored] = await sql`SELECT credential_id, public_key, aaguid FROM parent_auth_passkey WHERE user_id = ${ZELDA_USER()}`;
  for (const v of [stored!.credential_id as string, stored!.public_key as string]) expect(html).not.toContain(v);
  await box.getByRole("button", { name: /^Rename/ }).click();
  await box.getByLabel(COPY.passkeyRenameLabel).fill("Zelda's renamed passkey");
  await box.getByRole("button", { name: COPY.passkeyRenameSave }).click();
  await expect(box.getByText(COPY.passkeyRenamed)).toBeVisible();

  // The add stamped no proof, so removing asks again, now with the passkey first.
  await expect(box.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await box.getByRole("button", { name: COPY.usePasskey }).click();
  await expect(box.getByText("Thank you, that's you.")).toBeVisible();
  expect(paths).toContain("/api/auth/parent/portal-passkey/again");
  expect(paths).not.toContain("/api/auth/parent/passkey/verify-authentication");

  // A fresh browser with the passkey alone signs her in, no address typed.
  const credentials = await context.credentials.get();
  const fresh = await browser.newContext({ baseURL });
  try {
    await fresh.credentials.install();
    for (const c of credentials) await fresh.credentials.create(new URL(baseURL!).hostname, c);
    const other = await fresh.newPage();
    await other.goto("/sign-in");
    await other.getByRole("button", { name: PASSKEY_BUTTON }).click();
    await expect(other).toHaveURL(/\/choose-family$/);
  } finally {
    await fresh.close();
  }

  // Removed, with the words for the last one, and the backup codes go with it. The proof the passkey made above still
  // counts (a sign-in elsewhere moves its `last_used_at`, never when it came into force), so the box asks nothing.
  await page.reload();
  await expect(box.getByRole("button", { name: COPY.usePasskey })).toHaveCount(0);
  await expect(box.getByText(COPY.passkeyRemoveLastWords)).toBeVisible();
  await box.getByRole("button", { name: /^Remove/ }).click();
  await expect(box.getByText(COPY.passkeyRemovedLast)).toBeVisible();
  expect(await sql`SELECT id FROM parent_auth_passkey WHERE user_id = ${ZELDA_USER()}`).toHaveLength(0);
  expect(await sql`SELECT id FROM parent_backup_code WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`).toHaveLength(0);
});
