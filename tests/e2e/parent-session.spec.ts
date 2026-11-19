import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { PARENT_SESSION_FAMILY, parentSessionCookie } from "./parent-session";
import { addressOf, isDynamic, paramsProblems, parentRoutes } from "./parent-routes";
import { PARAMS } from "./parent-params";

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

// The params each parent page with a dynamic segment is asked for with: PARAMS, in tests/e2e/parent-params.ts, which
// tests/e2e/parent-a11y.spec.ts reads too (a spec can't import another spec).

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
  "second-moving.example",
  // Staff changes to other families waiting to reach QuickBooks (the write queue): a new student's name.
  "Pat Lee",
  // The Rivera family's refused buy-out (E2E_BUYOUT.refused, tests/e2e/buyout-seed.ts): its id; its requirement's title is above.
  "8d2e3f1a-6f3f-4000-8000-00000000b0b5"];

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
  // number and its amount, and by its pay link when it has one. The figures are kept by the app's own family (stage 2
  // of the app-owned families spec): another family's are those whose family isn't the one the Quetzalcoatl family's
  // customer is linked to, named here by the customer their family's link names.
  type Stored = { number: string; totalCents: number; payLink: string | null };
  const family = sql`SELECT family_id FROM accounting_link WHERE customer_id = ${PARENT_SESSION_FAMILY} AND family_id IS NOT NULL`;
  const rows = await sql`SELECT l.customer_id AS family_customer, m.invoices, m.total_cents FROM family_money m
    LEFT JOIN accounting_link l ON l.family_id = m.family_id WHERE m.family_id NOT IN (${family})`;
  const invoices = rows.flatMap((r) => (r.invoices as Stored[]).map((i) => ({ family: r.family_customer as string, ...i })));
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
  // by its title, and a waiver recorded for anyone outside that family by its reason. The season names the app's own
  // family and students (stage 2 of the app-owned families spec): the family's is the one its customer's link names.
  const family = sql`SELECT family_id FROM accounting_link WHERE customer_id = ${PARENT_SESSION_FAMILY} AND family_id IS NOT NULL`;
  const students = sql`SELECT id FROM student WHERE family_id IN (${family})`;
  const ours = (t: string) => sql`(coalesce(${sql(t)}.family_id IN (${family}), false) OR coalesce(${sql(t)}.student_id IN (${students}), false))`;
  const titles = await sql`SELECT r.title FROM requirement r WHERE r.covers = 'chosen'
    AND NOT EXISTS (SELECT 1 FROM requirement_cover c WHERE c.requirement_id = r.id AND ${ours("c")})`;
  const reasons = await sql`SELECT p.waived_reason FROM requirement_progress p WHERE p.waived_reason IS NOT NULL AND NOT ${ours("p")}`;
  expect(titles.length).toBeGreaterThanOrEqual(3);
  expect(reasons.length).toBeGreaterThanOrEqual(1);
  const unsearched = [...titles.map((r) => r.title as string), ...reasons.map((r) => r.waived_reason as string)].filter((v) => !OTHER_FAMILIES.some((s) => v.includes(s)));
  expect(unsearched, `scripts/seed-e2e.ts gives another family these in the season, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add a recognizable part of each.`).toEqual([]);
});

test("every buy-out the seed gives another family is searched for", async () => {
  // As above, for buy-outs: another family's must be findable by its id and by its requirement's title. Buy-outs name
  // the app's own family (stage 2 of the app-owned families spec): another family's is one whose family isn't the one
  // the Quetzalcoatl family's customer is linked to. Every state counts, so both passes of a run (the close spec ends
  // the Rivera family's refused one, and Zelda's own choices are her family's) find the same rows.
  const family = sql`SELECT family_id FROM accounting_link WHERE customer_id = ${PARENT_SESSION_FAMILY} AND family_id IS NOT NULL`;
  const rows = await sql`SELECT b.id, b.state, r.title, l.customer_id AS family_customer FROM buyout b JOIN requirement r ON r.id = b.requirement_id
    LEFT JOIN accounting_link l ON l.family_id = b.family_id WHERE b.family_id NOT IN (${family})`;
  expect(rows.length).toBeGreaterThanOrEqual(1);
  const unsearched = rows.flatMap((r) => [r.id as string, r.title as string].filter((v) => !OTHER_FAMILIES.some((s) => v.includes(s)))
    .map((v) => `${v} (a buy-out of ${r.family_customer}, ${r.state})`));
  expect(unsearched, `scripts/seed-e2e.ts gives another family these buy-outs, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add its id and a recognizable part of its requirement's title.`).toEqual([]);
});

test("every volunteer sign-up the seed gives another family is searched for", async () => {
  // As above, for volunteering: a sign-up of another family must be findable by its student's customer id or the name of
  // whoever fills it. Sign-ups name the app's own family and student (stage 2 of the app-owned families spec): another
  // family's is one whose family isn't the one the Quetzalcoatl family's customer is linked to, read back as the
  // customers their links name.
  const family = sql`SELECT family_id FROM accounting_link WHERE customer_id = ${PARENT_SESSION_FAMILY} AND family_id IS NOT NULL`;
  const rows = await sql`SELECT fl.customer_id AS family_customer, sl.customer_id AS student_customer, s.filler_name FROM volunteer_signup s
    JOIN accounting_link fl ON fl.family_id = s.family_id LEFT JOIN accounting_link sl ON sl.student_id = s.student_id
    WHERE s.family_id NOT IN (${family})`;
  expect(rows.length).toBeGreaterThanOrEqual(1);
  const unsearched = rows.filter((r) => !OTHER_FAMILIES.some((s) => (r.filler_name as string).includes(s) || (typeof r.student_customer === "string" && r.student_customer.includes(s))))
    .map((r) => `${r.filler_name} (a sign-up of ${r.family_customer})`);
  expect(unsearched, `scripts/seed-e2e.ts gives another family these volunteer sign-ups, and nothing in OTHER_FAMILIES (tests/e2e/parent-session.spec.ts) `
    + `would find them on a parent page: ${unsearched.join(", ")}. Add a recognizable part of each.`).toEqual([]);
});

test("every form request the seed gives another family is searched for", async () => {
  // As above, for forms: the form page sends its signers' names to the browser, so each value of another family's
  // request (its document's id, the name it was made for, each signer's name and address) must be findable.
  // A request names the app's own family (stage 2): another family's is any not the session family's record. Every
  // such request is scanned, said by the customer its family's link names, or by the record's own id with no link.
  const family = sql`SELECT family_id FROM accounting_link WHERE customer_id = ${PARENT_SESSION_FAMILY} AND family_id IS NOT NULL`;
  const rows = await sql`SELECT coalesce(fl.customer_id, r.family_id::text) AS family_label, r.envelope_id, r.subject_name, r.signers FROM signature_request r
    LEFT JOIN accounting_link fl ON fl.family_id = r.family_id WHERE r.family_id NOT IN (${family})`;
  expect(rows.length).toBeGreaterThanOrEqual(1);
  const values = rows.flatMap((r) => [r.envelope_id, r.subject_name, ...((r.signers as { name: string; email: string }[]) ?? []).flatMap((s) => [s.name, s.email])]
    .filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => ({ v, family: r.family_label as string })));
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
