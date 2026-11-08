import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PARENT_NAV } from "@/app/components/parent-nav";

describe("PARENT_NAV", () => {
  it("is a real array of the four parent tabs", () => {
    expect(Array.isArray(PARENT_NAV)).toBe(true);
    expect(PARENT_NAV.map((n) => n.href)).toEqual(["/", "/forms", "/payments", "/family"]);
  });
  it("lives in a module that is not a client module", () => {
    expect(readFileSync("src/app/components/parent-nav.ts", "utf8")).not.toMatch(/["']use client["']/);
  });
});
