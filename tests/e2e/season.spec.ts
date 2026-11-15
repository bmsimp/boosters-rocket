import { test, expect, type Page } from "@playwright/test";
import { parentSessionCookie } from "./parent-session";
import { staffSessionCookie } from "./staff-session";

// The season scripts/seed-e2e.ts gives the club: "Fall 2026", current, four steps with no dates (Join, Uniforms, Season,
// Wrap-up). The Quetzalcoatl family has done Join; in Uniforms, Xochitl is ticked off for the fitting and Yaretzi is
// not, so the family is on step 2. The staff test ticks Yaretzi and unticks her again, so both passes of the run (and a
// run that stopped halfway) start from the same place.
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 760;
const noSidewaysScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), `${page.url()} scrolls sideways`).toBe(false);
const FITTING = "Uniform fitting attended";

/** Staff: the fitting's progress page, with Yaretzi as the seed left her (not ticked). */
async function fittingWithYaretziUnticked(page: Page) {
  await page.goto("/staff/seasons/progress");
  await page.getByRole("link", { name: FITTING }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(FITTING);
  const row = page.locator(".progress-rows li").filter({ hasText: "Yaretzi Quetzalcoatl" });
  await expect(row).toBeVisible();
  if (await row.getByRole("button", { name: "Untick", exact: true }).isVisible()) {
    await row.getByRole("button", { name: "Untick", exact: true }).click();
    await expect(row.getByRole("button", { name: "Tick", exact: true })).toBeVisible();
  }
  return row;
}

test.beforeEach(async ({ context }) => { await context.addCookies([parentSessionCookie(), staffSessionCookie()]); });

test("Home shows the season ruler for the current season, and each student's progress in words", async ({ page }) => {
  await fittingWithYaretziUnticked(page);
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);

  // The ruler: a band under the club bar, above the greeting. Not a control: one link, to the Season page.
  const ruler = page.getByRole("region", { name: /^Fall 2026/ });
  await expect(ruler).toBeVisible();
  await expect(ruler.locator(".season-title")).toHaveText("Fall 2026 · Set 2 of 4: Uniforms");
  // On a phone the current set's name is in the heading, so a label that doesn't fit its cell loses nothing; on a wide
  // screen every cell shows its own label and the heading drops the name.
  if (isPhone(page)) await expect(ruler.locator(".current-name")).toBeVisible();
  else await expect(ruler.locator(".current-name")).toBeHidden();
  const cells = ruler.locator("ol.sets > li");
  await expect(cells).toHaveCount(4);
  await expect(cells.locator(".n")).toHaveText(["1", "2", "3", "4"]);
  await expect(cells.nth(0)).toHaveClass("done");
  await expect(cells.nth(0)).toContainText("Join, done");
  await expect(cells.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(cells.nth(1)).toContainText("Uniforms, current set");
  await expect(ruler.locator("[aria-current]")).toHaveCount(1);
  // The current step is filled with the club's color; the others are paper.
  const fill = (i: number) => cells.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await fill(1)).toBe("rgb(91, 42, 134)");
  expect(await fill(2)).not.toBe("rgb(91, 42, 134)");
  // A dot for each student on the current step: Xochitl finished, Yaretzi still on it. Decoration, hidden from a screen reader.
  const dots = cells.nth(1).locator(".on-set i");
  await expect(dots).toHaveText(["X", "Y"]);
  await expect(dots.nth(0)).toHaveClass("done");
  await expect(dots.nth(1)).not.toHaveClass(/done/);
  await expect(cells.nth(1).locator(".on-set")).toHaveAttribute("aria-hidden", "true");
  const rulerBox = (await ruler.boundingBox())!, heading = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
  expect(rulerBox.y + rulerBox.height).toBeLessThanOrEqual(heading.y);

  // The same facts in words, under each student: the state, then each requirement of the current step.
  const students = page.getByRole("region", { name: "Your students" });
  await expect(students).toContainText("Fall 2026 · Uniforms");
  const xochitl = students.locator("ul.students > li").filter({ hasText: "Xochitl Quetzalcoatl" });
  await expect(xochitl.locator(".count")).toHaveText("1 of 1 done");
  await expect(xochitl.locator("> .state")).toHaveText("Done with Uniforms");
  await expect(xochitl.locator(".reqs li")).toHaveText([`${FITTING}Done`, "Marching shoes sized (optional)Not done yet"]);
  const yaretzi = students.locator("ul.students > li").filter({ hasText: "Yaretzi Quetzalcoatl" });
  await expect(yaretzi.locator(".count")).toHaveText("0 of 1 done");
  await expect(yaretzi.locator("> .state")).toHaveText("1 thing left to do in Uniforms");
  await expect(yaretzi.locator(".reqs li").first()).toHaveText(`${FITTING}Not done yet`);
  // Every state is words with an icon, never a color alone.
  await expect(yaretzi.locator(".reqs .state svg").first()).toBeVisible();
  // Nothing of a step that is behind them or ahead, and nothing asked of another family alone.
  await expect(page.locator("body")).not.toContainText(/Handbook read|Banquet RSVP|Tuba locker|Percussion truck|Cast on his arm/);
  await noSidewaysScroll(page);

  // The link is big enough to tap, and leads to the Season page: every step, with the family's progress.
  const link = ruler.getByRole("link", { name: "See the whole season" });
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await link.click();
  await expect(page).toHaveURL(/\/season$/);
  await expect(page).toHaveTitle(/^Season · /);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fall 2026");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["1. Join", "2. Uniforms", "3. Season", "4. Wrap-up"]);
  await expect(page.getByRole("region", { name: "1. Join" })).toContainText("DoneYour familyHandbook readDone");
  await expect(page.getByRole("region", { name: "2. Uniforms" })).toContainText("The current set");
  await expect(page.getByRole("region", { name: "3. Season" })).toContainText("Nothing is asked of your family in this set.");
  const wrap = page.getByRole("region", { name: "4. Wrap-up" });
  await expect(wrap).toContainText("Banquet RSVP");
  await expect(wrap.locator(".when")).toContainText("Due ");
  await expect(page.locator("body")).not.toContainText(/Tuba locker|Percussion truck|Cast on his arm|Wolfgang/);
  // The Season page has no tab: it is reached from the ruler.
  await expect(page.locator(isPhone(page) ? "nav.tabs" : "nav.top-nav").getByRole("link", { name: /season/i })).toHaveCount(0);
  await noSidewaysScroll(page);
});

