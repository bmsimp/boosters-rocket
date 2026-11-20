import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { e2eMailPort } from "./run-config";
import { E2E_BUYOUT } from "./buyout-seed";
import { E2E_VOLUNTEER } from "./volunteer-seed";
import { codeFor, noSidewaysScroll, shot } from "./journey-helpers";
import { E2E_SIGNIN } from "./signin-seed";
import { removeZeldaDevicesMadeHere } from "./signin-links";

// One parent's whole visit, walked by what they would tap (docs/walkthrough.md): Zelda signs in with the code the
// portal mails her, chooses a family, reads Home, opens her signed form, looks at Payments, signs up for two shifts and
// cancels them, checks in at the shift that is on now, asks to pay instead of volunteering and to switch a buy-out
// back, looks at her details, changes the display, finds what installing needs, and signs out. It runs at 390 wide
// in the phone pass and 1440 in the desktop pass.
//
// Nothing here reaches QuickBooks or a Documenso. Forms are not set up in the seed, so her form is shown as stored.
// Money is the seed's figures. Every customer id in the seed is not digits, so the buy-out, the switch back and the
// details page are refused before anything is sent (tests/e2e/family-details.spec.ts checks the ids). The seed is left
// as it was found: both shifts are cancelled again, the refused buy-out is the kind the buy-out spec already leaves,
// and the check-in passes from either state, as tests/e2e/check-in.spec.ts does.
const sql = postgres(process.env.DATABASE_URL!);
let sink: MailSink;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const [seeded] = await sql`SELECT value FROM setting WHERE key = 'mail'`;
  expect((seeded?.value as { port?: number } | undefined)?.port, "the mail port in the seeded settings; seed again with this run's E2E_MAIL_PORT").toBe(e2eMailPort());
  sink = await startMailSink({ secure: true, port: e2eMailPort(), key: readFileSync(".e2e/sink-key.pem", "utf8"), cert: readFileSync(".e2e/sink-cert.pem", "utf8") });
});
// The sign-in remembers this browser's device for Zelda (slice SI-3b): it goes after, keeping the seed's.
test.afterAll(async () => { await removeZeldaDevicesMadeHere(sql); await sink.close(); await sql.end(); });

