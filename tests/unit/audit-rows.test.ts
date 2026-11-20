import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Every create, update and delete is recorded (v1 spec §13.1, docs/conformance.md row 13.1). This reads every file
 * under src/ and finds each write to the database: a drizzle `.insert(t)`, `.update(t)` or `.delete(t)` on a table of
 * src/lib/db/schema.ts, and an INSERT, UPDATE or DELETE written as SQL. Each must sit in a function that writes an audit
 * row (`writeAudit`, or a call to a function that does), or in a helper that runs inside its caller's work and is called
 * only from such functions: one the file keeps to itself, or one that takes the caller's transaction (a `Tx`). Anything
 * else is named in NOT_AUDITED with why.
 *
 * It is a heuristic. It follows calls by name, within a file and through named imports; it can't tell that a helper's
 * caller wrote its audit row in the same transaction, or that a function's audit row covers each write in it. What it
 * does catch is a new write in a function that writes no audit row at all, which the write's own test may not.
 */

const files = (dir: string): string[] => readdirSync(path.resolve(dir), { recursive: true }).map(String)
  .filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}/${f.replaceAll("\\", "/")}`);

/**
 * Writes that are not the club's records, so an audit row for each would only bury the ones that are: file#function,
 * and why. A change here is a decision, like an entry in ACTION_NAMES.
 */
const NOT_AUDITED: Record<string, string> = {
  // Caches for the Health page: what an outside service last answered, or what a job last did.
  "src/lib/forms/settings.ts#patchStatus": "a cache: when Documenso last answered, failed or sent a webhook, for the Health page",
  "src/lib/jobs/marks.ts#markJob": "a cache: when the volunteer reminders, the buy-out check and the welcome emails last ran, and their counts, for the Health page; what they send or change is audited",
  "src/lib/parents/breach-mark.ts#markBreachCheck": "a cache: when the password breach service last answered or failed, with a short code, for the Health page; each password chosen is audited (parent.password.set, with whether it was checked)",
  // Rows a page load makes so that something has an id: nothing is sent or signed.
  "src/lib/forms/my-forms.ts#loadMyForms": "a placeholder: the family's signature requests are made, not opened and with nothing sent, the first time its Forms page is read, so each has an id; the open that makes a document is audited (form.document.create)",
  // A session's own upkeep.
  "src/lib/parents/sessions.ts#renewParentSession": "a session's expiry pushed forward while the parent keeps using it, and (since SI-5b) the expiry and last use of the remembered device it names with it; signing in, signing out, ending sessions and remembering and forgetting devices are audited",
  // Rate-limit counts.
  "src/lib/parents/rate-limit.ts#takeRateLimitPlace": "rate-limit counts: one row per try, cleaned up when they expire (CLEANED_TABLES); a refusal is audited by its caller",
  "src/lib/parents/rate-limit.ts#giveBackRateLimit": "rate-limit counts: a right password's try gives its own row back (password-signin.ts), so only wrong tries stay counted; the sign-in it goes on to is audited",
  // Claims: a row held so that two requests or two runs never do one thing twice.
  "src/lib/forms/requests.ts#claim": "a claim: holds a request while an open makes its document (preparing_at); the open is audited",
  "src/lib/forms/requests.ts#release": "a claim: lets go of the hold above",
  "src/lib/quickbooks/sandbox-check/writes.ts#closeUnmade": "a claim: the check of the portal's requests marks a record it listed and never made; the run is audited at its start and end",
  "src/lib/quickbooks/sandbox-check/writes.ts#noteCloseFailed": "a claim: the same check notes a record it couldn't make inactive, to try again at its next run",
  // Setup's and the connection's own progress, before the thing they lead to is done (and audited).
  "src/lib/setup/state.ts#updateSetupState": "which step of the first-run setup is showing; what the steps save (the first Admin, the keys) is audited",
  "src/lib/quickbooks/connection.ts#beginConnect": "the single-use state of a connection being started, before Intuit answers; the connection made (quickbooks.connect) is audited",
  // The import of the app's records from the roster cache (src/lib/families/roster-import.ts#importInto) left this list
  // in stage 3's slice 10: its one caller under src/, "Create a family from this" (src/lib/roster/no-family.ts), writes
  // its audit row (accounting.family.from_customer) in the same transaction, so the scan covers it.
};

type Unit = { key: string; exported: boolean; takesTx: boolean; calls: Set<string>; callers: Set<string>; writes: string[] };

function scan(): Map<string, Unit> {
  // The tables of the schema: each pgTable, and the Better Auth tables, made inside authTables() and exported one by one.
  const tables = new Set([...readFileSync(path.resolve("src/lib/db/schema.ts"), "utf8").matchAll(/export const (\w+) = (?:pgTable\(|(?:staff|parent)Auth\.\w+;)/g)].map((m) => m[1]!));
  const SQL_WRITE = /^\s*(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;
  const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const nameOf = (fn: ts.FunctionLikeDeclaration): string | null => {
    if (fn.name) return fn.name.getText();
    let p = fn.parent;
    while (p && (ts.isCallExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent;
    return p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) ? p.name.getText() : null;
  };
  const exported = (fn: ts.Node) => {
    let n = fn;
    while (!ts.isSourceFile(n.parent)) n = n.parent;
    return ts.isExportAssignment(n) || (ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  };
  const resolve = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? path.posix.join(path.posix.dirname(from), spec) : null;
    return base === null ? null : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((f) => existsSync(path.resolve(f))) ?? null;
  };

  const units = new Map<string, Unit & { names: Set<string>; file: string }>();
  const importsOf = new Map<string, Map<string, string>>();
  for (const file of files("src")) {
    const sf = ts.createSourceFile(file, readFileSync(path.resolve(file), "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = new Map<string, string>();
    for (const s of sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const bindings = s.importClause?.namedBindings;
      const target = resolve(file, s.moduleSpecifier.text);
      if (target && bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) imports.set(el.name.text, `${target}#${(el.propertyName ?? el.name).text}`);
    }
    importsOf.set(file, imports);
    const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const unitFor = (fn: ts.FunctionLikeDeclaration) => {
      const key = `${file}#${nameOf(fn) ?? `(line ${line(fn)})`}`;
      if (!units.has(key)) {
        units.set(key, { key, file, exported: exported(fn), names: new Set(), calls: new Set(), callers: new Set(), writes: [],
          takesTx: fn.parameters.some((p) => /\bTx\b/.test(p.type?.getText() ?? "")) });
      }
      return units.get(key)!;
    };
    const walk = (n: ts.Node, fn: ts.FunctionLikeDeclaration | null) => {
      const inside = fn ?? (isFn(n) ? n : null);
      const unit = inside ? unitFor(inside) : null;
      const write = (what: string) => {
        if (!unit) throw new Error(`${file}:${line(n)} writes to the database outside any function (${what}): this test can't say whose audit row covers it.`);
        unit.writes.push(`${what} (line ${line(n)})`);
      };
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (unit && ts.isIdentifier(callee)) unit.names.add(callee.text);
        if (ts.isPropertyAccessExpression(callee) && ["insert", "update", "delete"].includes(callee.name.text) && n.arguments.length === 1) {
          const [table] = n.arguments;
          if (table && ts.isIdentifier(table) && tables.has(table.text)) write(`${callee.name.text} ${table.text}`);
        }
      }
      if (ts.isTaggedTemplateExpression(n) && n.tag.getText() === "sql") {
        const text = ts.isNoSubstitutionTemplateLiteral(n.template) ? n.template.text : n.template.head.text;
        if (SQL_WRITE.test(text)) write(text.trim().split(/\s+/).slice(0, 3).join(" "));
      }
      n.forEachChild((c) => walk(c, inside));
    };
    walk(sf, null);
  }
  // Calls by name: to a function of the same file, or to one imported by name.
  for (const u of units.values()) {
    const imports = importsOf.get(u.file)!;
    for (const name of u.names) {
      const key = units.has(`${u.file}#${name}`) ? `${u.file}#${name}` : imports.get(name);
      if (key) { u.calls.add(key); units.get(key)?.callers.add(u.key); }
    }
  }
  return units;
}

