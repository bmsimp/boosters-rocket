import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { E2E_BUYOUT } from "./buyout-seed";

// Staff close a buy-out from Reconciliation (src/lib/buyouts/close.ts): the Rivera family's buy-out of its trailer
// shifts, which QuickBooks refused (scripts/seed-e2e.ts, tests/e2e/buyout-seed.ts). Closing sends nothing to
// QuickBooks, and every id in the seed is not digits, so nothing could reach Intuit anyway. At desktop width only: the
// phone pass would close it first. A run on a seed this spec already closed finds it closed, and checks that instead.
const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });
test.beforeEach(async ({ context }, info) => {
  test.skip(info.project.name !== "desktop", "staff close the seeded buy-out once, at desktop width");
  await context.addCookies([staffSessionCookie()]);
});

const NOTE = "The Rivera family will volunteer instead: closed in the browser run.";

test("staff close a refused buy-out from Reconciliation, saying why, and it is gone from the list", async ({ page }) => {
  const [before] = await sql`SELECT state FROM buyout WHERE id = ${E2E_BUYOUT.refused}`;
  const queued = await sql`SELECT count(*)::int AS n FROM write_queue`;
  await page.goto("/staff/reconciliation");
  const list = page.getByRole("region", { name: /^Volunteer buy-outs/ });
  const ours = () => list.getByRole("row").filter({ hasText: "Rivera trailer shifts" });
  if (before!.state === "refused") {
    await expect(ours()).toHaveCount(1);
    await expect(ours()).toContainText("QuickBooks refused the invoice, so nothing was billed");
    await expect(ours().getByRole("link", { name: "Its buy-outs" })).toHaveAttribute("href", "/staff/roster/E2E-10/buyouts");
    await ours().getByRole("button", { name: "Close this buy-out" }).click();
    await expect(ours()).toContainText("Nothing is sent to QuickBooks.");
    // Asked first: without a reason nothing is closed.
    await ours().getByRole("button", { name: "Close it" }).click();
    await expect(ours().getByRole("alert")).toContainText("Say why, in a few words. The note is kept in the audit log, for staff only.");
    await ours().getByLabel(/^Why\?/).fill(NOTE);
    await ours().getByRole("button", { name: "Close it" }).click();
  }
  await expect(ours()).toHaveCount(0);
  await page.reload();
  await expect(ours()).toHaveCount(0);

  const [after] = await sql`SELECT state, end_reason FROM buyout WHERE id = ${E2E_BUYOUT.refused}`;
  expect(after).toEqual({ state: "voided", end_reason: "closed_by_staff" });
  const audited = await sql`SELECT after FROM audit_log WHERE action = 'volunteer.buyout.closed' AND target_id = ${E2E_BUYOUT.refused}`;
  expect(audited).toHaveLength(1);
  expect(audited[0]!.after).toMatchObject({ why: "closed_by_staff", close: "refused", note: NOTE });
  // Nothing was queued for QuickBooks.
  expect((await sql`SELECT count(*)::int AS n FROM write_queue`)[0]!.n).toBe(queued[0]!.n);

  // The family's buy-outs page says how it ended.
  await page.goto("/staff/roster/E2E-10/buyouts");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Volunteer buy-outs");
  await expect(page.getByRole("row").filter({ hasText: "Rivera trailer shifts" })).toContainText("Closed by staff: nothing was sent to QuickBooks");
});
