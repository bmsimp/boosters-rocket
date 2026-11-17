import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { focusStop } from "./a11y-checks";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";
import { E2E_VOLUNTEER } from "./volunteer-seed";
import { E2E_EMAIL, emailTokenHash } from "./email-seed";
import { codeFor } from "./journey-helpers";

/**
 * The parent journeys docs/accessibility-checks.md walked by hand, walked here by the keyboard alone: Tab, Shift+Tab,
 * Enter, Space, the arrow keys and typing, never a click (a check-in address is opened as the QR code opens it). At
 * each Tab stop the focus ring must show (a11y-checks.ts, focusStop), the keyboard must reach what the journey needs
 * in the order the page is read, and after each action the focus must land where the page says it does. On the pages
 * where a journey ends, the keyboard must be able to Tab on through the page and out of it: nothing traps it.
 *
 * Run in the desktop pass only, at 1440 wide: tests/e2e/parent-a11y.spec.ts walks every page with Tab at 360 for the
 * phone's tab bar. Not walked here, because the run can't reach them: agreeing to sign and signing in Documenso's frame
 * (forms are not set up in the seed), and saving the phone and address form (QuickBooks is never reached; the details
 * page shows only its note). The seed is left as it was found, or in a state the other specs accept: the sign-up is
 * cancelled again, the check-in is left done (tests/e2e/check-in.spec.ts passes from either state), and the email
 * change's settings and seeded request are put back as tests/e2e/family-email.spec.ts puts them.
 */
const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;

test.describe.configure({ mode: "serial" });
test.skip(({ viewport }) => (viewport?.width ?? 0) < 760, "walked once, at a laptop's width: parent-a11y.spec.ts walks Tab at a phone's");
test.beforeAll(async () => {
  const [seeded] = await sql`SELECT value FROM setting WHERE key = 'mail'`;
  expect((seeded?.value as { port?: number } | undefined)?.port, "the mail port in the seeded settings; seed again with this run's E2E_MAIL_PORT").toBe(e2eMailPort());
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); await sql.end(); });

/** Everything a Tab stop on the way showed wrong: no ring, or left under something fixed. Checked at the end of each step. */
let ringProblems: string[] = [];

/** Whether the focus is on this element, or inside it (a radio's group, a frame). */
const focusedIn = (target: Locator) => target.evaluate((el) => el === document.activeElement || el.contains(document.activeElement));

/**
 * Presses Tab (or Shift+Tab) until the focus is on `target`, checking the ring at every stop on the way, and gives
 * back the stops it passed. Fails when the target isn't reached within `max` stops: it is missing, out of the
 * keyboard's reach, or something on the way holds the keyboard.
 */
async function tabTo(page: Page, target: Locator, o: { max?: number; back?: boolean } = {}): Promise<string[]> {
  const stops: string[] = [];
  for (let i = 0; i < (o.max ?? 40); i++) {
    await page.keyboard.press(o.back ? "Shift+Tab" : "Tab");
    const stop = await page.evaluate(focusStop);
    if (stop) {
      stops.push(stop.element);
      for (const p of stop.problems) ringProblems.push(`${new URL(page.url()).pathname} · ${stop.element}: ${p}`);
    }
    if (await focusedIn(target)) return stops;
  }
  throw new Error(`The keyboard did not reach ${target} on ${page.url()} in ${o.max ?? 40} stops. It went: ${stops.join(" > ")}`);
}

/** From where the focus is, Tab goes on through the page and leaves it (or comes round to the top): nothing traps it. */
async function tabsOut(page: Page) {
  const seen: string[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(focusStop);
    if (!stop) return;
    if (seen.length > 3 && stop.element === seen[0]) return;
    seen.push(stop.element);
    for (const p of stop.problems) ringProblems.push(`${new URL(page.url()).pathname} · ${stop.element}: ${p}`);
  }
  throw new Error(`Tab never left ${page.url()}: the keyboard went round ${seen.slice(-10).join(" > ")}`);
}

/** Starts the Tab order from the top of the page, as a page load does. */
async function fromTheTop(page: Page) {
  await page.evaluate(() => {
    const start = document.createElement("div");
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus();
    start.remove();
    window.scrollTo(0, 0);
  });
}

