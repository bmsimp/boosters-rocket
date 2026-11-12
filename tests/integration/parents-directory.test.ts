import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, heldAddress, parent } from "@/lib/db/schema";
import { runReconcile } from "../helpers/reconcile";
import { familyNames, familySignins, getPerson, listPeople } from "@/lib/parents/directory";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";

describe("the people directory", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); });
  const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("12", "No Mail", "10", null),
    par("13", "Shared Sam", "10", "sam@example.com"), fam("20", "Chen Family"), par("21", "Shared Sam", "20", "sam@example.com")];

  it("lists what each person can reach, with family names, last sign-in and welcome, and finds by name or email", async () => {
    await seedCache(ALL); await runReconcile({ cause: "test" });
    const [ana] = await db.select().from(parent);
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") });
    await db.insert(auditLog).values({ door: "parent", actorId: ana!.id, actorLabel: ana!.email, action: "signin", targetType: "parent", targetId: ana!.id, at: new Date("2026-11-05T12:00:00Z") });
    expect(await listPeople()).toEqual([{ parentId: ana!.id, name: "Ana Rivera", email: "ana@example.com", blocked: false,
      families: [{ familyQboId: "10", familyName: "Rivera Family", previousCompany: false, kind: "can", words: "Can sign in (hasn't yet)" }],
      lastSigninAt: "2026-11-05T12:00:00.000Z", welcomedAt: "2026-11-01T12:00:00.000Z" }]);
    expect((await listPeople("RIVERA")).length).toBe(1);
    expect((await listPeople("ana@ex")).length).toBe(1);
    expect(await listPeople("zzz")).toEqual([]);
    expect(await getPerson(ana!.id)).toMatchObject({ name: "Ana Rivera", blockedReason: null, blockedAt: null, welcomeOwed: false });
    expect(await getPerson("00000000-0000-4000-8000-00000000dead")).toBeNull();
  });

  it("shows a family's sign-ins with reasons, and names the other family only when asked for detail", async () => {
    await seedCache(ALL); await runReconcile({ cause: "test" });
    const plain = await familySignins("10", { detailed: false });
    expect(plain.map((s) => `${s.name}: ${s.words}`)).toEqual([
      "Ana Rivera: Can sign in (hasn't yet)",
      "No Mail: Can't sign in: no email address in QuickBooks",
      "Shared Sam: Held: this address is also under another family",
    ]);
    expect(JSON.stringify(plain)).not.toContain("Chen");
    expect(plain.find((s) => s.name === "No Mail")).toMatchObject({ parentId: null, email: null, kind: "cannot" });
    const detailed = await familySignins("10", { detailed: true });
    expect(detailed.find((s) => s.name === "Shared Sam")!.words).toBe("Held: this address is also under Chen Family");
  });

  it("shows a blocked person as blocked, and a link made by hand as it stands before sign-ins are switched on", async () => {
    await seedParentSettings({ signin: false, everEnabled: false });
    await seedCache(ALL);
    const p = await seedParent({ name: "Hand Seeded", email: "seeded@example.com", blocked: true });
    await seedGuardian({ parentId: p.id, familyQboId: "10" });
    expect(await familySignins("10", { detailed: true })).toEqual([{ parentId: p.id, sourceQboId: null, name: "Hand Seeded", email: "seeded@example.com", kind: "blocked", words: "Blocked" }]);
  });

  it("keeps two same-named records with no address in one family apart by their QuickBooks source", async () => {
    await seedCache([fam("10", "Rivera Family"), par("14", "Pat Rivera", "10", null), par("15", "Pat Rivera", "10", null)]);
    await runReconcile({ cause: "test" });
    expect((await familySignins("10", { detailed: false })).map((s) => [s.sourceQboId, s.name, s.email])).toEqual([["14", "Pat Rivera", null], ["15", "Pat Rivera", null]]);
  });

  it("lists two addresses on a family record with no parent type separately, one of them held", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await seedCache([fam("10", "Rivera Family", { email: "a@x.org; b@x.org" }), fam("20", "Chen Family", { email: "b@x.org" })]);
    await runReconcile({ cause: "test" });
    const rows = await familySignins("10", { detailed: false });
    expect(rows.map((s) => `${s.email}: ${s.words}`)).toEqual([
      "a@x.org: Can sign in (hasn't yet)",
      "b@x.org: Held: this address is also under another family",
    ]);
  });

  it("shows a hand-made link that is closed as held exactly once", async () => {
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")]);
    const p = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "10" });
    await seedGuardian({ parentId: p.id, familyQboId: "20" });
    await runReconcile({ cause: "test" });
    const rows = await familySignins("10", { detailed: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parentId: p.id, kind: "held" });
  });

  it("gives staff each family's words for a person held under one family and let in to another", async () => {
    await seedCache(ALL); await runReconcile({ cause: "test" });
    await db.update(heldAddress).set({ approvedFamilyQboIds: ["10", "20"] }).where(eq(heldAddress.email, "sam@example.com"));
    await runReconcile({ cause: "test" });
    await db.update(heldAddress).set({ approvedFamilyQboIds: ["20"] }).where(eq(heldAddress.email, "sam@example.com"));
    await runReconcile({ cause: "test" });
    const people = await listPeople("sam");
    expect(people).toHaveLength(1);
    expect(people[0]!.families).toEqual([
      { familyQboId: "10", familyName: "Rivera Family", previousCompany: false, kind: "held", words: "Held: this address is also under Chen Family" },
      { familyQboId: "20", familyName: "Chen Family", previousCompany: false, kind: "can", words: "Can sign in (hasn't yet)" },
    ]);
  });

  it("marks a link from a previous QuickBooks company, keeping its old ID but never naming the family that ID has now", async () => {
    await seedCache(ALL); await runReconcile({ cause: "test" });
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    await seedGuardian({ parentId: ana!.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect((await getPerson(ana!.id))!.families).toEqual([
      { familyQboId: "10", familyName: "Rivera Family", previousCompany: false, kind: "can", words: "Can sign in (hasn't yet)" },
      { familyQboId: "20", familyName: "A family in the previous QuickBooks company", previousCompany: true, kind: "cannot", words: "Can't sign in: a different QuickBooks company was connected" },
    ]);
  });

  it("gives family names from the roster, and a stand-in for an ID it doesn't know", async () => {
    await seedCache(ALL);
    expect(await familyNames(["10", "NOPE"])).toEqual(new Map([["10", "Rivera Family"], ["NOPE", "Family account NOPE"]]));
  });
});
