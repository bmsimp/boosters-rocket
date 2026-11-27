import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { familyPages } from "./family-records";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });
test.describe.configure({ mode: "serial" });

// The run does everything twice (phone, then desktop) against one seeded database, and may be run again without
// re-seeding. Each test leaves things as it found them, or passes from either state. The seed switches parent sign-ins
// on (the door is closed until they are), and every spec that signs a parent in needs them on, so nothing here
// switches them off. Welcome emails stay off: the worker isn't running here, and a welcome to a
// seeded address would land in the sink that spec reads.

const mark = async () => Number((await sql`SELECT coalesce(max(id), 0) AS id FROM audit_log`)[0]!.id);

// Who can sign in is the portal's own guardians (scripts/seed-e2e.ts): Zelda in her two families and Ana in the Rivera
// family, so 2 people to 3 families, whatever QuickBooks holds. Switching on opens and closes no row.
test("an Admin switches parent sign-ins on (and finds them on the second time)", async ({ page }) => {
  const since = await mark();
  await page.goto("/staff/settings/parents/setup?step=signins");
  await expect(page.getByRole("heading", { name: "Step 1: Parent sign-ins" })).toBeVisible();
  await expect(page.getByText("Clean-up preview")).toHaveCount(0);
  const on = page.getByRole("button", { name: "Switch parent sign-ins on" });
  if (await on.count()) {
    await expect(page.getByText("Switching on lets 2 people sign in, to 3 families: the guardians the portal holds for each family.")).toBeVisible();
    await on.click();
    // The page says so in words once it is on: the pressed button is gone by then, and its message with it.
    await expect(page.getByText("Parent sign-ins are on. 2 people can sign in, to 3 families.")).toBeVisible();
    const saves = await sql`SELECT after FROM audit_log WHERE id > ${since} AND action = 'settings.parents.save'`;
    expect(saves).toHaveLength(1);
    expect(saves[0]!.after).toMatchObject({ signin: true });
  } else {
    await expect(page.getByText("Parent sign-ins are on. 2 people can sign in, to 3 families.")).toBeVisible();
  }
  // Nobody was made or let in from QuickBooks: Sam's parent records gave him no sign-in.
  const made = await sql`SELECT action FROM audit_log WHERE id > ${since} AND action IN ('parent.create', 'parent.access.granted', 'parent.access.ended')`;
  expect(made).toEqual([]);
  expect(await sql`SELECT 1 FROM parent WHERE email = 'sam@example.com'`).toHaveLength(0);

  await page.goto("/staff/settings/parents");
  const details = page.locator("dl.details");
  await expect(details.locator("dt", { hasText: "Parent sign-ins" }).locator("xpath=following-sibling::dd[1]")).toHaveText("On");
  await expect(details.locator("dt", { hasText: "Who can sign in" }).locator("xpath=following-sibling::dd[1]")).toHaveText("2 people, to 3 families");
  await expect(details.locator("dt", { hasText: "Welcome emails" }).locator("xpath=following-sibling::dd[1]")).toHaveText("Off: nobody is emailed");
  await expect(details.locator("dt", { hasText: "Waiting for staff" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Configure", exact: true })).toBeVisible();
  await expect(page.locator("main input:not([type=hidden]), main textarea, main select")).toHaveCount(0);
  const [row] = await sql`SELECT value FROM setting WHERE key = 'parents.settings'`;
  expect(row!.value).toMatchObject({ signin: true, welcome: false });
});

test("the staff home and the Parents page have nothing to review", async ({ page }) => {
  await page.goto("/staff");
  await expect(page.getByText(/address(es)? to review/)).toHaveCount(0);
  await page.goto("/staff/parents");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Parents");
  await expect(page.getByRole("heading", { name: /^To review/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "ana@example.com" })).toContainText("Rivera Family");
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
    // Whatever happened above, Ana ends unblocked. Through the database: unblocking changes no link, and with welcome
    // emails off it owes nothing, so these columns are all an unblock changes.
    await sql`UPDATE parent SET blocked = false, blocked_at = null, blocked_by = null, blocked_reason = null, updated_at = now()
      WHERE email = 'ana@example.com' AND blocked`;
  }
});

test("a family's roster page lists its guardians; a family with none in the portal has none, whatever QuickBooks holds", async ({ page }) => {
  await page.goto(await familyPages.roster("E2E-10"));
  await expect(page.getByRole("heading", { name: "Portal sign-ins" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Portal sign-ins" }).getByRole("row").filter({ hasText: "ana@example.com" })).toContainText(/Can sign in/);
  await page.goto(await familyPages.roster("E2E-40"));
  const signins = page.getByRole("region", { name: "Portal sign-ins" });
  await expect(signins.getByText("Nobody can sign in for it yet.")).toBeVisible();
  await expect(signins).not.toContainText("sam@example.com");
  await page.goto("/staff/roster");
  const attention = page.getByRole("region", { name: /^Needs attention/ });
  await expect(attention).toBeVisible();
  await expect(attention).not.toContainText("Once parent sign-ins are on, nobody at that address can sign in");
  await expect(attention).not.toContainText("sam@example.com");
});

test("the Parent sign-ins and Parents pages are refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ["/staff/parents", "/staff/settings/parents", "/staff/settings/parents/setup"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/staff\/sign-in/);
  }
  await context.close();
});
