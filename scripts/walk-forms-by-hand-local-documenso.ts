/**
 * Walks the forms journey in a real browser against a LOCAL Documenso, by hand. Not part of any test suite: the browser
 * run (pnpm e2e) never reaches a Documenso, and this needs one running on this machine. docs/walkthrough.md says when
 * and how to run it.
 *
 * What it does, as the seeded people of scripts/seed-e2e.ts:
 *   1. the Admin sets up Forms (Documenso's address and API token), checks the connection and makes the webhook secret;
 *   2. the Admin attaches the local Documenso's template to "Medical release" (asked of each student, no template yet);
 *   3. Zelda opens Forms, chooses "Sign for Xochitl", agrees to sign electronically, signs in the embedded frame, and
 *      the page reads the form as signed (it asks Documenso itself; a local Documenso can't reach the portal's webhook).
 *
 * Before: build and seed as for the browser suite (docs/agents/testing.md: e2e in a worktree), and start the app on E2E_PORT
 * with the same variables. The local Documenso is the one step 4 verified (compose project br-documenso-spike, at
 * http://localhost:3500, not changed by this script). Its account file holds the API token and template ids; it lives
 * outside the repository and is read here at run time, never copied:
 *   DOCUMENSO_ACCOUNT=<path to the spike's account.json> WALK_OUT=<a folder for screenshots> \
 *     pnpm tsx scripts/walk-forms-by-hand-local-documenso.ts
 * After: seed again (pnpm tsx scripts/seed-e2e.ts). This leaves Forms set up and a signed document in the database,
 * which the browser suite does not expect, and a document in the local Documenso.
 *
 * Nothing secret is printed: not the token, the webhook secret or a signing token.
 */
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { assertE2eDatabase, e2eBaseUrl } from "../tests/e2e/run-config";
import { parentSessionCookie } from "../tests/e2e/parent-session";
import { staffSessionCookie } from "../tests/e2e/staff-session";

const DOCUMENSO = process.env.DOCUMENSO_ORIGIN ?? "http://localhost:3500";
type Account = { apiToken: string; templates: { main: { envelopeId: string } } };

