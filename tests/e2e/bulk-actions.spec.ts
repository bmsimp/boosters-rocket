import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { BULK, seedBulk } from "./bulk-seed";

/**
 * The bulk actions on the QuickBooks setup screens (src/lib/bulk.ts), at each project's width (390 and 1440), with axe:
 * tick rows, open the action's Drawer from the bar (on a phone, from "N selected · Actions"), read what would happen to
 * each row, press, and read what did. Accounting links' Link to their suggested families and Create families, on data
 * each test adds and takes away (tests/e2e/bulk-seed.ts); Reconciliation's Try again and Give up on two changes the test
 * queues and removes, so the seed's own waiting and stuck changes (tests/e2e/roster-writes.spec.ts) are left alone. The
 * worker never runs in this run, so nothing is sent.
 */
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
async function checked(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(["color-contrast"]).analyze();
  expect(results.violations.flatMap((v) => v.nodes.map((n) => `${where} · ${n.target.join(" ")}: ${v.id} (${v.help})`))).toEqual([]);
}
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

/** Opens a bulk action of the list `bulk` (its BulkSelect): from the bar on a wide screen, from "N selected · Actions" on a phone. */
async function openAction(page: Page, bulk: Locator, phone: boolean, count: number, noun: string, label: string): Promise<Locator> {
  if (phone) {
    await bulk.getByRole("button", { name: `${count} selected · Actions` }).click();
    await page.getByRole("dialog", { name: `${count} ${noun} selected` }).getByRole("button", { name: label }).click();
  } else {
    await bulk.locator(".bulk-bar").getByRole("button", { name: label }).click();
  }
  const drawer = page.getByRole("dialog", { name: label });
  await expect(drawer).toBeVisible();
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return drawer;
}

test("Accounting links: link a Suggested family, and create a family from a customer with no family, in bulk", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  const { drop } = await seedBulk(sql);
  try {
    await page.goto("/staff/links");
    const families = page.getByRole("region", { name: "Families" });
    const row = families.getByRole("row").filter({ hasText: BULK.family });
    await expect(row).toContainText("Suggested");
    // Only a Suggested row has a box: Rivera Family is linked already.
    await expect(families.getByRole("checkbox", { name: "Select Rivera Family" })).toHaveCount(0);
    await families.getByRole("checkbox", { name: `Select ${BULK.family}` }).check();
    let drawer = await openAction(page, families.locator(".bulk"), phone, 1, "family", "Link 1 to its suggested family");
    await expect(drawer).toContainText(`“${BULK.linkName}” to ${BULK.family}`);
    await expect(drawer).toContainText("Nothing is sent to QuickBooks.");
    await checked(page, "Link to their suggested families, before");
    await drawer.getByRole("button", { name: "Link 1 customer" }).click();
    let results = page.getByRole("dialog", { name: "Link 1 to its suggested family" });
    await expect(results.getByText("1 linked.")).toBeVisible();
    await expect(results).toContainText(`${BULK.family}: Linked`);
    await checked(page, "Link to their suggested families, after");
    await noSidewaysScroll(page);
    await results.getByRole("button", { name: "Done" }).click();
    await expect(results).toBeHidden();
    await expect(families.getByRole("row").filter({ hasText: BULK.family })).toContainText("Linked");
    expect((await sql`SELECT customer_id, origin FROM accounting_link WHERE family_id IS NOT NULL AND customer_id = ${BULK.linkId}`).map((r) => [r.customer_id, r.origin])).toEqual([[BULK.linkId, "confirmed"]]);

    const noFamily = page.getByRole("region", { name: /^Customers with no family/ });
    await noFamily.getByRole("checkbox", { name: `Select ${BULK.makeName}` }).check();
    drawer = await openAction(page, noFamily.locator(".bulk"), phone, 1, "customer", "Create 1 family");
    await expect(drawer).toContainText(`${BULK.makeName}: A linked family.`);
    await checked(page, "Create families, before");
    await drawer.getByRole("button", { name: "Create 1 family" }).click();
    results = page.getByRole("dialog", { name: "Create 1 family" });
    await expect(results.getByText("1 family made.")).toBeVisible();
    await expect(results).toContainText(`${BULK.makeName}: Made a family, linked`);
    await checked(page, "Create families, after");
    await results.getByRole("button", { name: "Done" }).click();
    expect(await sql`SELECT 1 FROM accounting_link WHERE family_id IS NOT NULL AND customer_id = ${BULK.makeId}`).toHaveLength(1);
  } finally {
    await drop();
  }
});

