import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { staffSessionCookie } from "./staff-session";
import { e2ePort } from "./run-config";

const sql = postgres(process.env.DATABASE_URL!);
const finishedState = { status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" };
test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  // The address test reopens setup; whatever happened in it, the next spec finds setup finished.
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
  await sql.end();
});

// Both passes of a run (phone, then desktop) read one seeded database. These tests only add audit rows, under a name
// of their own each time, and count nothing but those.
const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test("the Health page tells an Admin what is working, in words, and that the address matches", async ({ page, context, baseURL }) => {
  await context.addCookies([staffSessionCookie()]);
  await page.goto("/staff/health");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Health");
  const line = (key: string) => page.locator(`li[data-health="${key}"]`);
  for (const key of ["database", "worker", "cleanup", "quickbooks", "money", "mail", "forms", "parents", "backup", "version"]) await expect(line(key)).toBeVisible();
  await expect(line("database")).toContainText("Working");
  // No worker runs beside the browser tests, and nothing has backed this database up: the page says so plainly.
  await expect(line("worker")).toContainText("Needs attention");
  await expect(line("worker")).toContainText("Last woke: never");
  await expect(line("backup")).toContainText("No backup has been recorded.");
  await expect(line("mail")).toContainText("Outgoing mail");
  // The version was fixed into the build: the package version, with the commit when the build knew it.
  await expect(line("version")).toContainText(/Running \d+\.\d+\.\d+( \([0-9a-f]{7,12}\))?\./);
  await expect(page.getByText(`This portal's address is ${baseURL}.`)).toBeVisible();
  await expect(page.getByText("Your browser reached it at this same address.")).toBeVisible();
  await expect(page.getByText("These don't match.")).toHaveCount(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
  const html = await page.content();
  for (const secret of [process.env.BETTER_AUTH_SECRET!, process.env.SETTINGS_ENCRYPTION_KEY!]) expect(html).not.toContain(secret);
});

test("the Health page, the audit log and its export are refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ["/staff/health", "/staff/audit", "/staff/audit/export"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/staff\/sign-in$/);
  }
  // The liveness check stays bare for everyone.
  const res = await context.request.get("/api/health");
  expect(await res.text()).toBe('{"ok":true}');
  await context.close();
});

test("the audit log pages, filters by who and by day, and exports what was found", async ({ page, context }) => {
  await context.addCookies([staffSessionCookie()]);
  const who = `ops-e2e-${Date.now()}@example.org`;
  await sql`INSERT INTO audit_log (door, actor_label, action, target_type, target_id)
            SELECT 'staff', ${who}, CASE WHEN n % 2 = 0 THEN 'parent.block' ELSE 'signin' END, 'parent', 'ops-e2e-' || n FROM generate_series(1, 60) AS n`;
  await page.goto("/staff/audit");
  await page.getByLabel("Who did it (part of a name or email)").fill(who.toUpperCase());
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { name: "60 rows found" })).toBeVisible();
  const rows = page.getByRole("region", { name: "60 rows found" }).locator("table tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(rows.first()).toContainText("Parent blocked"); // the action in words, with its code beside it
  await expect(rows.first()).toContainText("parent.block");
  await page.getByRole("link", { name: "Older" }).click();
  await expect(rows).toHaveCount(10);
  await page.getByRole("link", { name: "Newer" }).click();
  await expect(rows).toHaveCount(50);

  // A day is the viewer's own day: today finds them all, a day long past finds none.
  const today = localDay(new Date());
  await page.getByLabel("From this day").fill(today);
  await page.getByLabel("To this day").fill(today);
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { name: "60 rows found" })).toBeVisible();
  await expect(page.getByLabel("From this day")).toHaveValue(today);
  await expect(page.getByLabel("To this day")).toHaveValue(today);
  await page.getByLabel("What happened").fill("signin");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("heading", { name: "30 rows found" })).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export these 30 rows (CSV)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = readFileSync(await download.path(), "utf8").trim().split("\r\n");
  expect(lines).toHaveLength(31);
  expect(lines[0]).toContain('"When (UTC)","Door","Who"');
  for (const l of lines.slice(1)) { expect(l).toContain(`"${who}"`); expect(l).toContain('"Signed in","signin"'); }
  const exported = await sql`SELECT actor_label, permission, after FROM audit_log WHERE action = 'audit.export' AND lower(after->>'who') = ${who}`;
  expect(exported.map((r) => ({ ...r, after: { rows: r.after.rows, action: r.after.action } })))
    .toEqual([{ actor_label: "e2e-admin@example.org", permission: "Audit.Log.Read", after: { rows: 30, action: "signin" } }]);

  await page.getByLabel("From this day").fill("2001-01-01");
  await page.getByLabel("To this day").fill("2001-01-02");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByText("Nothing matches. Try fewer filters.")).toBeVisible();
  await page.getByRole("link", { name: "Show everything" }).click();
  await expect(page).toHaveURL(/\/staff\/audit$/);
});

test("the setup page shows the portal's address, and warns when the browser reached it under another one", async ({ page, baseURL }) => {
  execFileSync("node", ["scripts/setup-code.mjs", "--reopen"], { encoding: "utf8", env: process.env });
  await page.goto("/setup");
  await expect(page.getByText(`This portal's address is ${baseURL}.`)).toBeVisible();
  await expect(page.getByText("Your browser reached it at this same address.")).toBeVisible();
  // The same server, reached by number instead of by name: a different address as far as sign-in and emailed links go.
  const other = `http://127.0.0.1:${e2ePort()}`;
  await page.goto(`${other}/setup`);
  const warning = page.getByRole("alert").filter({ hasText: "These don't match." });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(`Your browser reached the portal at ${other}, but the portal believes its address is ${baseURL}.`);
  await expect(warning).toContainText("APP_URL");
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
});
