import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";
import { e2eMailPort } from "./run-config";
import { E2E_EMAIL, emailTokenHash } from "./email-seed";

// A parent changes the address they sign in with (src/lib/parents/email-change.ts): asks at phone width, the link
// arrives in the mail sink, opening it puts the question, and confirming is refused because another person holds the
// address. Since stage 3's slice 11d a confirmed change is the portal's alone, so a change made here would end Zelda's
// sessions, the one every later spec signs in with: for this spec another person holds the new address (one address
// is one person), and the confirm changes nothing. The change itself is proved in tests/integration/email-change.test.ts.
//
// The change is offered while parent sign-ins are on, which tests/e2e/parents.spec.ts switches on later in the phone
// pass. So for this spec sign-ins are on and the other person exists, and afterward both are put back as they were,
// with Zelda's seeded request (E2E_EMAIL.own, which asking replaces): the seed is as it was found.
const sql = postgres(process.env.DATABASE_URL!);
const NEW = "zelda.moved@e2e-moving.example";
let sink: MailSink;
let saved: { setting: unknown[] };

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
/** A message as the sink got it, its quoted-printable line breaks joined again. */
const textOf = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
/** Zelda, whatever address she holds: never the other person this spec gives the new address. */
const zelda = async () => (await sql`SELECT id, email FROM parent WHERE email = 'zelda@example.com' OR (email = ${NEW} AND name <> 'Someone Else')`)[0]!;

test.beforeAll(async () => {
  const [seeded] = await sql`SELECT value FROM setting WHERE key = 'mail'`;
  expect((seeded?.value as { port?: number } | undefined)?.port, "the mail port in the seeded settings; seed again with this run's E2E_MAIL_PORT").toBe(e2eMailPort());
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); await sql.end(); });

test.describe("a parent changes their sign-in email", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 760, "asked and confirmed at phone width; the desktop pass would only do it again");

  test.beforeAll(async () => {
    saved = { setting: [...await sql`SELECT value FROM setting WHERE key = 'parents.settings'`] };
    const on = { signin: true, everEnabled: true, welcome: false, requireActiveStudents: false };
    await sql`INSERT INTO setting (key, value) VALUES ('parents.settings', ${sql.json(on)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    // Another person signs in with the new address, so confirming changes nothing of Zelda's.
    await sql`INSERT INTO parent (name, email) VALUES ('Someone Else', ${NEW})`;
  });

  test.afterAll(async () => {
    const p = await zelda();
    if (saved.setting.length) await sql`UPDATE setting SET value = ${sql.json((saved.setting[0] as { value: never }).value)} WHERE key = 'parents.settings'`;
    else await sql`DELETE FROM setting WHERE key = 'parents.settings'`;
    await sql`DELETE FROM parent WHERE email = ${NEW}`;
    // Asking replaced the seeded request: put it back, and drop the one this spec made (spent by the refused confirm).
    // The request names the family it was asked in by the app's record, the one Zelda's row in it names.
    const [link] = await sql`SELECT id, family_id FROM guardian WHERE parent_id = ${p.id} AND family_qbo_id = ${PARENT_SESSION_FAMILY}`;
    await sql`DELETE FROM parent_email_change WHERE parent_id = ${p.id} AND (used_at IS NULL OR new_email = ${NEW})`;
    await sql`INSERT INTO parent_email_change (parent_id, guardian_id, family_id, new_email, token_hash, expires_at)
            VALUES (${p.id}, ${link!.id}, ${link!.family_id}, ${E2E_EMAIL.own.newEmail}, ${emailTokenHash(E2E_EMAIL.own.token)}, now() + interval '7 days')`;
  });

  test("asks at phone width, gets the link by mail, is asked, and is refused while another person holds the address", async ({ context, page, baseURL }) => {
    expect(isPhone(page)).toBe(true);

    await context.addCookies([parentSessionCookie()]);
    sink.messages.length = 0;
    await page.goto("/family");
    const account = page.getByRole("region", { name: "Your account" });
    const offer = account.getByRole("link", { name: "Change my sign-in email" });
    expect((await offer.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await offer.click();

    await expect(page).toHaveURL(/\/family\/email$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Change your sign-in email");
    await expect(page.locator("main .lede")).toContainText("You sign in with zelda@example.com.");
    await page.getByRole("textbox", { name: "New email" }).fill(` ${NEW.toUpperCase()} `);
    await noSidewaysScroll(page);
    const send = page.getByRole("button", { name: "Send me a link" });
    expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await send.click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText(`We've sent a link to ${NEW}. Open it within 24 hours to finish the change. Until then, keep signing in with the address you use now.`);

    // The link goes to the new address, and a notice with no link to the old one.
    await expect.poll(() => sink.messages.filter((m) => m.to.includes(NEW)).length, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => sink.messages.filter((m) => m.to.includes("zelda@example.com")).length, { timeout: 15_000 }).toBe(1);
    const link = new RegExp(`${baseURL}/family/email/([A-Za-z0-9_-]{43})`).exec(textOf(sink.messages.find((m) => m.to.includes(NEW))!.raw));
    expect(link, "the link in the email to the new address").not.toBeNull();
    const notice = textOf(sink.messages.find((m) => m.to.includes("zelda@example.com"))!.raw);
    expect(notice).toContain("Someone asked to change the email address you sign in to");
    expect(notice).not.toContain("/family/email");
    expect(notice).not.toContain(NEW);
    for (const m of sink.messages) expect(textOf(m.raw)).not.toMatch(/Quetzalcoatl|Second Family|Rivera/);

    // Opening the link changes nothing: mail scanners open links too.
    await page.goto(link![0]!);
    await expect(page.getByRole("heading", { name: `Use ${NEW} to sign in from now on?` })).toBeVisible();
    await noSidewaysScroll(page);
    const [asked] = await sql`SELECT used_at FROM parent_email_change WHERE token_hash = ${emailTokenHash(link![1]!)}`;
    expect(asked).toEqual({ used_at: null });

    // Saying yes: refused, because another person signs in with the address, in words that never say why.
    const yes = page.getByRole("button", { name: "Yes, use this address" });
    expect((await yes.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await yes.click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("That change can't be made here, so nothing was changed. Please ask the club to change your sign-in email.");
    const [refusal] = await sql`SELECT after FROM audit_log WHERE action = 'parent.email.save.failed' ORDER BY id DESC LIMIT 1`;
    expect(refusal!.after).toEqual({ code: "address_taken" });
    expect(await sql`SELECT 1 FROM audit_log WHERE action = 'parent.email.save'`).toHaveLength(0);

    // Nothing changed: the link is spent (it can never work), the address and the cache are as they were, and she is
    // still signed in.
    expect((await sql`SELECT used_at FROM parent_email_change WHERE token_hash = ${emailTokenHash(link![1]!)}`)[0]!.used_at).not.toBeNull();
    expect((await zelda()).email).toBe("zelda@example.com");
    expect((await sql`SELECT email FROM qbo_customer WHERE qbo_id = 'E2E-P1'`)[0]).toEqual({ email: "zelda@example.com" });
    await page.goto("/family");
    await expect(page.getByRole("region", { name: "Your account" })).toContainText("zelda@example.com");
  });
});