test("Reconciliation: try two stuck changes again, then give them up with one note, in bulk", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  const [rivera] = await sql`SELECT family_id FROM accounting_link WHERE customer_id = 'E2E-10' AND family_id IS NOT NULL`;
  const items = await sql`INSERT INTO write_queue (realm_id, request, target_qbo_id, family_id, state, sent, tries, last_code, last_tried_at, next_try_at, asked_by_label, created_at)
          SELECT '9130000000000001', jsonb_build_object('op', 'rename', 'role', 'student', 'qboId', 'E2E-12', 'syncToken', '0', 'name', n, 'was', 'Leo Rivera'), 'E2E-12', ${rivera!.family_id},
            'stuck', false, 8, 'http_429', now() - interval '1 hour', null, 'e2e-admin@example.org', now() - interval '2 hours'
          FROM unnest(ARRAY['Leo Bulk A', 'Leo Bulk B']) AS n RETURNING id`;
  try {
    await page.goto("/staff/reconciliation");
    const writes = page.getByRole("region", { name: "Changes waiting to reach QuickBooks" });
    let bulk = writes.locator(".bulk").filter({ hasText: "Leo Bulk A" });
    for (const name of ["Leo Bulk A", "Leo Bulk B"]) await bulk.getByRole("checkbox", { name: new RegExp(`^Select .*${name}`) }).check();
    let drawer = await openAction(page, bulk, phone, 2, "changes", "Try 2 changes again");
    await expect(drawer).toContainText("Leo Bulk A");
    await checked(page, "Try again, before");
    await drawer.getByRole("button", { name: "Try 2 changes again" }).click();
    let results = page.getByRole("dialog", { name: "Try 2 changes again" });
    await expect(results.getByText("2 asked to be tried again.")).toBeVisible();
    await checked(page, "Try again, after");
    await results.getByRole("button", { name: "Done" }).click();
    expect((await sql`SELECT state FROM write_queue WHERE id IN ${sql(items.map((i) => i.id as string))}`).map((r) => r.state)).toEqual(["waiting", "waiting"]);

    // Now waiting: ticked again in the Waiting list, and given up with one note.
    await page.reload();
    bulk = writes.locator(".bulk").filter({ hasText: "Leo Bulk A" });
    for (const name of ["Leo Bulk A", "Leo Bulk B"]) await bulk.getByRole("checkbox", { name: new RegExp(`^Select .*${name}`) }).check();
    drawer = await openAction(page, bulk, phone, 2, "changes", "Give up on 2 changes");
    await drawer.getByLabel("Why? One note for them all (kept in the audit log)").fill("Renamed by hand in QuickBooks.");
    await checked(page, "Give up, before");
    await drawer.getByRole("button", { name: "Give up on 2 changes" }).click();
    results = page.getByRole("dialog", { name: "Give up on 2 changes" });
    await expect(results.getByText("2 given up.")).toBeVisible();
    await noSidewaysScroll(page);
    await results.getByRole("button", { name: "Done" }).click();
    expect((await sql`SELECT state, note FROM write_queue WHERE id IN ${sql(items.map((i) => i.id as string))}`).map((r) => [r.state, r.note]))
      .toEqual([["given_up", "Renamed by hand in QuickBooks."], ["given_up", "Renamed by hand in QuickBooks."]]);
  } finally {
    await sql`DELETE FROM write_queue WHERE id IN ${sql(items.map((i) => i.id as string))}`;
  }
});
