import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { familyPages } from "./family-records";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// Staff changes to the roster in QuickBooks (roadmap step 5). This run's QuickBooks connection holds made-up tokens,
// and no seeded customer or customer type has an id that is digits (scripts/seed-e2e.ts; tests/e2e/family-details.spec.ts
// checks it), so every change here is refused by the client before anything is sent: the browser shows the forms, the
// name offered when one is taken, and the refusal. A student added to a linked family is saved in the portal first
// (stage 3's slice 9e), so its refusal is kept on Reconciliation; the test removes both after, so both passes of the
// run (phone, then desktop) find the seed as it was. Sending and the cache that follows are covered against the stub
// in vitest (tests/integration/roster-writes.test.ts, linked-saved-first.test.ts), as is a flat-shaped club.
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
const mark = async () => Number((await sql`SELECT coalesce(max(id), 0) AS id FROM audit_log`)[0]!.id);

test.describe("staff", () => {
  test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

  test("add a student: a taken name is offered with a suffix; the student is saved in the portal first, and QuickBooks' refusal is kept on Reconciliation", async ({ page }) => {
    const since = await mark();
    const [{ n: before }] = await sql`SELECT count(*)::int AS n FROM qbo_customer` as unknown as [{ n: number }];
    await page.goto(await familyPages.roster("E2E-10"));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rivera Family");
    const changes = page.getByRole("region", { name: "Change in QuickBooks" });
    await changes.getByText("Add a student").click();
    await changes.getByLabel("The student's name, as QuickBooks will show it").fill("Leo Rivera");
    await changes.getByRole("button", { name: "Add the student" }).click();
    const alert = changes.getByRole("alert").first();
    await expect(alert).toContainText("“Leo Rivera” is already a name in QuickBooks");
    const offer = changes.getByRole("button", { name: "Use “Leo Rivera (2)”" });
    await expect(offer).toBeVisible();
    await noSidewaysScroll(page);
    await offer.click();
    // Saved in the portal first (stage 3's slice 9e); the client refuses the send for its ids, and the refusal is kept.
    await expect(changes.getByText("Leo Rivera (2) is added to Rivera Family in the portal, but they aren't in QuickBooks", { exact: false })).toBeVisible();
    const kept = await sql`SELECT after FROM audit_log WHERE id > ${since} AND action = 'roster.write.kept_refused'`;
    expect(kept.map((r) => r.after)).toEqual([{ op: "create", role: "student", code: "bad_id", state: "refused" }]);
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM qbo_customer` as unknown as [{ n: number }];
    expect(after).toBe(before);
    const items = await sql`SELECT id, state, student_id FROM write_queue WHERE request->>'name' = 'Leo Rivera (2)'`;
    expect(items.map((i) => i.state)).toEqual(["refused"]);
    try {
      // On Reconciliation under its own heading, with what can be done about it.
      await page.goto("/staff/reconciliation");
      const writes = page.getByRole("region", { name: "Changes waiting to reach QuickBooks" });
      await expect(writes.getByRole("heading", { name: "Not in QuickBooks, kept in the portal (1)" })).toBeVisible();
      const row = writes.getByRole("row").filter({ hasText: "Add the student “Leo Rivera (2)” to Rivera Family" });
      await expect(row).toContainText("It couldn't be sent to QuickBooks");
      await expect(row.getByRole("button", { name: "Send the portal's value" })).toBeVisible();
      await noSidewaysScroll(page);
    } finally {
      // Left as the seed was, for the other pass: the kept refusal goes, and the student saved first with it.
      for (const i of items) {
        await sql`DELETE FROM write_queue WHERE id = ${i.id}`;
        if (i.student_id) await sql`DELETE FROM student WHERE id = ${i.student_id}`;
      }
    }
  });

  test("a family's page says what can be changed here and what is changed in QuickBooks", async ({ page }) => {
    await page.goto(await familyPages.roster("E2E-40"));
    await expect(page.getByRole("region", { name: "Change in QuickBooks" })).toContainText("A guardian's phone and mailing address are the portal's own. Guardians change them on their Family page, and staff on the person's page");
    const waiting = page.getByRole("region", { name: "Waiting to reach QuickBooks" });
    await expect(waiting).toContainText("Rename the parent “Sam Okafor” to “Samuel Okafor”");
    await expect(page.getByText("A change to Sam Okafor is waiting to reach QuickBooks, so nothing else can be changed for now.")).toBeVisible();
    await noSidewaysScroll(page);
  });

  test("the Reconciliation page lists the waiting and the stuck changes, with what can be done about them", async ({ page }) => {
    const res = await page.goto("/staff/reconciliation");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reconciliation");
    const writes = page.getByRole("region", { name: "Changes waiting to reach QuickBooks" });
    await expect(writes.getByRole("heading", { name: "Stuck (1)" })).toBeVisible();
    await expect(writes.getByRole("heading", { name: "Waiting (1)" })).toBeVisible();
    const stuck = writes.getByRole("row").filter({ hasText: "Add the student “Pat Lee” to Lee Family" });
    await expect(stuck).toContainText("Stuck: it won't be tried again until someone asks");
    await expect(stuck).toContainText("QuickBooks asked the portal to slow down (http_429)");
    await expect(stuck.getByRole("button", { name: "Try again now" })).toBeVisible(); // not selected: the worker would take it up
    const waitingOne = writes.getByRole("row").filter({ hasText: "Rename the parent “Sam Okafor” to “Samuel Okafor”" });
    await expect(waitingOne).toContainText("e2e-admin@example.org");
    await expect(waitingOne).toContainText("QuickBooks didn't answer in time (timeout)");
    await expect(page.getByRole("region", { name: /^Needs attention in the roster/ })).toBeVisible();
    // The Admin may see money: the second family's student is worth a look (scripts/seed-e2e.ts).
    await expect(page.getByRole("region", { name: "Money worth a look" }).getByRole("link", { name: "Second Family" })).toBeVisible();
    await noSidewaysScroll(page);
  });
});

test("the Reconciliation page is refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/staff/reconciliation");
  await expect(page).toHaveURL(/\/staff\/sign-in/);
  await context.close();
});