test("staff tick a student off, and the parent then sees it; unticked, the family is back where it was", async ({ page }) => {
  const row = await fittingWithYaretziUnticked(page);
  const who = page.getByRole("region", { name: "Who has done it" });
  await expect(who).toContainText("2 of 4 done, 2 still to do.");
  await expect(row.locator(".state")).toHaveText("Not done yet");
  await row.getByRole("button", { name: "Tick", exact: true }).click();
  await expect(row.locator(".state")).toHaveText("Done");
  await expect(row).toContainText("by E2E Admin");
  await expect(who).toContainText("3 of 4 done, 1 still to do.");

  // The parent: both students have finished Uniforms, Season asks nothing, so the family is on Wrap-up.
  await page.goto("/");
  const ruler = page.getByRole("region", { name: /^Fall 2026/ });
  await expect(ruler.locator(".season-title")).toContainText("Set 4 of 4");
  await expect(ruler.locator("ol.sets > li.done")).toHaveCount(3);
  await expect(ruler.locator("ol.sets > li").nth(3)).toHaveAttribute("aria-current", "step");
  await expect(page.getByRole("region", { name: "Your students" })).toContainText("Your family1 thing left to do in Wrap-upBanquet RSVPNot done yet");
  await page.goto("/season");
  const uniforms = page.getByRole("region", { name: "2. Uniforms" });
  await expect(uniforms.locator("> .state")).toHaveText("Done");
  await expect(uniforms).toContainText(`Yaretzi Quetzalcoatl${FITTING}Done`);

  // Staff untick her: the seed is as it was, and the parent is back on Uniforms.
  await page.goto("/staff/seasons/progress");
  await page.getByRole("link", { name: FITTING }).click();
  const again = page.locator(".progress-rows li").filter({ hasText: "Yaretzi Quetzalcoatl" });
  await again.getByRole("button", { name: "Untick", exact: true }).click();
  await expect(again.getByRole("button", { name: "Tick", exact: true })).toBeVisible();
  await expect(again.locator(".state")).toHaveText("Not done yet");
  await page.goto("/");
  await expect(page.getByRole("region", { name: /^Fall 2026/ }).locator(".season-title")).toContainText("Set 2 of 4");
});

test("staff see the season's set-up: its steps, what each asks, and the kinds that are coming later", async ({ page }) => {
  await page.goto("/staff/seasons");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Seasons");
  const listed = page.getByRole("region", { name: "Seasons", exact: true }).getByRole("listitem");
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("Fall 2026");
  await expect(listed).toContainText("Current season: parents see it · 4 steps · 6 requirements");
  await page.getByRole("link", { name: "Fall 2026" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fall 2026");
  await expect(page.getByRole("heading", { level: 2, name: /^\d\. / })).toHaveText(["1. Join", "2. Uniforms", "3. Season", "4. Wrap-up"]);
  const uniforms = page.getByRole("region", { name: "2. Uniforms" });
  await expect(uniforms).toContainText("Percussion truck crew sign-offChecklist item · Required · Each student · A chosen list of 1");
  // Only a kind that can be met today can be added; the others are listed and can't be picked.
  await uniforms.getByText("Add a requirement to Uniforms").click();
  const kinds = uniforms.getByLabel("Kind").locator("option");
  await expect(kinds).toHaveText(["Checklist item", "Form (coming later)", "Payment (coming later)", "Volunteering (coming later)"]);
  expect(await kinds.evaluateAll((all) => all.map((o) => (o as HTMLOptionElement).disabled))).toEqual([false, true, true, true]);
  await noSidewaysScroll(page);

  // The Club page offers the time zone that decides which day it is for a step's dates.
  await page.goto("/staff/settings/club");
  await expect(page.getByLabel(/^Time zone/)).toHaveValue("UTC");
});
