import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { focusStop } from "./a11y-checks";
import { PARENT_SESSION_FAMILY, PARENT_SESSION_TOKEN, parentSessionCookie } from "./parent-session";
import { E2E_VOLUNTEER } from "./volunteer-seed";
import { E2E_EMAIL, emailTokenHash } from "./email-seed";
import { codeFor, passOffer } from "./journey-helpers";
import { E2E_SIGNIN, deviceTokenHash } from "./signin-seed";
import { removeZeldaDevicesMadeHere, resetPasskeyOffer } from "./signin-links";
import { appCodeAt, clearZeldaCounts, keepZeldaProof, nextAppCode, removeZeldaSecondSteps, setZeldaProof } from "./authenticator-steps";
import { STRICT_PARENT, makeStrictParent, removeStrictParent, storeLevel } from "./strict-seed";
import { ENROLMENT_COPY } from "../../src/lib/parents/enrolment-copy";

/**
 * The parent journeys docs/accessibility-checks.md walked by hand, walked here by the keyboard alone: Tab, Shift+Tab,
 * Enter, Space, the arrow keys and typing, never a click (a check-in address is opened as the QR code opens it). At
 * each Tab stop the focus ring must show (a11y-checks.ts, focusStop), the keyboard must reach what the journey needs
 * in the order the page is read, and after each action the focus must land where the page says it does. On the pages
 * where a journey ends, the keyboard must be able to Tab on through the page and out of it: nothing traps it.
 *
 * Run in the desktop pass only, at 1440 wide: tests/e2e/parent-a11y.spec.ts walks every page with Tab at 360 for the
 * phone's tab bar. Not walked here, because the run can't reach them: agreeing to sign and signing in Documenso's frame
 * (forms are not set up in the seed). The phone and address form is walked to its Save button and not pressed: a save
 * changes the seed, and tests/e2e/family-details.spec.ts saves it and puts it back. The seed is left as it was found, or in a state the other specs accept: the sign-up is
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
// Journey 1 remembers this browser's device for Zelda (slice SI-3b): it goes after, keeping the seed's, and so do the
// answers to the passkey offer it and journey 13 give on Home (slice SI-8).
test.afterAll(async () => { await removeZeldaDevicesMadeHere(sql); await resetPasskeyOffer(sql); await sink.close(); await sql.end(); });

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

/**
 * Where the focused element sits among the page's Tab stops in document order: whether it is the first, and whether it
 * is the last. A Tab stop is a focusable element with no negative tabindex, not disabled, shown and not inert; of a
 * group of radios, only one is a stop. Run in the page.
 */
function tabEdge(): { first: boolean; last: boolean } {
  const el = document.activeElement;
  const shown = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && !e.closest("[inert]");
  const radios = new Set<string>();
  const stops = [...document.querySelectorAll<HTMLElement>("a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable='true']")].filter((e) => {
    if (e.tabIndex < 0 || (e as HTMLButtonElement).disabled || (e instanceof HTMLInputElement && e.type === "hidden") || !shown(e)) return false;
    if (e instanceof HTMLInputElement && e.type === "radio" && e.name) {
      if (radios.has(e.name)) return el === e; // the one the focus is on stands for its group
      radios.add(e.name);
    }
    return true;
  });
  const at = stops.findIndex((e) => e === el || (e instanceof HTMLInputElement && el instanceof HTMLInputElement && e.type === "radio" && el.type === "radio" && e.name === el.name && e.name !== ""));
  return { first: at === 0, last: at !== -1 && at === stops.length - 1 };
}

/**
 * From where the focus is, Tab goes on through the page and leaves it, or comes round to the top from the page's last
 * Tab stop: nothing traps it. Coming back round to a stop it passed from anywhere but the last is a trap.
 */
