import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * v1 spec §12, invariant 6: QuickBooks text is never rendered as HTML. Pages render text through React, which writes it
 * as text; the page tests render hostile names and invoice numbers and find them escaped (tests/integration/
 * payments-page.test.ts, roster-pages.test.ts, parent-home-family.test.ts and others). What would get round that is
 * markup written by hand, so nothing under src/ may use the browser's or React's ways of writing raw HTML, but the one
 * fixed script in the root layout that applies the display choices before first paint, which takes no value from
 * anywhere. Email bodies escape every paragraph (src/lib/mail/messages.ts, tests/unit/mail-messages.test.ts).
 */
const root = path.resolve(__dirname, "../..");
const sources = readdirSync(path.join(root, "src"), { recursive: true }).map((f) => `src/${String(f).replaceAll("\\", "/")}`).filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f));
const RAW_HTML = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|createContextualFragment|DOMParser\b/g;
/** The one place raw HTML is written, and exactly what it writes. */
const ALLOWED: Record<string, string> = { "src/app/layout.tsx": "<script dangerouslySetInnerHTML={{ __html: DISPLAY_SCRIPT }} />" };

describe("nothing under src/ writes raw HTML (v1 spec §12, invariant 6)", () => {
  it("finds the source files", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("uses no raw-HTML API but the root layout's fixed display script", () => {
    const found = sources.flatMap((file) => {
      const source = readFileSync(path.join(root, file), "utf8");
      const allowed = ALLOWED[file];
      const uses = [...source.matchAll(RAW_HTML)].length;
      const expected = allowed && source.includes(allowed) ? 1 : 0;
      return uses > expected ? [`${file}: ${uses} use${uses === 1 ? "" : "s"} of a raw-HTML API`] : [];
    });
    expect(found, "Render QuickBooks text, and any text, as React children: never as markup built by hand.").toEqual([]);
  });

  it("keeps the display script a fixed string that takes no value from anywhere", () => {
    const script = readFileSync(path.join(root, "src/app/display-script.ts"), "utf8");
    expect(script).toMatch(/export const DISPLAY_SCRIPT = `/);
    expect(script).not.toContain("${");
    expect(script.match(/^import /m)).toBeNull();
  });
});
