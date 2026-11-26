import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { familyIdOf, familyPages } from "./family-records";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// This run never reaches Intuit: the app has no switch that points it elsewhere. The spec never selects
// "Connect to QuickBooks", "Save this shape", "Refresh now" or "Disconnect"; it only checks that they are there.
// Nor does it reach Boosters Rocket: the run's QBO_RELAY_URL (playwright.config.ts) names a port nothing listens on, so
// the registration's check, the one call to it these tests cause, answers that the relay couldn't be reached.

test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const LAYERED_WORDS = "Layered: families are Family, students are Student, parents are Parent.";
const HOSTILE = "<img src=x onerror=alert(1)> Family";

test("an Admin sees what is set for QuickBooks, and no inputs on the view", async ({ page }) => {
  await page.goto("/staff");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, E2E");
  await page.goto("/staff/settings/quickbooks");
  // The Connection card names the company. The seed keeps a stuck change, so the head and a Notice say it needs attention.
  await expect(page.getByRole("region", { name: "Connection", exact: true }).getByText("E2E Sandbox Company", { exact: true })).toBeVisible();
  await expect(page.locator(".integration-head .status-dot")).toHaveText("Needs attention");
  await expect(page.locator("main")).toContainText("Health says needs attention.");
  await expect(page.getByText("Sandbox (an Intuit test company)")).toBeVisible();
  await expect(page.getByText(LAYERED_WORDS)).toBeVisible();
  await expect(page.getByText("6 families, 4 students, 5 parents; 1 customer outside the portal")).toBeVisible();
  await expect(page.locator("main input:not([type=hidden])")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("9130000000000001");
  await expect(page.getByText("Disconnect", { exact: true })).toBeVisible(); // the closed section's summary; never opened
});

// Stage 4's slice M8: the page an Admin says on, first, that they mean to connect a different company. The seed is
// connected, so it lists what a switch ends and keeps, says to disconnect first, and offers no press. Nothing changes.
test("the switch page lists what a switch ends and keeps, and while connected says to disconnect first, with no press", async ({ page }) => {
  await page.goto("/staff/settings/quickbooks/setup?step=connect");
  const toSwitch = page.getByRole("link", { name: "Connect a different company", exact: true });
  await expect(toSwitch).toHaveAttribute("href", "/staff/settings/quickbooks/switch");
  await page.goto("/staff/settings/quickbooks");
  await expect(page.getByRole("link", { name: "Connect a different company", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Connect a different company", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/quickbooks\/switch$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect a different QuickBooks company");
  await expect(page.getByRole("heading", { name: "What a switch ends" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What is kept" })).toBeVisible();
  await expect(page.getByText(/family links?, \d+ student links? and \d+ guardian links?\. You link them again on Accounting links\./)).toBeVisible();
  await expect(page.getByText("Every signed form, still downloadable by its family and by staff.")).toBeVisible();
  await expect(page.getByText("QuickBooks is connected now. Disconnect it first, from QuickBooks settings, then come back here.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch companies: sign in to Intuit" })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("9130000000000001");
});

test("step 1 keeps what was typed after a refusal and empties the secret after a save", async ({ page, baseURL }) => {
  await page.goto("/staff/settings/quickbooks/setup?step=app");
  await expect(page.getByLabel("Redirect address")).toHaveValue(`${baseURL}/api/quickbooks/callback`);
  await expect(page.getByRole("textbox", { name: "Client ID", exact: true })).toHaveValue("e2e-client-id-1234567890");
  await expect(page.getByLabel(/Client secret/)).toHaveValue("");

  // A Client ID the form refuses (it has spaces): the error shows and all three fields still hold what was typed.
  await page.getByRole("textbox", { name: "Client ID", exact: true }).fill("not a valid client id");
  await page.getByLabel(/Client secret/).fill("typed-secret-one");
  await page.getByRole("radio", { name: /^Production/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Enter the Client ID from your Intuit app's Keys and credentials page.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Client ID", exact: true })).toHaveValue("not a valid client id");
  await expect(page.getByLabel(/Client secret/)).toHaveValue("typed-secret-one");
  await expect(page.getByRole("radio", { name: /^Production/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^Sandbox/ })).not.toBeChecked();

  // The seeded Client ID and environment again, and a new secret: saving while connected is allowed when only the
  // secret changes, and it reaches nothing outside the app. The secret field is empty afterward.
  await page.getByRole("textbox", { name: "Client ID", exact: true }).fill("e2e-client-id-1234567890");
  await page.getByRole("radio", { name: /^Sandbox/ }).check();
  await page.getByLabel(/Client secret/).fill("typed-secret-two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Next: connect to QuickBooks" })).toHaveAttribute("href", "/staff/settings/quickbooks/setup?step=connect");
  await expect(page.getByLabel(/Client secret/)).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Client ID", exact: true })).toHaveValue("e2e-client-id-1234567890");
  await expect(page.getByRole("radio", { name: /^Sandbox/ })).toBeChecked();
});

test("the three steps open in order, and a shape is previewed with the controls keeping the choice", async ({ page }) => {
  await page.goto("/staff/settings/quickbooks");
  await page.getByRole("link", { name: "Change", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/quickbooks\/setup/);

  await page.goto("/staff/settings/quickbooks/setup?step=connect");
  await expect(page.getByRole("button", { name: "Connect to QuickBooks" })).toBeVisible(); // not selected: it would leave for Intuit

  await page.goto("/staff/settings/quickbooks/setup?step=shape");
  await expect(page.getByRole("button", { name: "Save this shape" })).toBeVisible(); // not selected: saving reads QuickBooks
  const layered = page.getByRole("radio", { name: /^Layered/ }), flat = page.getByRole("radio", { name: /^Flat/ });
  const type = (name: string) => page.getByRole("checkbox", { name, exact: true });
  const family = page.getByLabel("A family is a customer of this type"), student = page.getByLabel("A student is a sub-customer of this type"), parent = page.getByLabel("A parent is a sub-customer of this type");
  await expect(layered).toBeChecked();
  await expect(family).toHaveValue("E2E-T1");

  // The saved layered shape, previewed: the kind and each select still hold the choice afterward.
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(/^6 families/)).toBeVisible();
  await expect(page.getByText(/^4 students/)).toBeVisible();
  await expect(page.getByText(/^5 parents/)).toBeVisible();
  await expect(page.getByText("1 customers outside the portal")).toBeVisible();
  await expect(layered).toBeChecked();
  await expect(family).toHaveValue("E2E-T1");
  await expect(student).toHaveValue("E2E-T3");
  await expect(parent).toHaveValue("E2E-T2");

  // A layered choice that differs from the saved shape (no student type): a control that went back to its starting
  // value after Preview would show Student again here.
  await student.selectOption("");
  await expect(page.getByText("The choice has changed since this preview. Select Preview again to see what it would show.")).toBeVisible();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(/^0 students/)).toBeVisible();
  await expect(page.getByText("5 customers outside the portal")).toBeVisible();
  await expect(layered).toBeChecked();
  await expect(family).toHaveValue("E2E-T1");
  await expect(student).toHaveValue("");
  await expect(parent).toHaveValue("E2E-T2");

  // Switch to flat and choose Student: the layered preview no longer applies.
  await flat.check();
  await expect(page.getByText("The choice has changed since this preview. Select Preview again to see what it would show.")).toBeVisible();
  await type("Student").check();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("4 members (Leo Rivera, Wolfgang Secondborn, Xochitl Quetzalcoatl, and more)")).toBeVisible();
  await expect(page.getByText("12 customers outside the portal")).toBeVisible();
  await expect(page.getByText("The choice has changed since this preview.")).toHaveCount(0);
  await expect(flat).toBeChecked();
  await expect(type("Student")).toBeChecked();
  await expect(type("Parent")).not.toBeChecked();
  await expect(type("Family")).not.toBeChecked();

  // Change one control: the line replaces the preview. Preview again for the new result.
  await type("Parent").check();
  await expect(page.getByText("The choice has changed since this preview. Select Preview again to see what it would show.")).toBeVisible();
  await expect(page.getByText(/^4 members/)).toHaveCount(0);
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(/^9 members/)).toBeVisible();
  await expect(page.getByText("7 customers outside the portal")).toBeVisible();
  await expect(type("Parent")).toBeChecked();
  await expect(type("Student")).toBeChecked();

  // Nothing was saved: saving reads QuickBooks again, and this run never reaches Intuit.
  await page.goto("/staff/settings/quickbooks");
  await expect(page.getByText(LAYERED_WORDS)).toBeVisible();
});

test("staff open a family from the roster, hostile names stay text, and the visit is in the audit log", async ({ page }) => {
  await page.goto("/staff/roster");
  // The hostile family has no parent and no student, so Needs attention lists it too; look inside Families.
  const families = page.getByRole("region", { name: "Families" });
  await expect(families.getByRole("link", { name: "Rivera Family" })).toBeVisible();
  await expect(families.getByText(HOSTILE)).toBeVisible();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Lincoln High");
  await expect(page.getByRole("region", { name: /^Needs attention/ }).getByText(HOSTILE).first()).toBeVisible(); // listed once for each rule it breaks
  await expect(page.getByRole("region", { name: "How fresh this is" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh now" })).toBeVisible(); // not selected: it would call Intuit

  await page.getByLabel("Find a family").fill("river");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(families.getByRole("link", { name: "Rivera Family" })).toBeVisible();
  await expect(families.locator(`a[href='${await familyPages.roster("E2E-20")}']`)).toHaveCount(0);
  // Each family links to its page by its app family record, never by its customer.
  await expect(families.getByRole("link", { name: "Rivera Family" })).toHaveAttribute("href", await familyPages.roster("E2E-10"));
  // Only rows written from here on count: an earlier run, or the other project, leaves the same action behind.
  const [mark] = await sql`SELECT coalesce(max(id), 0) AS id FROM audit_log`;
  await families.getByRole("link", { name: "Rivera Family" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rivera Family");
  await expect(page.getByRole("region", { name: "Parents in QuickBooks" }).getByRole("row").filter({ hasText: "ana@example.com" })).toContainText("555-0101");
  await expect(page.getByRole("region", { name: "Students" }).getByText("Leo Rivera", { exact: true })).toBeVisible();
  const reads = await sql`SELECT target_type, target_id, actor_label FROM audit_log WHERE id > ${mark!.id} AND action = 'roster.family.read'`;
  // One visit, one row, naming the app's own family record.
  expect(reads.map((r) => ({ ...r }))).toEqual([{ target_type: "family", target_id: await familyIdOf("E2E-10"), actor_label: "e2e-admin@example.org" }]);
  await page.goto("/staff/settings/audit");
  await expect(page.getByText("roster.family.read").first()).toBeVisible();
});

test("the roster and QuickBooks settings are refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/staff/roster");
  await expect(page).toHaveURL(/\/staff\/sign-in/);
  await page.goto("/staff/settings/quickbooks");
  await expect(page).toHaveURL(/\/staff\/sign-in/);
  await context.close();
});

// Connect through Boosters Rocket (docs/superpowers/specs/2026-11-24-connect-through-boosters-rocket-design.md, §8 "End
// to end"). The seed connects with the club's own app, and every test here puts its mode, its registration, its
// token_mode and the relay's mark back, whatever happens in it.
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
const E2E_PORTAL_ID = "brp_e2e0portal0id001";
async function backToTheSeed() {
  await sql`DELETE FROM qbo_relay`;
  await sql`DELETE FROM setting WHERE key = 'health.mark.quickbooks_relay'`;
  await sql`UPDATE qbo_connection SET connect_mode = 'own_app', token_mode = 'own_app', relay_environment = null, state_hash = null, state_staff_user_id = null, state_expires_at = null, state_mode = null`;
}
async function checked(page: Page, where: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${where} scrolls sideways`).toBe(false);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(["color-contrast"]).analyze();
  expect(results.violations.flatMap((v) => v.nodes.map((n) => `${where} · ${n.target.join(" ")}: ${v.id} (${v.help})`))).toEqual([]);
}

test("an Admin chooses Boosters Rocket, makes the key, copies the address and key, and saves the id to reach Ready to connect", async ({ page, baseURL }) => {
  try {
    await page.goto("/staff/settings/quickbooks/setup?step=app");
    await expect(page.getByRole("heading", { name: "Step 1: How to connect" })).toBeVisible();
    const relay = page.getByRole("radio", { name: /^Connect through Boosters Rocket/ }), own = page.getByRole("radio", { name: /^Use our own Intuit app/ });
    await expect(own).toBeChecked();
    await expect(page.getByRole("heading", { name: "Your Intuit app" })).toBeVisible();
    await checked(page, "step 1, the club's own app");

    // Through Boosters Rocket: the registration shows under the choice before it is saved, and saving is one press.
    await relay.check();
    await expect(page.getByRole("heading", { name: "Not registered yet" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your Intuit app" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save this choice" }).click();
    await expect(page.getByRole("button", { name: "Save this choice" })).toHaveCount(0);
    await expect(relay).toBeChecked();
    await checked(page, "step 1, not registered yet");

    // The key: made on the server, its public half shown with the portal's address, each with a Copy button.
    await page.getByRole("button", { name: "Make this portal's key" }).click();
    await expect(page.getByRole("heading", { name: "Waiting for the id" })).toBeVisible();
    await expect(page.getByLabel("This portal's address")).toHaveValue(baseURL!);
    await expect(page.getByLabel("This portal's public key")).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
    await expect(page.getByRole("button", { name: "Copy" })).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Write the email" })).toHaveAttribute("href", /^mailto:support@boostersrocket\.com\?/);
    await expect(page.locator("body")).not.toContainText("PRIVATE KEY");
    await checked(page, "step 1, waiting for the id");

    // A bad id is refused and nothing moves on; the id Boosters Rocket sent back is saved, and the check can't reach it.
    await page.getByLabel("Portal id").fill("not-an-id");
    await page.getByRole("button", { name: "Save the portal id" }).click();
    await expect(page.getByRole("heading", { name: "Waiting for the id" })).toBeVisible();
    await page.getByLabel("Portal id").fill(E2E_PORTAL_ID);
    await page.getByRole("button", { name: "Save the portal id" }).click();
    await expect(page.getByRole("heading", { name: "Ready to connect" })).toBeVisible();
    await expect(page.getByText(E2E_PORTAL_ID, { exact: true })).toBeVisible();
    await expect(page.getByText(/Boosters Rocket couldn.t be reached just now, so the registration wasn.t checked\./)).toBeVisible();
    await expect(page.locator("summary", { hasText: "Make a new key" })).toBeVisible(); // a closed section; never opened
    await checked(page, "step 1, ready to connect");
  } finally {
    await backToTheSeed();
  }
});

test("step 2 through Boosters Rocket asks which QuickBooks and shows QuickBooks' logo, black on light and white on dark", async ({ page }) => {
  await sql`UPDATE qbo_connection SET connect_mode = 'relay'`;
  try {
    await page.goto("/staff/settings/quickbooks/setup?step=connect");
    await expect(page.getByRole("heading", { level: 2, name: "Step 2: Connect to QuickBooks" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Which QuickBooks" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^The club's real books/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /^An Intuit sandbox \(test\) company/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect to QuickBooks" })).toBeVisible(); // not selected: it would leave for Boosters Rocket
    const black = page.locator(".qb-full-logo img.qb-on-light"), white = page.locator(".qb-full-logo img.qb-on-dark");
    const theme = (t: string | null) => page.evaluate((v) => { if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme; }, t);
    await page.emulateMedia({ colorScheme: "light" }); await theme(null);
    await expect(black).toBeVisible(); await expect(white).toBeHidden();
    await checked(page, "step 2 through Boosters Rocket");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(white).toBeVisible(); await expect(black).toBeHidden();
    // The portal's own theme wins over the device's, either way.
    await theme("light");
    await expect(black).toBeVisible(); await expect(white).toBeHidden();
    await page.emulateMedia({ colorScheme: "light" }); await theme("dark");
    await expect(white).toBeVisible(); await expect(black).toBeHidden();
  } finally {
    await backToTheSeed();
  }
});

// The owner's finding of 2026-11-25: the switch asks which QuickBooks through Boosters Rocket, and with the club's own app
// says which one its keys are for. The seed's connection is hidden (its company kept for the roster) and put back; the
// press is never selected: it would leave for Boosters Rocket or Intuit.
test("once disconnected, the switch page asks which QuickBooks through Boosters Rocket, and names the own app's", async ({ page }) => {
  await sql`UPDATE qbo_connection SET realm_id = NULL`;
  try {
    await page.goto("/staff/settings/quickbooks/switch");
    await expect(page.getByRole("button", { name: "Switch companies: sign in to Intuit" })).toBeVisible();
    await expect(page.getByText("The club's Intuit app is set to sandbox, Intuit's test companies. To connect the other, save the app's Production keys in step 1.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Step 1: How to connect" })).toHaveAttribute("href", "/staff/settings/quickbooks/setup?step=app");
    await expect(page.getByRole("group", { name: "Which QuickBooks" })).toHaveCount(0);

    await sql`UPDATE qbo_connection SET connect_mode = 'relay', relay_environment = 'sandbox'`;
    await page.goto("/staff/settings/quickbooks/switch");
    await expect(page.getByRole("group", { name: "Which QuickBooks" })).toBeVisible();
    const real = page.getByRole("radio", { name: /^The club's real books/ }), sandbox = page.getByRole("radio", { name: /^An Intuit sandbox \(test\) company/ });
    await expect(sandbox).toBeChecked();
    await real.check();
    await expect(real).toBeChecked();
    await expect(sandbox).not.toBeChecked();
    await expect(page.getByText("The club's Intuit app is set to")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: /^I understand that every family's link to the books ends/ })).toBeVisible();
    await checked(page, "the switch page through Boosters Rocket");
  } finally {
    await sql`UPDATE qbo_connection SET realm_id = '9130000000000001'`;
    await backToTheSeed();
  }
});

// The owner's finding of 2026-11-25, step 2: step 2 asks which company while nothing is connected and the roster names
// one, and shows what a switch ends and keeps in place for a different one. The seed's connection is hidden (its company
// kept for the roster) and put back; Connect to QuickBooks is never selected: it would leave for Intuit.
test("once disconnected, step 2 asks which company, and a different one shows what a switch ends and its box", async ({ page }) => {
  await sql`UPDATE qbo_connection SET realm_id = NULL`;
  try {
    await sql`UPDATE setting SET value = ${sql.json({ realmId: "9130000000000001", companyName: "E2E Sandbox Company", environment: "sandbox" })} WHERE key = 'roster.source'`;
    await page.goto("/staff/settings/quickbooks/setup?step=connect");
    const same = page.getByRole("radio", { name: /^The same company as before \(E2E Sandbox Company\)/ }), other = page.getByRole("radio", { name: /^A different company/ });
    await expect(page.getByRole("group", { name: "Which company" })).toBeVisible();
    await expect(same).toBeEnabled();
    await expect(page.getByRole("heading", { name: "What a switch ends" })).toHaveCount(0);
    await other.check();
    await expect(page.getByRole("heading", { name: "What a switch ends" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /^I understand that every family's link to the books ends/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect to QuickBooks" })).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Connect a different company", exact: true })).toHaveClass(/\bbtn\b/);
    await checked(page, "step 2's company question");

    // The club's app is set to the sandbox; families read from the real books make it a different company.
    await sql`UPDATE setting SET value = ${sql.json({ realmId: "9130000000000001", companyName: "E2E Sandbox Company", environment: "production" })} WHERE key = 'roster.source'`;
    await page.goto("/staff/settings/quickbooks/setup?step=connect");
    await expect(same).toBeDisabled();
    await expect(other).toBeChecked();
    await expect(page.getByText("The families came from the club's real books, and the club's Intuit app is set to a sandbox company, so this is a different company.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("9130000000000001");
  } finally {
    await sql`UPDATE setting SET value = ${sql.json({ realmId: "9130000000000001" })} WHERE key = 'roster.source'`;
    await sql`UPDATE qbo_connection SET realm_id = '9130000000000001'`;
  }
});

test("Disconnect through Boosters Rocket stays unusable until the box is ticked; the club's own app has one line and no box", async ({ page }) => {
  // The club's own app first: one line, no box, and the button usable (never selected).
  await page.goto("/staff/settings/quickbooks");
  await page.getByText("Disconnect", { exact: true }).click();
  await expect(page.getByText("If another portal uses this same Intuit app's keys for this company, it is disconnected too.")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect QuickBooks" })).not.toHaveAttribute("aria-disabled", "true");

  await sql`UPDATE qbo_connection SET connect_mode = 'relay', token_mode = 'relay', relay_environment = environment`;
  try {
    await page.goto("/staff/settings/quickbooks");
    await expect(page.getByRole("region", { name: "Connection", exact: true }).getByText("Through Boosters Rocket", { exact: true })).toBeVisible();
    await page.getByText("Disconnect", { exact: true }).click();
    await expect(page.getByText("Every portal connected to this QuickBooks company through Boosters Rocket shares one connection. Disconnecting here may disconnect the others too, such as a trial copy of this portal.")).toBeVisible();
    const ack = page.getByRole("checkbox", { name: "I understand that disconnecting may also disconnect any other portal connected to this company through Boosters Rocket." });
    const press = page.getByRole("button", { name: "Disconnect QuickBooks" });
    await expect(ack).not.toBeChecked();
    await expect(press).toHaveAttribute("aria-disabled", "true");
    await expect(press).not.toHaveAttribute("disabled", /.*/); // aria-disabled, never disabled, so it keeps the focus
    await checked(page, "QuickBooks settings, Disconnect through Boosters Rocket");
    await ack.check();
    await expect(press).not.toHaveAttribute("aria-disabled", "true");
    await ack.uncheck();
    await expect(press).toHaveAttribute("aria-disabled", "true");
    // Never selected: the run holds made-up tokens, and a disconnect would end the seed's connection.
  } finally {
    await backToTheSeed();
  }
});

test("QuickBooks' own ball marks its row on Integrations and the QuickBooks page's head", async ({ page }) => {
  await page.goto("/staff/settings/integrations");
  await expect(page.locator('img[src="/integrations/quickbooks/qb-ball.svg"]').first()).toBeVisible();
  await page.goto("/staff/settings/quickbooks");
  await expect(page.locator('.integration-head img[src="/integrations/quickbooks/qb-ball.svg"]')).toBeVisible();
});
