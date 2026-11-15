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

/** What is wrong with a parent page's guard, in words that say what to add; null when it is right. */
function parentPageProblem(file: string, source = read(file)): string | null {
  if (importsFromGuards(source, "requireParentPage") && /\brequireParentPage\(\s*\)/.test(pageBody(source))) return null;
  return `${file}: a parent page must call requireParentPage() itself; the guard in the layout does not run on client navigation. `
    + `Add \`import { requireParentPage } from "@/lib/guards";\` and make \`const ctx = await requireParentPage();\` the first line of the page's default export (an async function).`;
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
  "src/app/api/health/route.ts": "Public on purpose: answers only {ok: true} or {ok: false} (tests/integration/health.test.ts).",
  "src/app/api/internal/worker/route.ts": "The worker's token (isWorkerRequest); without it, a bare 404 (tests/integration/jobs-runner.test.ts).",
  "src/app/api/quickbooks/callback/route.ts": "A staff session with Settings.QuickBooks.ReadWrite, checked in the handler, and the state value from the connect step (tests/integration/quickbooks-connection.test.ts).",
  "src/app/setup/certificates/[name]/route.ts": "downloadAccess(): the setup session while setup is open, or an Admin afterward; otherwise 404 (tests/integration/setup-certificates-route.test.ts).",
  "src/app/setup/finish/route.ts": "Setup open, the setup session cookie, and the named Admin signed in; otherwise a redirect that changes nothing (tests/integration/setup-finish.test.ts).",
  "src/app/setup/scripts/[name]/route.ts": "downloadAccess(), as the certificate download; otherwise 404 (tests/integration/setup-scripts-route.test.ts).",
};

/**
 * Modules that read across families, for staff pages only: never imported by anything under src/app/(parent)/.
 * A parent page reads through a query that takes ctx.familyQboId and returns that family alone.
 */
const STAFF_ONLY_IMPORTS: { module: string; names: string[] | "all"; why: string }[] = [
  { module: "@/lib/roster/queries", names: "all", why: "loadRosterPage() and rosterEntry() load every family in the club" },
  { module: "@/lib/parents/directory", names: ["listPeople", "getPerson", "heldReview", "familySignins"], why: "they return other families' names, or a block reason (see the note at the top of the module)" },
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
  const NEW = "src/app/(parent)/new/page.tsx", NEW_STAFF = "src/app/staff/(app)/new/page.tsx";

  it("accepts a parent page that calls the guard, alone or beside other loads", () => {
    expect(parentPageProblem(NEW, `${PARENT_IMPORT}export default async function P() {\n  const ctx = await requireParentPage();\n  return <p>{ctx.name}</p>;\n}`)).toBeNull();
    expect(parentPageProblem(NEW, `${PARENT_IMPORT}export default async function P() {\n  const [ctx, club] = await Promise.all([requireParentPage(), getClubSettings()]);\n  return null;\n}`)).toBeNull();
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

describe("parent code never imports the staff-only queries", () => {
  const parentCode = app.filter((f) => f.startsWith(PARENT_PAGES) && /\.(tsx|ts)$/.test(f));

  it.each(parentCode)("%s imports nothing that reads across families", (file) => {
    const source = code(read(file));
    for (const { module, names, why } of STAFF_ONLY_IMPORTS) {
      for (const [, imported] of source.matchAll(new RegExp(`import\\s+(?:type\\s+)?([^;]*?)\\s+from\\s*["']${module}["']`, "g"))) {
        const bad = names === "all" ? [imported!.trim()] : names.filter((n) => new RegExp(`\\b${n}\\b`).test(imported!));
        expect(bad, `${file} imports ${bad.join(", ")} from ${module}, which is for staff pages only: ${why}. `
          + `Read through a query that takes ctx.familyQboId and returns that family alone.`).toEqual([]);
      }
    }
  });
});
