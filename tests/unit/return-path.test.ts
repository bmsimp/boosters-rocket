import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { MAX_RETURN_PATH, NOT_PARENT_SECTIONS, landingPath, safeReturnPath, withReturnPath } from "@/lib/auth/return-path";

describe("the return path: where a parent lands after signing in", () => {
  it.each([
    "/", "/display", "/payments", "/family", "/forms", "/forms/1f0e5c1a-7b1c-4a52-9f0e-3a1b2c3d4e5f", "/students/E2E-S1", "/a/b/c/d",
    "/display/", "/payments?year=2026", "/payments?year=2026&open=1", "/forms/12?step=sign", "/?welcome=1", "/search?q=a%20b", "/x_y~z-1",
  ])("honors the parent path %s as it is", (value) => {
    expect(safeReturnPath(value)).toBe(value);
    expect(landingPath(value)).toBe(value);
  });

  it.each([
    // Another site, however it is spelled.
    ["a scheme-relative address", "//evil.example"],
    ["a scheme-relative address with a path", "//evil.example/display"],
    ["three slashes", "///evil.example"],
    ["a backslash, which browsers read as a slash", "/\\evil.example"],
    ["two backslashes", "\\\\evil.example"],
    ["a slash then a backslash", "/\\/evil.example"],
    ["a backslash further in", "/display\\evil.example"],
    ["an absolute address", "https://evil.example/"],
    ["an absolute address without slashes", "https:evil.example"],
    ["an absolute address in capitals", "HTTPS://EVIL.EXAMPLE/display"],
    ["a script address", "javascript:alert(1)"],
    ["a data address", "data:text/html,<script>alert(1)</script>"],
    ["an address with user information", "/@evil.example"],
    ["a host after user information", "//portal.example@evil.example/"],
    ["a colon in the path", "/display:8080"],
    ["a path that doesn't start with a slash", "display"],
    ["a relative path", "./display"],
    ["an address of this site written in full", "http://localhost:3000/display"],
    // Encoded forms of the same.
    ["an encoded slash after the first", "/%2Fevil.example"],
    ["encoded slashes", "/%2F%2Fevil.example"],
    ["a lower-case encoded slash", "/%2fevil.example"],
    ["an encoded backslash", "/%5Cevil.example"],
    ["a doubly encoded slash", "/%252Fevil.example"],
    ["an encoded staff path", "/%73taff"],
    ["an encoded dot segment", "/display/%2e%2e/staff"],
    ["an encoded tab", "/%09/evil.example"],
    ["an encoded line break", "/display%0d%0aLocation:%20https://evil.example"],
    ["an encoded null", "/display%00"],
    ["a percent sign on its own", "/100%"],
    // Control characters and space, which browsers drop or trim before reading the address.
    ["a tab between two slashes", "/\t/evil.example"],
    ["a line feed between two slashes", "/\n/evil.example"],
    ["a carriage return", "/\r/evil.example"],
    ["a null character", "/display\u0000"],
    ["a leading space", " /display"],
    ["a trailing line break", "/display\n"],
    ["a space in the path", "/dis play"],
    ["a delete character", "/display\u007f"],
    // Not ASCII: look-alike slashes and dots.
    ["a full-width slash", "/／evil.example"],
    ["a division slash", "/∕evil.example"],
    ["an ideographic full stop", "/。。/staff"],
    // Dot segments, which lead somewhere else than they read.
    ["a parent segment", "/display/../staff"],
    ["a parent segment first", "/../staff"],
    ["a current segment", "/./staff"],
    ["a dot before two slashes", "/.//evil.example"],
    ["a file", "/sw.js"],
    ["a dot folder", "/.well-known/x"],
    ["an empty segment", "/display//family"],
    ["a fragment", "/display#top"],
    ["a query that holds an address", "/display?next=//evil.example"],
    ["a query with a slash", "/display?to=/staff"],
    ["a second question mark", "/display?a=1?b=2"],
    // The parts of this site that are not parent pages.
    ["a staff page", "/staff"],
    ["a staff page deeper in", "/staff/roster/12"],
    ["the staff sign-in page", "/staff/sign-in"],
    ["a staff page in capitals", "/STAFF/roster"],
    ["a staff page with a query", "/staff?x=1"],
    ["a staff page with a trailing slash", "/staff/"],
    ["setup", "/setup"],
    ["a setup download", "/setup/scripts/staff"],
    ["the API", "/api/auth/parent/sign-out"],
    ["the API root", "/api"],
    ["the health check", "/api/health"],
    ["the sign-in page itself", "/sign-in"],
    ["the sign-in page with a path of its own", "/sign-in?next=%2Fdisplay"],
    ["the family chooser", "/choose-family"],
    ["the refusal page", "/refused"],
    ["a framework path", "/_next/static/chunks/main.js"],
    ["a framework data path", "/_next/data/x"],
    ["the installable app's icons", "/icons/192"],
    // Not a string of a usable size.
    ["nothing", ""],
    ["a value one character too long", `/${"a".repeat(MAX_RETURN_PATH)}`],
    ["a very long value", `/${"a/".repeat(5000)}`],
    ["a parameter given twice", ["/display", "/payments"]],
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["an object", { toString: () => "/display" }],
    ["a form's data", new FormData()],
  ] as [string, unknown][])("refuses %s", (_what, value) => {
    expect(safeReturnPath(value)).toBeNull();
    expect(landingPath(value)).toBe("/");
    expect(withReturnPath("/sign-in", value)).toBe("/sign-in");
    expect(withReturnPath("/choose-family", value)).toBe("/choose-family");
  });

  it("takes a value of exactly the longest length", () => {
    const longest = `/${"a".repeat(MAX_RETURN_PATH - 1)}`;
    expect(longest).toHaveLength(MAX_RETURN_PATH);
    expect(safeReturnPath(longest)).toBe(longest);
  });

  it("never answers with anything but the value it was given", () => {
    // What is honored is passed on untouched: nothing is decoded, trimmed or rebuilt on the way.
    for (const value of ["/display", "/payments?year=2026&x=%2F", "/forms/abc/"]) expect(safeReturnPath(value)).toBe(value);
  });

  it("carries a path to the sign-in page and the chooser, encoded, and leaves the home page out", () => {
    expect(withReturnPath("/sign-in", "/display")).toBe("/sign-in?next=%2Fdisplay");
    expect(withReturnPath("/choose-family", "/payments?year=2026&open=1")).toBe("/choose-family?next=%2Fpayments%3Fyear%3D2026%26open%3D1");
    expect(withReturnPath("/sign-in", "/")).toBe("/sign-in");
    expect(withReturnPath("/sign-in", undefined)).toBe("/sign-in");
    // What it writes is read back as the same path.
    const carried = new URL(withReturnPath("/sign-in", "/payments?year=2026&open=1"), "http://portal.example").searchParams.get("next");
    expect(safeReturnPath(carried)).toBe("/payments?year=2026&open=1");
  });

  it("leads only to this site, read the way a browser reads it", () => {
    // Whatever is honored, a browser on the portal resolves it to the portal's own origin and to the same path.
    for (const value of ["/", "/display", "/forms/12?step=sign", "/x_y~z-1/"]) {
      const url = new URL(safeReturnPath(value)!, "https://portal.example");
      expect(url.origin).toBe("https://portal.example");
      expect(url.pathname + url.search).toBe(value);
    }
  });

  /**
   * Every folder of src/app that serves something and is not a parent page is refused as a return path. Found on disk:
   * a new area of the site (a page or a route handler outside src/app/(parent)/) fails here until it is listed.
   */
  it("refuses every part of the site outside the parent pages, found on disk", () => {
    const app = path.resolve(__dirname, "../../src/app");
    const serves = (dir: string): boolean => readdirSync(dir, { recursive: true }).some((f) => /(^|[\\/])(page|route)\.(tsx|ts|jsx|js)$/.test(String(f)));
    const areas = readdirSync(app).filter((name) => statSync(path.join(app, name)).isDirectory() && !/^\(.*\)$/.test(name) && serves(path.join(app, name)));
    expect(areas).toEqual(expect.arrayContaining(["api", "staff", "setup", "sign-in", "choose-family", "refused"]));
    const open = areas.filter((name) => safeReturnPath(`/${name}`) !== null || safeReturnPath(`/${name}/x`) !== null);
    expect(open, `These folders of src/app serve pages or route handlers that are not parent pages, and a parent could be sent to them after signing in: ${open.join(", ")}. `
      + `Add each to NOT_PARENT_SECTIONS in src/lib/auth/return-path.ts, or move its pages under src/app/(parent)/ if they are parent pages.`).toEqual([]);
    // And the parent pages themselves are not shut out by the list.
    expect(existsSync(path.join(app, "(parent)"))).toBe(true);
    const parentSections = readdirSync(path.join(app, "(parent)")).filter((name) => statSync(path.join(app, "(parent)", name)).isDirectory() && !/^[([]/.test(name));
    const shut = parentSections.filter((name) => NOT_PARENT_SECTIONS.includes(name.toLowerCase()));
    expect(shut, `NOT_PARENT_SECTIONS in src/lib/auth/return-path.ts lists parent pages: ${shut.join(", ")}.`).toEqual([]);
  });
});
