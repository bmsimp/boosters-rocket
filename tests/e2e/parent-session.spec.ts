import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { parentSessionCookie } from "./parent-session";

// The seeded session (scripts/seed-e2e.ts) is Zelda's, with the Quetzalcoatl family chosen. Nothing here changes it,
// so both passes of the run, and a run without a new seed, find it as it was.

test("the seeded parent session opens the parent home, not the sign-in page", async ({ context, page }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(/localhost:3100\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, Zelda");
  await expect(page.getByText("Viewing Quetzalcoatl Family.")).toBeVisible();
  await page.goto("/display");
  await expect(page).toHaveURL(/\/display$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Display");
});

test("a cookie signed with another secret, or for a session that doesn't exist, is sent to sign in", async ({ browser }) => {
  const real = parentSessionCookie();
  const [token] = decodeURIComponent(real.value).split(".");
  const forged = { ...real, value: encodeURIComponent(`${token}.${Buffer.from("not the signature").toString("base64")}`) };
  for (const cookie of [forged, parentSessionCookie("no-such-session-token")]) {
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);
    await context.close();
  }
});

// Every parent page without a dynamic segment, found on disk: a new page is covered without being listed here.
const PARENT_DIR = "src/app/(parent)";
const parentRoutes = readdirSync(PARENT_DIR, { recursive: true }).map((f) => String(f).replaceAll("\\", "/"))
  .filter((f) => /(^|\/)page\.tsx$/.test(f))
  .map((f) => `/${f.split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/")}`)
  .filter((route) => !route.includes("["));
// Everything scripts/seed-e2e.ts puts in QuickBooks that is not the Quetzalcoatl family's, Zelda's second family included.
const OTHER_FAMILIES = ["Rivera", "Okafor", "Lee Family", "Lincoln High", "onerror=alert", "Second Family", "Wolfgang", "Secondborn",
  "ana@example.com", "sam@example.com", "555-0101", "E2E-FAMILY-2", "E2E-P2", "E2E-S3"];

test("no parent page sends the browser anything of another family, in the HTML or in the data sent with it", async ({ context, page }) => {
  // tests/integration/parent-isolation.test.ts searches each page's HTML. This reads the whole response, which also
  // carries every prop a server component passes to a client component, rendered or not.
  expect(parentRoutes).toEqual(expect.arrayContaining(["/", "/display"]));
  await context.addCookies([parentSessionCookie()]);
  for (const route of parentRoutes) {
    const res = await page.goto(route);
    expect(res?.status(), route).toBe(200);
    const sent = await res!.text();
    expect(sent, route).toContain("Zelda"); // the signed-in parent's own page, not the sign-in page
    for (const theirs of OTHER_FAMILIES) expect(sent, `${route} sent "${theirs}" to a parent of the Quetzalcoatl family`).not.toContain(theirs);
  }
});
