import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { askedAddressHash, linkTokenHash, removeZeldaLinks, removeZeldaSessionsMadeHere, ZELDA_EMAIL } from "./signin-links";

/**
 * "Set up or reset my password" in the browser (the sign-in release, slice SI-3a): followed from /sign-in, asked for
 * Zelda's address, answered in its one sentence, the set-up link read from the mail sink and opened, a long random
 * password set (it passes the breach check whether the real service answers or not), and Zelda signed in on the
 * chooser (she has two families). An address nobody holds gets the same words and no mail. After each test Zelda's
 * password, links and the sessions made here go, and the asks' counts, so the seed is as it was for the next pass.
 */
const sql = postgres(process.env.DATABASE_URL!);
const NOBODY = "nobody-asks@example.com";
const ANSWER = "If that address can sign in here, we've emailed it a link.";
let sink: MailSink;
let started: Date;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.beforeEach(async () => { sink.messages.length = 0; started = new Date(); });
test.afterEach(async () => {
  await removeZeldaLinks(sql);
  await removeZeldaSessionsMadeHere(sql);
  await sql`DELETE FROM rate_limit_event WHERE kind = 'password_ask_email' AND subject IN (${askedAddressHash(ZELDA_EMAIL)}, ${askedAddressHash(NOBODY)})`;
  await sql`DELETE FROM rate_limit_event WHERE kind = 'password_ask_ip' AND at >= ${started}`;
});
test.afterAll(async () => { await sink.close(); await sql.end(); });

/** A message's bodies as text, whatever transfer encoding the mailer chose for them. */
function bodiesOf(raw: string): string {
  const unfolded = raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const base64 = [...raw.matchAll(/\r?\n\r?\n([A-Za-z0-9+/=\r\n]{40,})/g)].map((m) => Buffer.from(m[1]!.replace(/\s+/g, ""), "base64").toString("utf8"));
  return [unfolded, ...base64].join("\n");
}

/** The token of the newest set-up link mailed to Zelda. */
async function setupTokenMailed(): Promise<string> {
  let token = "";
  await expect.poll(() => {
    for (const m of sink.messages.filter((x) => x.to.includes(ZELDA_EMAIL)).reverse()) {
      const found = /\/sign-in\/set-up\/([A-Za-z0-9_-]{43})/.exec(bodiesOf(m.raw))?.[1];
      if (found) { token = found; return true; }
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
  return token;
}

test("asked from /sign-in, mails Zelda a set-up link that sets her password and signs her in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Set up or reset my password" }).click();
  await expect(page).toHaveURL(/\/sign-in\/password$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up or reset my password");
  await page.getByLabel("Email").fill(ZELDA_EMAIL);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status")).toContainText(ANSWER);

  const token = await setupTokenMailed();
  // The link works once the portal has put it in place, a moment after its mail was handed over.
  await expect.poll(async () => (await sql`SELECT count(*)::int AS n FROM parent_signin_token
    WHERE token_hash = ${linkTokenHash("setup", token)} AND used_at IS NULL`)[0]!.n, { timeout: 15_000 }).toBe(1);
  await page.goto(`/sign-in/set-up/${token}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Choose a password");
  const password = randomBytes(24).toString("base64url");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Type it again").fill(password);
  await page.getByRole("button", { name: "Save my password" }).click();
  await expect(page).toHaveURL(/\/choose-family$/);
});

test("an address nobody holds gets the same words, and no mail", async ({ page }) => {
  await page.goto("/sign-in/password");
  await page.getByLabel("Email").fill(NOBODY);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("status")).toContainText(ANSWER);
  // An ask that mails nothing makes no link and starts no send, so there is nothing to wait for.
  const [links] = await sql`SELECT count(*)::int AS n FROM parent_signin_token WHERE created_at >= ${started}`;
  expect(links!.n).toBe(0);
  expect(sink.messages.filter((m) => m.to.includes(NOBODY))).toEqual([]);
});