function fail(message: string): never {
  console.error(`walk-forms: ${message}`);
  process.exit(2);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  try { assertE2eDatabase(url); } catch (e) { fail(`DATABASE_URL must be this tree's browser-test database.\n${(e as Error).message}`); }
  const accountPath = process.env.DOCUMENSO_ACCOUNT ?? fail("set DOCUMENSO_ACCOUNT to the local Documenso's account.json (outside the repository).");
  const account = JSON.parse(readFileSync(accountPath, "utf8")) as Account;
  if (!account.apiToken || !account.templates?.main?.envelopeId) fail("the account file has no apiToken or templates.main.envelopeId.");
  const out = process.env.WALK_OUT ?? fail("set WALK_OUT to a folder for the screenshots.");
  mkdirSync(out, { recursive: true });
  const base = e2eBaseUrl();
  if (!(await fetch(`${DOCUMENSO}/api/health`).then((r) => r.ok, () => false))) fail(`no Documenso answers at ${DOCUMENSO}.`);
  if (!(await fetch(`${base}/api/health`).then((r) => r.ok, () => false))) fail(`no portal answers at ${base}: start it first.`);

  const sql = postgres(url);
  const [zelda] = await sql`SELECT id FROM parent WHERE email = 'zelda@example.com'`;
  const [medical] = await sql`SELECT r.id, r.form FROM requirement r WHERE r.title = 'Medical release' AND r.kind = 'form'`;
  await sql.end();
  if (!zelda || !medical) fail("this database doesn't hold the browser seed: run pnpm tsx scripts/seed-e2e.ts first.");

  const browser = await chromium.launch();
  const width = Number(process.env.WALK_WIDTH ?? 1440), phone = width < 760;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 1000 }, hasTouch: phone });
  await context.addCookies([staffSessionCookie(), parentSessionCookie()]);
  const page = await context.newPage();
  const shot = async (name: string) => { await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true }); console.log(`- ${name}: ${page.url().replace(base, "")}`); };
  const said = async (p: Page) => (await p.locator("main").innerText()).replace(/\s+/g, " ");

  try {
    // 1. Forms settings.
    await page.goto(`${base}/staff/settings/forms/setup`);
    await page.getByLabel("Documenso's address", { exact: true }).fill(DOCUMENSO);
    await page.getByLabel(/^API token/).fill(account.apiToken);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).waitFor();
    await page.locator(".notice").first().waitFor();
    await page.reload();
    await page.getByRole("button", { name: "Check the connection" }).click();
    await page.getByRole("region", { name: /Check the connection/ }).locator(".notice").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Make (the|a new) secret$/ }).click();
    await page.getByLabel("Secret (shown this once)").waitFor();
    await shot("1-forms-settings");

    // 2. The template, on the requirement's own page.
    await page.goto(`${base}/staff/seasons/${(await seasonOf(url, medical.id as string))}/requirements/${medical.id as string}`);
    await page.getByText("Attach a template", { exact: true }).click();
    const select = page.getByLabel("Template in Documenso");
    await select.or(page.getByLabel("The address of the template's page in Documenso")).first().waitFor();
    if (await select.count()) await select.selectOption(account.templates.main.envelopeId);
    else fail("the requirement page listed no templates from Documenso: check the connection.");
    await page.getByRole("button", { name: /^Check and attach/ }).click();
    await page.locator("main .notice-done, main .notice-late").first().waitFor({ timeout: 30_000 });
    await shot("2-template-attached");
    if (await page.locator("main .notice-late").count()) fail(`attaching the template was refused: ${await page.locator("main .notice-late").first().innerText()}`);

    // 3. The parent signs.
    await page.goto(`${base}/forms`);
    await page.getByRole("link", { name: /^Sign for Xochitl/ }).click();
    await shot("3-consent");
    await page.getByRole("button", { name: /agree/i }).click();
    const frame = page.frameLocator("iframe[title^='Sign: ']");
    const canvas = frame.locator(".konva-container canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 60_000 });
    await shot("4-frame");
    // As step 4's verification signed (docs/superpowers/specs/2026-11-15-documenso-verification.md): type the
    // signature, then place it on the signature field, found from the document Documenso made, then complete.
    const field = await signatureField(url, account.apiToken);
    // As a person on a phone does: the page scrolled so the frame starts at the top of the screen, clear of the tab bar.
    const frameTop = () => page.locator("iframe[title^='Sign: ']").evaluate((e) => e.scrollIntoView({ block: "start" }));
    const box = async () => { await canvas.scrollIntoViewIfNeeded(); await frameTop(); await page.waitForTimeout(500); return (await canvas.boundingBox())!; };
    const onField = async () => { const b = await box(); return { x: (field.x + field.w / 2) / 100 * b.width, y: (field.y + field.h / 2) / 100 * b.height }; };
    // The portal's frame is narrower than Documenso's wide layout at any width, so it shows Documenso's narrow one: tap
    // or click the signature field, then type the signature in the dialog it opens.
    if (phone) await canvas.tap({ position: await onField() });
    else await canvas.click({ position: await onField() });
    await frame.getByRole("tab", { name: "Type" }).waitFor({ timeout: 15_000 });
    await frame.getByRole("tab", { name: "Type" }).click();
    await frame.getByTestId("signature-pad-type-input").fill("Zelda Quetzalcoatl");
    await frameTop();
    await frame.locator("[role=dialog]").getByRole("button", { name: "Sign", exact: true }).click();
    const complete = frame.locator('button:has-text("Complete") >> visible=true').first();
    await frameTop();
    await complete.click({ timeout: 20_000 });
    await frame.getByRole("button", { name: "Sign", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector("iframe[title^='Sign: ']"), null, { timeout: 60_000 }).catch(() => {});
    await shot("5-after-signing");
    // Documenso seals the signed copy a moment later ("Signed, being finished" until then): the page reads it again on
    // each load, for up to two minutes.
    let words = "";
    for (let i = 0; i < 24; i++) {
      await page.reload();
      words = await said(page);
      if (/This form is signed/.test(words)) break;
      await page.waitForTimeout(5000);
    }
    await shot("6-signed");
    console.log(/This form is signed/.test(words) ? "SIGNED: the form reads as signed." : /being finished/.test(words) ? "SIGNED, being finished: Documenso hasn't sealed it yet." : `NOT SIGNED: the page says: ${words.slice(0, 300)}`);
  } catch (e) {
    await shot("zz-stopped").catch(() => {});
    console.error(`walk-forms stopped: ${(e as Error).message.split("\n")[0]}`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

/** Where Zelda's signature field is on the page, in percent, read from the document the portal had Documenso make. */
async function signatureField(url: string, token: string): Promise<{ x: number; y: number; w: number; h: number }> {
  const sql = postgres(url);
  // A request names the app's own student; E2E-S1 is the customer that student's link names.
  const [request] = await sql`SELECT s.envelope_id, s.signers FROM signature_request s JOIN accounting_link l ON l.student_id = s.student_id AND l.customer_id = 'E2E-S1'
    WHERE s.envelope_id IS NOT NULL`;
  await sql.end();
  if (!request) fail("the portal made no document for Xochitl's form.");
  const res = await fetch(`${DOCUMENSO}/api/v2/envelope/${request.envelope_id as string}`, { headers: { Authorization: token } });
  if (!res.ok) fail(`Documenso answered ${res.status} for the document.`);
  const envelope = await res.json() as { recipients: { id: number; email: string }[]; fields: { recipientId: number; type: string; positionX: string; positionY: string; width: string; height: string }[] };
  const me = envelope.recipients.find((r) => r.email === "zelda@example.com") ?? fail("Zelda is not a recipient of the document.");
  const f = envelope.fields.find((x) => x.recipientId === me.id && x.type === "SIGNATURE") ?? fail("the document has no signature field for Zelda.");
  return { x: Number(f.positionX), y: Number(f.positionY), w: Number(f.width), h: Number(f.height) };
}

async function seasonOf(url: string, requirementId: string): Promise<string> {
  const sql = postgres(url);
  const [row] = await sql`SELECT s.season_id FROM requirement r JOIN season_step s ON s.id = r.step_id WHERE r.id = ${requirementId}`;
  await sql.end();
  return row!.season_id as string;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
