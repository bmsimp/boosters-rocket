import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { parentSessionCookie } from "./parent-session";
import { PARENT_DIR } from "./parent-routes";
import { PARENT_NAV } from "../../src/app/components/parent-nav";

// Signed in as the seeded parent (scripts/seed-e2e.ts): Zelda, with the Quetzalcoatl family chosen and a second family
// she could switch to. Nothing here changes the session or the roster, so both passes of the run find them as seeded.
// The run has a phone pass and a desktop pass (playwright.config.ts): the tabs lead on a phone, the top nav at 760px and wider.
const STUDENTS = ["Xochitl Quetzalcoatl", "Yaretzi Quetzalcoatl"];
const NOT_READY = "This part of the portal isn't ready yet";
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const mainNav = (page: Page) => page.locator(isPhone(page) ? "nav.tabs" : "nav.top-nav");
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

test.beforeEach(async ({ context }) => { await context.addCookies([parentSessionCookie()]); });

test("Home greets the parent and shows their family's students and their own details", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/^Home · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
  await expect(page.locator(".family-name")).toHaveText("Quetzalcoatl Family");

  const students = page.getByRole("region", { name: "Your students" });
  await expect(students.getByRole("listitem")).toHaveText(STUDENTS);
  const details = page.getByRole("region", { name: "Your details" });
  await expect(details.locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com"]);
  await expect(details).toContainText("For now, the club makes changes for you. Ask the club and they'll update it.");
  await expect(page.locator(".roster-asof")).toContainText("From the club's QuickBooks, as of");
  await expect(page.locator(".roster-asof time")).toBeVisible();

  // No placeholder, nothing that has no data yet, and nothing of her second family.
  await expect(page.getByRole("main")).not.toContainText(/will show here|season|grade|Wolfgang|Second Family/i);

  // On a phone the boxes stack in one column. At 760px and wider they fill two: whichever boxes the page has, one
  // starts at the left edge and one ends at the right, so no column stands empty.
  const head = (await page.locator(".home-head").boundingBox())!;
  const boxes = await page.locator("main > section").evaluateAll((all) => all.map((s) => { const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; }));
  expect(boxes.length).toBeGreaterThanOrEqual(2);
  expect(Math.min(...boxes.map((b) => b.left))).toBeCloseTo(head.x, 0);
  expect(Math.max(...boxes.map((b) => b.right))).toBeCloseTo(head.x + head.width, 0);
  if (isPhone(page)) {
    for (const box of boxes) { expect(box.left).toBeCloseTo(head.x, 0); expect(box.right).toBeCloseTo(head.x + head.width, 0); }
  } else {
    const columns = new Set(boxes.map((b) => Math.round(b.left)));
    expect(columns.size).toBe(2);
    // The first row holds a box in each column.
    const top = Math.min(...boxes.map((b) => b.top));
    expect(boxes.filter((b) => Math.abs(b.top - top) < 1)).toHaveLength(2);
  }
  await noSidewaysScroll(page);
});

test("Family shows the same students and details, the account, and the way to switch family", async ({ page }) => {
  const res = await page.goto("/family");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/^Family · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
  await expect(page.getByRole("region", { name: "Your students" }).getByRole("listitem")).toHaveText(STUDENTS);
  await expect(page.getByRole("region", { name: "Your details" }).locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com"]);
  await expect(page.getByRole("region", { name: "Your account" }).locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com"]);

  // She is in two families: the page says so and names only the one she is looking at. The chooser lists them.
  const families = page.getByRole("region", { name: "Your families" });
  await expect(families).toContainText("You're a guardian in 2 families. You're looking at Quetzalcoatl Family now.");
  await expect(page.getByRole("main")).not.toContainText(/Second Family|Wolfgang/);
  await expect(families.getByRole("link", { name: "Switch family" })).toHaveAttribute("href", "/choose-family");
  await noSidewaysScroll(page);

  await families.getByRole("link", { name: "Switch family" }).click();
  await expect(page).toHaveURL(/\/choose-family$/);
  await expect(page.getByRole("button", { name: "Quetzalcoatl Family" })).toBeVisible();
  // The families are a list of buttons, not bullets.
  await expect(page.locator("ul.stack")).toHaveCSS("list-style-type", "none");
  await expect(page.locator("ul.stack")).toHaveCSS("padding-left", "0px");
});

test("every tab and top-nav link leads to a real page", async ({ page }) => {
  await page.goto("/");
  const nav = mainNav(page);
  await expect(nav).toBeVisible();
  await expect(page.locator(isPhone(page) ? "nav.top-nav" : "nav.tabs")).toBeHidden();
  const links = nav.getByRole("link");
  await expect(links).toHaveText(PARENT_NAV.map((n) => n.label));
  expect(await links.evaluateAll((all) => all.map((a) => a.getAttribute("href")))).toEqual(PARENT_NAV.map((n) => n.href));

  for (const { href, label } of PARENT_NAV) {
    // Asked for directly: a page, not the not-ready page.
    const res = await page.goto(href);
    expect(res?.status(), href).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(NOT_READY);
    // Reached by its tab from Home.
    await page.goto("/");
    await mainNav(page).getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === href);
    await expect(mainNav(page).getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(NOT_READY);
    await noSidewaysScroll(page);
  }
});

test("the tab bar has one column for each tab, across the whole screen", async ({ page }) => {
  test.skip(!isPhone(page), "the tabs show on phones only");
  await page.goto("/");
  const boxes = await page.locator("nav.tabs a").evaluateAll((all) => all.map((a) => { const r = a.getBoundingClientRect(); return { left: r.left, width: r.width, top: r.top, height: r.height }; }));
  expect(boxes).toHaveLength(PARENT_NAV.length);
  const width = page.viewportSize()!.width;
  boxes.forEach((box, i) => {
    expect(box.width).toBeCloseTo(width / PARENT_NAV.length, 0);
    expect(box.left).toBeCloseTo((i * width) / PARENT_NAV.length, 0);
    expect(box.top).toBe(boxes[0]!.top);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

test("a signed-in parent who asks for a page that doesn't exist keeps the club bar and the tabs", async ({ page }) => {
  for (const path of ["/forms", "/payments", "/no-such-page"]) {
    // A tab is only listed once its page is built: if one of these now exists, it is no longer this test's business.
    if (existsSync(`${PARENT_DIR}${path}/page.tsx`)) continue;
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(NOT_READY);
    await expect(page.locator("header.bar .club")).toHaveText("E2E Boosters");
    await expect(page.getByRole("link", { name: "Your account and display settings, Zelda Quetzalcoatl" })).toBeVisible();
    await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
    await expect(mainNav(page).getByRole("link")).toHaveText(PARENT_NAV.map((n) => n.label));
    await expect(page.locator("body")).not.toContainText(/Second Family|Wolfgang/);
    await noSidewaysScroll(page);
  }
  await mainNav(page).getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
});

test("the account control is marked as current on the Display page, and the Switch family link is big enough to tap", async ({ page }) => {
  await page.goto("/");
  const account = page.getByRole("link", { name: "Your account and display settings, Zelda Quetzalcoatl" });
  await expect(account).not.toHaveAttribute("aria-current", /.*/);
  const line = page.locator(".switch-family");
  await expect(line).toHaveText("Viewing Quetzalcoatl Family. Switch family");
  expect((await line.getByRole("link", { name: "Switch family" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await account.click();
  await expect(page).toHaveURL(/\/display$/);
  await expect(account).toHaveAttribute("aria-current", "page");
});
