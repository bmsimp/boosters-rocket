import { test, expect, type Locator, type Page } from "@playwright/test";
import postgres from "postgres";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";
import { noSidewaysScroll, shot, staffMenuTo } from "./journey-helpers";
import { familyPages } from "./family-records";

// A staff member's working session, walked by what they would tap (docs/walkthrough.md): the seeded Admin goes from the
// staff home through the grouped menu to the roster and one family, its money, the Parents list, a guardian added to a
// family and removed again, a new season with a
// requirement of each kind, a tick and a waiver (and what the parent then reads), a volunteer event with a shift, its
// sign-up list and check-in sheet, a correction to a family's credit, the signed-forms matrix and one form's evidence,
// Balances, Reconciliation, the audit log and its export, Health and Settings. It runs at 390 wide in the phone pass
// and 1440 in the desktop pass.
//
// Nothing here reaches QuickBooks: no change made here is a write to it (a roster change from the browser is refused
// by the seed's ids, tests/e2e/roster-writes.spec.ts). First-time setup on an
// empty database is walked by hand and written in docs/walkthrough.md: this run's database is seeded and finished.
// What the walk makes is taken away again, so the season, volunteer and credit specs count what the seed holds.
const sql = postgres(process.env.DATABASE_URL!);
const SEASON = "Walk season (e2e)", EVENT = "Walk car wash (e2e)", NOTE = "Walk e2e: helped at the pit, by hand", WAIVER = "Walk e2e waiver: away all term";
const GUARDIAN = { name: "Walk Guardian", email: "walk.guardian@example.com" };

async function tidy() {
  // The guardian the walk adds and removes: their row, then the person (their sign-in account goes with them).
  for (const p of await sql`SELECT id FROM parent WHERE email = ${GUARDIAN.email}`) {
    await sql`DELETE FROM parent_auth_session WHERE user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${p.id as string})`;
    await sql`DELETE FROM guardian WHERE parent_id = ${p.id as string}`;
    await sql`DELETE FROM parent WHERE id = ${p.id as string}`;
  }
  await sql`DELETE FROM volunteer_credit WHERE note = ${NOTE}`;
  const events = await sql`SELECT id FROM volunteer_event WHERE name = ${EVENT}`;
  for (const e of events) {
    await sql`DELETE FROM volunteer_shift WHERE event_id = ${e.id as string}`;
    await sql`DELETE FROM volunteer_event WHERE id = ${e.id as string}`;
  }
  await sql`DELETE FROM season WHERE name = ${SEASON}`;
  await sql`DELETE FROM requirement_progress WHERE waived_reason = ${WAIVER}`;
}

