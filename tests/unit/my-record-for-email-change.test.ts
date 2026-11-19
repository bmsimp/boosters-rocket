import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * loadMyRecordForMyEmailChange() (src/lib/parents/my-family.ts) also finds a record whose email field reads as the
 * change the person's own live request asks for. Staff can type that same address into QuickBooks for someone else, so
 * it is for the change of sign-in email alone, which the person finishes only by holding the link mailed to that
 * address: never for what a parent is shown or may edit, which go by loadMyFamily() and loadMyRecord().
 */
const root = path.resolve(__dirname, "../..");
const files = readdirSync(path.join(root, "src"), { recursive: true }).map(String).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => f.split(path.sep).join("/"));

describe("the record found by a live email change", () => {
  it("is asked for only by the change of sign-in email", () => {
    const naming = files.filter((f) => readFileSync(path.join(root, "src", f), "utf8").includes("loadMyRecordForMyEmailChange"));
    expect(naming.sort()).toEqual(["lib/parents/email-change.ts", "lib/parents/my-family.ts"]);
  });
});
