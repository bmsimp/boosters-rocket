import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The owner's rule of 2026-11-25 (docs/agents/ui.md, "No fold-outs"): nothing in the app is folded away behind a
 * <details>/<summary>. A form a person opens is a Drawer, a press that needs a second look a ConfirmDialog, and an
 * explanation one or two sentences in the open. The fold-out primitive, HowThisWorks, is gone. No file is exempt.
 */
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(p) ? [p] : [];
});

const FOLD = /<details\b|<summary\b|\bHowThisWorks\b|how-this-works/g;

function foldOuts(): string[] {
  return files(path.resolve("src/app")).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...text.matchAll(FOLD)].map((m) => `${path.relative(process.cwd(), f)}:${text.slice(0, m.index).split("\n").length}: ${m[0]}`);
  });
}

describe("no fold-outs", () => {
  it("no <details>, <summary> or HowThisWorks anywhere under src/app", () => {
    expect(foldOuts()).toEqual([]);
  });

  it("the stylesheet draws no disclosure", () => {
    const css = readFileSync("src/app/booster.css", "utf8");
    expect(css).not.toMatch(/\bsummary\b|details\.more|\.how-body|\.how-caret/);
  });

  it("would catch one", () => {
    const sample = `<details className="more"><summary>Disconnect</summary></details> <HowThisWorks summary="x">y</HowThisWorks>`;
    expect([...sample.matchAll(FOLD)].map((m) => m[0])).toEqual(["<details", "<summary", "HowThisWorks", "HowThisWorks"]);
  });
});
