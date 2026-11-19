import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { familyPages } from "./family-records";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// Staff changes to the roster in QuickBooks (roadmap step 5). This run's QuickBooks connection holds made-up tokens,
// and no seeded customer or customer type has an id that is digits (scripts/seed-e2e.ts; tests/e2e/family-details.spec.ts
// checks it), so every change here is refused by the client before anything is sent: the browser shows the forms, the
// name offered when one is taken, and the refusal. Sending and the cache that follows are covered against the stub in
// vitest (tests/integration/roster-writes.test.ts), as is a flat-shaped club. Nothing here changes the roster, so both
// passes of the run (phone, then desktop) find the seed as it was.
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
const mark = async () => Number((await sql`SELECT coalesce(max(id), 0) AS id FROM audit_log`)[0]!.id);

test.describe("staff", () => {
  test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

  test("add a student: a taken name is offered with a suffix, and the send is refused before it reaches QuickBooks", async ({ page }) => {
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
    await expect(changes.getByText("That couldn't be sent to QuickBooks, so nothing was changed.")).toBeVisible();
    await expect(changes.getByLabel("The student's name, as QuickBooks will show it")).toHaveValue("Leo Rivera (2)");
    // Refused by the client for its ids, and audited; nothing reached the roster or the queue.
    const refused = await sql`SELECT after FROM audit_log WHERE id > ${since} AND action = 'roster.write.refused'`;
    expect(refused.map((r) => r.after)).toEqual([{ op: "create", role: "student", code: "bad_id" }]);
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM qbo_customer` as unknown as [{ n: number }];
    expect(after).toBe(before);
    expect(await sql`SELECT id FROM write_queue WHERE request->>'name' = 'Leo Rivera (2)'`).toHaveLength(0);
  });

  test("a family's page says what can be changed here and what is changed in QuickBooks", async ({ page }) => {
    await page.goto(await familyPages.roster("E2E-40"));
    await expect(page.getByRole("region", { name: "Changing the roster" })).toContainText("Email addresses, phone numbers and mailing addresses are changed in QuickBooks");
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
