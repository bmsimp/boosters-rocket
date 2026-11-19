import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, parentAuthSession, parentAuthUser, setting, signinCode } from "@/lib/db/schema";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { runReconcile } from "../helpers/reconcile";
import { resetDb, seedParent, seedGuardian, seedParentSession } from "../helpers/db";
import { seedCache, seedRosterRead, seedShape, seedParentSettings, SIGNINS_ON, fam, par, stu, P_SHAPE } from "../helpers/roster-cache";

const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const links = async () => (await db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)))
  .map((r) => ({ email: r.p.email, family: r.g.familyQboId, source: r.g.sourceQboId, status: r.g.status, reason: r.g.disabledReason }))
  .sort((a, b) => `${a.family}${a.email}`.localeCompare(`${b.family}${b.email}`));
const run = () => runReconcile({ cause: "test" });
const RIVERA = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10")];

describe("the reconcile", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); });

  it("changes nothing while parent sign-ins have never been switched on", async () => {
    await seedCache(RIVERA);
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    expect(await run()).toEqual({ ran: false, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0, appRecords: expect.any(Object) });
    expect(await links()).toEqual([{ email: "seeded@example.com", family: "POC-FAMILY-1", source: null, status: "active", reason: null }]);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("changes nothing when there is no shape", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA);
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect((await run()).ran).toBe(false);
    expect(await links()).toEqual([]);
    expect(await audits("parent.access.granted")).toEqual([]);
  });

  it("changes nothing when the shape names a type QuickBooks no longer has", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache(RIVERA, [{ qboId: "F", name: "Family" }]);           // "P" and "S" are gone
    expect((await run()).ran).toBe(false);
    expect(await links()).toEqual([]);
  });

  it("makes a person, their sign-in account and an invited link, audited with the cause", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA);
    expect(await run()).toEqual({ ran: true, granted: 1, ended: 0, emailChanged: 0, welcomeOwed: 0, appRecords: expect.any(Object) });
    expect(await links()).toEqual([{ email: "ana@example.com", family: "10", source: "11", status: "invited", reason: null }]);
    const [p] = await db.select().from(parent);
    expect(p).toMatchObject({ name: "Ana Rivera", email: "ana@example.com", welcomeOwed: false });
    expect(await db.select().from(parentAuthUser)).toEqual([expect.objectContaining({ parentId: p!.id, email: "ana@example.com", emailVerified: true })]);
    const [row] = await audits("parent.access.granted");
    expect(row).toMatchObject({ door: "system", actorLabel: "reconcile", targetType: "guardian" });
    expect(row!.after).toMatchObject({ familyQboId: "10", sourceQboId: "11", cause: "test" });
    const made = await audits("parent.create");
    expect(made).toEqual([expect.objectContaining({ door: "system", actorId: null, actorLabel: "reconcile", targetType: "parent", targetId: p!.id })]);
    expect(made[0]!.after).toEqual({ name: "Ana Rivera", email: "ana@example.com", sourceQboId: "11", cause: "test" });
  });

  it("changes nothing the second time", async () => {
    // The first run grants, owes a welcome, takes over a hand-made link and opens a hold, so every kind of write happens once.
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    await seedCache([...RIVERA, fam("20", "Chen Family"), par("21", "Mei Chen", "20", "mei@example.com"),
      fam("30", "Bo Family"), par("31", "Bo Lee", "30", "bo@example.com"), fam("40", "Lee Family"), par("41", "Bo Lee", "40", "bo@example.com")]);
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com" });
    await seedGuardian({ parentId: mei.id, familyQboId: "20" });
    await run();
    const first = new Set((await db.select().from(auditLog)).map((r) => r.action));
    expect(first).toEqual(new Set(["parent.create", "parent.access.granted", "parent.access.moved", "parent.hold.opened"]));
    const before = (await db.select().from(auditLog)).length;
    expect(await run()).toEqual({ ran: true, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0, appRecords: expect.any(Object) });
    expect((await db.select().from(auditLog)).length).toBe(before);
  });

  it("marks a welcome as owed only when welcomes are on and the person has never been welcomed", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    await seedParent({ name: "Old Hand", email: "old@example.com", welcomedAt: new Date("2026-01-01T00:00:00Z") });
    await seedCache([...RIVERA, par("13", "Old Hand", "10", "old@example.com")]);
    expect((await run()).welcomeOwed).toBe(1);
    const owed = Object.fromEntries((await db.select().from(parent)).map((p) => [p.email, p.welcomeOwed]));
    expect(owed).toEqual({ "ana@example.com": true, "old@example.com": false });
    const granted = await audits("parent.access.granted");
    expect(granted).toHaveLength(2);
    const [anaRow, oldRow] = [granted.find((r) => (r.after as { sourceQboId: string }).sourceQboId === "11")!, granted.find((r) => (r.after as { sourceQboId: string }).sourceQboId === "13")!];
    expect(anaRow.after).toMatchObject({ welcomeOwed: true });
    expect(oldRow.after).not.toHaveProperty("welcomeOwed");
  });

  it("closes a hand-seeded link QuickBooks doesn't back, and takes over one it does", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA);
    const stray = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: stray.id, familyQboId: "POC-FAMILY-1" });
    const ana = await seedParent({ name: "Ana R", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    expect(await run()).toMatchObject({ granted: 0, ended: 1 });
    expect(await links()).toEqual([
      { email: "ana@example.com", family: "10", source: "11", status: "active", reason: null },
      { email: "seeded@example.com", family: "POC-FAMILY-1", source: null, status: "disabled", reason: "not_in_quickbooks" },
    ]);
    expect((await db.select().from(parent).where(eq(parent.id, ana.id)))[0]!.name).toBe("Ana Rivera");
    expect(await audits("parent.name.changed")).toHaveLength(1);
    const moved = await audits("parent.access.moved");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ door: "system", actorLabel: "reconcile", targetType: "guardian", before: { sourceQboId: null } });
    expect(moved[0]!.after).toEqual({ sourceQboId: "11", parentId: ana.id, familyQboId: "10", cause: "test" });
  });

  it("closes a hand-made link for an address that is held as held, not as missing from QuickBooks", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache([...RIVERA, fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")]);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    expect(await run()).toMatchObject({ ended: 1 });
    expect(await links()).toEqual([{ email: "ana@example.com", family: "10", source: null, status: "disabled", reason: "held" }]);
  });

  it("ends the session for a closed family at once and leaves the person's other family alone, then reopens it as it was", async () => {
    // A roster company, so each family has its record: a session names the family record it chose, and a closed link
    // ends the sessions that chose its row's record.
    await seedRosterRead({ realmId: "4620000000000001" });
    await seedParentSettings(SIGNINS_ON);
    const both = [...RIVERA, fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
    await seedCache(both);
    await db.insert(heldAddress).values({ email: "ana@example.com", approvedFamilyQboIds: ["10", "20"] });
    await run();
    await db.update(guardian).set({ status: "active" });
    const [u] = await db.select().from(parentAuthUser);
    const inTen = await seedParentSession(u!.id, { familyQboId: "10" }), inTwenty = await seedParentSession(u!.id, { familyQboId: "20" });

    await seedCache(both.map((c) => (c.qboId === "11" ? { ...c, active: false } : c)));
    expect(await run()).toMatchObject({ ended: 1 });
    expect((await db.select().from(parentAuthSession)).map((s) => s.id)).toEqual([inTwenty.id]);
    expect(inTen.id).not.toBe(inTwenty.id);
    expect((await links()).find((l) => l.family === "10")).toMatchObject({ status: "disabled", reason: "inactive" });
    expect((await audits("parent.access.ended"))[0]!.after).toMatchObject({ familyQboId: "10", reason: "inactive", sessionsEnded: 1 });

    await seedCache(both);
    expect(await run()).toMatchObject({ granted: 1 });
    expect((await links()).find((l) => l.family === "10")).toMatchObject({ status: "active", reason: null });
  });

  it("ends every session when a person's last link closes", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA); await run();
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: null });
    await seedCache([fam("10", "Rivera Family", { active: false }), par("11", "Ana Rivera", "10", "ana@example.com")]);
    await run();
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await links())[0]).toMatchObject({ status: "disabled", reason: "family_inactive" });
  });

  it("changes a person's address in place when the QuickBooks record's address changes", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(RIVERA); await run();
    const [before] = await db.select().from(parent);
    await db.update(parent).set({ welcomedAt: new Date(), welcomeOwed: false });
    await db.insert(signinCode).values({ parentId: before!.id, codeHash: "x", expiresAt: new Date(Date.now() + 60_000) });
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana.new@example.com")]);
    expect(await run()).toEqual({ ran: true, granted: 0, ended: 0, emailChanged: 1, welcomeOwed: 0, appRecords: expect.any(Object) });
    const people = await db.select().from(parent);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ id: before!.id, email: "ana.new@example.com", welcomeOwed: false });
    expect((await db.select().from(parentAuthUser))[0]!.email).toBe("ana.new@example.com");
    expect(await db.select().from(signinCode)).toEqual([]);
    const [row] = await audits("parent.email.changed");
    expect(row).toMatchObject({ targetType: "parent", targetId: before!.id, before: { email: "ana@example.com" } });
    expect(row!.after).toMatchObject({ email: "ana.new@example.com", cause: "test" });
  });

  it("signs the person out when their address changes in place, since a session was proved with the old address", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA); await run();
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id);
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana.new@example.com"), stu("12", "Leo Rivera", "10")]);
    expect(await run()).toMatchObject({ emailChanged: 1, ended: 0 });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await audits("parent.email.changed"))[0]!.after).toMatchObject({ sessionsEnded: 1 });
  });

  it("moves the link when the new address already belongs to someone else", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache([...RIVERA, fam("20", "Chen Family"), par("21", "Mei Chen", "20", "mei@example.com")]); await run();
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "mei@example.com"), fam("20", "Chen Family"), par("21", "Mei Chen", "20", "mei@example.com")]);
    await db.insert(heldAddress).values({ email: "mei@example.com", approvedFamilyQboIds: ["10", "20"] });
    await run();
    expect(await links()).toEqual([
      { email: "ana@example.com", family: "10", source: null, status: "disabled", reason: "address_changed" },
      { email: "mei@example.com", family: "10", source: "11", status: "invited", reason: null },
      { email: "mei@example.com", family: "20", source: "21", status: "invited", reason: null },
    ]);
    expect(await audits("parent.email.changed")).toEqual([]);
    // The closed link's source is dropped so the new link can carry it: the audit row keeps what it was.
    const [ended] = await audits("parent.access.ended");
    expect(ended).toMatchObject({ before: { status: "invited", sourceQboId: "11" } });
    expect(ended!.after).toMatchObject({ familyQboId: "10", reason: "address_changed" });
  });

  it("closes a sourced link as held when its owner's address is now on another record of the family and held there", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache(RIVERA); await run();
    // Record 11 is gone; Ana's address is now on record 13 of the same family, and under the Chen family too.
    await seedCache([fam("10", "Rivera Family"), par("13", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"),
      fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")]);
    expect(await run()).toMatchObject({ ended: 1 });
    expect(await links()).toEqual([{ email: "ana@example.com", family: "10", source: "11", status: "disabled", reason: "held" }]);
  });

  it("holds an address under two families, keeps a row for it, and opens both once staff approve", async () => {
    await seedParentSettings(SIGNINS_ON);
    await seedCache([...RIVERA, fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")]);
    expect(await run()).toMatchObject({ granted: 0 });
    expect(await links()).toEqual([]);
    expect(await db.select().from(heldAddress)).toEqual([expect.objectContaining({ email: "ana@example.com", approvedFamilyQboIds: [] })]);
    const opened = await audits("parent.hold.opened");
    expect(opened).toEqual([expect.objectContaining({ door: "system", actorLabel: "reconcile", targetType: "held_address", targetId: "ana@example.com", after: { cause: "test" } })]);
    await run();
    expect(await audits("parent.hold.opened")).toHaveLength(1);                 // the row already exists: nothing new to audit
    await db.update(heldAddress).set({ approvedFamilyQboIds: ["10", "20"] });
    expect(await run()).toMatchObject({ granted: 2 });
    expect(await db.select().from(parent)).toHaveLength(1);
    expect((await links()).map((l) => l.family)).toEqual(["10", "20"]);
  });

  it("with no parent type, gives each address on the family record its own person, and changes only the one that changed", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await seedParentSettings(SIGNINS_ON);
    await seedCache([fam("10", "Rivera Family", { email: "ana@example.com; leo@example.com" })]); await run();
    expect(await links()).toEqual([
      { email: "ana@example.com", family: "10", source: "10", status: "invited", reason: null },
      { email: "leo@example.com", family: "10", source: "10", status: "invited", reason: null },
    ]);
    const leo = (await db.select().from(parent).where(eq(parent.email, "leo@example.com")))[0]!;
    await seedCache([fam("10", "Rivera Family", { email: "ana@example.com; leo.new@example.com" })]);
    expect(await run()).toMatchObject({ emailChanged: 1, ended: 0, granted: 0 });
    expect((await db.select().from(parent).where(eq(parent.id, leo.id)))[0]!.email).toBe("leo.new@example.com");
    expect((await links()).map((l) => l.email)).toEqual(["ana@example.com", "leo.new@example.com"]);
    await seedShape(P_SHAPE);
  });

  it("closes a family's links when the active-students setting is on and it has no active student", async () => {
    await seedParentSettings(SIGNINS_ON); await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo", "10", { active: false })]);
    await run();
    await seedParentSettings({ requireActiveStudents: true });
    expect(await run()).toMatchObject({ ended: 1 });
    expect((await links())[0]).toMatchObject({ status: "disabled", reason: "no_active_students" });
  });
});

describe("the reconcile when addresses move between records", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); });
  const ids = async () => Object.fromEntries((await db.select().from(parent)).map((p) => [p.email, p.id]));
  const family = (a: string, b: string) => [fam("10", "Rivera Family"), par("11", "Ann Rivera", "10", a), par("13", "Fay Rivera", "10", b), stu("12", "Leo Rivera", "10")];

  it("never changes a person onto an address someone else had: record 11 goes E to X while record 13 goes F to E", async () => {
    await seedCache(family("e@example.com", "f@example.com")); await run();
    const start = await ids();
    await seedCache(family("x@example.com", "e@example.com"));
    expect(await run()).toMatchObject({ emailChanged: 0 });
    expect(await links()).toEqual([
      { email: "e@example.com", family: "10", source: "13", status: "invited", reason: null },
      { email: "f@example.com", family: "10", source: null, status: "disabled", reason: "address_changed" },
      { email: "x@example.com", family: "10", source: "11", status: "invited", reason: null },
    ]);
    const now = await ids();
    expect(now["e@example.com"]).toBe(start["e@example.com"]);
    expect(now["f@example.com"]).toBe(start["f@example.com"]);
    expect(Object.values(start)).not.toContain(now["x@example.com"]);
    expect(await audits("parent.email.changed")).toEqual([]);
  });

  it("does the same with the IDs the other way round: record 11 goes F to E while record 13 goes E to X", async () => {
    await seedCache(family("f@example.com", "e@example.com")); await run();
    const start = await ids();
    await seedCache(family("e@example.com", "x@example.com"));
    expect(await run()).toMatchObject({ emailChanged: 0 });
    expect(await links()).toEqual([
      { email: "e@example.com", family: "10", source: "11", status: "invited", reason: null },
      { email: "f@example.com", family: "10", source: null, status: "disabled", reason: "address_changed" },
      { email: "x@example.com", family: "10", source: "13", status: "invited", reason: null },
    ]);
    const now = await ids();
    expect(now["e@example.com"]).toBe(start["e@example.com"]);
    expect(now["f@example.com"]).toBe(start["f@example.com"]);
    expect(await audits("parent.email.changed")).toEqual([]);
  });

  it("keeps each person when two records swap addresses", async () => {
    await seedCache(family("e@example.com", "f@example.com")); await run();
    const start = await ids();
    await seedCache(family("f@example.com", "e@example.com"));
    expect(await run()).toMatchObject({ emailChanged: 0 });
    expect(await links()).toEqual([
      { email: "e@example.com", family: "10", source: "13", status: "invited", reason: null },
      { email: "f@example.com", family: "10", source: "11", status: "invited", reason: null },
    ]);
    expect(await ids()).toEqual(start);
    expect(await audits("parent.email.changed")).toEqual([]);
  });

  it("leaves a blocked person blocked at their address through the chain", async () => {
    await seedCache(family("e@example.com", "f@example.com")); await run();
    await db.update(parent).set({ blocked: true }).where(eq(parent.email, "e@example.com"));
    const start = await ids();
    await seedCache(family("x@example.com", "e@example.com"));
    await run();
    const [atE] = await db.select().from(parent).where(eq(parent.email, "e@example.com"));
    expect(atE).toMatchObject({ id: start["e@example.com"], blocked: true });
    expect((await db.select().from(parent).where(eq(parent.email, "f@example.com")))[0]!.blocked).toBe(false);
  });

  it("never treats another company's link as the same link, even with the same IDs", async () => {
    const old = await seedParent({ name: "Old Company", email: "old@example.com" });
    await seedGuardian({ parentId: old.id, familyQboId: "10", sourceQboId: "11", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "new@example.com")]);
    expect(await run()).toMatchObject({ granted: 1, emailChanged: 0, ended: 0 });
    expect(await links()).toEqual([
      { email: "new@example.com", family: "10", source: "11", status: "invited", reason: null },
      { email: "old@example.com", family: "10", source: "11", status: "disabled", reason: "company_changed" },
    ]);
    expect((await db.select().from(parent).where(eq(parent.id, old.id)))[0]).toMatchObject({ email: "old@example.com", name: "Old Company" });
  });

  it("reuses another company's row for the same person only as a new invited link", async () => {
    const old = await seedParent({ name: "Ana Rivera", email: "old@example.com" });
    const row = await seedGuardian({ parentId: old.id, familyQboId: "10", sourceQboId: "11", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "old@example.com")]);
    expect(await run()).toMatchObject({ granted: 1 });
    expect((await db.select().from(guardian))[0]).toMatchObject({ id: row.id, status: "invited", disabledReason: null, statusBeforeDisable: null, sourceQboId: "11" });
    const [g] = await audits("parent.access.granted");
    expect(g).toMatchObject({ targetId: row.id });
    expect(g!.after).toMatchObject({ status: "invited", sourceQboId: "11", reopenedFrom: "company_changed", cause: "test" });
  });

  it("never owes a welcome to a blocked person, and says nothing of one on the grant", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(RIVERA);
    await seedParent({ name: "Ana Rivera", email: "ana@example.com", blocked: true });
    expect(await run()).toMatchObject({ granted: 1, welcomeOwed: 0 });
    expect((await db.select().from(parent))[0]!.welcomeOwed).toBe(false);
    expect((await audits("parent.access.granted"))[0]!.after).not.toHaveProperty("welcomeOwed");
  });
});