test.describe.configure({ mode: "serial" });
test.beforeAll(tidy);
test.afterAll(async () => { await tidy(); await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const box = (page: Page, name: string | RegExp) => page.getByRole("region", { name });
/** Opens a disclosure by its summary, unless it is open already (a step with nothing in it starts with its form open). */
async function opened(details: Locator) {
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator("summary").first().click();
}

test("a staff member's session: the roster, a season, volunteering, forms, money and the club's records", async ({ page, context }) => {
  test.setTimeout(180_000);

  await test.step("starts on the staff home and opens a family from the roster", async () => {
    await page.goto("/staff");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, E2E");
    // The seed's waiting and stuck changes.
    await expect(page.locator("[data-today]").filter({ hasText: "stuck on its way to QuickBooks" })).toHaveCount(1);
    await noSidewaysScroll(page);
    await shot(page, "s01-home");
    await staffMenuTo(page, "Families", "Roster");
    await expect(page).toHaveURL(/\/staff\/roster$/);
    await page.getByRole("link", { name: "Quetzalcoatl Family" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    await noSidewaysScroll(page);
    await shot(page, "s02-family");
  });

  await test.step("follows the family to what it owes", async () => {
    await box(page, "More about this family").getByRole("link", { name: "What it owes" }).click();
    // Addressed by the family's app record, which the seed makes anew each time (./family-records.ts).
    await expect(page).toHaveURL(/\/staff\/balances\/[0-9a-f-]{36}$/);
    expect(new URL(page.url()).pathname).toBe(await familyPages.balance("E2E-FAMILY"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    await expect(page.locator("main")).toContainText("$185.00");
    await noSidewaysScroll(page);
    await shot(page, "s03-family-money");
  });

  await test.step("reads Parents: everyone the portal holds, and each family they belong to", async () => {
    await staffMenuTo(page, "Families", "Parents");
    await expect(page).toHaveURL(/\/staff\/parents$/);
    // The seed's guardians: Zelda in her two families, Ana in the Rivera family. Nothing is held for review any more.
    const zelda = page.getByRole("row").filter({ hasText: "zelda@example.com" });
    await expect(zelda).toContainText("Quetzalcoatl Family");
    await expect(zelda).toContainText("Second Family");
    await expect(page.locator("main")).not.toContainText("To review");
    await noSidewaysScroll(page);
    await shot(page, "s04-parents");
  });

  await test.step("adds a guardian to a family, then removes them with a note only staff see", async () => {
    const since = Number((await sql`SELECT coalesce(max(id), 0) AS id FROM audit_log`)[0]!.id);
    await page.goto(await familyPages.roster("E2E-50"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Lee Family");
    const signins = box(page, "Portal sign-ins");
    await signins.getByLabel("Name", { exact: true }).fill(GUARDIAN.name);
    await signins.getByLabel("Email address they sign in with").fill(GUARDIAN.email);
    await signins.getByRole("button", { name: "Add guardian" }).click();
    await expect(signins.getByText(`Added ${GUARDIAN.name}.`, { exact: false })).toBeVisible();
    const row = signins.getByRole("row").filter({ hasText: GUARDIAN.email });
    await expect(row).toContainText("Can sign in (hasn't yet)");
    await noSidewaysScroll(page);
    await shot(page, "s04b-guardian-added");
    await row.locator("summary").click();
    await row.getByLabel("Why? (staff only)").fill("Walk e2e: added by the walk");
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(signins.getByRole("row").filter({ hasText: GUARDIAN.email })).toContainText("Can't sign in: removed by staff");
    // The answer outlives the swap of Remove for Reinstate, and the focus, whose button went, is on it.
    await expect(signins.getByRole("row").filter({ hasText: GUARDIAN.email }).getByRole("status")).toContainText("Removed. They can't sign in to this family any more");
    await expect(page.locator(":focus")).toContainText("Removed.");
    await expect(signins.getByRole("button", { name: `Reinstate ${GUARDIAN.name}` })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Walk e2e: added by the walk");
    const made = await sql`SELECT action, after FROM audit_log WHERE id > ${since} AND action IN ('parent.create', 'parent.access.granted', 'parent.access.ended') ORDER BY id`;
    expect(made.map((r) => r.action).sort()).toEqual(["parent.access.ended", "parent.access.granted", "parent.create"]);
    expect(made.find((r) => r.action === "parent.access.ended")!.after).toMatchObject({ reason: "removed", note: "Walk e2e: added by the walk" });
  });

  await test.step("sets up a season with a requirement of each kind", async () => {
    await staffMenuTo(page, "Season", "Seasons");
    await expect(page).toHaveURL(/\/staff\/seasons$/);
    await page.getByLabel("Season name, such as Fall 2027").fill(SEASON);
    await page.getByRole("button", { name: "Start with no steps" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(SEASON);
    await page.getByLabel("Step name").fill("Walk step");
    await page.getByRole("button", { name: "Add step" }).click();
    const step = box(page, "1. Walk step");
    await expect(step).toBeVisible();
    for (const [kind, title] of [["Checklist item", "Walk checklist"], ["Form", "Walk form"], ["Payment", "Walk payment"], ["Volunteering", "Walk volunteering"]] as const) {
      await opened(step.locator("details", { has: page.getByText("Add a requirement to Walk step") }));
      await step.getByLabel("Kind").selectOption({ label: kind });
      await step.getByLabel("What it is, in your club's words").fill(title);
      if (kind === "Volunteering") await step.getByLabel("How much").fill("2");
      await step.getByRole("button", { name: "Add requirement" }).click();
      await expect(step.getByRole("link", { name: title })).toBeVisible();
    }
    await expect(step).toContainText(/Walk checklist\s*Checklist item/);
    await expect(step).toContainText(/Walk form\s*Form/);
    await expect(step).toContainText(/Walk payment\s*Payment/);
    await expect(step).toContainText(/Walk volunteering\s*Volunteering/);
    await noSidewaysScroll(page);
    await shot(page, "s05-new-season");
  });

  await test.step("waives a requirement for one family; the parent reads Waived and never the reason; then the waiver is removed", async () => {
    await staffMenuTo(page, "Season", "Progress");
    await page.getByRole("link", { name: "Banquet RSVP" }).click();
    const row = page.locator(".progress-rows tbody tr").filter({ hasText: "Quetzalcoatl Family" });
    await row.getByText("Waive for Quetzalcoatl Family").click();
    await row.getByLabel(/^Why\?/).fill(WAIVER);
    await row.getByRole("button", { name: "Waive", exact: true }).click();
    // Drawn again from what was saved (the reason typed is in the text box until then, so it can't be the sign).
    await expect(row.getByRole("button", { name: "Remove waiver" })).toBeVisible();
    await expect(row.locator(".when")).toContainText(WAIVER);
    await noSidewaysScroll(page);
    await shot(page, "s06-waived");
    await context.addCookies([parentSessionCookie()]);
    await page.goto("/season");
    const wrap = page.getByRole("region", { name: "4. Wrap-up" });
    await expect(wrap).toContainText(/Banquet RSVP\s*Waived/);
    await expect(page.locator("body")).not.toContainText(WAIVER);
    await page.goBack();
    await page.reload();
    await row.getByRole("button", { name: "Remove waiver" }).click();
    await expect(row.getByText("Waive for Quetzalcoatl Family")).toBeVisible();
  });

  await test.step("runs a volunteer event: a shift, its sign-up list and its check-in sheet", async () => {
    await staffMenuTo(page, "Season", "Volunteering");
    await expect(page).toHaveURL(/\/staff\/volunteer$/);
    const add = box(page, "Add an event");
    await add.getByLabel("Event name, such as Home game concessions").fill(EVENT);
    await add.getByLabel("Date").fill(new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10));
    await add.getByLabel("Where").fill("Bandroom parking lot");
    await add.getByLabel("Who to contact").fill("Pat Organizer");
    await add.getByRole("button", { name: "Add event" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(EVENT);
    const shiftBox = box(page, "Add a shift");
    await shiftBox.getByLabel("Starts at").fill("09:00");
    await shiftBox.getByLabel(/^Ends at/).fill("11:00");
    await shiftBox.getByLabel("Places").fill("3");
    await shiftBox.getByLabel(/^Role/).fill("Hoses");
    await shiftBox.getByRole("button", { name: "Add shift" }).click();
    const shift = box(page, "9:00 am to 11:00 am, Hoses");
    await expect(shift).toContainText("0 of 3 places filled");
    await expect(shift).toContainText("Nobody has signed up yet.");
    await noSidewaysScroll(page);
    await shot(page, "s07-event");
    await shift.getByRole("link", { name: "Check-in code to print" }).click();
    await expect(page).toHaveURL(/\/staff\/volunteer\/check-in\/[0-9a-f-]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Check in: ${EVENT}`);
    await expect(page.locator("svg.checkin-qr")).toBeVisible();
    await expect(page.locator(".checkin-address")).toContainText("/volunteer/check-in/");
    await noSidewaysScroll(page);
    await shot(page, "s08-check-in-sheet");
  });

  await test.step("corrects a family's volunteer credit, and takes the correction back", async () => {
    await staffMenuTo(page, "Season", "Volunteer credit");
    await page.getByRole("link", { name: "Quetzalcoatl Family" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
    await page.getByLabel("Counts toward").selectOption({ label: (await page.getByLabel("Counts toward").locator("option", { hasText: "Pit crew hours" }).textContent())! });
    await page.getByLabel("Hours, such as 2 or 1.5").fill("1");
    await page.getByLabel("What was done (only staff see this)").fill(NOTE);
    await page.getByRole("button", { name: "Add credit" }).click();
    const credit = page.getByRole("row").filter({ hasText: NOTE });
    await expect(credit).toBeVisible();
    await noSidewaysScroll(page);
    await shot(page, "s09-credit");
    await credit.getByText("Remove this credit").click();
    await credit.getByLabel(/^Why it's being removed/).fill("Walk e2e: entered by mistake");
    await credit.getByRole("button", { name: "Remove it" }).click();
    await expect(page.getByRole("region", { name: "Removed credit" }).getByRole("row").filter({ hasText: NOTE })).toContainText("Removed");
  });

  await test.step("reads the signed-forms matrix and one form's evidence", async () => {
    await staffMenuTo(page, "Season", "Signed forms");
    await expect(page).toHaveURL(/\/staff\/forms$/);
    await noSidewaysScroll(page);
    await shot(page, "s10-forms");
    await page.getByRole("link", { name: /Signed.*Quetzalcoatl|Quetzalcoatl.*Signed|Travel consent/ }).first().click();
    await expect(page.locator("main")).toContainText("Zelda Quetzalcoatl");
    await noSidewaysScroll(page);
    await shot(page, "s11-form-evidence");
  });

  await test.step("reads Balances and Reconciliation", async () => {
    await staffMenuTo(page, "Money", "Balances");
    await expect(page).toHaveURL(/\/staff\/balances$/);
    await expect(page.locator("main")).toContainText("Worth a look");
    await noSidewaysScroll(page);
    await shot(page, "s12-balances");
    await staffMenuTo(page, "Money", "Reconciliation");
    await expect(box(page, /^Changes waiting to reach QuickBooks/)).toContainText("Stuck (1)");
    await noSidewaysScroll(page);
    await shot(page, "s13-reconciliation");
  });

  await test.step("reads the audit log, finds the walk's own visits, and exports it", async () => {
    await staffMenuTo(page, "Admin", "Audit");
    await expect(page).toHaveURL(/\/staff\/audit/);
    await expect(page.locator("main")).toContainText("Requirement waived");
    await noSidewaysScroll(page);
    await shot(page, "s14-audit");
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: /^Export/ }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  });

  await test.step("opens Health and Settings", async () => {
    await staffMenuTo(page, "Admin", "Health");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Health");
    await noSidewaysScroll(page);
    await shot(page, "s15-health");
    await staffMenuTo(page, null, "Settings");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
    await page.getByRole("link", { name: "Open club settings" }).click();
    await expect(page.getByRole("link", { name: "Back to Settings" })).toBeVisible();
    await noSidewaysScroll(page);
    await shot(page, "s16-settings-club");
  });
});
