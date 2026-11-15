import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A tripwire. Until 2026-11-15 this file held the portal to reading QuickBooks only. The owner then decided that a
 * parent edits their own phone and mailing address (roadmap, decisions of 2026-11-14; v1 spec §6.2), so the rule it
 * holds now is: the portal sends QuickBooks one write, a sparse update of one customer's phone and billing address,
 * and it can be sent from one place only.
 *
 * A new write (an email change, a staff edit, an invoice) is a decision named in a slice brief: it adds its function
 * and its caller to the lists below on purpose, never to make this pass.
 */
const read = (dir: string) => (existsSync(path.resolve(dir)) ? readdirSync(path.resolve(dir), { recursive: true }).map(String) : [])
  .filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: `${dir}/${f.replaceAll("\\", "/")}`, text: readFileSync(path.resolve(dir, f), "utf8") }));
/** The code without comments: a method or a function that is only mentioned doesn't count. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const CLIENT = "src/lib/quickbooks/client.ts";
/** The one function that sends a write to the QuickBooks API, and the constant that holds its address and body. */
const WRITE = "qboUpdateCustomerContact";
/** The only modules that may name that function: where it is written, and the parent's contact edits that call it. */
const MAY_SEND_THE_WRITE = [CLIENT, "src/lib/parents/contact-edits.ts"];
/** What reaches the contact edits' save from a browser: the parent's own server action, and nothing else. */
const SAVE = "saveMyContact";
const MAY_SAVE = ["src/lib/parents/contact-edits.ts", "src/app/(parent)/family/details/actions.ts"];

const METHOD = /["']?method["']?\s*:\s*([^,}\n]+)/g;
const methodsIn = (text: string) => [...code(text).matchAll(METHOD)].map((m) => m[1]!.trim());

describe("the portal writes one thing to QuickBooks: a parent's own phone and address (v1 spec §6.2)", () => {
  const everything = read("src");
  // src/lib/money reads invoices for parents, and src/lib/parents/contact-edits.ts reads and changes a parent's own
  // record: scanned with the rest, on purpose. A new folder that calls QuickBooks is found by the test below.
  const sources = [...read("src/lib/quickbooks"), ...read("src/lib/roster"), ...read("src/lib/jobs"), ...read("src/lib/money"),
    ...everything.filter((s) => s.file === "src/lib/parents/contact-edits.ts")];
  const client = code(sources.find((s) => s.file === CLIENT)!.text);
  const bodyOf = (name: string) => {
    const at = client.indexOf(`export async function ${name}(`);
    expect(at, `${CLIENT} has no exported function ${name}`).toBeGreaterThanOrEqual(0);
    const next = client.indexOf("\nexport ", at + 1);
    return client.slice(at, next < 0 ? undefined : next);
  };

  it("finds the QuickBooks code", () => {
    expect(sources.length).toBeGreaterThan(2);
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining([CLIENT, "src/lib/money/family-money.ts", "src/lib/parents/contact-edits.ts"]));
  });

  it("scans every module that calls the QuickBooks client", () => {
    const callsClient = (text: string, file: string) => /from\s*["'][^"']*quickbooks\/client["']/.test(text) || (file.startsWith("src/lib/quickbooks/") && /from\s*["']\.\/client["']/.test(text));
    const callers = everything.filter((s) => callsClient(code(s.text), s.file));
    expect(callers.map((s) => s.file)).toEqual(expect.arrayContaining(["src/lib/roster/refresh.ts", "src/lib/quickbooks/connection.ts"]));
    const unscanned = callers.map((s) => s.file).filter((f) => !sources.some((s) => s.file === f));
    expect(unscanned, `These modules call the QuickBooks client and are not scanned here: ${unscanned.join(", ")}. Add their folder to \`sources\` in tests/unit/quickbooks-writes.test.ts.`).toEqual([]);
  });

  it("still has no PUT, PATCH or DELETE, and never a method it can't read", () => {
    for (const s of sources) {
      expect(s.text, s.file).not.toMatch(/["']?method["']?\s*:\s*["'](PUT|PATCH|DELETE)["']/i);
      // Every method is written out as "GET" or "POST": one built from a variable could be anything.
      for (const method of methodsIn(s.text)) expect(method, `${s.file} sets a request method this scan can't read`).toMatch(/^["'](GET|POST)["']$/);
    }
  });

  it("writes nothing to the log, so no token, request or response body can end up there", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/console\.\w+\(/);
  });

  it("sends nothing but GET, except to Intuit's token and revoke endpoints and the one customer update", () => {
    const posts = sources.flatMap((s) => methodsIn(s.text).filter((m) => /POST/.test(m)).map(() => s.file));
    // The token request and the customer update in the client; the revoke in the connection.
    expect(posts.sort()).toEqual([CLIENT, CLIENT, "src/lib/quickbooks/connection.ts"]);
    expect(methodsIn(bodyOf("tokenRequest"))).toEqual([`"POST"`]);
    expect(bodyOf("tokenRequest")).toContain("qboEndpoints().token");
    expect(methodsIn(bodyOf(WRITE))).toEqual([`"POST"`]);
    // Everything else in the client that reaches the API is a GET: qboGet, and what is built on it.
    expect(methodsIn(bodyOf("qboGet"))).toEqual([`"GET"`]);
    expect(methodsIn(client)).toEqual([`"POST"`, `"GET"`, `"POST"`]);
  });

  it("can send the update to the customer endpoint only, with nothing in it but an Id, a SyncToken, the phone and the billing address", () => {
    const write = bodyOf(WRITE);
    // Its address is the constant's, not an argument: the function takes no path.
    expect(write).toContain("/${CUSTOMER_UPDATE.path}`");
    expect(/export async function \w+\(([^)]*)\)/.exec(write)![1]).not.toMatch(/\bpath\b|\burl\b|\bbody\b/);
    expect(write).toContain("JSON.stringify(CUSTOMER_UPDATE.body(customerId, syncToken, change))");
    const at = client.indexOf("export const CUSTOMER_UPDATE = {");
    expect(at).toBeGreaterThanOrEqual(0);
    const constant = client.slice(at, client.indexOf("\n} as const;", at));
    expect(constant).toContain(`path: "customer",`);
    // The top-level fields the body can carry. `sparse: true` is what keeps every field not sent as it was.
    const fields = [...constant.matchAll(/(?:^|[{\s])([A-Z]\w*):/g)].map((m) => m[1]);
    expect(fields).toEqual(["Id", "SyncToken", "PrimaryPhone", "FreeFormNumber", "BillAddr", "Line1", "Line2", "Line3", "Line4", "Line5", "City", "CountrySubDivisionCode", "PostalCode", "Country"]);
    expect(constant).toContain("sparse: true,");
  });

  it("lets only the parent's contact edits send it, and only the parent's own action save through them", () => {
    const naming = (name: string) => everything.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.text))).map((s) => s.file).sort();
    expect(naming(WRITE), `${WRITE} is the portal's one write to QuickBooks. A new caller is a decision for a slice brief, not a fix made in passing.`).toEqual([...MAY_SEND_THE_WRITE].sort());
    expect(naming(SAVE)).toEqual([...MAY_SAVE].sort());
    // Nobody reaches the client's write by taking the module whole.
    for (const s of everything) expect(code(s.text), s.file).not.toMatch(/import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*quickbooks\/client["']|import\(\s*["'][^"']*quickbooks\/client["']\s*\)|require\(\s*["'][^"']*quickbooks\/client["']\s*\)/);
  });
});
