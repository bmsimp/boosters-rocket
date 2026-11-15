import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";
import { addressOf, isDynamic, paramsProblems, parentRoutes, type DynamicRouteParams } from "./parent-routes";

const sql = postgres(process.env.DATABASE_URL!);
test.afterAll(async () => { await sql.end(); });

// The seeded session (scripts/seed-e2e.ts) is Zelda's, with the Quetzalcoatl family chosen. Nothing here changes it,
// so both passes of the run, and a run without a new seed, find it as it was.

test("the seeded parent session opens the parent home, not the sign-in page", async ({ context, page, baseURL }) => {
  await context.addCookies([parentSessionCookie()]);
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveURL(`${baseURL}/`);
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

// Every parent page, found on disk: a new page is covered without being listed here.
const routes = parentRoutes();

/**
 * For a page with a dynamic segment: the params to ask for it with, ids from scripts/seed-e2e.ts. `own` is something of
 * the Quetzalcoatl family (E2E-FAMILY), `other` the same kind of thing in another family.
 *   "/students/[id]": { own: { id: "E2E-S1" }, other: { id: "E2E-S3" } },
 */
const PARAMS: Record<string, DynamicRouteParams> = {};

// Everything scripts/seed-e2e.ts gives a family that is not the Quetzalcoatl family, Zelda's second family included:
// strings that would give that family away, in the HTML or in the data sent with it. When the seed gives another
// family something new (a customer, an invoice, a form), add its recognizable strings here.
const OTHER_FAMILIES = ["Rivera", "Okafor", "Lee Family", "Lincoln High", "onerror=alert", "Second Family", "Wolfgang", "Secondborn",
  "ana@example.com", "sam@example.com", "555-0101", "E2E-FAMILY-2", "E2E-P2", "E2E-S3",
  // What the second family owes: its invoice numbers, each amount, its total and the address behind its Pay button.
  "SF-2051", "SF-2052", "SF-2009", "$312.47", "$64.19", "$273.58", "$376.66", "scs-v1-e2e-second"];

test("every parent page with a dynamic segment has params to ask for it with", () => {
  const problems = paramsProblems(routes, PARAMS);
  expect(problems, problems.join(" ")).toEqual([]);
});

test("every customer the seed gives another family is searched for", async () => {
  // The list above is kept by hand; this keeps it honest for the roster. A customer outside the Quetzalcoatl family
  // must hold at least one of the strings, in its name, id, email address or phone number.
  const others = await sql`SELECT qbo_id, display_name, email, phone FROM qbo_customer
    WHERE qbo_id <> ${PARENT_SESSION_FAMILY} AND parent_qbo_id IS DISTINCT FROM ${PARENT_SESSION_FAMILY}`;
  expect(others.length).toBeGreaterThan(5);
  const unsearched = others.filter((c) => !OTHER_FAMILIES.some((s) => [c.qbo_id, c.display_name, c.email, c.phone].some((v) => typeof v === "string" && v.includes(s))))
    .map((c) => `${c.qbo_id} (${c.display_name})`);
  expect(unsearched, `These customers in scripts/seed-e2e.ts belong to another family, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add a recognizable string of each: a name, an email address, an id that isn't a short number.`).toEqual([]);
});

test("every invoice the seed gives another family is searched for", async () => {
  // As above, for money: each invoice stored for a family other than the Quetzalcoatl family must be findable by its
  // number and its amount, and by its pay link when it has one.
  type Stored = { number: string; totalCents: number; payLink: string | null };
  const rows = await sql`SELECT family_qbo_id, invoices, total_cents FROM family_money WHERE family_qbo_id <> ${PARENT_SESSION_FAMILY}`;
  const invoices = rows.flatMap((r) => (r.invoices as Stored[]).map((i) => ({ family: r.family_qbo_id as string, ...i })));
  expect(invoices.length).toBeGreaterThanOrEqual(3);
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const searched = (value: string) => OTHER_FAMILIES.some((s) => value.includes(s));
  const unsearched = [
    ...invoices.flatMap((i) => [i.number, dollars(i.totalCents), ...(i.payLink ? [i.payLink] : [])].filter((v) => !searched(v)).map((v) => `${v} (an invoice of ${i.family})`)),
    ...rows.map((r) => dollars(Number(r.total_cents))).filter((v) => !searched(v)).map((v) => `${v} (a family's total)`),
  ];
  expect(unsearched, `scripts/seed-e2e.ts gives another family these, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add each.`).toEqual([]);
});

test("no parent page sends the browser anything of another family, in the HTML or in the data sent with it", async ({ context, page }) => {
  // tests/integration/parent-isolation.test.ts searches each page's HTML. This reads the whole response, which also
  // carries every prop a server component passes to a client component, rendered or not.
  expect(routes).toEqual(expect.arrayContaining(["/", "/display"]));
  await context.addCookies([parentSessionCookie()]);
  for (const route of routes) {
    const params = PARAMS[route];
    if (isDynamic(route) && !params) continue; // the test above fails and says what to add
    const own = addressOf(route, params?.own);
    const res = await page.goto(own);
    expect(res?.status(), own).toBe(200);
    const sent = await res!.text();
    expect(sent, own).toContain("Zelda"); // the signed-in parent's own page, not the sign-in page
    for (const theirs of OTHER_FAMILIES) expect(sent, `${own} sent "${theirs}" to a parent of the Quetzalcoatl family`).not.toContain(theirs);

    if (!params) continue;
    // Asked for another family's ids: a 404 or a page, but nothing of theirs. The address is echoed in what Next.js
    // sends, so a string that is in the address itself is not searched for.
    const other = addressOf(route, params.other);
    const asked = decodeURIComponent(other);
    const answer = await page.goto(other);
    expect(answer?.status(), `${other} must answer 404 or a page, not fail`).toBeLessThan(500);
    const answered = await answer!.text();
    for (const theirs of OTHER_FAMILIES.filter((s) => !asked.includes(s))) {
      expect(answered, `${other}, asked for by a parent of the Quetzalcoatl family with another family's ids, sent "${theirs}"`).not.toContain(theirs);
    }
  }
});
