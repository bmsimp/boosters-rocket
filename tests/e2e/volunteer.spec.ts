import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";
import { e2eMailPort } from "./run-config";
import { E2E_VOLUNTEER } from "./volunteer-seed";

// The event scripts/seed-e2e.ts gives the club: "Pancake breakfast", 20 days ahead, with a griddle shift (four places,
// one taken by the Rivera family's Leo) and a cleanup shift. Zelda signs herself up for the griddle and cancels again,
// so both passes of the run (phone, then desktop) start from the same count.
let sink: MailSink;
test.beforeAll(async () => {
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
test.afterAll(async () => { await sink.close(); });

const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
const griddle = (page: Page) => page.locator(".lines li").filter({ hasText: "7:00 am to 9:00 am, Griddle" });

test("a parent signs up for a shift, sees the count and their own sign-up, gets the calendar file, and cancels", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  sink.messages.length = 0;
  const res = await page.goto("/volunteer");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Volunteer");
  await expect(page.getByRole("heading", { name: "Pancake breakfast" })).toBeVisible();
  await expect(page.getByText("Nobody in your family is signed up for a shift yet.")).toBeVisible();
  await expect(griddle(page)).toContainText("1 of 4 places filled");
  // Another family has a place on the griddle; the page says how many, never who.
  await expect(page.locator("main")).not.toContainText("Rivera");
  await noSidewaysScroll(page);

  await griddle(page).getByRole("link", { name: "Sign up for 7:00 am to 9:00 am, Griddle" }).click();
  await expect(page).toHaveURL(new RegExp(`/volunteer/shifts/${E2E_VOLUNTEER.griddle}$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pancake breakfast");
  await expect(page.getByText("1 of 4 places filled")).toBeVisible();
  const me = page.getByRole("radio", { name: /^Me \(Zelda Quetzalcoatl\)/ });
  await expect(me).toBeChecked();
  await expect(page.getByRole("radio", { name: /^Xochitl Quetzalcoatl/ })).toBeVisible();
  await noSidewaysScroll(page);
  await page.getByRole("button", { name: "Sign me up" }).click();
  await expect(page.getByRole("status")).toContainText("You're signed up. Thank you!");

  // The confirmation, with the calendar file, to Zelda alone.
  await expect.poll(() => sink.messages.filter((m) => m.to.includes("zelda@example.com")).length, { timeout: 15_000 }).toBe(1);
  const raw = sink.messages.find((m) => m.to.includes("zelda@example.com"))!.raw;
  expect(raw).toContain("Subject: You're signed up: Pancake breakfast");
  expect(raw).toMatch(/Content-Type: text\/calendar/);
  expect(raw).not.toContain("Rivera");

  await page.goto("/volunteer");
  await expect(griddle(page)).toContainText("2 of 4 places filled");
  const mine = page.locator("section", { has: page.getByRole("heading", { name: "Your sign-ups" }) });
  await expect(mine).toContainText("Pancake breakfast, Griddle");
  await expect(mine).toContainText("You're doing this one");
  await expect(mine).toContainText("You can cancel here until");
  await noSidewaysScroll(page);
  await mine.getByRole("button", { name: "Cancel my sign-up" }).click();
  await mine.getByRole("button", { name: "Yes, cancel it" }).click();
  await expect(mine.getByRole("status")).toContainText("Cancelled. Your place is free for someone else now.");
  await page.reload();
  await expect(griddle(page)).toContainText("1 of 4 places filled");
  await expect(page.getByText("Nobody in your family is signed up for a shift yet.")).toBeVisible();
});

test("staff see the shift's sign-ups by name", async ({ context, page }) => {
  await context.addCookies([staffSessionCookie()]);
  const res = await page.goto(`/staff/volunteer/${E2E_VOLUNTEER.event}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pancake breakfast");
  const shift = page.locator("section", { has: page.getByRole("heading", { name: "7:00 am to 9:00 am, Griddle" }) });
  await expect(shift).toContainText("1 of 4 places filled");
  await expect(shift).toContainText("Leo Rivera");
  await expect(shift).toContainText("Rivera Family");
  await noSidewaysScroll(page);
});
