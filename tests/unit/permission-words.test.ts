import { describe, it, expect } from "vitest";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS } from "@/lib/permissions/registry";
import { expandRules } from "@/lib/permissions/rules";
import { PERMISSION_AREAS, PERMISSION_WORDS, readTwinOf } from "@/lib/permissions/words";
import { checklistView, rulesFromChecklist } from "@/lib/permissions/checklist";

describe("every permission has words", () => {
  it("has plain words for each permission in the registry, and for nothing else", () => {
    const missing = PERMISSIONS.filter((p) => !PERMISSION_WORDS[p]?.trim());
    expect(missing, `These permissions have no words in PERMISSION_WORDS (src/lib/permissions/words.ts), so the roles checklist can't offer them: ${missing.join(", ")}`).toEqual([]);
    expect(Object.keys(PERMISSION_WORDS).sort()).toEqual([...PERMISSIONS].sort());
  });

  it("gives each permission its own words, written as a sentence a volunteer can read", () => {
    const words = Object.values(PERMISSION_WORDS);
    expect(new Set(words).size).toBe(words.length);
    for (const w of words) {
      expect(w, w).toMatch(/^[A-Z]/);
      expect(w, w).not.toMatch(/\.$/);
      expect(w, w).not.toMatch(/\b[A-Z][a-z]+\.[A-Z]/); // never a permission's own name
    }
  });

  it("puts every permission a role may hold in exactly one area, and no Admin-only one in any", () => {
    const listed = PERMISSION_AREAS.flatMap((a) => a.permissions);
    expect([...listed].sort()).toEqual([...GRANTABLE].sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const p of ADMIN_ONLY) expect(listed).not.toContain(p);
  });

  it("knows which Read a ReadWrite brings with it, as the rules do", () => {
    expect(readTwinOf("Settings.Club.ReadWrite")).toBe("Settings.Club.Read");
    expect(readTwinOf("Season.Progress.ReadWrite")).toBe("Season.Progress.Read");
    expect(readTwinOf("Roster.Family.ReadWrite")).toBeNull(); // Roster.Family.Read doesn't exist
    expect(readTwinOf("Roster.Read")).toBeNull();
    for (const p of GRANTABLE) {
      const twin = readTwinOf(p);
      if (twin) expect(expandRules({ include: [p], exclude: [] }).has(twin), p).toBe(true);
    }
  });
});

describe("a role from the checklist", () => {
  it("is saved as the exact names ticked, with the Read a ReadWrite brings, so it gives exactly what is ticked", () => {
    const r = rulesFromChecklist(["Season.Progress.ReadWrite", "Roster.Read"]);
    expect(r).toEqual({ ok: true, rules: { include: ["Roster.Read", "Season.Progress.Read", "Season.Progress.ReadWrite"], exclude: [] } });
    if (!r.ok) return;
    expect([...expandRules(r.rules)].sort()).toEqual([...r.rules.include].sort());
  });

  it("gives exactly what is ticked, whatever is ticked", () => {
    for (const p of GRANTABLE) {
      const r = rulesFromChecklist([p]);
      if (!r.ok) throw new Error(p);
      expect([...expandRules(r.rules)].sort(), p).toEqual([...r.rules.include].sort());
    }
  });

  it("refuses an Admin-only permission, a pattern, a name that doesn't exist and anything that isn't a name, and nothing ticked", () => {
    for (const bad of [["Audit.Log.Read"], ["Settings.*"], ["*"], ["Roster.Everything"], [42], [null]]) {
      expect(rulesFromChecklist(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(rulesFromChecklist([])).toEqual({ ok: false, errors: ["Tick at least one thing this role lets people do."] });
  });

  it("shows a role of exact names as just what it gives", () => {
    expect(checklistView({ include: ["Roster.Read", "Parents.ReadWrite"], exclude: [] })).toEqual({ granted: ["Roster.Read", "Parents.ReadWrite"], patterns: false });
  });

  it("shows a role with a wildcard or an exclude as what it grants today, and says it uses patterns", () => {
    const view = checklistView({ include: ["Season.*"], exclude: ["Season.Steps.ReadWrite"] });
    expect(view.patterns).toBe(true);
    expect(view.granted).toEqual(["Season.Steps.Read", "Season.Progress.Read", "Season.Progress.ReadWrite"]);
    const everything = checklistView({ include: ["*"], exclude: [] });
    expect(everything.patterns).toBe(true);
    expect(everything.granted).toEqual([...GRANTABLE]);
    for (const p of ADMIN_ONLY) expect(everything.granted).not.toContain(p);
  });
});
