import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isPermission } from "@/lib/permissions/registry";

/**
 * Every page and route handler is guarded, found from disk: nobody registers a new page here. A page guards itself.
 * A layout is not a guard in this Next.js version: layouts do not re-run when the browser navigates between pages
 * (node_modules/next/dist/docs/01-app/02-guides/authentication.md), so a page that leans on its layout is open.
 *
 * This is a scan of the source. tests/integration/parent-isolation.test.ts then runs every parent page and proves the
 * guard is really reached: no session goes to /sign-in, no chosen family goes to /choose-family.
 */
const root = path.resolve(__dirname, "../..");
const filesUnder = (dir: string): string[] =>
  readdirSync(path.join(root, dir), { recursive: true }).map((f) => `${dir}/${String(f).replaceAll("\\", "/")}`);
const app = filesUnder("src/app");
const isPage = (f: string) => /\/page\.(tsx|ts|jsx|js)$/.test(f);
const isRoute = (f: string) => /\/route\.(tsx|ts|jsx|js)$/.test(f);

const PARENT_PAGES = "src/app/(parent)/";
const STAFF_PAGES = "src/app/staff/(app)/";
const STAFF_HOME = "src/app/staff/(app)/page.tsx";

const read = (file: string) => readFileSync(path.join(root, file), "utf8");
/** The code without comments, so a guard that is only mentioned, or commented out, doesn't count. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
/** The part of the file from its default export on: the page itself, not a helper declared above it. */
const pageBody = (source: string): string => {
  const at = code(source).search(/\bexport\s+default\b/);
  return at < 0 ? "" : code(source).slice(at);
};
const importsFromGuards = (source: string, name: string) =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']@/lib/guards["']`).test(code(source));

/** "src/app/(parent)/students/[id]/page.tsx" is the route "/students/[id]": route groups in (parentheses) are not part of the address. */
const parentRouteOf = (file: string) =>
  `/${file.slice(PARENT_PAGES.length).split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).join("/")}`;

/**
 * What is wrong with a parent page's guard, in words that say what to add; null when it is right. The guard is given
 * the page's own address, so a visitor who has to sign in first is brought back to it: that address must be written
 * out where this scan can read it, and must be this page's, not another's. Only the home page may leave it out:
 * everyone lands there anyway.
 */
function parentPageProblem(file: string, source = read(file)): string | null {
  const call = /\brequireParentPage\(\s*([^)]*?)\s*\)/.exec(pageBody(source));
  if (!importsFromGuards(source, "requireParentPage") || !call) {
    return `${file}: a parent page must call requireParentPage() itself; the layout guards nothing, and does not run again on client navigation. `
      + `Add \`import { requireParentPage } from "@/lib/guards";\` and make \`const ctx = await requireParentPage("/this-page");\` (the page's own address) the first line of the page's default export (an async function).`;
  }
  const argument = call[1]!;
  const route = parentRouteOf(file);
  const fixedPart = route.split("[")[0]!;
  const own = route.includes("[") ? `a template that starts with \`${fixedPart}\${...}\` for the route ${route}.` : `"${route}".`;
  if (argument === "") {
    return route === "/" ? null
      : `${file}: requireParentPage() is called with no address, which only the home page may do. Pass this page's own address, written out, so a parent who signs in is brought back here: ${own}`;
  }
  const literal = /^(["'])([^"'`]*)\1$/.exec(argument)?.[2];
  const ok = route.includes("[") ? argument.startsWith(`\`${fixedPart}\${`) : literal === route;
  if (ok) return null;
  return `${file}: requireParentPage(${argument}) must be given this page's own address, written out, so a parent who signs in is brought back here and not somewhere else: ${own}`;
}

/** The same for a staff page: the guard, with a permission from src/lib/permissions/registry.ts on every page but the staff home. */
function staffPageProblem(file: string, source = read(file)): string | null {
  const call = /\brequireStaffPage\(\s*([^)]*?)\s*\)/.exec(pageBody(source));
  if (!importsFromGuards(source, "requireStaffPage") || !call) {
    return `${file}: a staff page must call requireStaffPage(...) itself; the guard in the layout does not run on client navigation. `
      + `Add \`import { requireStaffPage } from "@/lib/guards";\` and make \`const ctx = await requireStaffPage("Area.Object.Level");\` the first line of the page's default export (an async function).`;
  }
  const argument = call[1]!;
  if (argument === "") {
    return file === STAFF_HOME ? null
      : `${file}: requireStaffPage() is called with no permission, which only the staff home may do. Pass the permission this page needs, as a string from src/lib/permissions/registry.ts: \`await requireStaffPage("Area.Object.Level")\`.`;
  }
  const literal = /^(["'])([^"']+)\1$/.exec(argument)?.[2];
  if (!literal || !isPermission(literal)) {
    return `${file}: requireStaffPage(${argument}) must be given a permission written out as a string that is listed in src/lib/permissions/registry.ts, so the page's permission can be read from its source.`;
  }
  return null;
}

/**
 * Pages outside the two guarded trees, each with how it is protected. A new page belongs under src/app/(parent)/ or
 * src/app/staff/(app)/; adding one here is a decision that it may be seen without that guard.
 */
const OTHER_PAGES: Record<string, string> = {
  "src/app/sign-in/page.tsx": "Public: the parent sign-in form. Shows no family data (tests/e2e/public-pages.spec.ts).",
  "src/app/sign-in/set-up/[token]/page.tsx": "No session: the set-up link in its address is the guard (linkVerdict(), src/lib/parents/signin-links.ts). Opening it writes nothing; it shows the form or one message, the same for every refusal, and nothing of a person or family. Its action (beforeSignInAction, src/app/sign-in/password-actions.ts) checks the link again under the person's lock (tests/integration/password-links.test.ts).",
  "src/app/sign-in/reset/[token]/page.tsx": "No session: the reset link in its address is the guard, as the set-up page's (linkVerdict(), src/lib/parents/signin-links.ts). Opening it writes nothing; it shows the form or one message, the same for every refusal, and nothing of a person or family (tests/integration/password-links.test.ts).",
  "src/app/staff/sign-in/page.tsx": "Public: the staff sign-in buttons. Shows no family data (tests/e2e/public-pages.spec.ts).",
  "src/app/refused/page.tsx": "Public: one fixed message, the same whoever is refused and whatever the reason.",
  "src/app/choose-family/page.tsx": "Reads getParentState() itself and redirects to /sign-in without a session; it lists only the signed-in parent's own families (tests/integration/choose-family-action.test.ts).",
  "src/app/setup/page.tsx": "Answers 404 once setup is finished; while it is open, everything past the unlock form needs the setup session cookie (tests/integration/setup-state.test.ts, tests/e2e/setup.spec.ts).",
};

/**
 * Every route handler, each with how it is guarded. A route handler has no page guard and no server-action wrapper, so
 * each one is a decision: add the file here with a sentence saying what stops a stranger, and a test that proves it.
 * Nothing lives under src/app/(parent)/ or src/app/staff/ today. Machine-facing endpoints live under /api/, which
 * src/proxy.ts leaves alone while setup is open; anything else is redirected to /setup.
 */
const ROUTE_HANDLERS: Record<string, string> = {
  "src/app/api/auth/parent/[...all]/route.ts": "Better Auth's own handler for the parent door; the routes a parent doesn't need answer 404 (PARENT_DISABLED_PATHS in src/lib/auth/parent-auth.ts, tests/integration/parent-door.test.ts).",
  "src/app/api/auth/staff/[...all]/route.ts": "Better Auth's own handler for the staff door (src/lib/auth/staff-auth.ts).",
  "src/app/api/documenso/webhook/route.ts": "The secret Documenso sends in X-Documenso-Secret, compared in constant time; without it, a bare 404. A message is only a hint: the handler stores what Documenso's API says about the portal's own request, never what the body says, and answers with no data (tests/integration/forms-webhook.test.ts).",
  "src/app/api/health/route.ts": "Public on purpose: answers only {ok: true} or {ok: false} (tests/integration/health.test.ts).",
  "src/app/api/internal/worker/route.ts": "The worker's token (isWorkerRequest); without it, a bare 404 (tests/integration/jobs-runner.test.ts).",
  "src/app/api/quickbooks/callback/route.ts": "A staff session with Settings.QuickBooks.ReadWrite, checked in the handler, and the state value from the connect step (tests/integration/quickbooks-connection.test.ts).",
  "src/app/icons/[name]/route.ts": "Public on purpose: the club's app icons, which a phone fetches before anyone signs in. It answers a fixed list of names with a picture of the club's short name on the club's color, and reads no family data (tests/integration/pwa-icons.test.ts).",
  "src/app/staff/(app)/audit/export/route.ts": "A staff session with Audit.Log.Read, which only an Admin holds, checked in the handler before anything is read; anyone else is redirected with no rows. Each export is audited and sent no-store (tests/integration/audit-log.test.ts).",
  "src/app/(parent)/forms/[id]/signed/route.ts": "The parent session, checked first in the handler by requireParentPage() (signed out: to sign-in and back; refused: /refused). The request id is looked up within the session's app family (activeFamilyOf()) and its evidence by request, by that app family and by the roster's company, never an earlier company's (findMySignedPdf); an id that isn't a uuid, nobody's, another family's or one with no kept evidence all answer the same 404 with no bytes. Sent no-store with a fixed file name (tests/integration/signed-forms-downloads.test.ts).",
  "src/app/staff/(app)/forms/evidence/[id]/[file]/route.ts": "A staff session with Forms.Signature.Read, checked in the handler before anything is read; anyone else is redirected with no bytes. Each download is audited (forms.evidence.download) before a byte is sent, no-store, with a fixed file name (tests/integration/signed-forms-downloads.test.ts).",
  "src/app/setup/certificates/[name]/route.ts": "downloadAccess(): the setup session while setup is open, or an Admin afterward; otherwise 404 (tests/integration/setup-certificates-route.test.ts).",
  "src/app/setup/finish/route.ts": "Setup open, the setup session cookie, and the named Admin signed in; otherwise a redirect that changes nothing (tests/integration/setup-finish.test.ts).",
  "src/app/setup/scripts/[name]/route.ts": "downloadAccess(), as the certificate download; otherwise 404 (tests/integration/setup-scripts-route.test.ts).",
};

/**
 * Modules that read across families, for staff pages only: never imported by anything under src/app/(parent)/.
 * A parent page reads through a query that takes ctx.familyId and returns that family alone.
 */
const STAFF_ONLY_IMPORTS: { module: string; names: string[] | "all"; why: string }[] = [
  { module: "@/lib/roster/queries", names: "all", why: "loadRosterPage(), rosterFamilies() and rosterEntry() load every family in the club" },
  { module: "@/lib/parents/directory", names: ["listPeople", "getPerson", "familySignins"], why: "they return other families' names, a family's guardians, or a block reason (see the note at the top of the module)" },
  { module: "@/lib/seasons/setup", names: "all", why: "a requirement's chosen list names other families and students" },
  { module: "@/lib/seasons/subjects", names: "all", why: "loadSeasonFamilies() loads every family in the club" },
  { module: "@/lib/seasons/staff-progress", names: "all", why: "it reads every family's ticks and waivers, with the reasons" },
  { module: "@/lib/seasons/everyone", names: "all", why: "the season's reads for every family at once: every chosen list, tick and waiver with its reason" },
  { module: "@/lib/money/balances", names: "all", why: "loadBalances() loads every family's money" },
  { module: "@/lib/money/sweep", names: "all", why: "the worker's run reads every family's invoices" },
  { module: "@/lib/money/items", names: "all", why: "it is the staff choice of what a payment requirement is met by" },
  { module: "@/lib/volunteer/setup", names: "all", why: "a shift's sign-up list names people of every family" },
  { module: "@/lib/signed-forms/matrix", names: "all", why: "the matrix lists every family's forms and who has signed them" },
  { module: "@/lib/signed-forms/evidence", names: "all", why: "it opens any family's signed form, its evidence and the earlier company's archive" },
  { module: "@/lib/signed-forms/evidence-job", names: "all", why: "the worker fetches every family's completed forms" },
  { module: "@/lib/signed-forms/copies", names: "all", why: "it reads every family's kept forms to send their copies" },
  { module: "@/lib/signed-forms/reminders", names: "all", why: "the reminder sweep reads every family's forms and guardians" },
  { module: "@/lib/signed-forms/start-again", names: "all", why: "it starts any family's form again, by its id" },
  { module: "@/lib/signed-forms/worker", names: "all", why: "the worker's call into all of the above" },
  { module: "@/lib/signed-forms/rules", names: "all", why: "the staff words and rules of the signed forms pages; parents read src/lib/forms/states.ts" },
  { module: "@/lib/volunteer/staff-credit", names: "all", why: "it reads staff notes and removal reasons, and loads every family for the credit pages" },
  { module: "@/lib/volunteer/reminders", names: "all", why: "the worker's reminders read every family's sign-ups and standings" },
  { module: "@/lib/seasons/due-reminders", names: "all", why: "the worker's due-date reminders read every family's standings, figures and guardians" },
  { module: "@/lib/volunteer/moved-student", names: "all", why: "it is a roster write's, and reads the sign-up list of staff" },
  { module: "@/lib/roster/writes", names: "all", why: "staff changes to the roster in QuickBooks: it reads every family, and sends writes" },
  { module: "@/lib/roster/queue", names: "all", why: "the write queue names every family's waiting changes" },
  { module: "@/lib/buyouts/staff", names: "all", why: "the Reconciliation list of every family's buy-outs that need a look, and one family's buy-outs for staff" },
  { module: "@/lib/buyouts/close", names: "all", why: "staff close any family's buy-out by its id, and give up its queue item" },
  { module: "@/lib/buyouts/daily-check", names: "all", why: "the worker's check of every family's buy-out invoices" },
  { module: "@/lib/buyouts/setup", names: "all", why: "the staff choice of a requirement's buy-out price and item" },
  { module: "@/lib/buyouts/moved", names: "all", why: "it is a roster write's: a moved student's buy-outs" },
  { module: "@/lib/staff-home/today", names: "all", why: "the staff home's counts read every family's forms and every shift's sign-ups" },
  { module: "@/lib/quickbooks/sandbox-check/run", names: "all", why: "the Admin's check of the portal's requests reads every customer and some families' invoices" },
  { module: "@/lib/quickbooks/sandbox-check/writes", names: "all", why: "the check's writes to QuickBooks, for an Intuit sandbox company only" },
  { module: "@/lib/families/roster-import", names: "all", why: "the import of the app's own records from the roster: it reads every family's customers, sign-ins and records (its one caller under src/ is src/lib/roster/no-family.ts, since stage 3's slice 10)" },
  { module: "@/lib/roster/no-family", names: "all", why: "the customers no family is linked to read every customer of the roster cache, and 'Create a family from this' makes a family of any of them" },
  { module: "@/lib/parents/guardians", names: "all", why: "staff add, remove and reinstate guardians: it gives any address a sign-in for any family" },
  { module: "@/lib/parents/people", names: "all", why: "staff block and rename people: a rename starts sends to QuickBooks for each membership's Parent customer (stage 3's slice 9h)" },
  { module: "@/lib/parents/contact-take-in", names: "all", why: "the take-in of contact details reads every person, guardian row, family and cached customer at once (stage 3's slice 11a)" },
];

describe("every page guards itself", () => {
  const parentPages = app.filter((f) => f.startsWith(PARENT_PAGES) && isPage(f));
  const staffPages = app.filter((f) => f.startsWith(STAFF_PAGES) && isPage(f));

  it("finds the pages on disk", () => {
    expect(parentPages).toContain("src/app/(parent)/page.tsx");
    expect(staffPages).toContain(STAFF_HOME);
    expect(staffPages.length).toBeGreaterThan(10);
  });

  it.each(parentPages)("%s calls requireParentPage() in the page", (file) => {
    const problem = parentPageProblem(file);
    if (problem) expect.fail(problem);
  });

  it.each(staffPages)("%s calls requireStaffPage() in the page, with a permission", (file) => {
    const problem = staffPageProblem(file);
    if (problem) expect.fail(problem);
  });

  // The scan itself, on sources written here: what it accepts and what it catches.
  const PARENT_IMPORT = `import { requireParentPage } from "@/lib/guards";\n`;
  const STAFF_IMPORT = `import { requireStaffPage } from "@/lib/guards";\n`;
  const HOME = "src/app/(parent)/page.tsx", NEW = "src/app/(parent)/new/page.tsx", NEW_STAFF = "src/app/staff/(app)/new/page.tsx";

  it("accepts a parent page that calls the guard, alone or beside other loads", () => {
    expect(parentPageProblem(NEW, `${PARENT_IMPORT}export default async function P() {\n  const ctx = await requireParentPage("/new");\n  return <p>{ctx.name}</p>;\n}`)).toBeNull();
    expect(parentPageProblem(NEW, `${PARENT_IMPORT}export default async function P() {\n  const [ctx, club] = await Promise.all([requireParentPage("/new"), getClubSettings()]);\n  return null;\n}`)).toBeNull();
  });

  it("lets the home page, and no other, call the guard with no address", () => {
    const bare = `${PARENT_IMPORT}export default async function P() {\n  const ctx = await requireParentPage();\n  return <p>{ctx.name}</p>;\n}`;
    expect(parentPageProblem(HOME, bare)).toBeNull();
    expect(parentPageProblem(NEW, bare)).toContain(`${NEW}: requireParentPage() is called with no address, which only the home page may do`);
    expect(parentPageProblem(NEW, bare)).toContain(`"/new".`);
    expect(parentPageProblem("src/app/(parent)/forms/[id]/page.tsx", bare)).toContain("a template that starts with `/forms/${...}`");
  });

  // The guard may be told the page's own address (src/lib/guards.ts): a visitor who signs in is brought back to it.
  const NEW_DYNAMIC = "src/app/(parent)/forms/[id]/page.tsx";
  const withGuard = (call: string) => `${PARENT_IMPORT}export default async function P({ params }) {\n  const { id } = await params;\n  const ctx = await ${call};\n  return null;\n}`;

  it("accepts a parent page that gives the guard its own address", () => {
    expect(parentPageProblem(NEW, withGuard(`requireParentPage("/new")`))).toBeNull();
    expect(parentPageProblem(NEW, withGuard(`requireParentPage('/new')`))).toBeNull();
    expect(parentPageProblem(HOME, withGuard(`requireParentPage("/")`))).toBeNull();
    expect(parentPageProblem("src/app/(parent)/(money)/payments/page.tsx", withGuard(`requireParentPage("/payments")`))).toBeNull();
    expect(parentPageProblem(NEW_DYNAMIC, withGuard("requireParentPage(`/forms/${id}`)"))).toBeNull();
    expect(parentPageProblem(NEW_DYNAMIC, withGuard("requireParentPage(`/forms/${encodeURIComponent(id)}`)"))).toBeNull();
  });

  it.each([
    ["gives the guard another page's address", NEW, `requireParentPage("/payments")`],
    ["gives the guard an address this scan can't read", NEW, `requireParentPage(HERE)`],
    ["gives the guard an address on another site", NEW, `requireParentPage("https://evil.example/new")`],
    ["has a dynamic segment and gives the guard a fixed address", NEW_DYNAMIC, `requireParentPage("/forms")`],
    ["has a dynamic segment and gives the guard another page's template", NEW_DYNAMIC, "requireParentPage(`/students/${id}`)"],
    ["has a dynamic segment and gives the guard only what it was asked for", NEW_DYNAMIC, "requireParentPage(id)"],
  ])("catches a parent page that %s", (_what, file, call) => {
    expect(parentPageProblem(file, withGuard(call))).toContain(`${file}: ${call.split("(")[0]}(`);
    expect(parentPageProblem(file, withGuard(call))).toContain("must be given this page's own address");
  });

  it.each([
    ["has no guard and leans on the layout", `export default function P() { return <p>Display</p>; }`],
    ["only mentions the guard in a comment", `${PARENT_IMPORT}export default async function P() {\n  // const ctx = await requireParentPage();\n  /* await requireParentPage() */\n  return null;\n}`],
    ["calls the guard only in a helper above the page", `${PARENT_IMPORT}async function load() { return requireParentPage(); }\nexport default function P() { return null; }`],
    ["calls a guard of the same name from somewhere else", `import { requireParentPage } from "./my-guard";\nexport default async function P() { await requireParentPage(); return null; }`],
  ])("catches a parent page that %s", (_what, source) => {
    expect(parentPageProblem(NEW, source)).toContain(`${NEW}: a parent page must call requireParentPage() itself`);
  });

  it("accepts a staff page with a permission, and the staff home with none", () => {
    expect(staffPageProblem(NEW_STAFF, `${STAFF_IMPORT}export default async function P() {\n  const ctx = await requireStaffPage("Roster.Read");\n  return null;\n}`)).toBeNull();
    expect(staffPageProblem(NEW_STAFF, `${STAFF_IMPORT}export default async function P() {\n  const [ctx] = await Promise.all([requireStaffPage('Roster.Read'), load()]);\n  return null;\n}`)).toBeNull();
    expect(staffPageProblem(STAFF_HOME, `${STAFF_IMPORT}export default async function P() { const ctx = await requireStaffPage(); return null; }`)).toBeNull();
  });

  it.each([
    ["has no guard", `export default function P() { return null; }`, "a staff page must call requireStaffPage(...) itself"],
    ["passes no permission and isn't the staff home", `${STAFF_IMPORT}export default async function P() { await requireStaffPage(); return null; }`, "called with no permission, which only the staff home may do"],
    ["passes a permission that doesn't exist", `${STAFF_IMPORT}export default async function P() { await requireStaffPage("Roster.Everything"); return null; }`, "must be given a permission written out as a string"],
    ["passes a permission the scan can't read", `${STAFF_IMPORT}const NEEDS = "Roster.Read";\nexport default async function P() { await requireStaffPage(NEEDS); return null; }`, "must be given a permission written out as a string"],
  ])("catches a staff page that %s", (_what, source, problem) => {
    expect(staffPageProblem(NEW_STAFF, source)).toContain(`${NEW_STAFF}: `);
    expect(staffPageProblem(NEW_STAFF, source)).toContain(problem);
  });

  it("has no page outside the two guarded trees that isn't listed here with how it is protected", () => {
    const others = app.filter((f) => isPage(f) && !f.startsWith(PARENT_PAGES) && !f.startsWith(STAFF_PAGES));
    const unlisted = others.filter((f) => !(f in OTHER_PAGES));
    expect(unlisted, `These pages are outside src/app/(parent)/ and src/app/staff/(app)/, so no page guard is checked for them: ${unlisted.join(", ")}. `
      + `Move each under one of those folders, or add it to OTHER_PAGES in tests/integration/page-guards.test.ts with a sentence saying how it is protected.`).toEqual([]);
    const gone = Object.keys(OTHER_PAGES).filter((f) => !others.includes(f));
    expect(gone, `OTHER_PAGES lists pages that no longer exist: ${gone.join(", ")}. Remove them.`).toEqual([]);
  });
});

describe("every route handler is listed with its guard", () => {
  const routes = app.filter(isRoute);

  it("has no route handler that isn't listed here with how it is guarded", () => {
    const unlisted = routes.filter((f) => !(f in ROUTE_HANDLERS));
    expect(unlisted, `These route handlers are not in ROUTE_HANDLERS in tests/integration/page-guards.test.ts: ${unlisted.join(", ")}. `
      + `A route handler has no page guard and no action wrapper. Add each with a sentence saying how it is guarded and which test proves it; `
      + `one that returns a family's data must take the family from the session (getParentIdentity()), never from the URL.`).toEqual([]);
    const gone = Object.keys(ROUTE_HANDLERS).filter((f) => !routes.includes(f));
    expect(gone, `ROUTE_HANDLERS lists route handlers that no longer exist: ${gone.join(", ")}. Remove them.`).toEqual([]);
  });

  it("has none under the parent pages or the staff pages", () => {
    // Listed above or not, a handler in these trees sits beside guarded pages and looks guarded when it isn't.
    const inside = routes.filter((f) => f.startsWith(PARENT_PAGES) || f.startsWith("src/app/staff/"));
    for (const f of inside) expect(ROUTE_HANDLERS[f], `${f} is a route handler among the guarded pages: list it in ROUTE_HANDLERS with how it is guarded`).toBeTruthy();
  });
});

/** One place a source file names another module, in any of the ways JavaScript has. `module` is null when it isn't written as a plain string. */
type ModuleUse = { module: string | null; clause: string; text: string };

/**
 * Every module a file reaches for: `import ... from`, `export ... from`, a bare `import "m"`, `import("m")` and
 * `require("m")`. `clause` is what stands between the keyword and `from` (the names taken); the other forms take the
 * whole module, written here as "*".
 */
function moduleUses(source: string): ModuleUse[] {
  const src = code(source);
  const uses: ModuleUse[] = [];
  const oneLine = (text: string) => text.replace(/\s+/g, " ");
  // The clause holds no quote, semicolon, "=" or bracket and no second keyword, so it can't run on from an earlier statement.
  for (const m of src.matchAll(/\b(?:import|export)\s+(?:type\s+)?((?:(?!\b(?:import|export)\b)[^;"'`=()])*?)\s*\bfrom\s*(["'`])([^"'`]+)\2/g)) {
    uses.push({ module: m[3]!, clause: m[1]!, text: oneLine(m[0]) });
  }
  for (const m of src.matchAll(/\bimport\s*(["'`])([^"'`]+)\1/g)) uses.push({ module: m[2]!, clause: "*", text: oneLine(m[0]) });
  for (const m of src.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
    const literal = /^(["'`])([^"'`$]+)\1$/.exec(m[1]!)?.[2] ?? null;
    uses.push({ module: literal, clause: "*", text: oneLine(m[0]) });
  }
  return uses;
}

/** The names a clause takes ("listPeople" in `{ listPeople as people }`), and whether it takes the module whole: a default, `* as name` or `*`. */
function taken(clause: string): { whole: boolean; names: string[] } {
  const names = (/\{([^}]*)\}/.exec(clause)?.[1] ?? "").split(",")
    .map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
  const outsideBraces = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
  return { whole: outsideBraces !== "" || names.includes("default"), names };
}

/** The file a module path names, without its extension: "@/lib/x", "@/lib/x.ts" and "../../../lib/x" (from a page three folders down) are one module. */
function moduleFile(module: string, importer: string): string {
  const file = module.startsWith("@/") ? `src/${module.slice(2)}`
    : module.startsWith(".") ? path.posix.join(path.posix.dirname(importer), module) : module;
  return path.posix.normalize(file).replace(/\.(tsx?|jsx?|mjs|cjs)$/, "").replace(/\/index$/, "");
}

/** Everything in a parent file that reaches a staff-only module, in words that say what to do instead; empty when there is nothing. */
function staffOnlyImportProblems(file: string, source = read(file)): string[] {
  const instead = `Read through a query that takes ctx.familyId and returns that family alone.`;
  const problems: string[] = [];
  for (const use of moduleUses(source)) {
    if (use.module === null) {
      problems.push(`${file}: \`${use.text}\` loads a module this scan can't read, so it can't tell whether it is a staff-only one. Write the module's path as a plain string.`);
      continue;
    }
    const target = moduleFile(use.module, file);
    for (const { module, names, why } of STAFF_ONLY_IMPORTS) {
      const staffOnly = moduleFile(module, file);
      // The same file, or the same path under another root: a relative path or an alias the scan resolved differently.
      if (target !== staffOnly && !target.endsWith(staffOnly.slice("src".length))) continue;
      const { whole, names: takenNames } = taken(use.clause);
      if (names === "all") {
        problems.push(`${file}: \`${use.text}\` reaches ${module}, which is for staff pages only: ${why}. ${instead}`);
      } else if (whole) {
        problems.push(`${file}: \`${use.text}\` takes the whole of ${module}, and with it ${names.join(", ")}, which are for staff pages only: ${why}. `
          + `Import by name only what the page needs (\`import { accessWords } from "${module}"\`), never the module whole. ${instead}`);
      } else {
        const bad = names.filter((n) => takenNames.includes(n));
        if (bad.length) problems.push(`${file}: \`${use.text}\` takes ${bad.join(", ")} from ${module}, which ${bad.length > 1 ? "are" : "is"} for staff pages only: ${why}. ${instead}`);
      }
    }
  }
  return problems;
}

/**
 * Parent code that lives outside src/app/(parent)/: the query modules parent pages read their family through, the
 * frame drawn around every parent page, and the not-found page, which draws that frame for a signed-in parent. They
 * pass the same scan, so they can never come to import a staff-only module.
 * A new query module for parent pages is added here, one to a line.
 */
const PARENT_CODE_ELSEWHERE = [
  "src/lib/parents/my-family.ts",
  "src/lib/parents/contact-edits.ts",
  "src/lib/parents/contact-fields.ts",
  "src/lib/parents/email-change.ts",
  "src/lib/parents/email-field.ts",
  // The confirmed address taken into the roster cache, and nothing else (stage 3's slice 9c: no record keeping).
  "src/lib/roster/cache-email.ts",
  // The names of the person's own families, from the app's records, for the chooser and the frame.
  "src/lib/parents/my-family-names.ts",
  "src/lib/seasons/my-season.ts",
  "src/lib/seasons/recorded.ts",
  "src/lib/seasons/kinds.ts",
  "src/lib/seasons/progress.ts",
  // The season's chosen lists and ticks for the families asked about, which volunteering reads too.
  "src/lib/seasons/season-rows.ts",
  // The lookups through a link, which a parent's season finds the session's app family by.
  "src/lib/families/links.ts",
  "src/lib/families/ids.ts",
  // The session's own family and students as the app's records, which volunteering's parent pages find them by.
  "src/lib/families/session-family.ts",
  // Whether a requirement's buy-out stands, as volunteering reads it, by the app's own records.
  "src/lib/volunteer/bought.ts",
  "src/lib/volunteer/my-volunteer.ts",
  "src/lib/volunteer/signed-up.ts",
  "src/lib/volunteer/rules.ts",
  "src/lib/volunteer/clock.ts",
  "src/lib/volunteer/notices.ts",
  "src/lib/volunteer/calendar.ts",
  "src/lib/volunteer/settings.ts",
  "src/lib/volunteer/credit.ts",
  "src/lib/volunteer/allocation.ts",
  "src/lib/volunteer/check-in.ts",
  "src/lib/buyouts/rules.ts",
  "src/lib/buyouts/standing.ts",
  "src/lib/buyouts/my-buyouts.ts",
  "src/lib/buyouts/writes.ts",
  "src/app/components/parent-frame.tsx",
  "src/app/not-found.tsx",
  // What a set-up or reset link's page and action run for a visitor with no session (the pages and their action are
  // under src/app/sign-in, BEFORE_SIGN_IN_CODE below): they read one person from a token anyone can send.
  "src/lib/parents/signin-links.ts",
  "src/lib/parents/password-set.ts",
];

/**
 * The pages and actions a visitor reaches before signing in (src/app/sign-in, the parent door's sign-in and a set-up
 * or reset link's pages): scanned whole as parent code, so none can come to import a module that reads across
 * families.
 */
const BEFORE_SIGN_IN_CODE = "src/app/sign-in/";

/**
 * Parent-facing folders under src/lib/: code that parent pages call to read one family's data. The scan reads every
 * file in them as it reads the pages, so none can reach a staff-only query either.
 */
const PARENT_FACING_LIB = ["src/lib/money", "src/lib/forms", "src/lib/documenso"];

describe("parent code never imports the staff-only queries", () => {
  const isSource = (f: string) => /\.(tsx?|jsx?|mjs|cjs)$/.test(f);
  const parentCode = [
    ...app.filter((f) => f.startsWith(PARENT_PAGES) && isSource(f)),
    ...app.filter((f) => f.startsWith(BEFORE_SIGN_IN_CODE) && isSource(f)),
    ...PARENT_CODE_ELSEWHERE,
    ...PARENT_FACING_LIB.flatMap(filesUnder).filter(isSource),
  ];

  it("finds the parent code on disk", () => {
    expect(parentCode).toEqual(expect.arrayContaining(["src/app/(parent)/page.tsx", "src/app/(parent)/layout.tsx", "src/app/(parent)/display/display-settings.tsx"]));
    expect(parentCode).toEqual(expect.arrayContaining(["src/app/(parent)/payments/page.tsx", "src/app/(parent)/money-box.tsx", "src/lib/money/family-money.ts"]));
    expect(parentCode).toEqual(expect.arrayContaining(["src/app/(parent)/forms/[id]/page.tsx", "src/app/(parent)/forms/actions.ts", "src/lib/forms/my-forms.ts", "src/lib/forms/signing.ts", "src/lib/documenso/client.ts"]));
    expect(parentCode).toEqual(expect.arrayContaining(["src/app/sign-in/page.tsx", "src/app/sign-in/password-link-page.tsx", "src/app/sign-in/password-form.tsx",
      "src/app/sign-in/password-actions.ts", "src/app/sign-in/set-up/[token]/page.tsx", "src/app/sign-in/reset/[token]/page.tsx"]));
    // read() throws for a file that is gone, so a module renamed or removed can't stay listed and unscanned.
    for (const file of PARENT_CODE_ELSEWHERE) expect(read(file).length, file).toBeGreaterThan(0);
  });

  it("catches a parent query module that reaches a staff-only module the way a neighbor in src/lib would", () => {
    const QUERY = "src/lib/parents/my-family.ts";
    expect(staffOnlyImportProblems(QUERY, `import { familyNames } from "./directory";\nimport { getShape } from "@/lib/roster/shape";`)).toEqual([]);
    expect(staffOnlyImportProblems(QUERY, `import { listPeople } from "./directory";`)).toHaveLength(1);
    expect(staffOnlyImportProblems(QUERY, `import { loadRosterPage } from "../roster/queries";`)).toHaveLength(1);
    expect(staffOnlyImportProblems(QUERY, `import { rosterEntry } from "@/lib/roster/queries";`)).toHaveLength(1);
  });

  it.each(parentCode)("%s imports nothing that reads across families", (file) => {
    const problems = staffOnlyImportProblems(file);
    if (problems.length) expect.fail(problems.join("\n"));
  });

  // The scan itself, on sources written here: what it accepts and every way of reaching a module that it catches.
  const NEW = "src/app/(parent)/students/[id]/page.tsx";
  const ROSTER = "@/lib/roster/queries", DIRECTORY = "@/lib/parents/directory";

  it("accepts what a parent page may import, the names of the directory that are not staff-only among them", () => {
    expect(staffOnlyImportProblems(NEW, [
      `import { requireParentPage } from "@/lib/guards";`,
      `import { accessWords, familyNames, type PersonFamily } from "${DIRECTORY}";`,
      `import type { AccessKind } from "../../../../lib/parents/directory";`,
      `import * as model from "@/lib/roster/model";`,
      `import Link from "next/link";`,
      `import "./students.css";`,
      `export { metadata } from "../metadata";`,
      `export const dynamic = "force-dynamic";`,
      `const Chart = lazy(() => import("./chart"));`,
      `export default async function P() { const ctx = await requireParentPage(); return <p>{accessWords(ctx).words} imports nothing from "${ROSTER}"</p>; }`,
    ].join("\n"))).toEqual([]);
  });

  it.each([
    ["a named import", `import { listPeople } from "${DIRECTORY}";`, "takes listPeople from"],
    ["a named import under another name", `import { accessWords, getPerson as person } from "${DIRECTORY}";`, "takes getPerson from"],
    ["a named import over several lines", `import {\n  accessWords,\n  getPerson,\n  familySignins,\n} from "${DIRECTORY}";`, "takes getPerson, familySignins from"],
    ["a named import after a line with no semicolon", `export const dynamic = "force-dynamic"\nimport { listPeople } from '${DIRECTORY}'`, "takes listPeople from"],
    ["a namespace import", `import * as dir from "${DIRECTORY}";\nconst people = await dir.listPeople();`, "takes the whole of"],
    ["a default import", `import dir from "${DIRECTORY}";`, "takes the whole of"],
    ["a default import beside an allowed name", `import dir, { accessWords } from "${DIRECTORY}";`, "takes the whole of"],
    ["a dynamic import", `const dir = await import("${DIRECTORY}");`, "takes the whole of"],
    ["a dynamic import in backticks", `const { listPeople } = await import(\n  \`${DIRECTORY}\`\n);`, "takes the whole of"],
    ["require", `const { listPeople } = require("${DIRECTORY}");`, "takes the whole of"],
    ["a re-export by name", `export { listPeople } from "${DIRECTORY}";`, "takes listPeople from"],
    ["a re-export of everything", `export * from "${DIRECTORY}";`, "takes the whole of"],
    ["a re-export as a namespace", `export * as dir from "${DIRECTORY}";`, "takes the whole of"],
    ["a relative path to the directory", `import { listPeople } from "../../../../lib/parents/directory";`, "takes listPeople from"],
    ["a relative path with its extension", `const dir = await import("../../../../lib/parents/directory.ts");`, "takes the whole of"],
    ["any name from the roster queries", `import { previewShape } from "${ROSTER}";`, `reaches ${ROSTER}`],
    ["a type from the roster queries", `import type { RosterPage } from "${ROSTER}";`, `reaches ${ROSTER}`],
    ["the roster queries as a namespace", `import * as roster from "${ROSTER}";`, `reaches ${ROSTER}`],
    ["the roster queries by a relative path", `import { rosterEntry } from "../../../../lib/roster/queries";`, `reaches ${ROSTER}`],
    ["the roster queries by a dynamic import", `const { loadRosterPage } = await import("${ROSTER}");`, `reaches ${ROSTER}`],
    ["the roster queries re-exported", `export { rosterEntry } from "${ROSTER}";`, `reaches ${ROSTER}`],
    ["the roster queries imported for nothing", `import "${ROSTER}";`, `reaches ${ROSTER}`],
  ])("catches %s", (_what, source, problem) => {
    const problems = staffOnlyImportProblems(NEW, `import { requireParentPage } from "@/lib/guards";\n${source}\nexport default async function P() { await requireParentPage(); return null; }`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${NEW}: `);
    expect(problems[0]).toContain(problem);
    expect(problems[0]).toContain("for staff pages only");
  });

  it("catches a module it can't read, and says so", () => {
    const problems = staffOnlyImportProblems(NEW, "const where = `@/lib/${area}/queries`;\nconst queries = await import(where);\nconst other = await import(`@/lib/${area}/directory`);");
    expect(problems).toHaveLength(2);
    for (const problem of problems) expect(problem).toContain("loads a module this scan can't read");
  });

  it("doesn't count an import that is only mentioned in a comment", () => {
    expect(staffOnlyImportProblems(NEW, `// import { listPeople } from "${DIRECTORY}";\n/* const dir = await import("${ROSTER}"); */\nexport default function P() { return null; }`)).toEqual([]);
  });
});
