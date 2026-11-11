import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (dir: string) => (existsSync(path.resolve(dir)) ? readdirSync(path.resolve(dir), { recursive: true }).map(String) : [])
  .filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: `${dir}/${f.replaceAll("\\", "/")}`, text: readFileSync(path.resolve(dir, f), "utf8") }));

describe("the portal writes nothing to QuickBooks (spec §3)", () => {
  const sources = [...read("src/lib/quickbooks"), ...read("src/lib/roster"), ...read("src/lib/jobs")];
  it("finds the QuickBooks code", () => { expect(sources.length).toBeGreaterThan(2); });
  it("uses no write method anywhere", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/method:\s*["'](PUT|PATCH|DELETE)["']/);
  });
  it("writes nothing to the log, so no token or response body can end up there (spec §7)", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/console\.\w+\(/);
  });
  it("posts only to Intuit's token and revoke endpoints", () => {
    const posts = sources.flatMap((s) => [...s.text.matchAll(/method:\s*["']POST["']/g)].map(() => s.file));
    expect(posts.sort()).toEqual(["src/lib/quickbooks/client.ts", "src/lib/quickbooks/connection.ts"]);
    const client = sources.find((s) => s.file === "src/lib/quickbooks/client.ts")!.text;
    expect(client.slice(client.indexOf("export async function qboGet"))).not.toMatch(/method:\s*["']POST["']/);
  });
});
