import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// AGENTS.md (New staff page): every state and every action's answer on a staff page is a Notice or an ActionOutcome,
// never a bare status or error paragraph. The staff pages, the staff sign-in page and setup are held to it here.
const ROOTS = [join(process.cwd(), "src", "app", "staff"), join(process.cwd(), "src", "app", "setup")];
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : []; });
}

describe("staff answers", () => {
  it("are notices, not bare paragraphs with a role or the errors class", () => {
    const bare = ROOTS.flatMap(files).filter((f) => /<p\b[^>]*(role="(alert|status)"|className="errors)/.test(readFileSync(f, "utf8")));
    expect(bare).toEqual([]);
  });

  it("include the staff door's sign-out failure", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "components", "sign-out-button.tsx"), "utf8");
    expect(src).toMatch(/door === "staff" \? <Notice tone="problem">/);
  });
});
