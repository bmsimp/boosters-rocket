import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });
test.describe.configure({ mode: "serial" });

// The run does everything twice (phone, then desktop) against one seeded database, and may be run again without
// re-seeding. Each test leaves things as it found them, or passes from either state. The one change meant to last is
// "parent sign-ins on": tests/e2e/parent-sign-in.spec.ts passes with them on or never switched on, never switched off,
// so nothing here switches them off. Welcome emails stay off: the worker isn't running here, and a welcome to a
// seeded address would land in the sink that spec reads.

const mark = async () => Number((await sql`SELECT coalesce(max(id), 0) AS id FROM audit_log`)[0]!.id);
const HELD_DETAIL = "This person's email address is under more than one family in QuickBooks. Once parent sign-ins are on, nobody at that address can sign in to those families until someone with access to Parents says whether it is one person.";

/**
 * The decide test's clean-up, run whatever happened before it: when a decision on Sam's address is still there, it is
 * reversed through the Parents page. Not through the database: only the real reverse runs the reconcile that closes
 * the sign-ins the decision opened.
 */
async function reverseSamIfDecided(page: Page) {
  const [row] = await sql`SELECT 1 FROM held_address WHERE email = 'sam@example.com'
    AND (jsonb_array_length(approved_family_qbo_ids) > 0 OR jsonb_array_length(rejected_family_qbo_ids) > 0)`;
  if (!row) return;
  await page.goto("/staff/parents");
  const decided = page.getByRole("region", { name: "Decided" }).getByRole("listitem").filter({ hasText: "sam@example.com" });
  await decided.getByText("Reverse this decision").click();
  await decided.getByLabel("Why? (staff only)").fill("Reversed by the e2e run.");
  await decided.getByRole("button", { name: "Reverse", exact: true }).click();
  await expect(page.getByRole("heading", { name: "To review (1)" })).toBeVisible();
}

test("an Admin previews, then switches parent sign-ins on (and finds them on the second time)", async ({ page }) => {
  await page.goto("/staff/settings/parents/setup?step=preview");
  await expect(page.getByRole("heading", { name: "Step 1: What would happen" })).toBeVisible();
  await expect(page.getByText("2 people would be able to sign in, to 3 families.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Addresses under more than one family (1)" })).toBeVisible();
  await expect(page.getByText("sam@example.com: Okafor Family, Lee Family")).toBeVisible();
  // Zelda's two sign-ins come from records that are in QuickBooks (scripts/seed-e2e.ts), so the reconcile keeps them: none would end.
  // The list is worked out only while sign-ins are off, so on the second pass, with them on, it isn't there at all.
  const [before] = await sql`SELECT value FROM setting WHERE key = 'parents.settings'`;
  if ((before?.value as { signin?: boolean } | undefined)?.signin) await expect(page.getByRole("heading", { name: /Sign-ins that would end/ })).toHaveCount(0);
  else await expect(page.getByRole("heading", { name: "Sign-ins that would end (0)" })).toBeVisible();

  const since = await mark();
  await page.goto("/staff/settings/parents/setup?step=signins");
  await expect(page.getByRole("heading", { name: "Step 2: Parent sign-ins" })).toBeVisible();
  const on = page.getByRole("button", { name: "Switch parent sign-ins on" });
  if (await on.count()) {
    await on.click();
    // The page says so in words once it is on: the pressed button is gone by then, and its message with it.
    await expect(page.getByText("Parent sign-ins are on. 2 people can sign in, to 3 families.")).toBeVisible();
    const saves = await sql`SELECT after FROM audit_log WHERE id > ${since} AND action = 'settings.parents.save'`;
    expect(saves).toHaveLength(1);
    expect(saves[0]!.after).toMatchObject({ signin: true, everEnabled: true });
  } else {
    await expect(page.getByText("Parent sign-ins are on. 2 people can sign in, to 3 families.")).toBeVisible();
  }

  await page.goto("/staff/settings/parents");
  const details = page.locator("dl.details");
  await expect(details.locator("dt", { hasText: "Parent sign-ins" }).locator("xpath=following-sibling::dd[1]")).toHaveText("On");
  await expect(details.locator("dt", { hasText: "Who can sign in" }).locator("xpath=following-sibling::dd[1]")).toHaveText("2 people, to 3 families");
  await expect(details.locator("dt", { hasText: "Welcome emails" }).locator("xpath=following-sibling::dd[1]")).toHaveText("Off: nobody is emailed");
  await expect(details.locator("dt", { hasText: "Waiting for staff" }).locator("xpath=following-sibling::dd[1]")).toHaveText("1 address to review");
  await expect(page.getByRole("link", { name: "Change", exact: true })).toBeVisible();
  await expect(page.locator("main input:not([type=hidden]), main textarea, main select")).toHaveCount(0);
  const [row] = await sql`SELECT value FROM setting WHERE key = 'parents.settings'`;
  expect(row!.value).toMatchObject({ signin: true, everEnabled: true, welcome: false });
});

