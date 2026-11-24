import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { familyIdOf, familyPages } from "./family-records";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// This run never reaches Intuit: the app has no switch that points it elsewhere. The spec never selects
// "Connect to QuickBooks", "Save this shape", "Refresh now" or "Disconnect"; it only checks that they are there.

test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const LAYERED_WORDS = "Layered: families are Family, students are Student, parents are Parent.";
const HOSTILE = "<img src=x onerror=alert(1)> Family";

test("an Admin sees what is set for QuickBooks, and no inputs on the view", async ({ page }) => {
  await page.goto("/staff");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, E2E");
  await page.goto("/staff/settings/quickbooks");
  // The Connection card names the company. The seed keeps a stuck change, so the head and a Notice say it needs attention.
  await expect(page.getByRole("region", { name: "Connection" }).getByText("E2E Sandbox Company", { exact: true })).toBeVisible();
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
  await expect(page.getByLabel("Client ID")).toHaveValue("e2e-client-id-1234567890");
  await expect(page.getByLabel(/Client secret/)).toHaveValue("");

  // A Client ID the form refuses (it has spaces): the error shows and all three fields still hold what was typed.
  await page.getByLabel("Client ID").fill("not a valid client id");
  await page.getByLabel(/Client secret/).fill("typed-secret-one");
  await page.getByRole("radio", { name: /^Production/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Enter the Client ID from your Intuit app's Keys and credentials page.")).toBeVisible();
  await expect(page.getByLabel("Client ID")).toHaveValue("not a valid client id");
  await expect(page.getByLabel(/Client secret/)).toHaveValue("typed-secret-one");
  await expect(page.getByRole("radio", { name: /^Production/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /^Sandbox/ })).not.toBeChecked();

  // The seeded Client ID and environment again, and a new secret: saving while connected is allowed when only the
  // secret changes, and it reaches nothing outside the app. The secret field is empty afterward.
  await page.getByLabel("Client ID").fill("e2e-client-id-1234567890");
  await page.getByRole("radio", { name: /^Sandbox/ }).check();
  await page.getByLabel(/Client secret/).fill("typed-secret-two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByLabel(/Client secret/)).toHaveValue("");
  await expect(page.getByLabel("Client ID")).toHaveValue("e2e-client-id-1234567890");
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
