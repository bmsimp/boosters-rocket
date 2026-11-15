import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addressOf, isDynamic, paramsProblems, parentRoutes } from "../e2e/parent-routes";

// tests/e2e/parent-session.spec.ts asks for every parent page and searches what the browser is sent. No parent page has
// a dynamic segment yet, so what the spec does when one arrives is proved here, on folders made up for the purpose.
describe("the parent pages the e2e run asks for", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "booster-parent-routes-"));
    for (const page of ["page.tsx", "display/page.tsx", "(money)/invoices/page.tsx", "(money)/invoices/[id]/page.tsx", "students/[id]/forms/[...path]/page.tsx"]) {
      mkdirSync(path.join(dir, path.dirname(page)), { recursive: true });
      writeFileSync(path.join(dir, page), "export default function P() { return null; }\n");
    }
    writeFileSync(path.join(dir, "display/display-settings.tsx"), "export function DisplaySettings() { return null; }\n");
    writeFileSync(path.join(dir, "layout.tsx"), "export default function L() { return null; }\n");
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it("finds the real parent pages on disk", () => {
    expect(parentRoutes()).toEqual(expect.arrayContaining(["/", "/display"]));
  });

  it("finds every page, dynamic ones included, and nothing that isn't a page", () => {
    expect(parentRoutes(dir)).toEqual(["/", "/display", "/invoices", "/invoices/[id]", "/students/[id]/forms/[...path]"]);
    expect(parentRoutes(dir).filter(isDynamic)).toEqual(["/invoices/[id]", "/students/[id]/forms/[...path]"]);
  });

  it("says exactly what to add for a dynamic page that has no params", () => {
    const problems = paramsProblems(parentRoutes(dir), { "/invoices/[id]": { own: { id: "E2E-INV-1" }, other: { id: "E2E-INV-9" } } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("The parent page /students/[id]/forms/[...path] has a dynamic segment and no params to ask for it with");
    expect(problems[0]).toContain("Add it to PARAMS in tests/e2e/parent-session.spec.ts with ids from scripts/seed-e2e.ts");
  });

  it("has nothing to say when every dynamic page has params, or when there are no dynamic pages", () => {
    const params = { own: { id: "E2E-S1", path: ["medical", "2026"] }, other: { id: "E2E-S3", path: ["medical"] } };
    expect(paramsProblems(parentRoutes(dir), { "/invoices/[id]": params, "/students/[id]/forms/[...path]": params })).toEqual([]);
    expect(paramsProblems(["/", "/display"], {})).toEqual([]);
  });

  it("says to remove params for a page that is gone or has no dynamic segment", () => {
    const params = { own: { id: "E2E-S1" }, other: { id: "E2E-S3" } };
    const problems = paramsProblems(["/", "/display"], { "/students/[id]": params, "/display": params });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("names /students/[id], which is not a parent page with a dynamic segment any more. Remove it.");
    expect(problems[1]).toContain("names /display, which has no dynamic segment. Remove it.");
  });

  it("fills a route's params into its address", () => {
    expect(addressOf("/")).toBe("/");
    expect(addressOf("/display")).toBe("/display");
    expect(addressOf("/students/[id]", { id: "E2E-S1" })).toBe("/students/E2E-S1");
    expect(addressOf("/students/[id]/forms/[...path]", { id: "E2E S1", path: ["medical", "2026/27"] })).toBe("/students/E2E%20S1/forms/medical/2026%2F27");
    expect(addressOf("/help/[[...topic]]", {})).toBe("/help");
    expect(addressOf("/help/[[...topic]]", { topic: ["fees", "late"] })).toBe("/help/fees/late");
  });

  it("refuses to make an address when a param is missing", () => {
    expect(() => addressOf("/students/[id]", {})).toThrow('The route /students/[id] needs the param "id", and the params given have none.');
    expect(() => addressOf("/students/[id]/forms/[...path]", { id: "E2E-S1", path: [] })).toThrow('needs the param "path", and the params given have id, path.');
  });
});
