import { test, expect, type Page } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "the page scrolls sideways").toBe(true);

test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const rail = (page: Page) => page.getByRole("navigation", { name: "Settings" });

test("an Admin opens Settings from the menu, follows an item of the rail to its page and comes back", async ({ page }) => {
  await page.goto("/staff");
  if (isPhone(page)) {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator("#mobile-menu").getByRole("link", { name: "Settings" }).click();
  } else {
    await page.locator("header.bar nav.top-nav").getByRole("link", { name: "Settings" }).click();
  }
  await expect(page).toHaveURL(/\/staff\/settings$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  // The rail: every item an Admin may open, in its group, each with its status in words.
  await expect(rail(page).getByRole("link")).toHaveText([/^Club/, /^Staff/, /^Roles/, /^Parent sign-ins/, /^Integrations/, /^Audit log/, /^Health/, /^Design system/]);
  for (const group of ["Club", "People and access", "Connections", "Administration"]) await expect(rail(page).getByRole("list", { name: group, exact: true })).toBeVisible();
  await expect(rail(page).getByRole("link", { name: /^Club/ })).toContainText("Set");
  await noSidewaysScroll(page);

  await rail(page).getByRole("link", { name: /^Club/ }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/club$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Club");
  await expect(page.locator("main input, main select")).toHaveCount(0); // a plain view: the form is on its own page
  if (isPhone(page)) await expect(rail(page)).toBeHidden(); // each item is its own page on a phone
  else await expect(rail(page).getByRole("link", { name: /^Club/ })).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: "Change", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/club\/edit$/);
  await expect(page.getByLabel("Club name")).toHaveValue("E2E Boosters");
  await expect(page.locator(".club-preview")).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByRole("link", { name: "Back to club settings" }).click();
  if (isPhone(page)) await page.locator("main").getByRole("link", { name: "Settings", exact: true }).click();
  else await expect(page.locator("main").getByRole("link", { name: "Settings", exact: true })).toBeHidden(); // the rail is the way on a desktop
  if (isPhone(page)) await expect(page).toHaveURL(/\/staff\/settings$/);
  if (!isPhone(page)) await expect(page.locator('header.bar nav.top-nav a[aria-current="page"]')).toHaveText(["Settings"]);
});

test("Find a setting filters the rail in the browser: a keyword finds an integration, Enter opens the first, Escape clears", async ({ page }) => {
  await page.goto("/staff/settings");
  const find = page.getByRole("searchbox", { name: "Find a setting" });
  await find.fill("smtp");
  await expect(rail(page).getByRole("link")).toHaveText([/^Outgoing mail/]);
  await find.fill("zzz nothing");
  await expect(rail(page).getByRole("status")).toHaveText("No setting matches");
  await find.press("Escape");
  await expect(find).toHaveValue("");
  await expect(rail(page).getByRole("link", { name: /^Health/ })).toBeVisible();
  await find.fill("backup");
  await find.press("Enter");
  await expect(page).toHaveURL(/\/staff\/settings\/health$/);
});

test("the Integrations page groups the systems by kind, and each row opens its page, with Integrations as the way back", async ({ page }) => {
  await page.goto("/staff/settings/integrations");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Integrations");
  for (const kind of ["Accounting", "Forms and signing", "Outgoing mail", "Staff sign-in"]) await expect(page.getByRole("region", { name: kind, exact: true })).toBeVisible();
  const accounting = page.getByRole("region", { name: "Accounting", exact: true });
  await expect(accounting).toContainText("One QuickBooks company is connected at a time.");
  await expect(accounting.getByRole("link", { name: /^QuickBooks Online/ })).toContainText("Connected");
  await noSidewaysScroll(page);
  await page.getByRole("region", { name: "Staff sign-in", exact: true }).getByRole("link", { name: /^Google/ }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/sign-in#staff-google$/);
  await expect(page.locator("#staff-google")).toBeVisible();
  await page.locator("main").getByRole("link", { name: "Integrations" }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/integrations$/);
  await accounting.getByRole("link", { name: /^QuickBooks Online/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("QuickBooks");
  await expect(page.getByRole("region", { name: "Connection" })).toContainText("E2E Sandbox Company");
  await noSidewaysScroll(page);
});

test("an Admin makes a role by ticking what it lets people do, changes it, and deletes it", async ({ page }, info) => {
  const name = `Ticked role ${info.project.name}`;
  await page.goto("/staff/settings/roles");
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
  await expect(fresh.getByRole("status")).toHaveText("Done Role made.");

  const box = page.getByRole("region", { name, exact: true });
  await expect(box).toBeVisible();
  await expect(box.getByLabel("See the roster: families, students and parents")).toBeChecked();
  await expect(box.getByLabel("Change club settings", { exact: true })).toBeChecked();
  await expect(box.getByLabel("See what every family owes, and ask for a fresh read from QuickBooks")).not.toBeChecked();
  await box.getByLabel("Change club settings", { exact: true }).uncheck();
  await box.getByLabel("See what every family owes, and ask for a fresh read from QuickBooks").check();
  await box.getByRole("button", { name: "Save role" }).click();
  await expect(box.getByRole("status")).toHaveText("Done Saved.");
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
  await expect(page.locator("main").getByRole("region", { name: "Admin", exact: true })).not.toContainText("Delete role");
});

test("the Staff page shows each person's roles as ticks with their own Save, and a quieter Turn off sign-in", async ({ page }) => {
  await page.goto("/staff/settings/staff");
  await expect(page.locator("main details")).toHaveCount(0);
  const rows = page.locator("li.staff-person");
  await expect(rows.first().getByRole("group", { name: /^Roles for / })).toBeVisible();
  await expect(rows.first().getByRole("button", { name: /^Save roles/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change my name" })).toBeVisible();
  await noSidewaysScroll(page);
});
