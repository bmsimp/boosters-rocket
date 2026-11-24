import { describe, it, expect } from "vitest";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS } from "@/lib/permissions/registry";
import { expandRules } from "@/lib/permissions/rules";
import { PERMISSION_AREAS, PERMISSION_WORDS, readTwinOf, withReadTwins } from "@/lib/permissions/words";
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

  it("says that Roster.Family.ReadWrite gives and ends a guardian's sign-in and changes a family's details, and Parents.ReadWrite changes a name and a parent's details beside blocking and the welcome", () => {
    // Stage 3's slice 11c: staff see and change a guardian's phone and mailing address, so the words say who may.
    // Stage 3's slice 7b, the lead's choice: adding, removing and reinstating a guardian gives or ends an address's view
    // of a family, so it goes with the permission that changes a family, and its words say so plainly.
    expect(PERMISSION_WORDS["Roster.Family.ReadWrite"]).toBe("Add, rename, move and make inactive families, students and parents in QuickBooks, and give or end a guardian's sign-in for a family: add, remove and reinstate its guardians, and let them sign in again after the family, or one of its students, was made active again from the books; and change a family's phone and mailing address, where the books keep them on the family");
    expect(PERMISSION_WORDS["Parents.ReadWrite"]).toBe("See every parent, change a parent's name, block or unblock a parent, and resend a welcome email; and see and change a parent's phone and mailing address (and see a family's, where the books keep them on the family)");
  });

  it("says that Settings.QuickBooks.ReadWrite registers the portal with Boosters Rocket", () => {
    // Connect through Boosters Rocket, slice 2: no new permission; the one that connects QuickBooks registers the portal.
    expect(PERMISSION_WORDS["Settings.QuickBooks.ReadWrite"]).toBe("Connect QuickBooks, register the portal with Boosters Rocket, and choose the membership shape");
  });

  it("has a linking permission an Admin holds and a custom role (a treasurer's) may be given, which brings the roster's view with it", () => {
    // Open question 1 of the app-owned families spec: "Link families to accounting", not Admin-only. Stage 3's slice 10
    // uses it for "Create a family from this" on Reconciliation, a Roster.Read page, so ticking it brings Roster.Read.
    expect(PERMISSIONS).toContain("Accounting.Link.ReadWrite");
    expect(ADMIN_ONLY).not.toContain("Accounting.Link.ReadWrite");
    expect(GRANTABLE).toContain("Accounting.Link.ReadWrite");
    expect(PERMISSION_WORDS["Accounting.Link.ReadWrite"]).toMatch(/^Link families to accounting/);
    expect(PERMISSION_AREAS.find((a) => a.permissions.includes("Accounting.Link.ReadWrite"))?.area).toBe("Families");
    expect(readTwinOf("Accounting.Link.ReadWrite")).toBe("Roster.Read");
    expect(rulesFromChecklist(["Accounting.Link.ReadWrite"])).toEqual({ ok: true, rules: { include: ["Roster.Read", "Accounting.Link.ReadWrite"], exclude: [] } });
  });

  it("has the club messages permissions: posting a custom role may hold, deleting and the email switch an Admin's alone", () => {
    // Club messages, spec section 10.
    expect(GRANTABLE).toContain("Messages.Post.ReadWrite");
    expect(ADMIN_ONLY).toContain("Messages.Delete.ReadWrite");
    expect(ADMIN_ONLY).toContain("Settings.Messages.ReadWrite");
    expect(PERMISSION_AREAS.find((a) => a.permissions.includes("Messages.Post.ReadWrite"))?.area).toBe("Messages");
    // There is no Messages.Post.Read: posting brings nothing else with it.
    expect(readTwinOf("Messages.Post.ReadWrite")).toBeNull();
    expect(expandRules({ include: ["*"], exclude: [] }).has("Messages.Delete.ReadWrite")).toBe(false);
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
    // Roster.Family.Read doesn't exist: the roster's changes are made from pages behind Roster.Read, so it comes along.
    expect(readTwinOf("Roster.Family.ReadWrite")).toBe("Roster.Read");
    expect(readTwinOf("Roster.Read")).toBeNull();
    for (const p of GRANTABLE) {
      const twin = readTwinOf(p);
      if (!twin) continue;
      const saved = rulesFromChecklist([p]);
      expect(saved.ok && expandRules(saved.rules).has(twin), p).toBe(true);
    }
  });

  it("starts a role's ticks from what saving writes, so no box reads 'comes with' while it isn't granted", () => {
    expect(withReadTwins(["Season.Steps.ReadWrite"]).sort()).toEqual(["Season.Steps.Read", "Season.Steps.ReadWrite"]);
    expect(withReadTwins(["Roster.Family.ReadWrite"]).sort()).toEqual(["Roster.Family.ReadWrite", "Roster.Read"]);
    expect(withReadTwins(["Roster.Read", "Finance.Balance.Read"])).toEqual(["Roster.Read", "Finance.Balance.Read"]);
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
