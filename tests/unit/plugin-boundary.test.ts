import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { CROSSINGS } from "./plugin-crossings";

// The plugin boundary (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 3, "How the core finds
// plugins"): the core imports nothing under src/plugins/ but index.ts and types.ts. Until slice P7 moves it, QuickBooks'
// code still lives in src/lib (PLUGIN_CODE_TODAY): every place the core reaches into it today is a crossing, listed in
// ./plugin-crossings.ts. A new one fails here; one that is gone fails too, so each slice shortens the list, which ends
// empty.

const ROOT = path.resolve(__dirname, "../..");
const SRC_DIRS = ["src/lib", "src/app"];

/** The plugin's code: its own folder, and the paths of src/lib it moves from in slice P7 (section 4's table). */
const PLUGIN_CODE_TODAY = [
  "src/plugins/",
  "src/lib/quickbooks/",
  "src/lib/roster/",
  "src/lib/money/",
  "src/lib/buyouts/",
  "src/lib/accounting/",
  "src/lib/families/links.ts",
  "src/lib/families/roster-import.ts",
  "src/lib/parents/contact-queue.ts",
  "src/lib/parents/contact-take-in.ts",
];
/** The two files under src/plugins/ the core may import. */
const CORE_MAY_IMPORT = ["src/plugins/index.ts", "src/plugins/types.ts"];

/**
 * The plugin's own pages, route handlers and their parts under src/app (Next.js needs routes there): thin files the
 * plugin's code is reached from, so they may import it. They are its manifest's pages (src/plugins/quickbooks/plugin.ts).
 */
const PLUGIN_ROUTES = [
  "src/app/staff/(app)/settings/quickbooks/",
  "src/app/staff/(app)/balances/",
  "src/app/staff/(app)/reconciliation/",
  "src/app/staff/(app)/links/",
  "src/app/staff/(app)/money/",
  "src/app/staff/(app)/roster/[id]/buyouts/",
  "src/app/(parent)/payments/",
  "src/app/api/quickbooks/",
];

const under = (file: string, roots: readonly string[]) => roots.some((r) => (r.endsWith("/") ? file.startsWith(r) : file === r));

function filesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...filesIn(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every module a file names: `import ... from`, `export ... from`, a bare `import "m"`, and `import("m")`. */
function modulesOf(source: string): string[] {
  const src = code(source);
  return [
    ...[...src.matchAll(/\b(?:import|export)\s[^;"'`]*?\bfrom\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!),
    ...[...src.matchAll(/\bimport\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!),
    ...[...src.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]!),
  ];
}

const known = new Set([...SRC_DIRS.flatMap(filesIn), ...filesIn("src/plugins")]);

/** The source file a module names, or null for a package. */
function fileOf(module: string, importer: string): string | null {
  const base = module.startsWith("@/") ? `src/${module.slice(2)}` : module.startsWith(".") ? path.posix.join(path.posix.dirname(importer), module) : null;
  if (base === null) return null;
  const plain = path.posix.normalize(base);
  for (const f of [plain, `${plain}.ts`, `${plain}.tsx`, `${plain}/index.ts`, `${plain}/index.tsx`]) if (known.has(f)) return f;
  return plain;
}

/** Every crossing of the boundary today: a core file, and the plugin files it imports. */
function crossings(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of SRC_DIRS.flatMap(filesIn)) {
    if (under(file, PLUGIN_CODE_TODAY) || under(file, PLUGIN_ROUTES)) continue;
    const reached = new Set<string>();
    for (const m of modulesOf(readFileSync(path.join(ROOT, file), "utf8"))) {
      const target = fileOf(m, file);
      if (target !== null && under(target, PLUGIN_CODE_TODAY) && !CORE_MAY_IMPORT.includes(target)) reached.add(target);
    }
    if (reached.size) found[file] = [...reached].sort();
  }
  return found;
}

describe("the plugin boundary", () => {
  const now = crossings();

  it("finds the files it scans", () => {
    expect(known.has("src/plugins/index.ts")).toBe(true);
    expect(known.has("src/lib/roster/writes.ts")).toBe(true);
    // A crossing it can read: the scan does see imports.
    expect(Object.keys(now).length).toBeGreaterThan(0);
  });

  it("has the core reach under src/plugins/ only through index.ts and types.ts", () => {
    const into = Object.entries(now).flatMap(([file, targets]) => targets.filter((t) => t.startsWith("src/plugins/")).map((t) => `${file} imports ${t}`));
    expect(into, "The core imports a plugin's own files. Read the plugin through src/plugins/index.ts (pluginOn(), accountingOn()) "
      + "and its types through src/plugins/types.ts; what the core needs from a plugin is a slot it fills.").toEqual([]);
  });

  it("adds no crossing to the list of today's", () => {
    const added = Object.entries(now).flatMap(([file, targets]) => targets.filter((t) => !(CROSSINGS[file] ?? []).includes(t)).map((t) => `${file} imports ${t}`));
    expect(added, "A core file reaches into QuickBooks' code (still in src/lib until slice P7). Put what the core needs in the core, "
      + "or reach the plugin through a slot of src/plugins/types.ts; a crossing is never added to tests/unit/plugin-crossings.ts.").toEqual([]);
  });

  it("lists no crossing that is gone: the list only shortens", () => {
    const gone = Object.entries(CROSSINGS).flatMap(([file, targets]) => targets.filter((t) => !(now[file] ?? []).includes(t)).map((t) => `${file} imports ${t}`));
    expect(gone, "These crossings are gone: take them out of tests/unit/plugin-crossings.ts.").toEqual([]);
  });
});
