import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Nothing under src/ reads a guardian row's two old copies, `family_qbo_id` and `source_qbo_id` (stage 3's slice 12b1),
 * so this build keeps working beside a database slice 12b2 has dropped them from. Drizzle names every column the schema
 * declares in a whole-row select (`select()`, `{ g: guardian }`) and in an insert, so a reader selects GUARDIAN_COLS
 * (src/lib/parents/sessions.ts) and a row is made by SQL that names only what it writes. The two places left that name
 * them are the ones slice 12b1 keeps, each until slice 12b2: an unlink's clear of the copy (the lead's decision 4) and
 * the clear of a change of company (clearParentAccess(), which nothing reaches since stage 2).
 */
const files = (dir: string): string[] => readdirSync(path.resolve(dir), { recursive: true }).map(String)
  .filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}/${f.replaceAll("\\", "/")}`);

const NAMES_THEM: [string, RegExp][] = [
  ["a read of either column", /guardian\.(familyQboId|sourceQboId)\b/g],
  ["a whole-row select", /select\(\s*\)\s*\.from\(\s*guardian\s*\)/g],
  ["a whole-row select", /\{\s*g:\s*guardian\s*[,}]/g],
  ["drizzle's insert", /\.insert\(\s*guardian\s*\)/g],
  ["a write of either column", /\.update\(\s*guardian\s*\)\s*\.set\(\{[^}]*\b(familyQboId|sourceQboId)\b/g],
  ["a whole-row returning", /\.update\(\s*guardian\s*\)[^;]*\.returning\(\s*\)/g],
];
/** file: how many matches of each kind it keeps, and why. */
const KEPT: Record<string, Record<string, number>> = {
  // unlinkFamily(): it sets its rows' copy null and counts them (guardianRowsCleared), until slice 12b2 drops the column.
  "src/lib/accounting/link-writes.ts": { "a read of either column": 1, "a write of either column": 1 },
  // clearParentAccess(): its whole-row select, unreachable since stage 2; slice 12b2 makes the two clears consistent.
  "src/lib/parents/company-change.ts": { "a whole-row select": 1 },
};

describe("no guardian read or write under src/ names the two old columns", () => {
  it("but the two slice 12b2 removes", () => {
    const found: Record<string, Record<string, number>> = {};
    for (const file of files("src")) {
      if (file === "src/lib/db/schema.ts") continue; // declares them, until slice 12b2
      const text = readFileSync(file, "utf8");
      for (const [kind, re] of NAMES_THEM) {
        const n = text.match(re)?.length ?? 0;
        if (n) (found[file] ??= {})[kind] = (found[file]?.[kind] ?? 0) + n;
      }
    }
    expect(found).toEqual(KEPT);
  });

  it("GUARDIAN_COLS is what the readers select", () => {
    const sessions = readFileSync("src/lib/parents/sessions.ts", "utf8");
    expect(sessions).toMatch(/export const GUARDIAN_COLS = \{/);
    expect(sessions).not.toMatch(/GUARDIAN_COLS = \{[^}]*(familyQboId|sourceQboId)/);
  });
});