test("the staff home and the Parents page show the held address; a refusal keeps the note; deciding and reversing work", async ({ page }) => {
  await page.goto("/staff");
  await expect(page.getByText("1 address to review", { exact: true })).toBeVisible();
  await page.goto("/staff/parents");
  await expect(page.getByRole("heading", { name: "To review (1)" })).toBeVisible();
  const waiting = page.getByRole("region", { name: /^To review/ });
  await expect(waiting.getByText("sam@example.com")).toBeVisible();
  await expect(waiting.getByRole("listitem").filter({ hasText: "Okafor Family" }).last()).toContainText("Held");
  await expect(waiting.getByRole("listitem").filter({ hasText: "Lee Family" }).last()).toContainText("Held");

  try {
    // No note: refused.
    await waiting.getByRole("button", { name: "Same person", exact: true }).click();
    await expect(waiting.getByRole("alert")).toContainText("Add a short note saying how you know.");

    // A note, but the address stopped being under two families after the page loaded: refused, and the note stays.
    const note = waiting.getByLabel("How do you know? (staff only)");
    await note.fill("Sam confirmed by phone.");
    await sql`UPDATE qbo_customer SET active = false WHERE qbo_id = 'E2E-51'`;
    try {
      await waiting.getByRole("button", { name: "Same person", exact: true }).click();
      await expect(waiting.getByRole("alert")).toContainText("That address isn't held any more. Reload the page.");
    } finally {
      await sql`UPDATE qbo_customer SET active = true WHERE qbo_id = 'E2E-51'`;
    }
    await expect(note).toHaveValue("Sam confirmed by phone.");

    const since = await mark();
    await waiting.getByRole("button", { name: "Same person", exact: true }).click();
    await expect(page.getByRole("heading", { name: "To review (0)" })).toBeVisible();
    const decided = page.getByRole("region", { name: "Decided" }).getByRole("listitem").filter({ hasText: "sam@example.com" });
    await expect(decided).toContainText("Same person in Okafor Family, Lee Family.");
    await expect(decided).toContainText("Sam confirmed by phone.");
    const rows = await sql`SELECT action, after FROM audit_log WHERE id > ${since} AND action IN ('parent.hold.decided', 'parent.access.granted') ORDER BY id`;
    expect(rows.map((r) => r.action)).toEqual(["parent.hold.decided", "parent.access.granted", "parent.access.granted"]);
    expect(rows[0]!.after).toMatchObject({ decision: "same_person", familyQboIds: ["E2E-40", "E2E-50"], note: "Sam confirmed by phone." });
    expect(rows[1]!.after).toMatchObject({ cause: "hold" });

    // Put it back, so the second pass of the run starts from the same place.
    await decided.getByText("Reverse this decision").click();
    await decided.getByLabel("Why? (staff only)").fill("Reversed by the e2e run.");
    await decided.getByRole("button", { name: "Reverse", exact: true }).click();
    await expect(page.getByRole("heading", { name: "To review (1)" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Decided" }).getByText("sam@example.com")).toHaveCount(0);
  } finally {
    await reverseSamIfDecided(page);
  }
});

test("a person's page: block needs a reason, block, then unblock; the visit is in the audit log", async ({ page }) => {
  const since = await mark();
  await page.goto("/staff/parents?q=ana%40example.com");
  await page.getByRole("link", { name: "Ana Rivera" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ana Rivera");
  await expect(page.getByRole("button", { name: "Resend welcome email" })).toBeVisible(); // not selected: it would send an email

  try {
    const block = page.getByRole("region", { name: "Block", exact: true });
    await block.getByRole("button", { name: "Block", exact: true }).click();
    await expect(block.getByRole("alert")).toContainText("Say why, in a few words. Only staff see it.");
    await block.getByLabel("Why? (staff only)").fill("e2e block");
    await block.getByRole("button", { name: "Block", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Blocked", exact: true })).toBeVisible();
    await expect(page.getByText(/Reason: e2e block/)).toBeVisible();
    await expect(page.getByText("This person is blocked, so no email can be sent.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resend welcome email" })).toHaveCount(0);

    await page.getByRole("button", { name: "Unblock", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Block", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unblock", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Resend welcome email" })).toBeVisible();

    const rows = await sql`SELECT action, after FROM audit_log WHERE id > ${since} AND action IN ('parent.read', 'parent.block', 'parent.unblock') ORDER BY id`;
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["parent.read", "parent.block", "parent.unblock"]));
    expect(JSON.stringify(rows.filter((r) => r.action === "parent.block").map((r) => r.after))).toContain("e2e block");
    const [ana] = await sql`SELECT blocked, blocked_reason FROM parent WHERE email = 'ana@example.com'`;
    expect({ ...ana }).toEqual({ blocked: false, blocked_reason: null });
  } finally {
    // Whatever happened above, Ana ends unblocked. Through the database: unblocking changes no link and runs no
    // reconcile, and with welcome emails off it owes nothing, so these columns are all an unblock changes.
    await sql`UPDATE parent SET blocked = false, blocked_at = null, blocked_by = null, blocked_reason = null, updated_at = now()
      WHERE email = 'ana@example.com' AND blocked`;
  }
});

test("a family's roster page shows who can sign in and why someone can't; Needs attention lists the held item without the address", async ({ page }) => {
  await page.goto("/staff/roster/E2E-40");
  await expect(page.getByRole("heading", { name: "Portal sign-ins" })).toBeVisible();
  const signins = page.getByRole("region", { name: "Portal sign-ins" });
  await expect(signins.getByText("sam@example.com · Held: this address is also under Lee Family")).toBeVisible();
  await page.goto("/staff/roster/E2E-10");
  await expect(page.getByRole("region", { name: "Portal sign-ins" }).getByText(/^ana@example\.com · Can sign in/)).toBeVisible();
  await page.goto("/staff/roster");
  const attention = page.getByRole("region", { name: /^Needs attention/ });
  await expect(attention).toBeVisible();
  const held = attention.getByRole("row").filter({ hasText: HELD_DETAIL });
  await expect(held).toHaveCount(1);
  await expect(held).toContainText("Sam Okafor");
  await expect(attention).not.toContainText("sam@example.com");
});

test("the match review goes back to the settings when there is no previous company", async ({ page }) => {
  await page.goto("/staff/settings/parents/matches");
  await expect(page).toHaveURL(/\/staff\/settings\/parents$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Parent sign-ins");
});

test("the Parent sign-ins and Parents pages are refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ["/staff/parents", "/staff/settings/parents", "/staff/settings/parents/setup", "/staff/settings/parents/matches"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/staff\/sign-in/);
  }
  await context.close();
});