test("a parent's visit: sign in by password and emailed code, read and do what the family needs, and sign out", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
  sink.messages.length = 0;
  const phone = (page.viewportSize()?.width ?? 0) < 760;
  /** A parent tab: the tab bar at the foot of a phone, the club bar's links on a laptop. */
  const tab = (name: string) => (phone ? page.locator("nav.tabs") : page.locator("header.bar")).getByRole("link", { name, exact: true });

  await test.step("signs in with her password and the code from the email, and chooses a family", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
    await shot(page, "p01-sign-in");
    await page.getByLabel("Email").fill("zelda@example.com");
    await page.getByLabel("Password").fill(E2E_SIGNIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // A browser the portal doesn't know for her: the second step, the code it emails.
    await expect(page.getByRole("status")).toContainText("enter the 6-digit code we've emailed you");
    await page.getByLabel("6-digit code").fill(await codeFor(sql, sink, "zelda@example.com"));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/choose-family$/);
    await noSidewaysScroll(page);
    await shot(page, "p02-choose-family");
    await page.getByRole("button", { name: "Quetzalcoatl Family", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`);
  });

  await test.step("reads Home: what is owed, the season and each student", async () => {
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
    await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Quetzalcoatl Family" }).locator(".total, .owed, .big").first()).toContainText("$185.00");
    await expect(page.getByRole("heading", { name: "Your students" })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/Rivera|Second Family|Wolfgang/);
    await noSidewaysScroll(page);
    await shot(page, "p03-home");
  });

  await test.step("opens Forms, then the signed travel consent, and downloads it", async () => {
    await tab("Forms").click();
    await expect(page).toHaveURL(/\/forms$/);
    const family = page.getByRole("region", { name: "Your family" });
    await expect(family.locator(".state")).toHaveText("Signed");
    // The note that forms can't be signed yet speaks of those still to sign, never of the signed one.
    await expect(page.locator("main p[role=status]")).toHaveText(/^The forms still to sign aren't ready yet\./);
    await noSidewaysScroll(page);
    await shot(page, "p04-forms");
    await family.getByRole("link", { name: /^Open/ }).click();
    await expect(page).toHaveURL(/\/forms\/e2e00000-0000-4000-8000-000000000001$/);
    await expect(page.getByText("Zelda Quetzalcoatl (you)")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: /Download the signed form/ }).click();
    expect((await download).suggestedFilename()).toBe("signed-form.pdf");
    await noSidewaysScroll(page);
    await shot(page, "p05-form");
  });

  await test.step("looks at Payments: each open invoice, its Pay link to QuickBooks, and what was paid", async () => {
    await tab("Payments").click();
    await expect(page).toHaveURL(/\/payments$/);
    const owed = page.getByRole("region", { name: "Quetzalcoatl Family" });
    await expect(owed).toContainText("$185.00");
    const pay = owed.getByRole("link", { name: /^Pay/ });
    await expect(pay).toHaveCount(1);
    expect(new URL((await pay.getAttribute("href"))!).hostname).toMatch(/(^|\.)intuit\.com$/);
    await expect(page.getByRole("region", { name: "Paid in the last 12 months" })).toContainText("QZ-1017");
    await noSidewaysScroll(page);
    await shot(page, "p06-payments");
  });

  await test.step("signs up for two shifts, then cancels both", async () => {
    await tab("Volunteer").click();
    await expect(page).toHaveURL(/\/volunteer$/);
    await noSidewaysScroll(page);
    await shot(page, "p07-volunteer");
    const mine = page.getByRole("region", { name: "Your sign-ups" });
    for (const [label, shiftId] of [["7:00 am to 9:00 am, Griddle", E2E_VOLUNTEER.griddle], ["9:00 am to 11:00 am, Cleanup", E2E_VOLUNTEER.cleanup]] as const) {
      await page.getByRole("link", { name: `Sign up for ${label}` }).click();
      await expect(page).toHaveURL(new RegExp(`/volunteer/shifts/${shiftId}$`));
      await expect(page.getByRole("radio", { name: /^Me \(Zelda Quetzalcoatl\)/ })).toBeChecked();
      await page.getByRole("button", { name: "Sign me up" }).click();
      await expect(page.getByRole("status")).toContainText("You're signed up. Thank you!");
      await noSidewaysScroll(page);
      await page.getByRole("link", { name: "Back to Volunteer" }).first().click();
      await expect(mine).toContainText(`Pancake breakfast, ${label.split(", ")[1]}`);
    }
    await shot(page, "p08-signed-up");
    for (const role of ["Griddle", "Cleanup"]) {
      const place = mine.locator("li", { hasText: `Pancake breakfast, ${role}` });
      await place.getByRole("button", { name: "Cancel my sign-up" }).click();
      await place.getByRole("button", { name: "Yes, cancel it" }).click();
      await expect(mine).not.toContainText(`Pancake breakfast, ${role}`);
    }
    await expect(page.locator(".lines li").filter({ hasText: "7:00 am to 9:00 am, Griddle" })).toContainText("1 of 4 places filled");
    // The shift on now: what is left to do is check in there.
    await expect(mine.locator("li", { hasText: "Concession stand" })).toContainText(/This shift has started|Checked in/);
  });

  await test.step("checks in at the shift that is on now", async () => {
    // The check-in sheet's code opens this address on the parent's phone.
    await page.goto(`/volunteer/check-in/${E2E_VOLUNTEER.openCode}`);
    const button = page.getByRole("button", { name: "Check me in" });
    if (await button.isVisible()) await button.click();
    await expect(page.locator(".lines li").first()).toContainText("Checked in");
    await noSidewaysScroll(page);
    await shot(page, "p09-check-in");
    await page.getByRole("link", { name: "Back to Volunteer" }).click();
    await expect(page.getByRole("region", { name: "Your sign-ups" }).locator("li", { hasText: "Concession stand" })).toContainText("Checked in");
  });

  await test.step("chooses to pay instead, and is told calmly it couldn't be set up", async () => {
    const payInstead = page.getByRole("region", { name: "Pay instead of volunteering" });
    await payInstead.locator(".lines li").filter({ hasText: "Pit crew hours" }).getByRole("link", { name: /^Pay instead of volunteering \(\$25\.00\)/ }).click();
    await expect(page).toHaveURL(new RegExp(`/volunteer/pay-instead/${E2E_BUYOUT.offered}/family$`));
    await noSidewaysScroll(page);
    await shot(page, "p10-pay-instead");
    await page.getByRole("button", { name: "Confirm: invoice me $25.00" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("nothing has been billed");
  });

  await test.step("asks to switch a buy-out back to volunteering, and nothing is changed", async () => {
    await page.goto("/volunteer");
    await page.getByRole("region", { name: "Pay instead of volunteering" }).locator(".lines li").filter({ hasText: "Concession help" })
      .getByRole("link", { name: /^See your buy-out/ }).click();
    await expect(page).toHaveURL(new RegExp(`/volunteer/pay-instead/${E2E_BUYOUT.invoiced}/family$`));
    await page.getByRole("button", { name: "Volunteer instead" }).click();
    await expect(page.getByRole("button", { name: "Keep paying instead" })).toBeFocused();
    await page.getByRole("button", { name: "Yes, cancel the invoice" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("nothing was changed");
    const [b] = await sql`SELECT state FROM buyout WHERE id = ${E2E_BUYOUT.buyout}`;
    expect(b!.state).toBe("invoiced");
    await noSidewaysScroll(page);
    await shot(page, "p11-switch-back");
  });

  await test.step("opens their details from Family, in a form that holds the portal's own", async () => {
    await tab("Family").click();
    await expect(page).toHaveURL(/\/family$/);
    await noSidewaysScroll(page);
    await shot(page, "p12-family");
    await page.getByRole("link", { name: "Update my details" }).click();
    await expect(page).toHaveURL(/\/family\/details$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Update your details");
    // Her phone and address are the portal's own (stage 3's slice 11a): the form holds them, and nothing is sent here.
    await expect(page.getByRole("button", { name: "Save my details" })).toBeVisible();
    await shot(page, "p13-details");
  });

  await test.step("changes the display, finds what installing needs, and signs out", async () => {
    await page.getByRole("link", { name: /^ZQ/ }).click();
    await expect(page).toHaveURL(/\/display$/);
    await page.getByRole("radio", { name: /^Dark/ }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await shot(page, "p14-display-dark");
    await page.getByRole("radio", { name: /^Match my device/ }).first().check();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("heading", { name: "Add the portal to your home screen" })).toBeVisible();
    // What a phone reads to install the portal: the manifest the page names, and its icons.
    const href = await page.locator('link[rel="manifest"]').getAttribute("href");
    const manifest = await (await page.request.get(href!)).json() as { name: string; start_url: string; icons: { src: string }[] };
    expect(manifest.name).toBe("E2E Boosters");
    for (const icon of manifest.icons) expect((await page.request.get(icon.src)).headers()["content-type"]).toBe("image/png");
    await noSidewaysScroll(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/payments");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fpayments$/);
  });
});
