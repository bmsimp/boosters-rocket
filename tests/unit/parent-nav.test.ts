import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { PARENT_NAV } from "@/app/components/parent-nav";

/** The page file a parent address is served by: "/" is src/app/(parent)/page.tsx, "/family" is src/app/(parent)/family/page.tsx. */
const pageFile = (href: string) => `src/app/(parent)${href === "/" ? "" : href}/page.tsx`;

describe("PARENT_NAV", () => {
  // The tabs and the top nav list only pages that exist. Forms joins this list when its page is built.
  it("is a real array of the parent pages that exist, in tab order", () => {
    expect(Array.isArray(PARENT_NAV)).toBe(true);
    expect(PARENT_NAV.map((n) => n.href)).toEqual(["/", "/payments", "/family"]);
    expect(PARENT_NAV.map((n) => n.label)).toEqual(["Home", "Payments", "Family"]);
  });
  it.each(PARENT_NAV)("$label ($href) has a page on disk, so no tab leads to the not-ready page", ({ href }) => {
    expect(href).toMatch(/^\/[a-z0-9/-]*$/);
    expect(existsSync(pageFile(href)), `${pageFile(href)} does not exist: take ${href} out of PARENT_NAV until its page is built`).toBe(true);
  });
  it.each(PARENT_NAV)("$label ($href) has an icon for the bottom tabs", ({ href }) => {
    expect(readFileSync("src/app/components/parent-tabs.tsx", "utf8")).toContain(`"${href}": <`);
  });
  it("lives in a module that is not a client module", () => {
    expect(readFileSync("src/app/components/parent-nav.ts", "utf8")).not.toMatch(/["']use client["']/);
  });
});
