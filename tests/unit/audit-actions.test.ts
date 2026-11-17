import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ACTION_NAMES } from "@/lib/audit/actions";

/**
 * Every audit action the portal writes has words for the audit log page and its export (src/lib/audit/actions.ts).
 * An action with none is shown as its bare code, which an Admin reading the log cannot be expected to know. This
 * reads the source for the two ways an action is written: `action: "a.b"` (also both sides of a `? :`), and the
 * reconcile's own `audit("a.b", ...)`. An action built some other way is not found here: write it out as a string.
 */
const files = (dir: string): string[] => readdirSync(path.resolve(dir), { recursive: true }).map(String)
  .filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}/${f.replaceAll("\\", "/")}`);
const ACTION = /"([a-z_]+(?:\.[a-z_]+)+)"/g;

function actionsWritten(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files("src")) {
    if (file === "src/lib/audit/actions.ts") continue;
    const text = readFileSync(path.resolve(file), "utf8");
    for (const m of text.matchAll(/\baction:\s*([^,}\n]*)/g)) for (const a of m[1]!.matchAll(ACTION)) found.set(a[1]!, file);
    for (const m of text.matchAll(/\baudit\(\s*"([a-z_]+(?:\.[a-z_]+)+)"/g)) found.set(m[1]!, file);
  }
  return found;
}

describe("every audit action has words", () => {
  const written = actionsWritten();

  it("finds the actions in the source", () => {
    expect(written.size).toBeGreaterThan(60);
    for (const known of ["parent.block", "roster.refresh", "parent.access.granted", "season.requirement.tick", "season.requirement.untick", "parent.contact.save", "audit.export"]) {
      expect([...written.keys()], known).toContain(known);
    }
  });

  it("has a name for each one", () => {
    const nameless = [...written].filter(([action]) => !Object.hasOwn(ACTION_NAMES, action)).map(([action, file]) => `${action} (${file})`).sort();
    expect(nameless, `These audit actions have no words in ACTION_NAMES (src/lib/audit/actions.ts), so the audit page would show the bare code: ${nameless.join(", ")}`).toEqual([]);
  });
});