async function tabsOut(page: Page, max = 80) {
  const seen: string[] = [];
  let fromLast = false;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(focusStop);
    if (!stop) return;
    const edge = await page.evaluate(tabEdge);
    if (fromLast && edge.first) return;
    fromLast = edge.last;
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

test("the trap measure finds a box that holds the keyboard, and lets a page Tab out or come round from its last stop", async ({ page }) => {
  const body = (inside: string) => `<!doctype html><html lang="en"><body><main><button>Before</button>${inside}<button>After</button></main></body></html>`;
  // A hand-made trap: Tab on its last button goes back to its first, so the keyboard never reaches "After".
  await page.setContent(body(`<div id="box"><button id="a">A</button><button>B</button><button id="c">C</button></div>
    <script>document.getElementById("c").addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.getElementById("a").focus(); } });</script>`));
  await page.locator("#a").focus();
  await expect(tabsOut(page, 20)).rejects.toThrow("Tab never left");
  // The same box with no trap: Tab goes on to "After" and out of the page.
  await page.setContent(body(`<div><button id="a">A</button><button>B</button><button>C</button></div>`));
  await page.locator("#a").focus();
  await tabsOut(page, 20);
  // A page whose Tab comes round to the top from its last stop is not a trap.
  await page.setContent(body(`<div><button id="a">A</button><button>B</button></div>
    <script>document.querySelector("main > button:last-child").addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); document.querySelector("main > button").focus(); } });</script>`));
  await page.locator("#a").focus();
  await tabsOut(page, 20);
  ringProblems = [];
});

const bar = (page: Page, name: string) => page.locator("header.bar").getByRole("link", { name, exact: true });

test("a parent's journeys by keyboard alone: sign in, Home to Payments, a form, a shift and its cancelling, a check-in, the details and the Display page", async ({ page }) => {
  test.setTimeout(180_000);
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
  // The seed's state for the check-in: Zelda's place on the shift on now, not checked in yet.
  await sql`DELETE FROM volunteer_credit WHERE kind = 'checkin' AND removed_at IS NULL
    AND signup_id IN (SELECT s.id FROM volunteer_signup s JOIN accounting_link l ON l.family_id = s.family_id
      WHERE s.shift_id = ${E2E_VOLUNTEER.openShift} AND l.customer_id = 'E2E-FAMILY')`;
  sink.messages.length = 0;

  await test.step("1. signs in with a password and an emailed code: the email, the password, the button, then the code field, Enter signs in", async () => {
    await page.goto("/sign-in");
    // The sign-in page's bar has nothing in it to skip: the first stop is the email field, then the password, then the button.
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Email")).toBeFocused();
    await page.keyboard.type("zelda@example.com");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password")).toBeFocused();
    await page.keyboard.type(E2E_SIGNIN.password);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    // A browser the portal doesn't know for her: the code step, its field taking the focus.
    await expect(page.getByRole("status")).toContainText("enter the 6-digit code we've emailed you");
    await expect(page.getByLabel("6-digit code")).toBeFocused();
    // A wrong code is said as an alert, and the focus stays in the field to try again. The page's own alert, by its
    // words: Next.js keeps an empty role=alert of its own on every page (its route announcer), which a bare
    // getByRole("alert") finds at once, while the button still says Checking… and a second Enter is ignored.
    await page.keyboard.type("000000");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("That code didn't work. Check the newest email from us and try again, or start again with your email and password.");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible(); // no longer Checking…
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
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    // The sign-in proved the code on a new browser, so Home offers a passkey first (slice SI-8): journey 13 walks it by
    // keyboard; here it is answered Not now, and the walk starts from the top as before.
    await passOffer(page);
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
    await expect(page.locator(".list-row").first()).toContainText("Checked in");
    await tabsOut(page);
    ringsShown();
  });

  await test.step("6. Family: opens Update my details, reaches its form, and goes back", async () => {
    await fromTheTop(page);
    await tabTo(page, bar(page, "Family"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family$/);
    await tabTo(page, page.getByRole("link", { name: "Update my details" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family\/details$/);
    // The details are the portal's own (stage 3's slice 11a), so the form is there: its first field and its save are each reached.
    // By the field's role and exact name: the section's heading ("Phone and mailing address") names the section too.
    await tabTo(page, page.getByRole("main").getByRole("textbox", { name: "Phone", exact: true }));
    await tabTo(page, page.getByRole("button", { name: "Save my details" }));
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
  // As tests/e2e/family-email.spec.ts sets it up: offered while parent sign-ins are on, and another person holds the
  // new address, so the confirmation is refused and changes nothing (a change made would end Zelda's sessions, which
  // the later journeys sign in with: since stage 3's slice 11d it is the portal's alone).
  const NEW = "zelda.keys@e2e-moving.example";
  let saved: { setting: unknown[]; strongAt: Date | null };
  const zelda = async () => (await sql`SELECT id, email FROM parent WHERE email = 'zelda@example.com'`)[0]!;

  test.beforeAll(async () => {
    saved = {
      setting: [...await sql`SELECT value FROM setting WHERE key = 'parents.settings'`],
      strongAt: ((await sql`SELECT strong_at FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`)[0]?.strong_at ?? null) as Date | null,
    };
    const on = { signin: true, everEnabled: true, welcome: false, requireActiveStudents: false };
    await sql`INSERT INTO setting (key, value) VALUES ('parents.settings', ${sql.json(on)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    await sql`INSERT INTO parent (name, email) VALUES ('Someone Else', ${NEW})`;
    // A change of sign-in email is asked for only by a session that proved itself in the last 10 minutes (asking
    // again, slice SI-5a): the seeded session is stamped as just proved, a few seconds back so the database's clock
    // never puts it ahead of the app's, and put back after. Asking again by keyboard is journey 10's.
    await sql`UPDATE parent_auth_session SET strong_at = now() - interval '5 seconds' WHERE token = ${PARENT_SESSION_TOKEN}`;
  });

  test.afterAll(async () => {
    await sql`UPDATE parent_auth_session SET strong_at = ${saved.strongAt} WHERE token = ${PARENT_SESSION_TOKEN}`;
    const p = await zelda();
    if (saved.setting.length) await sql`UPDATE setting SET value = ${sql.json((saved.setting[0] as { value: never }).value)} WHERE key = 'parents.settings'`;
    else await sql`DELETE FROM setting WHERE key = 'parents.settings'`;
    await sql`DELETE FROM parent WHERE email = ${NEW}`;
    // The request names the family it was asked in by the app's record, the one Zelda's row in it names.
    const [link] = await sql`SELECT g.id, g.family_id FROM guardian g JOIN accounting_link fl ON fl.family_id = g.family_id
            WHERE g.parent_id = ${p.id} AND fl.customer_id = ${PARENT_SESSION_FAMILY}`;
    await sql`DELETE FROM parent_email_change WHERE parent_id = ${p.id} AND (used_at IS NULL OR new_email = ${NEW})`;
    await sql`INSERT INTO parent_email_change (parent_id, guardian_id, family_id, new_email, token_hash, expires_at)
            VALUES (${p.id}, ${link!.id}, ${link!.family_id}, ${E2E_EMAIL.own.newEmail}, ${emailTokenHash(E2E_EMAIL.own.token)}, now() + interval '7 days')`;
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

    // The link from the email: its one button, refused as the address is another person's, keeps the focus with the alert.
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

test.describe("10. sign-in settings, by keyboard: asking again, then the change form, then forgetting a device", () => {
  // Asking again (slice SI-5a) stamps the seeded session's strong_at, and the code it mails is spent: both are put back
  // as they were. The change form is reached and never sent, and Sign out everywhere is never pressed, so Zelda's
  // password, her device and the seeded session stay as seeded. The device forgotten (slice SI-5b) is this spec's own,
  // made here, used last just now so it is listed first, and removed after if it is still there; Zelda's seeded device,
  // which the seeded session names (scripts/seed-e2e.ts), is listed beside it as "This device" and never forgotten, so
  // the session keeps naming it.
  let strongAt: Date | null = null;
  let ownDevice = "";
  // The second test's own session and devices, removed after: a session of its own, so the seeded one goes on naming
  // Zelda's seeded device.
  const HERE_SESSION_TOKEN = "e2e-journey-10-forget-this-device";
  let hereDevices: string[] = [];
  test.beforeAll(async () => {
    strongAt = ((await sql`SELECT strong_at FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`)[0]?.strong_at ?? null) as Date | null;
    await sql`UPDATE parent_auth_session SET strong_at = NULL WHERE token = ${PARENT_SESSION_TOKEN}`;
    // First remembered long ago, on a day no other device of hers has, so its button's name finds it.
    const [made] = await sql`INSERT INTO parent_device (parent_id, token_hash, created_at, last_used_at, expires_at)
      SELECT id, ${`journey-10-device-${Date.now()}`}, '2001-02-03T12:00:00Z', now(), now() + interval '90 days' FROM parent WHERE email = 'zelda@example.com' RETURNING id`;
    ownDevice = made!.id as string;
  });
  test.afterAll(async () => {
    await sql`UPDATE parent_auth_session SET strong_at = ${strongAt} WHERE token = ${PARENT_SESSION_TOKEN}`;
    await sql`DELETE FROM signin_code WHERE parent_id IN (SELECT id FROM parent WHERE email = 'zelda@example.com')`;
    // The counts this journey's presses took for Zelda (forgetting's per-person press, asking again's per-person or
    // per-device tries), so the seed is left as it was found.
    await sql`DELETE FROM rate_limit_event WHERE kind IN ('signin_settings_parent', 'password_reask_parent', 'password_try_device')
      AND subject IN (SELECT id::text FROM parent WHERE email = 'zelda@example.com'
        UNION SELECT d.id::text FROM parent_device d JOIN parent p ON p.id = d.parent_id WHERE p.email = 'zelda@example.com')`;
    if (ownDevice) await sql`DELETE FROM parent_device WHERE id = ${ownDevice}`;
    await sql`DELETE FROM parent_auth_session WHERE token = ${HERE_SESSION_TOKEN}`;
    if (hereDevices.length > 0) await sql`DELETE FROM parent_device WHERE id IN ${sql(hereDevices)}`;
    hereDevices = [];
  });

  test("Family to Sign-in settings, the password, the emailed code, the change form's fields and button, and forgetting a device", async ({ context, page }) => {
    // The door's own counts (asking again uses them), as the sign-in journeys clear them.
    await sql`DELETE FROM rate_limit_event`;
    await sql`DELETE FROM signin_code WHERE parent_id IN (SELECT id FROM parent WHERE email = 'zelda@example.com')`;
    sink.messages.length = 0;
    await context.addCookies([parentSessionCookie()]);
    await page.goto("/family");
    await tabTo(page, page.getByRole("region", { name: "Your account" }).getByRole("link", { name: "Sign-in settings" }));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/family\/sign-in$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign-in settings");

    // The password: its field, then Continue; the code step's field takes the focus.
    // The field alone: its box is a region headed "Your password" too, which getByLabel() would also find; and the
    // devices box asks again too (slice SI-5b), so the field is the password box's.
    // Until a proof, the devices box draws its own asking again, with a Continue of its own: every step of this one is
    // read inside the password box.
    const passwordBox = page.getByRole("region", { name: "Your password" });
    const password = passwordBox.locator('input[name="password"][autocomplete="current-password"]');
    await tabTo(page, password);
    await page.keyboard.type(E2E_SIGNIN.password);
    await page.keyboard.press("Tab");
    await expect(passwordBox.getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(passwordBox.getByRole("status")).toContainText("We've emailed you a 6-digit code.");
    const code = passwordBox.getByLabel("6-digit code");
    await expect(code).toBeFocused();
    // A wrong code is an alert, and the focus stays in the field.
    await page.keyboard.type("000000");
    await page.keyboard.press("Enter");
    await expect(passwordBox.getByRole("alert")).toHaveText("Problem That code didn't work. Check the newest email from us and try again, or start again with your password.");
    await expect(passwordBox.getByRole("button", { name: "Confirm" })).toBeVisible(); // no longer Checking…
    await expect(code).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(await codeFor(sql, sink, "zelda@example.com"));
    await page.keyboard.press("Enter");

    // Proved: the thank-you takes the focus, and the change form follows it.
    await expect(page.getByRole("status").filter({ hasText: "Thank you, that's you." })).toBeFocused();
    await tabTo(page, page.getByLabel("New password", { exact: true }));
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("New password again")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Change my password" })).toBeFocused();
    // Not pressed: the run never changes Zelda's password. Sign out everywhere follows, and is never pressed either.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Sign out everywhere" })).toBeFocused();

    // The remembered devices (slice SI-5b): the proof covers forgetting too, so each listed device has its button (the
    // spec's own, Zelda's seeded one, and one an earlier journey's sign-in remembered, which goes after the file), then
    // "Forget every other device". The seeded session was made on the seeded device, so its row is "This device" and its
    // button "Forget this device"; every other row's reads "Forget", named by the row's two times.
    const devices = page.getByRole("region", { name: "Remembered devices" });
    const rowButtons = devices.getByRole("listitem").getByRole("button");
    const thisOne = devices.getByRole("listitem").filter({ hasText: "This device" });
    await expect(thisOne).toHaveCount(1);
    await expect(thisOne.getByRole("button", { name: "Forget this device", exact: true })).toHaveCount(1);
    await expect(devices.getByRole("button", { name: "Forget this device", exact: true })).toHaveCount(1);
    const listed = Number((await sql`SELECT count(*)::int AS n FROM parent_device
      WHERE parent_id = (SELECT id FROM parent WHERE email = 'zelda@example.com') AND expires_at > now()`)[0]!.n);
    expect(listed).toBeGreaterThanOrEqual(2);
    await expect(rowButtons).toHaveCount(listed);
    for (let i = 0; i < listed; i++) {
      await page.keyboard.press("Tab");
      await expect(rowButtons.nth(i)).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(devices.getByRole("button", { name: "Forget every other device" })).toBeFocused();
    // Back to the spec's own device, found by its button's name (first remembered in 2001, as made above), and forget
    // it: what happened takes the focus, its row goes, and the seeded device and its "This device" row stay.
    const own = devices.getByRole("button", { name: /^Forget the device first remembered .*2001.*, last used / });
    await expect(own).toHaveCount(1);
    await tabTo(page, own, { back: true });
    await page.keyboard.press("Enter");
    await expect(devices.getByRole("status")).toHaveText("Done That device is forgotten. The next time you sign in on it, we'll email you a code.");
    await expect(devices.getByRole("status")).toBeFocused();
    await expect(rowButtons).toHaveCount(listed - 1);
    await expect(own).toHaveCount(0);
    await expect(thisOne).toHaveCount(1);
    expect(await sql`SELECT id FROM parent_device WHERE id = ${ownDevice}`).toHaveLength(0);
    expect(await sql`SELECT id FROM parent_device WHERE token_hash = ${deviceTokenHash(E2E_SIGNIN.zeldaDevice)}`).toHaveLength(1);
    ownDevice = "";
    await tabsOut(page);
    ringsShown();
  });

  test("forgetting the device this session names leaves the rest as every other device, never a box that can't tell", async ({ context, page }) => {
    // A session of Zelda's own to this test, proved just now and made on a device of its own, with a second device of
    // its own beside it, so the list still has two rows (the spare and the seeded device) once the first is forgotten.
    const made = await sql`INSERT INTO parent_device (parent_id, token_hash, created_at, last_used_at, expires_at)
      SELECT id, ${`journey-10-here-${Date.now()}-`} || n, '2002-03-04T12:00:00Z', now(), now() + interval '90 days'
      FROM parent, (VALUES ('a'), ('b')) AS t(n) WHERE email = 'zelda@example.com' RETURNING id`;
    hereDevices = made.map((r) => r.id as string);
    expect(hereDevices).toHaveLength(2);
    await sql`INSERT INTO parent_auth_session (id, token, user_id, family_id, device_id, expires_at, strong_at)
      SELECT 'e2e-journey-10-session', ${HERE_SESSION_TOKEN}, user_id, family_id, ${hereDevices[0]!}, now() + interval '1 day', now()
      FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`;
    await context.addCookies([parentSessionCookie(HERE_SESSION_TOKEN)]);
    await page.goto("/family/sign-in");
    const devices = page.getByRole("region", { name: "Remembered devices" });
    const thisOne = devices.getByRole("listitem").filter({ hasText: "This device" });
    await expect(thisOne).toHaveCount(1);
    await expect(thisOne).toHaveAttribute("data-device", hereDevices[0]!);
    await tabTo(page, thisOne.getByRole("button", { name: "Forget this device", exact: true }), { max: 60 });
    await page.keyboard.press("Enter");
    await expect(devices.getByRole("status")).toHaveText("Done That device is forgotten. The next time you sign in on it, we'll email you a code.");
    await expect(devices.getByRole("status")).toBeFocused();
    await expect(thisOne).toHaveCount(0);
    // The page is drawn again with the session naming no device: the box still knows the rest are the others.
    await expect(devices.getByText("We can't tell which of these is the device you're using now.")).toHaveCount(0);
    await expect(devices.getByRole("button", { name: "Forget every other device", exact: true })).toHaveCount(1);
    await expect(devices.getByRole("button", { name: "Forget every device", exact: true })).toHaveCount(0);
    expect(await sql`SELECT id FROM parent_device WHERE id = ${hereDevices[0]!}`).toHaveLength(0);
    expect((await sql`SELECT device_id FROM parent_auth_session WHERE token = ${HERE_SESSION_TOKEN}`)[0]?.device_id).toBeNull();
    expect((await sql`SELECT device_id FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`)[0]?.device_id).not.toBeNull();
    ringsShown();
  });
});

test.describe("11. the authenticator app, by keyboard: asking again, the set-up, the key and the backup codes copied, asking again with the app, turning it off", () => {
  // The app is set up for Zelda here, through the page's own presses, and turned off by keyboard as the journey's last
  // step; it and her backup codes are removed after too, for a run cut off midway (the seed gives nobody an app). The
  // seeded session's proof is put back as it was, and the codes and counts the journey took are removed.
  let putProofBack: () => Promise<void> = async () => undefined;
  test.beforeAll(async () => {
    await removeZeldaSecondSteps(sql);
    await clearZeldaCounts(sql);
    putProofBack = await keepZeldaProof(sql);
  });
  test.afterAll(async () => {
    await removeZeldaSecondSteps(sql);
    await clearZeldaCounts(sql);
    await putProofBack();
  });

  test("the password and the emailed code, Set up, the key copied, the app's code, the backup codes copied, then asking again with the app and Turn off", async ({ context, page }) => {
    test.setTimeout(120_000);
    await sql`DELETE FROM rate_limit_event`;
    await setZeldaProof(sql, false);
    sink.messages.length = 0;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addCookies([parentSessionCookie()]);
    await page.goto("/family/sign-in");
    const box = page.getByRole("region", { name: "Authenticator app" });

    // Asking again inside the app's box: its password field, Continue, then the emailed code (Zelda has no app yet).
    const password = box.locator('input[name="password"][autocomplete="current-password"]');
    await tabTo(page, password, { max: 60 });
    await page.keyboard.type(E2E_SIGNIN.password);
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");
    const code = box.getByLabel("6-digit code");
    await expect(code).toBeFocused();
    await page.keyboard.type(await codeFor(sql, sink, "zelda@example.com"));
    await page.keyboard.press("Enter");
    await expect(box.getByRole("status").filter({ hasText: "Thank you, that's you." })).toBeFocused();

    // Set up: the next stop; Enter puts the focus on the words above the QR code.
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Set up an authenticator app", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box.getByText("Scan this QR code with your authenticator app.")).toBeFocused();
    await expect(box.getByRole("img", { name: "QR code to scan with your authenticator app" })).toBeVisible();
    const key = ((await box.locator(".app-key").textContent()) ?? "").trim();
    // The key's copy press, by Tab and Enter: it copies the key alone, and says so.
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Copy the key" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key.replace(/ /g, ""));
    // The code field, then Finish setting up by Enter: the backup codes' words take the focus.
    await page.keyboard.press("Tab");
    await expect(box.getByLabel("Code from your authenticator app", { exact: true })).toBeFocused();
    const at = await page.evaluate(() => Date.now());
    await page.keyboard.type(appCodeAt(key, at));
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Finish setting up" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box.getByRole("status").filter({ hasText: "Your authenticator app is set up." }).first()).toBeFocused();
    const codes = (await box.getByRole("list", { name: "Your backup codes" }).getByRole("listitem").allTextContents()).map((c) => c.trim());
    expect(codes).toHaveLength(10);
    await tabTo(page, box.getByRole("button", { name: "Copy the backup codes" }));
    await page.keyboard.press("Enter");
    await expect(box.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codes.join("\n"));
    ringsShown();

    // Asking again with the app: the proof taken away, the page drawn again; the password, then the app's code.
    await setZeldaProof(sql, false);
    await page.reload();
    const again = box.locator('input[name="password"][autocomplete="current-password"]');
    await tabTo(page, again, { max: 60 });
    await page.keyboard.type(E2E_SIGNIN.password);
    await page.keyboard.press("Enter");
    const appField = box.getByLabel("Code from your authenticator app, or a backup code");
    await expect(appField).toBeFocused();
    await page.keyboard.type(await nextAppCode(page, key, at));
    await page.keyboard.press("Enter");
    await expect(box.getByRole("status").filter({ hasText: "Thank you, that's you." })).toBeFocused();
    // New backup codes (not pressed), then Turn off by Enter: what happened takes the focus, and the box is off again.
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Make new backup codes" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Turn off the authenticator app" })).toBeFocused();
    await page.keyboard.press("Enter");
    const off = box.locator("div[tabindex='-1']").filter({ hasText: "Your authenticator app is turned off" });
    await expect(off).toBeFocused();
    await expect(box.getByRole("button", { name: "Set up an authenticator app", exact: true })).toBeVisible();
    expect(await sql`SELECT id FROM parent_authenticator WHERE parent_id = (SELECT id FROM parent WHERE email = 'zelda@example.com')`).toHaveLength(0);
    await tabsOut(page);
    ringsShown();
  });
});

test.describe("12. passkeys, by keyboard: asking again, adding one, the backup codes copied, renaming and cancelling, asking again with it, removing it", () => {
  // A passkey is added for Zelda here, with Playwright's own authenticator (`context.credentials`, installed before the
  // page touches navigator.credentials), through the page's own presses, and removed by keyboard as the journey's last
  // step; her passkeys, backup codes and counts are removed before and after too, for a run cut off midway (the seed
  // gives nobody a passkey), and the seeded session's proof is put back as it was.
  let putProofBack: () => Promise<void> = async () => undefined;
  const zeldasPasskeys = () => sql`SELECT id FROM parent_auth_passkey WHERE user_id = (SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = 'zelda@example.com'))`;
  const removeZeldasPasskeys = () => sql`DELETE FROM parent_auth_passkey WHERE user_id = (SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = 'zelda@example.com'))`;
  test.beforeAll(async () => {
    await removeZeldasPasskeys();
    await removeZeldaSecondSteps(sql);
    await clearZeldaCounts(sql);
    putProofBack = await keepZeldaProof(sql);
  });
  test.afterAll(async () => {
    await removeZeldasPasskeys();
    await removeZeldaSecondSteps(sql);
    await clearZeldaCounts(sql);
    await putProofBack();
  });

  test("the password and the emailed code, a name and Add, the backup codes copied, Rename then Cancel and Save, Use your passkey, then Remove", async ({ context, page }) => {
    test.setTimeout(120_000);
    await sql`DELETE FROM rate_limit_event`;
    await setZeldaProof(sql, false);
    sink.messages.length = 0;
    await context.credentials.install();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addCookies([parentSessionCookie()]);
    await page.goto("/family/sign-in");
    const box = page.getByRole("region", { name: "Passkeys" });

    // Asking again inside the box: its password field, Continue, then the emailed code (no passkey or app yet). The
    // box's own thanks takes the focus, and the name field is the next stop.
    await tabTo(page, box.locator('input[name="password"][autocomplete="current-password"]'), { max: 80 });
    await page.keyboard.type(E2E_SIGNIN.password);
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Continue" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box.getByLabel("6-digit code")).toBeFocused();
    await page.keyboard.type(await codeFor(sql, sink, "zelda@example.com"));
    await page.keyboard.press("Enter");
    await expect(box.getByRole("status").filter({ hasText: "Thank you, that's you." }).first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box.getByLabel("A name for it (optional)")).toBeFocused();
    await page.keyboard.type("Zelda keyboard key");
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Add a passkey", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");

    // Added: the words above the ten backup codes take the focus, and Copy copies the ten alone, one per line.
    await expect(box.getByRole("status").filter({ hasText: "Your passkey is added, and here are your backup codes." })).toBeFocused();
    const codes = (await box.getByRole("list", { name: "Your backup codes" }).getByRole("listitem").allTextContents()).map((c) => c.trim());
    expect(codes).toHaveLength(10);
    await tabTo(page, box.getByRole("button", { name: "Copy the backup codes" }));
    await page.keyboard.press("Enter");
    await expect(box.getByText("Copied.")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(codes.join("\n"));
    ringsShown();

    // Rename: its field takes the focus; Cancel gives the focus back to Rename; Rename again, a new name, Enter: the
    // answer takes the focus.
    const rename = box.getByRole("button", { name: /^Rename/ });
    await tabTo(page, rename);
    await page.keyboard.press("Enter");
    const field = box.getByLabel("New name");
    await expect(field).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Save the name" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(box.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(rename).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("Zelda renamed key");
    await page.keyboard.press("Enter");
    await expect(box.locator("div[tabindex='-1']").filter({ hasText: "The passkey's name is saved." })).toBeFocused();
    await expect(box.locator(".passkey-name").getByText("Zelda renamed key")).toBeVisible();

    // The add stamped no proof, so removing asks again: Use your passkey is reached, and its thanks takes the focus.
    await tabTo(page, box.getByRole("button", { name: "Use your passkey" }));
    await page.keyboard.press("Enter");
    await expect(box.getByRole("status").filter({ hasText: "Thank you, that's you." }).first()).toBeFocused();

    // Remove sits above the thanks, on the passkey, with the words for the last one: Shift+Tab reaches it, and its
    // answer takes the focus.
    await expect(box.getByText("This is your only passkey.")).toBeVisible();
    await tabTo(page, box.getByRole("button", { name: /^Remove/ }), { back: true });
    await page.keyboard.press("Enter");
    await expect(box.locator("div[tabindex='-1']").filter({ hasText: "That passkey is removed" })).toBeFocused();
    expect(await zeldasPasskeys()).toHaveLength(0);
    await tabsOut(page);
    ringsShown();
  });
});

test.describe("13. the passkey offer on Home, by keyboard: reached, Not now, the answer, then on through Home", () => {
  // A session of Zelda's own to this journey, made and proved just now (five seconds back: the database's clock may run
  // a little ahead of the app's) on a device of its own with no "Not now", as a
  // sign-in by the password and the emailed code leaves one (slice SI-8): Home offers a passkey. Turn on isn't walked
  // here (the ceremony is the browser's own; tests/e2e/passkeys.spec.ts presses it once). The session, its device and
  // Zelda's count are removed and put back after.
  const OFFER_SESSION_TOKEN = "e2e-journey-13-session-token";
  let offerDevice: string | null = null;
  const removeOfferSession = async () => {
    await sql`DELETE FROM parent_auth_session WHERE token = ${OFFER_SESSION_TOKEN}`;
    if (offerDevice) await sql`DELETE FROM parent_device WHERE id = ${offerDevice}`;
    await resetPasskeyOffer(sql);
  };
  // Not now takes a place under the settings' presses (signin_settings_parent): the journeys before it may have used them.
  // A session a run cut off midway left goes first.
  test.beforeAll(async () => { await removeOfferSession(); await clearZeldaCounts(sql); });
  test.afterAll(removeOfferSession);

  test("Tab reaches Turn on, then Not now; Enter answers, the focus lands on the answer, and Tab goes on through Home", async ({ context, page }) => {
    const [made] = await sql`INSERT INTO parent_device (parent_id, token_hash, expires_at)
      SELECT id, ${`journey-13-offer-${Date.now()}`}, now() + interval '90 days' FROM parent WHERE email = 'zelda@example.com' RETURNING id`;
    offerDevice = made!.id as string;
    await sql`INSERT INTO parent_auth_session (id, token, user_id, family_id, device_id, expires_at, created_at, strong_at)
      SELECT 'e2e-journey-13-session', ${OFFER_SESSION_TOKEN}, user_id, family_id, ${offerDevice}, now() + interval '1 day', now() - interval '5 seconds', now() - interval '5 seconds'
      FROM parent_auth_session WHERE token = ${PARENT_SESSION_TOKEN}`;
    await context.addCookies([parentSessionCookie(OFFER_SESSION_TOKEN)]);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    const offer = page.getByRole("region", { name: "Sign in with a passkey next time?" });
    await expect(offer).toBeVisible();
    await fromTheTop(page);
    await tabTo(page, offer.getByRole("button", { name: "Turn on", exact: true }));
    await page.keyboard.press("Tab");
    await expect(offer.getByRole("button", { name: "Not now", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const said = page.locator('[data-passkey-offer="said"]').getByRole("status");
    await expect(said).toHaveText("No problem. We'll leave it for now.");
    await expect(said).toBeFocused();
    await expect(offer).toHaveCount(0);
    expect((await sql`SELECT passkey_offer_declines AS n FROM parent WHERE email = 'zelda@example.com'`)[0]?.n).toBe(1);
    expect((await sql`SELECT passkey_offered_at FROM parent_device WHERE id = ${offerDevice}`)[0]?.passkey_offered_at).not.toBeNull();
    await tabsOut(page);
    ringsShown();
  });
});

test.describe("14. Strict's enrolment, by keyboard: signed in by the password, the app set up on /one-more-step, the backup codes, the box ticked, Continue, Home", () => {
  // Strict is stored for this journey alone and Standard put back after; the guardian is the journey's own, made with a
  // password and no second factor in the seeded family and removed after with all she made (tests/e2e/strict-seed.ts),
  // never Zelda, whose seeded session the gate would sign out at Strict.
  test.beforeAll(async () => { await removeStrictParent(sql); await storeLevel(sql, "strict"); await makeStrictParent(sql); });
  test.afterAll(async () => { await removeStrictParent(sql); await storeLevel(sql, "standard"); });

  test("the email, the password and Enter; Set up, the app's code and Enter; the box ticked with Space; Continue by Enter, and Home", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    await page.goto("/sign-in");
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Email")).toBeFocused();
    await page.keyboard.type(STRICT_PARENT.email);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password")).toBeFocused();
    await page.keyboard.type(STRICT_PARENT.password);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/one-more-step$/);

    // The app's set-up: Tab past the passkey's press to the app's, Enter puts the focus on the words above the QR code.
    const box = page.getByRole("region", { name: ENROLMENT_COPY.appTitle });
    await fromTheTop(page);
    await tabTo(page, box.getByRole("button", { name: ENROLMENT_COPY.appSetUp, exact: true }));
    await page.keyboard.press("Enter");
    await expect(box.getByText("Scan this QR code with your authenticator app.")).toBeFocused();
    const key = ((await box.locator(".app-key").textContent()) ?? "").trim();
    await tabTo(page, box.getByLabel("Code from your authenticator app", { exact: true }));
    await page.keyboard.type(appCodeAt(key, await page.evaluate(() => Date.now())));
    await page.keyboard.press("Enter");
    // Done: the words and the backup codes, the words taking the focus.
    await expect(page.getByRole("status").filter({ hasText: ENROLMENT_COPY.doneApp })).toBeFocused();
    await expect(page.getByRole("list", { name: "Your backup codes" }).getByRole("listitem")).toHaveCount(10);
    // Continue unticked says why and goes nowhere; the box ticked with Space, Continue takes her home.
    const saved = page.getByLabel(ENROLMENT_COPY.saved);
    await tabTo(page, saved);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: ENROLMENT_COPY.continue })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText(ENROLMENT_COPY.tickFirst)).toBeVisible();
    await expect(page).toHaveURL(/\/one-more-step$/);
    await page.keyboard.press("Shift+Tab");
    await expect(saved).toBeFocused();
    await page.keyboard.press("Space");
    await expect(saved).toBeChecked();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${baseURL}/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    ringsShown();
  });
});
