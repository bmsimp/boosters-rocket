import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The documents the owner and a club volunteer follow name files and pages: the owner's runbook
 * (docs/runbooks/before-the-first-family.md) and README.md. Each one they name must be there. This reads both and fails
 * for:
 *  - a file of the repository named in backticks (`docs/...`, `src/...`, `deploy/...`, a root file such as `AGENTS.md`)
 *    that doesn't exist;
 *  - a link to a file of the repository that doesn't exist, or to a heading that file doesn't have;
 *  - a page address in backticks (`/staff/settings/health`, `/volunteer/check-in/<code>`, `<APP_URL>/api/...`) that no page or
 *    route handler under src/app answers.
 */
const root = path.resolve(__dirname, "../..");
const DOCS = ["docs/runbooks/before-the-first-family.md", "README.md"];

/** Named in the documents but not part of the repository, each with why. */
const NOT_IN_REPO: Record<string, string> = {
  "deploy/.env": "the club's own settings, copied from deploy/.env.example at installation",
};

/** Paths in backticks that are on a server or inside a container, not pages: their first part. */
const NOT_PAGES = new Set(["srv", "backups", "opt", "tmp", "etc", "home", "var"]);

/** Files at the top of the repository a document may name without a folder. */
const ROOT_FILE = /^(?:[A-Za-z0-9_-]+\.md|LICENSE|Dockerfile|package\.json|docker-compose(?:\.poc)?\.yml|\.env\.example|\.nvmrc)$/;
const REPO_DIRS = ["docs", "src", "scripts", "deploy", "tests", ".github", "public", "drizzle", "design"];
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Every address src/app answers, as its segments: a page or a route handler, with route groups left out. */
function routes(): string[][] {
  const out: string[][] = [];
  const walk = (dir: string, segs: string[]) => {
    for (const name of readdirSync(path.join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(root, rel)).isDirectory()) walk(rel, /^\(.*\)$/.test(name) ? segs : [...segs, name]);
      else if (/^(page\.tsx|route\.ts)$/.test(name)) out.push(segs);
    }
  };
  walk("src/app", []);
  return out;
}
const ROUTES = routes();

/** Whether a page address (no query, no fragment) is one src/app answers. `<x>` stands for any one segment. */
function answers(address: string): boolean {
  const segs = address.split("/").filter(Boolean);
  return ROUTES.some((route) => {
    if (route.some((s) => s.startsWith("[..."))) {
      const fixed = route.findIndex((s) => s.startsWith("[..."));
      return segs.length > fixed && route.slice(0, fixed).every((s, i) => matchSeg(s, segs[i]!));
    }
    return route.length === segs.length && route.every((s, i) => matchSeg(s, segs[i]!));
  });
}
const matchSeg = (route: string, seg: string) => (route.startsWith("[") ? true : seg.startsWith("<") ? false : route === seg);

/** GitHub's anchor for a heading: lower case, punctuation but hyphens dropped, spaces as hyphens. */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");
const anchorsOf = (file: string) => new Set([...read(file).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!)));

type Named = { files: string[]; pages: string[]; links: { target: string; anchor: string | null }[] };

/** What a document names: repository files and page addresses in backticks, and links to the repository's files. */
function namedIn(doc: string): Named {
  const text = read(doc);
  const files: string[] = [], pages: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1]!.trim();
    if (/\s/.test(raw)) continue; // a command or a phrase, not a name
    const token = raw.replace(/[.,:;)]+$/, "");
    const page = /^(?:<APP_URL>)?(\/[A-Za-z0-9<>[\]._\-/]*)(?:[?#].*)?$/.exec(token);
    if (page) {
      const first = page[1]!.split("/")[1] ?? "";
      if (!NOT_PAGES.has(first)) pages.push(page[1]!.replace(/\/+$/, "") || "/");
      continue;
    }
    const top = token.split("/")[0]!;
    if ((REPO_DIRS.includes(top) && token.includes("/")) || ROOT_FILE.test(token)) files.push(token.replace(/\/$/, ""));
  }
  const links: Named["links"] = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1]!;
    if (/^[a-z]+:/i.test(href)) continue; // a site, not a file
    const [file, anchor] = href.split("#") as [string, string | undefined];
    const target = file ? path.posix.normalize(path.posix.join(path.posix.dirname(doc), file)) : doc;
    links.push({ target, anchor: anchor ?? null });
  }
  return { files, pages, links };
}

const exists = (name: string) => existsSync(path.join(root, name));

describe("the documents' own reading of the repository", () => {
  it("finds the pages src/app answers, through route groups and dynamic segments", () => {
    expect(answers("/staff/settings/health")).toBe(true);
    expect(answers("/volunteer/check-in/<code>")).toBe(true);
    expect(answers("/staff/volunteer/check-in/<shiftId>")).toBe(true);
    expect(answers("/forms/<id>/signed")).toBe(true);
    expect(answers("/api/auth/staff/callback/microsoft")).toBe(true);
    expect(answers("/")).toBe(true);
    expect(answers("/staff/nowhere")).toBe(false);
    expect(answers("/volunteer/<id>/nowhere")).toBe(false);
  });

  it("makes GitHub's anchors from headings", () => {
    expect(slug("5. The first start")).toBe("5-the-first-start");
    expect(slug("Documenso's account mail")).toBe("documensos-account-mail");
    expect(slug("Trusted time on signatures (a decision for the club)")).toBe("trusted-time-on-signatures-a-decision-for-the-club");
  });

  it("reads files, pages and links out of a document's text", () => {
    const named = namedIn("docs/runbooks/before-the-first-family.md");
    expect(named.pages).toEqual(expect.arrayContaining(["/staff/settings/health", "/staff/volunteer/check-in/<shiftId>", "/payments"]));
    expect(named.files).toEqual(expect.arrayContaining(["src/lib/forms/consent.ts", "docs/ui-backlog.md"]));
    expect(named.links.map((l) => l.target)).toEqual(expect.arrayContaining(["docs/runbooks/poc-linuxdev.md"]));
  });
});

describe.each(DOCS)("%s", (doc) => {
  const named = namedIn(doc);

  it("names only files the repository has", () => {
    const missing = named.files.filter((f) => !exists(f) && !(f in NOT_IN_REPO));
    expect(missing).toEqual([]);
  });

  it("names only pages the portal answers", () => {
    const missing = named.pages.filter((p) => !answers(p));
    expect(missing).toEqual([]);
  });

  it("links only to files and headings that are there", () => {
    const broken: string[] = [];
    for (const { target, anchor } of named.links) {
      if (!exists(target)) { broken.push(target); continue; }
      if (anchor && target.endsWith(".md") && !anchorsOf(target).has(anchor)) broken.push(`${target}#${anchor}`);
    }
    expect(broken).toEqual([]);
  });
});