const units = scan();
const AUDIT = "src/lib/audit/log.ts#writeAudit";

/** Functions that write an audit row: they call writeAudit, or a function that does. */
function auditing(): Set<string> {
  const out = new Set([AUDIT]);
  for (let more = true; more;) {
    more = false;
    for (const u of units.values()) if (!out.has(u.key) && [...u.calls].some((c) => out.has(c))) { out.add(u.key); more = true; }
  }
  return out;
}

/** And the helpers that run inside their callers' work, when every caller is covered. */
function covered(): Set<string> {
  const out = auditing();
  for (let more = true; more;) {
    more = false;
    for (const u of units.values()) {
      if (out.has(u.key) || !(u.takesTx || !u.exported) || u.callers.size === 0 || ![...u.callers].every((c) => out.has(c))) continue;
      out.add(u.key); more = true;
    }
  }
  return out;
}

describe("every write to the database has its audit row", () => {
  const writing = [...units.values()].filter((u) => u.writes.length > 0);
  const ok = covered();

  it("finds the writes in the source", () => {
    expect(writing.length).toBeGreaterThan(120);
    // A few of each kind: a drizzle write in an audited function, one in a helper given the caller's transaction, and SQL.
    for (const known of ["src/lib/parents/people.ts#blockPerson", "src/lib/forms/consent.ts#recordConsent", "src/lib/parents/switches.ts#setWelcome", "src/lib/parents/sessions.ts#endParentSessions",
      // A Better Auth table, exported one by one from authTables() rather than made with pgTable.
      "src/lib/parents/sessions.ts#renewParentSession"]) {
      expect(writing.map((u) => u.key), known).toContain(known);
    }
    expect(auditing().has("src/lib/parents/people.ts#blockPerson")).toBe(true);
    // Given the caller's transaction, and called only from functions that write an audit row.
    for (const helper of ["src/lib/forms/consent.ts#recordConsent", "src/lib/parents/sessions.ts#endParentSessions"]) expect(ok.has(helper), helper).toBe(true);
  });

  it("each sits in a function that writes an audit row, in a helper only such functions call, or is named on purpose", () => {
    const unrecorded = writing.filter((u) => !ok.has(u.key) && !Object.hasOwn(NOT_AUDITED, u.key)).map((u) => `${u.key}: ${u.writes.join(", ")}`);
    expect(unrecorded, `These functions write to the database and nothing they are part of writes an audit row (writeAudit in the same transaction). `
      + `Write one, or, if the rows are not the club's records (a cache, a claim, a count), name the function in NOT_AUDITED with why:\n${unrecorded.join("\n")}`).toEqual([]);
  });

  it("names nothing that no longer writes, or that writes its audit row now", () => {
    const stale = Object.keys(NOT_AUDITED).filter((key) => !units.get(key)?.writes.length || ok.has(key));
    expect(stale, "Take these out of NOT_AUDITED: they write nothing, or are covered by an audit row now").toEqual([]);
  });
});