function ringsShown() {
  const found = ringProblems;
  ringProblems = [];
  expect(found, `Tab stops with no visible focus ring:\n${found.join("\n")}`).toEqual([]);
}

const bar = (page: Page, name: string) => page.locator("header.bar").getByRole("link", { name, exact: true });

test("a parent's journeys by keyboard alone: sign in, Home to Payments, a form, a shift and its cancelling, a check-in, the details and the Display page", async ({ page }) => {
  test.setTimeout(180_000);
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
  // The seed's state for the check-in: Zelda's place on the shift on now, not checked in yet.
  await sql`DELETE FROM volunteer_credit WHERE kind = 'checkin' AND removed_at IS NULL
    AND signup_id IN (SELECT id FROM volunteer_signup WHERE shift_id = ${E2E_VOLUNTEER.openShift} AND family_qbo_id = 'E2E-FAMILY')`;
  sink.messages.length = 0;

  await test.step("1. signs in with an emailed code: Enter sends it, the code field takes the focus, Enter signs in", async () => {
    await page.goto("/sign-in");
    // The sign-in page's bar has nothing in it to skip: the first stop is the email field.
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Email")).toBeFocused();
    await page.keyboard.type("zelda@example.com");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("we've sent a 6-digit code");
    await expect(page.getByLabel("6-digit code")).toBeFocused();
    // A wrong code is said as an alert, and the focus stays in the field to try again.
    await page.keyboard.type("000000");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel("6-digit code")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(await codeFor(sql, sink, "zelda@example.com"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/choose-family$/);
    await tabTo(page, page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/$/);
    ringsShown();
  });

  await test.step("2. Home: Skip to the page is the first stop and goes past the bar; then Payments and its Pay link", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
    await fromTheTop(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to the page" });
    await expect(skip).toBeFocused();
    // Drawn while it has the focus: a tap target on the screen, with its ring.
    const box = (await skip.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect((await page.evaluate(focusStop))!.problems).toEqual([]);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    // The next stop is in the page itself: past the club bar and the Switch family line.
    expect(await page.evaluate(() => {
      const el = document.activeElement!, start = document.getElementById("page-start")!;
      return !el.closest("header.bar") && !el.closest(".switch-family") && Boolean(start.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "the stop after Skip to the page is inside the page").toBe(true);

    await fromTheTop(page);
    const order = await tabTo(page, bar(page, "Payments"));
    expect(order.slice(0, 4).map((s) => s.replace(/^a(\.[\w-]+)* /, ""))).toEqual(['"Skip to the page"', '"Home"', '"Forms"', '"Payments"']);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/payments$/);
    await expect(bar(page, "Payments")).toBeFocused(); // the frame is kept, and the focus with it
    const pay = page.getByRole("region", { name: "Quetzalcoatl Family" }).getByRole("link", { name: /^Pay \$/ });
    await tabTo(page, pay);
    await expect(pay).toHaveAccessibleName(/^Pay \$\d+\.\d{2}, invoice /);
    expect(new URL((await pay.getAttribute("href"))!).hostname).toMatch(/(^|\.)intuit\.com$/); // not followed: it is Intuit's page
    ringsShown();
  });

  await test.step("3. Forms: opens the signed form, whose page is titled with its name, and goes back", async () => {
    await fromTheTop(page);
    await tabTo(page, bar(page, "Forms"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/forms$/);
    await tabTo(page, page.getByRole("region", { name: "Your family" }).getByRole("link", { name: /^Open/ }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/forms\/e2e00000-0000-4000-8000-000000000001$/);
    await expect(page).toHaveTitle(/^Travel consent · /);
    await tabTo(page, page.getByRole("link", { name: /Download the signed form/ }));
    await tabTo(page, page.getByRole("link", { name: "Back to Forms" }), { back: true });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/forms$/);
    ringsShown();
  });

  await test.step("4. Volunteer: signs up for a shift, the thank-you takes the focus; cancelling asks, Keep it gives the focus back", async () => {
    await fromTheTop(page);
    await tabTo(page, bar(page, "Volunteer"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/volunteer$/);
    await tabTo(page, page.getByRole("link", { name: "Sign up for 9:00 am to 11:00 am, Cleanup" }), { max: 60 });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/volunteer/shifts/${E2E_VOLUNTEER.cleanup}$`));
    const me = page.getByRole("radio", { name: /^Me \(Zelda Quetzalcoatl\)/ });
    await tabTo(page, me);
    await expect(me).toBeChecked();
    // The choice group is one stop: the next is the button, which names who it signs up.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign me up" })).toBeFocused();
    await page.keyboard.press("Enter");
    const thanks = page.getByRole("status").filter({ hasText: "You're signed up. Thank you!" });
    await expect(thanks).toBeFocused();
    await tabTo(page, page.getByRole("link", { name: "Back to Volunteer" }).first(), { back: true });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/volunteer$/);

    const place = page.getByRole("region", { name: "Your sign-ups" }).locator("li", { hasText: "Pancake breakfast, Cleanup" });
    const cancel = place.getByRole("button", { name: "Cancel my sign-up" });
    await tabTo(page, cancel, { max: 60 });
    await page.keyboard.press("Enter");
    await expect(place.getByRole("button", { name: "Keep it" })).toBeFocused();
    await expect(place.getByRole("group", { name: "Cancel my sign-up?" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Space");
    await expect(place.getByRole("button", { name: "Keep it" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(place.getByRole("button", { name: "Yes, cancel it" })).toBeFocused();
    await page.keyboard.press("Enter");
    // The place leaves the list; what it said goes to the box's status line, which takes the focus.
    await expect(page.getByRole("status").filter({ hasText: /^Cancelled\./ })).toBeFocused();
    await expect(page.getByRole("region", { name: "Your sign-ups" })).not.toContainText("Pancake breakfast, Cleanup");
    ringsShown();
  });

  await test.step("5. checks in at the shift on now: the box's status line takes the focus", async () => {
    // A check-in address is opened by the QR code on the sheet, not by a key.
    await page.goto(`/volunteer/check-in/${E2E_VOLUNTEER.openCode}`);
    await tabTo(page, page.getByRole("button", { name: "Check me in" }));
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "Checked in" })).toBeFocused();
    await expect(page.locator(".lines li").first()).toContainText("Checked in");
    await tabsOut(page);
    ringsShown();
  });

  await test.step("6. Family: opens Update my details, reads why it can't be changed from this run, and goes back", async () => {
    await fromTheTop(page);
    await tabTo(page, bar(page, "Family"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family$/);
    await tabTo(page, page.getByRole("link", { name: "Update my details" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family\/details$/);
    await expect(page.locator("main")).toContainText("can't be changed here just yet");
    await tabTo(page, page.getByRole("main").getByRole("link", { name: "Back to Family" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family$/);
    ringsShown();
  });

  await test.step("8. the Display page: each choice group is one stop, the arrow keys choose, and Sign out signs out", async () => {
    await fromTheTop(page);
    await tabTo(page, page.locator("header.bar").getByRole("link", { name: /^ZQ:/ }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/display$/);
    const appearance = page.getByRole("group", { name: /^Appearance/ });
    await tabTo(page, appearance);
    await expect(appearance.getByRole("radio", { name: /^Match my device/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(appearance.getByRole("radio", { name: /^Dark/ })).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(appearance.getByRole("radio", { name: /^Match my device/ })).toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
    // One stop for each of the other groups, then Sign out.
    const stops = await tabTo(page, page.getByRole("button", { name: "Sign out" }));
    expect(stops.slice(0, 3).map((s) => s.replace(/^input\S* /, "")), `the stops after Appearance: ${stops.join(" > ")}`)
      .toEqual([expect.stringMatching(/^"Match my device/), expect.stringMatching(/^"Standard/), expect.stringMatching(/^"Match my device/)]); // Contrast, Text size, Motion
    ringsShown();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe("7. the email change, by keyboard", () => {
  // As tests/e2e/family-email.spec.ts sets it up: offered to a parent in one family while parent sign-ins are on. Her
  // record's id is not digits, so the confirmation is refused before anything is sent to QuickBooks.
  const NEW = "zelda.keys@e2e-moving.example";
  let saved: { setting: unknown[]; link: { status: string; disabled_reason: string | null; status_before_disable: string | null } };
  const zelda = async () => (await sql`SELECT id, email FROM parent WHERE email = 'zelda@example.com'`)[0]!;

  test.beforeAll(async () => {
    const p = await zelda();
    saved = {
      setting: [...await sql`SELECT value FROM setting WHERE key = 'parents.settings'`],
      link: (await sql`SELECT status, disabled_reason, status_before_disable FROM guardian WHERE parent_id = ${p.id} AND family_qbo_id = 'E2E-FAMILY-2'`)[0] as typeof saved.link,
    };
    const on = { signin: true, everEnabled: true, welcome: false, requireActiveStudents: false, reviewEmails: false };
    await sql`INSERT INTO setting (key, value) VALUES ('parents.settings', ${sql.json(on)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await sql`UPDATE guardian SET status = 'disabled', disabled_reason = 'not_in_quickbooks', status_before_disable = ${saved.link.status} WHERE parent_id = ${p.id} AND family_qbo_id = 'E2E-FAMILY-2'`;
  });

  test.afterAll(async () => {
    const p = await zelda();
    if (saved.setting.length) await sql`UPDATE setting SET value = ${sql.json((saved.setting[0] as { value: never }).value)} WHERE key = 'parents.settings'`;
    else await sql`DELETE FROM setting WHERE key = 'parents.settings'`;
    await sql`UPDATE guardian SET status = ${saved.link.status}, disabled_reason = ${saved.link.disabled_reason}, status_before_disable = ${saved.link.status_before_disable}
            WHERE parent_id = ${p.id} AND family_qbo_id = 'E2E-FAMILY-2'`;
    const [link] = await sql`SELECT id FROM guardian WHERE parent_id = ${p.id} AND family_qbo_id = ${PARENT_SESSION_FAMILY}`;
    await sql`DELETE FROM parent_email_change WHERE parent_id = ${p.id} AND used_at IS NULL`;
    await sql`INSERT INTO parent_email_change (parent_id, guardian_id, family_qbo_id, record_qbo_id, new_email, token_hash, expires_at)
            VALUES (${p.id}, ${link!.id}, ${PARENT_SESSION_FAMILY}, 'E2E-P1', ${E2E_EMAIL.own.newEmail}, ${emailTokenHash(E2E_EMAIL.own.token)}, now() + interval '7 days')`;
  });

  test("asks for a link, a bad address keeps the focus in the field, and the refused confirmation keeps it on its button", async ({ context, page, baseURL }) => {
    await sql`DELETE FROM rate_limit_event`;
    sink.messages.length = 0;
    await context.addCookies([parentSessionCookie()]);
    await page.goto("/family");
    await tabTo(page, page.getByRole("link", { name: "Change my sign-in email" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family\/email$/);
    const field = page.getByRole("textbox", { name: "New email" });
    await tabTo(page, field);
    // An address with no "@" is stopped by the browser's own message, with the focus left in the field.
    await page.keyboard.type("not-an-address");
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await expect(page.getByRole("main").getByRole("status")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(NEW);
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Send me a link" });
    await expect(send).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main").getByRole("status")).toContainText(`We've sent a link to ${NEW}.`);
    await expect(send).toBeFocused(); // busy was aria-disabled, so the button kept the focus
    await tabsOut(page);

    // The link from the email: its one button, refused before anything is sent, keeps the focus with the alert.
    await expect.poll(() => sink.messages.filter((m) => m.to.includes(NEW)).length, { timeout: 15_000 }).toBe(1);
    const raw = sink.messages.find((m) => m.to.includes(NEW))!.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
    const link = new RegExp(`${baseURL}/family/email/[A-Za-z0-9_-]{43}`).exec(raw)![0];
    await page.goto(link);
    const yes = page.getByRole("button", { name: "Yes, use this address" });
    await tabTo(page, yes);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("nothing was changed");
    await expect(yes).toBeFocused();
    expect((await zelda()).email).toBe("zelda@example.com");
    ringsShown();
  });
});
