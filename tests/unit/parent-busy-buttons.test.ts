import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// AGENTS.md (UI): a parent page's busy button is aria-disabled, never disabled. A disabled button drops the focus,
// and the keyboard's place with it (docs/accessibility-checks.md).
const ROOT = join(process.cwd(), "src", "app", "(parent)");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : []; });
}

describe("busy buttons on parent pages", () => {
  it("are never disabled while an action runs", () => {
    const found = files(ROOT).filter((f) => /(?<![-\w])disabled=\{[^}]*\bpending\b/.test(readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });
});
