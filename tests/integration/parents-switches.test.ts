import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, family, guardian, parent, parentAuthSession, parentAuthUser, qboConnection, setting, signinCode, student } from "@/lib/db/schema";
import { getParentSettings, PARENTS_KEY } from "@/lib/parents/settings";
import { missingForSignins, NO_STUDENTS_IN_SHAPE, peopleWithAccess, setRequireStudents, setSignins, setWelcome, signinCounts, studentsEffect } from "@/lib/parents/switches";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { resetDb, seedGuardian, seedGuardianInFamily, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { seedParentSettings, storeShape } from "../helpers/roster-cache";
import { saveShape } from "@/lib/roster/shape";
import { studentsRuleInForce } from "@/lib/parents/sessions";

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9", permission: "Settings.Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const rows = async () => (await db.select().from(guardian).orderBy(guardian.id)).map((g) => ({ id: g.id, status: g.status, disabledReason: g.disabledReason, familyId: g.familyId }));

/**
 * Ana, with an invited row in a family of the app's own (seedGuardianInFamily()), and no QuickBooks at all: the switches
 * need none (open question 15 of the app-owned families spec).
 */
async function seedAna(o: { familyQboId?: string } = {}) {
  const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
  const row = await seedGuardianInFamily({ parentId: ana.id, familyQboId: o.familyQboId ?? "10", status: "invited" });
  return { ana, row };
}

describe("the parent switches", () => {
  beforeEach(async () => { await resetDb(); });

  it("asks only for working mail before switching on: no QuickBooks, shape or roster read", async () => {
    await seedAna();
    expect(await db.select().from(qboConnection)).toEqual([]);
    expect(await missingForSignins()).toEqual(["Set up outgoing mail and send a test email first."]);
    expect(await setSignins(true, admin)).toEqual({ ok: false, errors: ["Set up outgoing mail and send a test email first."] });
    expect((await getParentSettings()).signin).toBe(false);
    expect(await audits("settings.parents.save")).toEqual([]);
    await seedWorkingMail();
    expect(await missingForSignins()).toEqual([]);
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await getParentSettings()).toMatchObject({ signin: true });
  });

  it("switching on saves the switch and is audited, and opens, closes and makes no sign-in", async () => {
    await seedWorkingMail();
    await seedAna();
    // A row closed earlier for a QuickBooks reason, and an open one of a family the app holds as inactive.
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com" });
    await seedGuardianInFamily({ parentId: mei.id, familyQboId: "20", status: "disabled", disabledReason: "not_in_quickbooks", statusBeforeDisable: "active" });
    const leo = await seedParent({ name: "Leo Park", email: "leo@example.com" });
    const inactive = await seedGuardianInFamily({ parentId: leo.id, familyQboId: "30" });
    await db.update(family).set({ active: false }).where(eq(family.id, inactive.familyId!));
    const [before, people] = [await rows(), await db.select().from(parent).orderBy(parent.id)];
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await rows()).toEqual(before);
    expect(await db.select().from(parent).orderBy(parent.id)).toEqual(people);
    const [row] = await audits("settings.parents.save");
    expect(row).toMatchObject({ door: "staff", actorLabel: "admin@club.org", permission: "Settings.Parents.ReadWrite", targetType: "setting", targetId: PARENTS_KEY, ip: "203.0.113.9" });
    expect(row!.before).toMatchObject({ signin: false });
    expect(row!.after).toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "standard" });
    for (const action of ["parent.create", "parent.access.granted", "parent.access.ended"]) expect(await audits(action)).toEqual([]);
  });

  it("switching off when sign-ins were never on does nothing", async () => {
    const u = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: u.id, familyQboId: "POC-FAMILY-1" });
    await seedParentSession(u.authUserId);
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await db.select().from(parentAuthSession)).toHaveLength(1);
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("switching off deletes every unused sign-in code and counts them", async () => {
    await seedWorkingMail(); const { ana } = await seedAna(); await setSignins(true, admin);
    await db.insert(signinCode).values({ parentId: ana.id, codeHash: "ab".repeat(32), expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(signinCode).values({ parentId: ana.id, codeHash: "cd".repeat(32), expiresAt: new Date(Date.now() + 600_000), usedAt: new Date() });
    await setSignins(false, admin);
    expect(await db.select().from(signinCode)).toHaveLength(1);              // only the used one remains
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, codesDeleted: 1 });
  });

  it("switching off signs every parent out; the rows stay as they were", async () => {
    await seedWorkingMail(); const { ana } = await seedAna(); await setSignins(true, admin);
    await seedParentSession(ana.authUserId);
    const before = await rows();
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await getParentSettings()).toMatchObject({ signin: false });
    expect(await rows()).toEqual(before);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, sessionsEnded: 1 });
  });

  it("switching off switches welcome emails off too, so switching on again emails nobody by surprise", async () => {
    await seedWorkingMail(); await seedAna(); await setSignins(true, admin);
    expect(await setWelcome(true, admin)).toEqual({ ok: true });
    expect((await db.select().from(parent)).filter((p) => p.welcomeOwed)).toHaveLength(1);
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false });
    expect((await db.select().from(parent)).filter((p) => p.welcomeOwed)).toEqual([]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, welcome: false, welcomeSwitchedOff: true, owedCleared: 1 });
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect((await db.select().from(parent)).filter((p) => p.welcomeOwed)).toEqual([]);
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
  });

  it("switching welcome emails off clears the owed welcomes and records how many", async () => {
    await seedWorkingMail(); await seedAna(); await setSignins(true, admin);
    await setWelcome(true, admin);
    expect(await setWelcome(false, admin)).toEqual({ ok: true });
    expect((await db.select().from(parent)).filter((p) => p.welcomeOwed)).toEqual([]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ welcome: false, owedCleared: 1 });
  });

  it("refuses to switch welcome emails on while sign-ins are off, and saves nothing", async () => {
    await seedWorkingMail(); await seedAna();
    expect(await setWelcome(true, admin)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    await setSignins(true, admin); await setSignins(false, admin);
    const saved = (await audits("settings.parents.save")).length;
    expect(await setWelcome(true, admin)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    expect((await getParentSettings()).welcome).toBe(false);
    expect(await audits("settings.parents.save")).toHaveLength(saved);
    expect(await setWelcome(false, admin)).toEqual({ ok: true });            // off always works
  });

  it("a press that changes nothing does no work and records nothing", async () => {
    await seedWorkingMail(); await seedAna(); await storeShape();
    await setSignins(true, admin);
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    const saved = await audits("settings.parents.save");
    expect(saved.filter((r) => (r.after as { signin?: boolean }).signin === true && !(r.before as { signin?: boolean }).signin)).toHaveLength(1);
    expect(saved.filter((r) => (r.after as Record<string, unknown>).requireActiveStudents === true && !(r.before as Record<string, unknown>).requireActiveStudents)).toHaveLength(1);
    expect(saved).toHaveLength(2);
  });

  it("the active-students setting is saved and audited and closes nothing; the gate reads it, from the app's own students", async () => {
    await seedWorkingMail();
    const { ana, row } = await seedAna();
    await db.insert(student).values({ familyId: row.familyId!, name: "Leo", active: false });
    await setSignins(true, admin);
    // The stored shape names students, so the setting can be switched on; no QuickBooks and no roster read: the gate
    // reads it from the app's own students.
    await storeShape();
    expect(await studentsEffect()).toEqual({ families: 1, people: 1 });
    expect(await signinCounts()).toEqual({ people: 1, families: 1, welcomeNow: 1 });
    const before = await rows();
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect(await rows()).toEqual(before);
    expect(await audits("parent.access.ended")).toEqual([]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toEqual({ signin: true, welcome: false, requireActiveStudents: true, level: "standard" });
    expect(await signinCounts()).toEqual({ people: 0, families: 0, welcomeNow: 0 });
    // A student comes back: she counts again, with no row reopened, since none was closed.
    await db.update(student).set({ active: true });
    expect(await signinCounts()).toEqual({ people: 1, families: 1, welcomeNow: 1 });
    expect(await studentsEffect()).toEqual({ families: 0, people: 0 });
    expect((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id)))).toHaveLength(1);
  });

  // With no student type the app holds no active student, so the setting would keep every parent out: it is never
  // switched on then, and a shape saved without one leaves it stored but not in force (studentsRuleInForce()).
  it("the active-students setting is refused while the shape names no students, and a shape saved without them leaves it stored but not in force", async () => {
    await seedWorkingMail(); await seedAna(); await setSignins(true, admin);
    for (const shape of [null, { kind: "flat" as const, memberTypeIds: ["M"] }, { kind: "layered" as const, familyTypeId: "F", studentTypeId: null, parentTypeId: "P" }]) {
      if (shape) await storeShape(shape);
      expect(await setRequireStudents(true, admin)).toEqual({ ok: false, errors: [NO_STUDENTS_IN_SHAPE] });
      expect((await getParentSettings()).requireActiveStudents).toBe(false);
    }
    expect((await audits("settings.parents.save")).filter((r) => (r.after as Record<string, unknown>).requireActiveStudents === true)).toEqual([]);
    // Off always works, and on works once the shape names students.
    expect(await setRequireStudents(false, admin)).toEqual({ ok: true });
    await storeShape();
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect(await studentsRuleInForce()).toBe(true);
    // A shape save never touches the parents' settings: one with students keeps the rule in force; one without leaves
    // the stored value as it is, not in force; one with students again puts it back in force, with nothing switched.
    // (Who it then lets in is tests/integration/parent-door.test.ts: a shape save here, with no roster company, also
    // takes Ana's row out of its family record, as keepAppRecordsInStep() does with no company.)
    const saved = (await audits("settings.parents.save")).length;
    await saveShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S2", parentTypeId: "P" }, { actor: admin.actor, ip: null });
    expect(await studentsRuleInForce()).toBe(true);
    for (const shape of [{ kind: "flat" as const, memberTypeIds: ["M"] }, { kind: "layered" as const, familyTypeId: "F", studentTypeId: null, parentTypeId: "P" }]) {
      await saveShape(shape, { actor: admin.actor, ip: null });
      expect(await getParentSettings()).toMatchObject({ signin: true, requireActiveStudents: true });
      expect(await studentsRuleInForce()).toBe(false);
      // Pressing "on" again (a stale page) is refused as when it is off, never told it is saved while not in force,
      // and changes and records nothing.
      expect(await setRequireStudents(true, admin)).toEqual({ ok: false, errors: [NO_STUDENTS_IN_SHAPE] });
      expect(await getParentSettings()).toMatchObject({ requireActiveStudents: true });
    }
    await saveShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" }, { actor: admin.actor, ip: null });
    expect(await studentsRuleInForce()).toBe(true);
    expect(await audits("settings.parents.save")).toHaveLength(saved);
    expect((await audits("settings.membership.save")).map((r) => r.after)).not.toContainEqual(expect.objectContaining({ requireActiveStudentsSwitchedOff: expect.anything() }));
  });

  it("counts the people who can sign in now by the gate's rule: never blocked, never of an inactive family", async () => {
    await seedWorkingMail(); await seedAna(); await setSignins(true, admin);
    const blocked = await seedParent({ name: "Blocked", email: "blocked@example.com", blocked: true });
    await seedGuardianInFamily({ parentId: blocked.id, familyQboId: "10" });
    const gone = await seedParent({ name: "Gone", email: "gone@example.com", welcomedAt: new Date() });
    const row = await seedGuardianInFamily({ parentId: gone.id, familyQboId: "40" });
    expect(await peopleWithAccess()).toBe(2);
    expect(await signinCounts()).toEqual({ people: 2, families: 2, welcomeNow: 1 });
    await db.update(family).set({ active: false }).where(eq(family.id, row.familyId!));
    expect(await peopleWithAccess()).toBe(1);
    expect(await db.select().from(setting).where(eq(setting.key, PARENTS_KEY))).toHaveLength(1);
  });

  it("keeps whatever sign-in level is stored through every switch: nothing writes the level yet", async () => {
    // Slice SI-1 of the sign-in release: the level exists and nothing sets it, so a save of any switch keeps it as stored.
    await seedWorkingMail(); await seedAna(); await storeShape();
    await seedParentSettings({ level: "strict" });
    const stored = async () => (await db.select().from(setting).where(eq(setting.key, PARENTS_KEY)))[0]!.value as Record<string, unknown>;
    for (const press of [() => setSignins(true, admin), () => setWelcome(true, admin), () => setRequireStudents(true, admin),
      () => setRequireStudents(false, admin), () => setWelcome(false, admin), () => setSignins(false, admin)]) {
      expect(await press()).toEqual({ ok: true });
      expect(await getParentSettings()).toMatchObject({ level: "strict" });
      expect(await stored()).toMatchObject({ level: "strict" });
      const last = (await audits("settings.parents.save")).at(-1)!;
      expect(last.before).toMatchObject({ level: "strict" });
      expect(last.after).toMatchObject({ level: "strict" });
    }
    expect(await audits("settings.parents.save")).toHaveLength(6);
  });
});
