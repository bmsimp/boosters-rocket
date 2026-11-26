import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { staffSessionCookie } from "./staff-session";

/**
 * The portal's dialogs (src/app/components/ui/sheet.tsx), on the design-system gallery's samples, at each project's
 * width (390 and 1440): a Drawer has its own address (Back closes it, a refresh opens it again), takes the focus in and
 * gives it back to its button, closes on Esc, leaves the page behind inert and still, and fills a phone's screen; a
 * ConfirmDialog does the same, small, with Cancel focused first and its press unusable until its box is ticked. And
 * the bulk select's bar.
 */
test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

const GALLERY = "/staff/settings/design-system";
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
async function checked(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).disableRules(["color-contrast"]).analyze();
  expect(results.violations.flatMap((v) => v.nodes.map((n) => `${where} · ${n.target.join(" ")}: ${v.id} (${v.help})`))).toEqual([]);
}
const focusInside = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")));
/** Whether the page behind can take the focus: an inert element can't. */
const behindFocusable = (page: Page, selector: string) => page.evaluate((s) => {
  const e = document.querySelector<HTMLElement>(s);
  e?.focus();
  return document.activeElement === e;
}, selector);

test("a Drawer: its own address, the focus in and back, Esc and Back close it, a refresh opens it, the page behind inert", async ({ page }, info) => {
  await page.goto(GALLERY);
  const opener = page.getByRole("link", { name: "Change the event" });
  await opener.click();
  await expect(page).toHaveURL(/[?&]ds-drawer=1/);
  const drawer = page.getByRole("dialog", { name: "Change the event" });
  await expect(drawer).toBeVisible();
  expect(await focusInside(page)).toBe(true);
  for (let i = 0; i < 8; i++) { await page.keyboard.press("Tab"); expect(await focusInside(page), `Tab ${i + 1} stays in the drawer`).toBe(true); }
  expect(await behindFocusable(page, "#ds-button button")).toBe(false);
  await expect(page.locator("html")).toHaveClass(/sheet-open/);
  await drawer.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // slid all the way in (the page's spinners run on)
  const box = (await drawer.boundingBox())!;
  const view = page.viewportSize()!;
  if (info.project.name === "phone") {
    // Covers the whole screen, from its left edge, and nothing in it runs past the right.
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.y)).toBe(0);
    expect(Math.round(box.width)).toBe(view.width);
    expect(Math.round(box.height)).toBe(view.height);
    expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } else {
    expect(Math.round(box.x + box.width)).toBe(view.width);
    expect(box.width).toBeLessThan(view.width / 2);
  }
  await checked(page, "a Drawer, open");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/ds-drawer=/);
  await expect(opener).toBeFocused();
  await expect(page.locator("html")).not.toHaveClass(/sheet-open/);

  // Back closes it; the Close button closes it and gives the focus back.
  await opener.click();
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/ds-drawer=/);
  await opener.click();
  await drawer.getByRole("link", { name: "Close" }).click();
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  // Its address opens it again, as a dialog.
  await page.goto(`${GALLERY}?ds-drawer=1`);
  await expect(drawer).toBeVisible();
  expect(await page.evaluate(() => document.querySelector("dialog[open]")?.matches(":modal"))).toBe(true);
  expect(await behindFocusable(page, "#ds-button button")).toBe(false);
});

test("a ConfirmDialog: Cancel first, its press unusable until the box is ticked, Esc closes it and the focus comes back", async ({ page }, info) => {
  await page.goto(GALLERY);
  const opener = page.getByRole("button", { name: "Disconnect QuickBooks" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Disconnect QuickBooks?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  const press = dialog.getByRole("button", { name: "Disconnect QuickBooks" });
  await expect(press).toHaveAttribute("aria-disabled", "true");
  await dialog.getByRole("checkbox").check();
  await expect(press).not.toHaveAttribute("aria-disabled", "true");
  expect(await behindFocusable(page, "#ds-button button")).toBe(false);
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeLessThan(page.viewportSize()!.width);
  await checked(page, `a ConfirmDialog, open (${info.project.name})`);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // Pressed, it closes and says what happened beside its button.
  await opener.click();
  await dialog.getByRole("checkbox").check();
  await press.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("A sample: nothing was disconnected.")).toBeVisible();
});

test("bulk select: the header ticks the page, mixed when some are, and the bar offers every row that matches", async ({ page }, info) => {
  await page.goto(GALLERY);
  const table = page.getByRole("table", { name: /Sample families/ });
  await table.getByRole("checkbox", { name: "Select Rivera Sample Family" }).check();
  const bar = page.locator(".bulk-bar");
  await expect(bar.locator(".bulk-count")).toHaveText("1 family selected");
  const header = table.getByRole("checkbox", { name: "Select every row on this page" });
  await expect(header).toHaveAttribute("aria-checked", "mixed");
  await header.focus();
  await page.keyboard.press("Space");
  await expect(bar.locator(".bulk-count")).toHaveText("5 families selected");
  await bar.getByRole("button", { name: "Select all 12 that match" }).click();
  await expect(bar.locator(".bulk-count")).toHaveText("12 families selected");
  const actions = info.project.name === "phone" ? page.getByRole("button", { name: "12 selected · Actions" }) : null;
  if (actions) {
    await actions.click();
    await page.getByRole("dialog", { name: "12 families selected" }).getByRole("button", { name: "Send a reminder" }).click();
  } else {
    await bar.getByRole("button", { name: "Send a reminder" }).click();
  }
  const send = page.getByRole("dialog", { name: "Send a reminder to 12 families" });
  await expect(send).toBeVisible();
  await send.getByRole("button", { name: "Send 12 reminders" }).click();
  await expect(send.getByText("4 sent, 1 not sent.")).toBeVisible();
  await checked(page, "bulk select's results");
});
