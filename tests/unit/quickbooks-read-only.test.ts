import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (dir: string) => (existsSync(path.resolve(dir)) ? readdirSync(path.resolve(dir), { recursive: true }).map(String) : [])
  .filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: `${dir}/${f.replaceAll("\\", "/")}`, text: readFileSync(path.resolve(dir, f), "utf8") }));

describe("the portal writes nothing to QuickBooks (spec §3)", () => {
  // src/lib/money reads invoices for parents through the client's GET-only functions: scanned with the rest, on purpose.
  const sources = [...read("src/lib/quickbooks"), ...read("src/lib/roster"), ...read("src/lib/jobs"), ...read("src/lib/money")];
  it("finds the QuickBooks code", () => {
    expect(sources.length).toBeGreaterThan(2);
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(["src/lib/quickbooks/client.ts", "src/lib/money/family-money.ts"]));
  });
  it("uses no write method anywhere", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/["']?method["']?\s*:\s*["'](PUT|PATCH|DELETE)["']/i);
  });
  it("writes nothing to the log, so no token or response body can end up there (spec §7)", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/console\.\w+\(/);
  });
  it("posts only to Intuit's token and revoke endpoints", () => {
    const posts = sources.flatMap((s) => [...s.text.matchAll(/["']?method["']?\s*:\s*["']POST["']/gi)].map(() => s.file));
    expect(posts.sort()).toEqual(["src/lib/quickbooks/client.ts", "src/lib/quickbooks/connection.ts"]);
    const client = sources.find((s) => s.file === "src/lib/quickbooks/client.ts")!.text;
    const at = client.indexOf("export async function qboGet");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(client.slice(at)).not.toMatch(/["']?method["']?\s*:\s*["']POST["']/i);
  });
});
