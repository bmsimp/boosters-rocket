import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { PARENT_SESSION_FAMILY, PARENT_SESSION_TOKEN, parentSessionCookie } from "./parent-session";
import { e2eMailPort } from "./run-config";
import { E2E_EMAIL, emailTokenHash } from "./email-seed";

// A parent changes the address they sign in with (src/lib/parents/email-change.ts): asks at phone width, the link
// arrives in the mail sink, opening it puts the question, and confirming is refused BEFORE ANYTHING IS SENT. Zelda's
// record in the Quetzalcoatl family is E2E-P1, an id that is not digits (the tripwire in tests/e2e/family-details.spec.ts),
// and an id that isn't digits is never sent to QuickBooks. This run's connection holds made-up tokens: a numeric id
// would send the confirmation's read and write to Intuit's real servers. The change itself, QuickBooks first and then
// the portal, is proved against a stub in tests/integration/email-change.test.ts.
//
// The change is offered only to a parent in one family, while parent sign-ins are on. Zelda is in two families on
// purpose (the family chooser test), and sign-ins are switched on by tests/e2e/parents.spec.ts, which runs later in the
// phone pass. So for this spec her link to the second family is closed and sign-ins are on, and afterward both are put
// back as they were, with her seeded request (E2E_EMAIL.own, which asking replaces): the seed is as it was found.
const sql = postgres(process.env.DATABASE_URL!);
const NEW = "zelda.moved@e2e-moving.example";
let sink: MailSink;
let saved: { setting: unknown[]; link: { status: string; disabled_reason: string | null; status_before_disable: string | null }; strongAt: Date | null };

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
/** A message as the sink got it, its quoted-printable line breaks joined again. */
const textOf = (raw: string) => raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
const zelda = async () => (await sql`SELECT id, email FROM parent WHERE email IN ('zelda@example.com', ${NEW})`)[0]!;

test.beforeAll(async () => {
  const [seeded] = await sql`SELECT value FROM setting WHERE key = 'mail'`;
  expect((seeded?.value as { port?: number } | undefined)?.port, "the mail port in the seeded settings; seed again with this run's E2E_MAIL_PORT").toBe(e2eMailPort());
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); await sql.end(); });

test.describe("a parent changes their sign-in email", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 760, "asked and confirmed at phone width; the desktop pass would only do it again");

  test.beforeAll(async () => {
    const p = await zelda();
    saved = {
      setting: [...await sql`SELECT value FROM setting WHERE key = 'parents.settings'`],
      link: (await sql`SELECT status, disabled_reason, status_before_disable FROM guardian WHERE parent_id = ${p.id} AND family_qbo_id = 'E2E-FAMILY-2'`)[0] as typeof saved.link,
      strongAt: ((await sql`SELECT strong_at FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`)[0]?.strong_at ?? null) as Date | null,
    };
    const on = { signin: true, everEnabled: true, welcome: false, requireActiveStudents: false };
    await sql`INSERT INTO setting (key, value) VALUES ('parents.settings', ${sql.json(on)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await sql`UPDATE guardian SET status = 'disabled', disabled_reason = 'not_in_quickbooks', status_before_disable = ${saved.link.status} WHERE parent_id = ${p.id} AND family_qbo_id = 'E2E-FAMILY-2'`;
    // The change is asked for only by a session that proved itself in the last 10 minutes (asking again, slice SI-5a):
    // the seeded session is stamped as just proved, a few seconds back so the database's clock never puts it ahead of
    // the app's, and put back after. Asking again in the browser is journey 10 of tests/e2e/keyboard-journeys.spec.ts.
    await sql`UPDATE parent_auth_session SET strong_at = now() - interval '5 seconds' WHERE token = ${PARENT_SESSION_TOKEN}`;
  });

  test.afterAll(async () => {
    await sql`UPDATE parent_auth_session SET strong_at = ${saved.strongAt} WHERE token = ${PARENT_SESSION_TOKEN}`;
    const p = await zelda();
    if (saved.setting.length) await sql`UPDATE setting SET value = ${sql.json((saved.setting[0] as { value: never }).value)} WHERE key = 'parents.settings'`;
    else await sql`DELETE FROM setting WHERE key = 'parents.settings'`;
    await sql`UPDATE guardian SET status = ${saved.link.status}, disabled_reason = ${saved.link.disabled_reason}, status_before_disable = ${saved.link.status_before_disable}
            WHERE parent_id = ${p.id} AND family_qbo_id = 'E2E-FAMILY-2'`;
    // Asking replaced the seeded request: put it back, and drop the one this spec made.
    // The request names the family it was asked in by the app's record, the one Zelda's row in it names.
    const [link] = await sql`SELECT id, family_id FROM guardian WHERE parent_id = ${p.id} AND family_qbo_id = ${PARENT_SESSION_FAMILY}`;
    await sql`DELETE FROM parent_email_change WHERE parent_id = ${p.id} AND used_at IS NULL`;
    await sql`INSERT INTO parent_email_change (parent_id, guardian_id, family_id, record_qbo_id, new_email, token_hash, expires_at)
            VALUES (${p.id}, ${link!.id}, ${link!.family_id}, 'E2E-P1', ${E2E_EMAIL.own.newEmail}, ${emailTokenHash(E2E_EMAIL.own.token)}, now() + interval '7 days')`;
  });

  test("asks at phone width, gets the link by mail, is asked, and is refused before anything is sent to QuickBooks", async ({ context, page, baseURL }) => {
    expect(isPhone(page)).toBe(true);
    // If this fails, don't change it: a numeric id here makes the confirmation call Intuit's real servers from this run.
    const [record] = await sql`SELECT g.source_qbo_id FROM guardian g JOIN parent p ON p.id = g.parent_id WHERE p.email = 'zelda@example.com' AND g.family_qbo_id = ${PARENT_SESSION_FAMILY}`;
    expect(record!.source_qbo_id).toBe("E2E-P1");
    expect(record!.source_qbo_id).not.toMatch(/^\d+$/);

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
    const [asked] = await sql`SELECT used_at, record_qbo_id FROM parent_email_change WHERE token_hash = ${emailTokenHash(link![1]!)}`;
    expect(asked).toEqual({ used_at: null, record_qbo_id: "E2E-P1" });

    // Saying yes: refused before anything is sent, because the record's id is not one QuickBooks gives.
    const yes = page.getByRole("button", { name: "Yes, use this address" });
    expect((await yes.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await yes.click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("We couldn't reach the club's books just now, so nothing was changed. Please open the link again in a little while.");
    const [refusal] = await sql`SELECT after FROM audit_log WHERE action = 'parent.email.save.failed' ORDER BY id DESC LIMIT 1`;
    expect(refusal!.after).toEqual({ code: "bad_id" });
    expect(await sql`SELECT 1 FROM audit_log WHERE action = 'parent.email.save'`).toHaveLength(0);

    // Nothing changed: the link still works, the address and the cache are as they were, and she is still signed in.
    expect((await sql`SELECT used_at FROM parent_email_change WHERE token_hash = ${emailTokenHash(link![1]!)}`)[0]).toEqual({ used_at: null });
    expect((await zelda()).email).toBe("zelda@example.com");
    expect((await sql`SELECT email FROM qbo_customer WHERE qbo_id = 'E2E-P1'`)[0]).toEqual({ email: "zelda@example.com" });
    await page.goto("/family");
    await expect(page.getByRole("region", { name: "Your account" })).toContainText("zelda@example.com");
  });
});
