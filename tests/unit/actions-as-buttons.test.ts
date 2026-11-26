import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The owner's rule of 2026-11-25 (docs/agents/ui.md, "Actions are buttons"): anything that starts or changes
 * something, or takes the person to the next step of a task, is a Button or a LinkButton, never an underlined link.
 * This catches the commonest breach cheaply: a bare `<a>` or `<Link>` (no button class) whose written words start with
 * an action's verb or a step ("Next: …", "Skip to step 3", "Connect a different company"). Words that come from a
 * constant or an expression aren't seen, so it is a floor, not a proof.
 */
const ROOTS = ["src/app/staff/(app)", "src/app/(parent)", "src/app/sign-in"];
/** The gallery draws the rule's "Don't" on purpose. */
const EXEMPT = new Set([path.normalize("src/app/staff/(app)/settings/design-system/gallery.tsx")]);
/** Links inside a sentence that names where something is done, kept as words in their sentence: "file: words". */
const IN_A_SENTENCE = new Set([
  // A family's roster page, its lede: "… Link it again on Accounting links." ends the page's one quiet line.
  `${path.normalize("src/app/staff/(app)/roster/[id]/page.tsx")}: Link it again on Accounting links`,
]);
const ACTION = /^(Next:|Skip to|Back to step \d|Connect|Disconnect|Reconnect|Move to|Check the|Create|Add an? |Make|Set up|Start|Switch|Pick|Link (it|them)|Write the|Go to|Continue|Save|Send|Pay\b|Run)/;
const ELEMENT = /<(a|Link)\b((?:[^>{]|\{[^}]*\})*)>([\s\S]*?)<\/\1>/g;

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
});

/** Every bare link in these files whose written words start like an action, as "file:line: words". */
function actionLinks(): string[] {
  return ROOTS.flatMap((r) => files(path.resolve(r))).filter((f) => !EXEMPT.has(path.relative(process.cwd(), f))).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...text.matchAll(ELEMENT)].flatMap((m) => {
      if (/\bbtn\b|buttonClass/.test(m[2]!)) return [];
      const words = m[3]!.replace(/\s+/g, " ").trim();
      if (IN_A_SENTENCE.has(`${path.relative(process.cwd(), f)}: ${words}`)) return [];
      return ACTION.test(words) ? [`${path.relative(process.cwd(), f)}:${text.slice(0, m.index).split("\n").length}: ${words.slice(0, 60)}`] : [];
    });
  });
}

describe("actions are buttons", () => {
  it("no bare link on a staff, parent or sign-in page starts with an action's verb or a step", () => {
    expect(actionLinks()).toEqual([]);
  });

  it("would catch one", () => {
    const sample = `<p><a className="link-line" href="/x">Next: connect to QuickBooks</a> <a href="/y">Back to QuickBooks settings</a> <a className="btn" href="/z">Skip to step 3</a></p>`;
    const found = [...sample.matchAll(ELEMENT)].filter((m) => !/\bbtn\b/.test(m[2]!) && ACTION.test(m[3]!.trim())).map((m) => m[3]);
    expect(found).toEqual(["Next: connect to QuickBooks"]);
  });
});
