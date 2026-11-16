import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";
import { addressOf, isDynamic, paramsProblems, parentRoutes, type DynamicRouteParams } from "./parent-routes";
import { E2E_VOLUNTEER } from "./volunteer-seed";
import { E2E_EMAIL } from "./email-seed";

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
const PARAMS: Record<string, DynamicRouteParams> = {
  // A shift is the club's, not a family's: `own` is one the Quetzalcoatl family can sign up for, `other` the one the
  // Rivera family has a place on. Neither may send anything of the Riveras' but the count.
  "/volunteer/shifts/[id]": { own: { id: E2E_VOLUNTEER.cleanup }, other: { id: E2E_VOLUNTEER.griddle } },
  // The Quetzalcoatl family's signed Travel consent, and the second family's unsigned one (fixed ids in scripts/seed-e2e.ts).
  "/forms/[id]": { own: { id: "e2e00000-0000-4000-8000-000000000001" }, other: { id: "e2e00000-0000-4000-8000-000000000002" } },
  // Zelda's change of sign-in address asked under the Quetzalcoatl family, and the one asked under her second family.
  "/family/email/[token]": { own: { token: E2E_EMAIL.own.token }, other: { token: E2E_EMAIL.other.token } },
};

// Everything scripts/seed-e2e.ts gives a family that is not the Quetzalcoatl family, Zelda's second family included:
// strings that would give that family away, in the HTML or in the data sent with it. When the seed gives another
// family something new (a customer, an invoice, a form), add its recognizable strings here.
const OTHER_FAMILIES = ["Rivera", "Okafor", "Lee Family", "Lincoln High", "onerror=alert", "Second Family", "Wolfgang", "Secondborn",
  "ana@example.com", "sam@example.com", "555-0101", "E2E-FAMILY-2", "E2E-P2", "E2E-S3",
  // What the second family owes: its invoice numbers, each amount, its total and the address behind its Pay button.
  "SF-2051", "SF-2052", "SF-2009", "$312.47", "$64.19", "$273.58", "$376.66", "scs-v1-e2e-second",
  // QuickBooks' own balance for the second family's student, which staff see under "Worth a look".
  "$362.47",
  // What the season asks of other families alone, and why one of them was let off.
  "Tuba locker key", "Percussion truck crew", "Cast on his arm",
  // Forms: the one asked of the second family alone, and the second family's own request: its document and its other guardian.
  "Trailer towing", "envelope_e2esecond", "Wilhelmina", "wilhelmina@second.example",
  // The address Zelda asked to change to under her second family.
  "second-moving.example"];

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

test("every requirement and waiver the seed gives another family alone is searched for", async () => {
  // As above, for the season: a requirement whose chosen list names nobody of the Quetzalcoatl family must be findable
  // by its title, and a waiver recorded for anyone outside that family by its reason.
  const mine = sql`SELECT qbo_id FROM qbo_customer WHERE qbo_id = ${PARENT_SESSION_FAMILY} OR parent_qbo_id = ${PARENT_SESSION_FAMILY}`;
  const titles = await sql`SELECT r.title FROM requirement r WHERE r.covers = 'chosen'
    AND NOT EXISTS (SELECT 1 FROM requirement_cover c WHERE c.requirement_id = r.id AND c.subject_qbo_id IN (${mine}))`;
  const reasons = await sql`SELECT waived_reason FROM requirement_progress WHERE waived_reason IS NOT NULL AND subject_qbo_id NOT IN (${mine})`;
  expect(titles.length).toBeGreaterThanOrEqual(3);
  expect(reasons.length).toBeGreaterThanOrEqual(1);
  const unsearched = [...titles.map((r) => r.title as string), ...reasons.map((r) => r.waived_reason as string)].filter((v) => !OTHER_FAMILIES.some((s) => v.includes(s)));
  expect(unsearched, `scripts/seed-e2e.ts gives another family these in the season, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add a recognizable part of each.`).toEqual([]);
});

test("every volunteer sign-up the seed gives another family is searched for", async () => {
  // As above, for volunteering: a sign-up of another family must be findable by its family's id or the name of whoever fills it.
  const rows = await sql`SELECT family_qbo_id, student_qbo_id, filler_name FROM volunteer_signup WHERE family_qbo_id <> ${PARENT_SESSION_FAMILY}`;
  expect(rows.length).toBeGreaterThanOrEqual(1);
  const unsearched = rows.filter((r) => !OTHER_FAMILIES.some((s) => (r.filler_name as string).includes(s) || (typeof r.student_qbo_id === "string" && r.student_qbo_id.includes(s))))
    .map((r) => `${r.filler_name} (a sign-up of ${r.family_qbo_id})`);
  expect(unsearched, `scripts/seed-e2e.ts gives another family these volunteer sign-ups, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add a recognizable part of each.`).toEqual([]);
});

test("every form request the seed gives another family is searched for", async () => {
  // As above, for forms: the form page sends its signers' names to the browser, so each value of another family's
  // request (its document's id, the name it was made for, each signer's name and address) must be findable.
  const rows = await sql`SELECT family_qbo_id, envelope_id, subject_name, signers FROM signature_request WHERE family_qbo_id <> ${PARENT_SESSION_FAMILY}`;
  expect(rows.length).toBeGreaterThanOrEqual(1);
  const values = rows.flatMap((r) => [r.envelope_id, r.subject_name, ...((r.signers as { name: string; email: string }[]) ?? []).flatMap((s) => [s.name, s.email])]
    .filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => ({ v, family: r.family_qbo_id as string })));
  const unsearched = values.filter(({ v }) => !OTHER_FAMILIES.some((s) => v.includes(s))).map(({ v, family }) => `${v} (a form request of ${family})`);
  expect(unsearched, `scripts/seed-e2e.ts gives another family these in its forms, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add a recognizable part of each.`).toEqual([]);
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
