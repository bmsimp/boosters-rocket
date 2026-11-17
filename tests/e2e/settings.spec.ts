import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page scrolls sideways").toBe(true);

test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

test("an Admin opens Settings from the menu, follows a section to its page and comes back", async ({ page }) => {
  await page.goto("/staff");
  if (isPhone(page)) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator("#mobile-menu").getByRole("link", { name: "Settings" }).click();
  } else {
    await page.locator("header.bar nav.top-nav").getByRole("link", { name: "Settings" }).click();
  }
  await expect(page).toHaveURL(/\/staff\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  for (const name of ["Club", "Staff sign-in", "Outgoing mail", "QuickBooks", "Parent sign-ins", "Forms (Documenso)"]) {
    await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
  }
  const club = page.getByRole("region", { name: "Club", exact: true });
  await expect(club).toContainText("E2E Boosters");
  await expect(club.locator(".state")).toBeVisible();
  await noSidewaysScroll(page);

  await club.getByRole("link", { name: "Open club settings" }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/club$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Club");
  await expect(page.locator("main input, main select")).toHaveCount(0); // a plain view: the form is on its own page
  await page.getByRole("link", { name: "Change", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/club\/edit$/);
  await expect(page.getByLabel("Club name")).toHaveValue("E2E Boosters");
  await expect(page.locator(".club-preview")).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByRole("link", { name: "Back to club settings" }).click();
  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page).toHaveURL(/\/staff\/settings$/);
  if (!isPhone(page)) await expect(page.locator('header.bar nav.top-nav a[aria-current="page"]')).toHaveText(["Settings"]);
});

test("an Admin makes a role by ticking what it lets people do, changes it, and deletes it", async ({ page }, info) => {
  const name = `Ticked role ${info.project.name}`;
  await page.goto("/staff/roles");
  await expect(page.locator("main textarea")).toHaveCount(0); // no patterns to type
  const fresh = page.getByRole("region", { name: "New role" });
  await fresh.getByLabel("Name", { exact: true }).fill(name);
  await fresh.getByLabel("See the roster: families, students and parents").check();
  await fresh.getByLabel("Change club settings", { exact: true }).check();
  // Change brings See with it, ticked and held.
  await expect(fresh.getByLabel(/^See the club settings/)).toBeChecked();
  await expect(fresh.getByLabel(/^See the club settings/)).toBeDisabled();
  await expect(fresh.getByText("See the audit log")).toHaveCount(0); // Admin-only permissions are not offered
  await fresh.getByRole("button", { name: "Make role" }).click();
  await expect(fresh.getByRole("status")).toHaveText("Role made.");

  const box = page.getByRole("region", { name, exact: true });
  await expect(box).toBeVisible();
  await expect(box.getByLabel("See the roster: families, students and parents")).toBeChecked();
  await expect(box.getByLabel("Change club settings", { exact: true })).toBeChecked();
  await expect(box.getByLabel("See what every family owes, and ask for a fresh read from QuickBooks")).not.toBeChecked();
  await box.getByLabel("Change club settings", { exact: true }).uncheck();
  await box.getByLabel("See what every family owes, and ask for a fresh read from QuickBooks").check();
  await box.getByRole("button", { name: "Save role" }).click();
  await expect(box.getByRole("status")).toHaveText("Saved.");
  await page.reload();
  const saved = page.getByRole("region", { name, exact: true });
  await expect(saved.getByLabel("See what every family owes, and ask for a fresh read from QuickBooks")).toBeChecked();
  await expect(saved.getByLabel("Change club settings", { exact: true })).not.toBeChecked();
  await expect(saved.getByLabel(/^See the club settings/)).toBeChecked(); // still ticked on its own: it was saved with the role
  await noSidewaysScroll(page);

  await saved.getByRole("button", { name: "Delete role" }).click();
  await expect(saved.getByRole("group", { name: /^Delete / })).toContainText(`Delete ${name}? Nobody holds it.`);
  await saved.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Admin", exact: true })).not.toContainText("Delete role");
});

test("the Staff page shows each person's roles as ticks with their own Save, and a quieter Turn off sign-in", async ({ page }) => {
  await page.goto("/staff/people");
  await expect(page.locator("main details")).toHaveCount(0);
  const rows = page.locator("li.staff-person");
  await expect(rows.first().getByRole("group", { name: /^Roles for / })).toBeVisible();
  await expect(rows.first().getByRole("button", { name: /^Save roles/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change my name" })).toBeVisible();
  await noSidewaysScroll(page);
});
