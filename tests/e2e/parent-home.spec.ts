import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { E2E_DETAILS } from "./details-seed";
import { parentSessionCookie } from "./parent-session";
import { PARENT_DIR } from "./parent-routes";
import { PARENT_NAV } from "../../src/app/components/parent-nav";

// Signed in as the seeded parent (scripts/seed-e2e.ts): Zelda, with the Quetzalcoatl family chosen and a second family
// she could switch to. Nothing here changes the session or the roster, so both passes of the run find them as seeded.
// The run has a phone pass and a desktop pass (playwright.config.ts): the tabs lead on a phone, the top nav at 760px and wider.
const STUDENTS = ["Xochitl Quetzalcoatl", "Yaretzi Quetzalcoatl"];
const NOT_FOUND = "We can't find that page";
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const mainNav = (page: Page) => page.locator(isPhone(page) ? "nav.tabs" : "nav.top-nav");
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);

test.beforeEach(async ({ context }) => { await context.addCookies([parentSessionCookie()]); });

test("Home is headed with the family's name and shows what is to do, its students, the total owed and the parent's own details", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/^Home · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");

  // To do comes first: each open invoice with its compact Pay, the soonest-due one primary.
  const sections = page.locator("main > .home-lists > section, main > .home-side > section");
  await expect(sections.first()).toHaveClass(/home-todo/);
  const todo = page.getByRole("region", { name: "To do" });
  await expect(todo.locator(".invoice-row")).toHaveCount(2);
  const pay = todo.getByRole("link", { name: "Pay $85.00, invoice QZ-1041 for Xochitl Quetzalcoatl" });
  await expect(pay).toHaveAttribute("href", /^https:\/\/connect\.intuit\.com\//);
  expect((await pay.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(todo).not.toContainText("QZ-1017"); // what was paid is on the Payments page

  // The total is said once, with where and when it is from, and the way to the Payments page.
  const money = page.getByRole("region", { name: "Total owed" });
  await expect(money.locator(".amt")).toHaveText("$185.00");
  await expect(page.getByRole("main").getByText("$185.00", { exact: true })).toHaveCount(1);
  await expect(money.locator(".asof")).toContainText("Owed now. From QuickBooks, as of ");
  await expect(money.getByRole("link", { name: "See your payments" })).toHaveAttribute("href", "/payments");

  // Each student by name; where each stands in the season is tests/e2e/season.spec.ts.
  const students = page.getByRole("region", { name: "Your students" });
  await expect(students.locator(".list > .list-row > .list-main > .list-title")).toHaveText(STUDENTS);
  const details = page.getByRole("region", { name: "Your details" });
  // Her phone is the portal's own (stage 3's slice 11a), and nothing says it came from QuickBooks.
  await expect(details.locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com", E2E_DETAILS.phone]);
  // Her sign-in email is hers to change too, from Family, though she is in two families (stage 3's slice 11d).
  await expect(details).toContainText("You can change your phone, mailing address and sign-in email on your Family page. To change your name, ask the club.");
  await expect(details.getByRole("link", { name: "Update my details" })).toHaveAttribute("href", "/family/details");
  await expect(page.locator(".roster-asof")).toHaveCount(0);

  // No placeholder, nothing that has no data yet, and nothing of her second family.
  await expect(page.getByRole("main")).not.toContainText(/will show here|grade|Wolfgang|Second Family/i);

  // On a phone the sections stack in one column: To do, the students, the total, the details. At 760px and wider the
  // lists fill the left column and the total and the details the right, so no column stands empty.
  const head = (await page.locator(".home-head").boundingBox())!;
  const boxes = await sections.evaluateAll((all) => all.map((s) => { const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; }));
  expect(boxes).toHaveLength(4);
  expect(Math.min(...boxes.map((b) => b.left))).toBeCloseTo(head.x, 0);
  expect(Math.max(...boxes.map((b) => b.right))).toBeCloseTo(head.x + head.width, 0);
  const [todoBox, studentsBox, moneyBox, detailsBox] = boxes as [typeof boxes[0], typeof boxes[0], typeof boxes[0], typeof boxes[0]];
  if (isPhone(page)) {
    for (const box of boxes) { expect(box.left).toBeCloseTo(head.x, 0); expect(box.right).toBeCloseTo(head.x + head.width, 0); }
    expect(studentsBox.top).toBeGreaterThan(todoBox.top);
    expect(moneyBox.top).toBeGreaterThan(studentsBox.top);
  } else {
    expect(new Set(boxes.map((b) => Math.round(b.left))).size).toBe(2);
    expect(todoBox.left).toBeCloseTo(head.x, 0);
    expect(studentsBox.left).toBeCloseTo(todoBox.left, 0);
    expect(moneyBox.left).toBeGreaterThan(todoBox.right);
    expect(moneyBox.top).toBeCloseTo(todoBox.top, 0);
    expect(detailsBox.left).toBeCloseTo(moneyBox.left, 0);
    expect(detailsBox.top).toBeGreaterThan(moneyBox.top);
  }
  await noSidewaysScroll(page);
});

test("Family shows the same students and details, the account, and the way to switch family", async ({ page }) => {
  const res = await page.goto("/family");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/^Family · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
  await expect(page.getByRole("region", { name: "Your students" }).getByRole("listitem")).toHaveText(STUDENTS);
  await expect(page.getByRole("region", { name: "Your details" }).locator("dd")).toHaveText(["Zelda Quetzalcoatl", "zelda@example.com", E2E_DETAILS.phone]);
  // Your details shows the name and email, so Your account doesn't repeat them.
  await expect(page.getByRole("region", { name: "Your account" }).locator("dd")).toHaveCount(0);

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
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(NOT_FOUND);
    // Reached by its tab from Home.
    await page.goto("/");
    await mainNav(page).getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === href);
    await expect(mainNav(page).getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(NOT_FOUND);
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

test("five tabs fit a 360px-wide phone: every label inside its own column, nothing scrolls sideways", async ({ page }) => {
  test.skip(!isPhone(page), "the tabs show on phones only");
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  const tabs = await page.locator("nav.tabs a").evaluateAll((all) => all.map((a) => {
    const box = a.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(a);
    const text = range.getBoundingClientRect();
    return { box: { left: box.left, right: box.right, height: box.height }, text: { left: text.left, right: text.right } };
  }));
  expect(tabs).toHaveLength(PARENT_NAV.length);
  for (const t of tabs) {
    expect(t.text.left).toBeGreaterThanOrEqual(t.box.left - 0.5);
    expect(t.text.right).toBeLessThanOrEqual(t.box.right + 0.5);
    expect(t.box.height).toBeGreaterThanOrEqual(44);
  }
  await noSidewaysScroll(page);
});

test("a signed-in parent who asks for a page that doesn't exist keeps the club bar and the tabs", async ({ page }) => {
  for (const path of ["/forms", "/no-such-page"]) {
    // A tab is only listed once its page is built: if one of these now exists, it is no longer this test's business.
    if (existsSync(`${PARENT_DIR}${path}/page.tsx`)) continue;
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(NOT_FOUND);
    await expect(page.locator("header.bar .club")).toHaveText("E2E Boosters");
    await expect(page.getByRole("link", { name: "Your account and display settings, Zelda Quetzalcoatl" })).toBeVisible();
    await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
    await expect(mainNav(page).getByRole("link")).toHaveText(PARENT_NAV.map((n) => n.label));
    await expect(page.locator("body")).not.toContainText(/Second Family|Wolfgang/);
    await noSidewaysScroll(page);
  }
  await mainNav(page).getByRole("link", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Quetzalcoatl Family");
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
