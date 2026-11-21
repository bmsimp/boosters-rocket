import { describe, it, expect, beforeEach, vi } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { db } from "@/lib/db/client";
import { eq, sql } from "drizzle-orm";
import { auditLog, family, guardian, parent, parentAuthSession, parentAuthUser, qboConnection, setting, signinCode, student } from "@/lib/db/schema";
import { CLOSED_PARENT_SETTINGS, getParentSettings, PARENTS_KEY, readStoredSettings } from "@/lib/parents/settings";
import { factorCounts, LEVEL_COUNT_CHANGED, LEVEL_UNREADABLE, missingForSignins, NO_STUDENTS_IN_SHAPE, peopleWithAccess, setLevel, setRequireStudents, setSignins,
  setWelcome, signinCounts, studentsEffect } from "@/lib/parents/switches";
import { resolveParentSession } from "@/lib/auth/resolve";
import { asAppFamilyId } from "@/lib/families/ids";
import { DOOR_IP, passwordStep } from "../helpers/parent-door";
import { authenticatorRows, backupCodeRows, seedAuthenticator, seedBackupCodes } from "../helpers/authenticator";
import { passkeyRows, seedPasskey } from "../helpers/passkey";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { resetDb, seedGuardian, seedGuardianInFamily, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { seedParentSettings, storeShape } from "../helpers/roster-cache";
import { saveShape } from "@/lib/roster/shape";
import { studentsRuleInForce } from "@/lib/parents/sessions";
import { hashLinkToken } from "@/lib/parents/signin-links";
import { parentDevice, parentSigninToken } from "@/lib/db/schema";
import { credentialRows, deviceRows, mintLink, seedDevice, seedPassword } from "../helpers/signin-links";

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

  it("switching off deletes every unused set-up and reset link and forgets every device, keeps passwords, and counts them", async () => {
    await seedWorkingMail(); const { ana } = await seedAna(); await setSignins(true, admin);
    const ben = await seedParent({ name: "Ben Ortiz", email: "ben@example.com" });
    await seedPassword(ana.authUserId, "a password long enough to keep");
    const used = await mintLink(ana.id, "setup");
    await db.update(parentSigninToken).set({ usedAt: new Date() }).where(eq(parentSigninToken.tokenHash, hashLinkToken("setup", used)));
    await mintLink(ana.id, "reset");
    await mintLink(ben.id, "setup");
    await seedDevice(ben.id);
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect((await db.select().from(parentSigninToken)).map((r) => r.usedAt !== null)).toEqual([true]);
    expect(await db.select().from(parentDevice)).toEqual([]);
    expect(await credentialRows(ana.authUserId)).toHaveLength(1);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, linksDeleted: 2, devicesForgotten: 1 });
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
    // (Who it then lets in is tests/integration/parent-door.test.ts. A shape save changes no record or guardian row
    // since stage 3's slice 9c.)
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

  it("keeps whatever sign-in level is stored through every other switch", async () => {
    // Slice SI-1 of the sign-in release made the level; since SI-10b only setLevel() writes it, so a save of any other
    // switch keeps it as stored.
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

  it("keeps the level an unreadable value names through a switch, or refuses every switch but the level's until one is chosen", async () => {
    await seedWorkingMail(); await seedAna();
    const stored = async () => (await db.select().from(setting).where(eq(setting.key, PARENTS_KEY)))[0]!.value;
    // A value that fails to parse (welcome isn't a boolean) but names Strict: the door is closed, and a switch keeps Strict.
    await db.insert(setting).values({ key: PARENTS_KEY, value: { signin: true, welcome: 1, level: "strict" } });
    expect(await getParentSettings()).toEqual(CLOSED_PARENT_SETTINGS);
    expect(await readStoredSettings()).toEqual({ settings: CLOSED_PARENT_SETTINGS, level: "strict" });
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await stored()).toEqual({ ...CLOSED_PARENT_SETTINGS, signin: true, level: "strict" });
    const [kept] = await audits("settings.parents.save");
    expect(kept!.before).toEqual({ ...CLOSED_PARENT_SETTINGS, level: "strict" });
    expect(kept!.after).toEqual({ ...CLOSED_PARENT_SETTINGS, signin: true, level: "strict" });
    // One whose level is neither word: every switch but the level's is refused, and nothing is stored or recorded.
    const unreadable = { signin: true, welcome: false, requireActiveStudents: false, level: "relaxed" };
    await db.update(setting).set({ value: unreadable }).where(eq(setting.key, PARENTS_KEY));
    expect((await readStoredSettings()).level).toBeNull();
    for (const press of [() => setSignins(true, admin), () => setWelcome(true, admin), () => setWelcome(false, admin),
      () => setRequireStudents(true, admin), () => setRequireStudents(false, admin)]) {
      expect(await press()).toEqual({ ok: false, errors: [LEVEL_UNREADABLE] });
      expect(await stored()).toEqual(unreadable);
    }
    expect(await audits("settings.parents.save")).toHaveLength(1);
    // Choosing Standard stores the closed state, and its row says the level it found couldn't be read.
    expect(await setLevel("standard", null, admin)).toEqual({ ok: true, signedOut: 0 });
    expect(await stored()).toEqual(CLOSED_PARENT_SETTINGS);
    const chosen = (await audits("settings.parents.save")).at(-1)!;
    expect(chosen.before).toEqual({ ...CLOSED_PARENT_SETTINGS, level: null });
    expect(chosen.after).toEqual(CLOSED_PARENT_SETTINGS);
    expect(await audits("settings.parents.save")).toHaveLength(2);
  });
});

/** A guardian with an active family of their own, who can sign in, with a password. */
async function seedCanSignIn(name: string, familyQboId: string) {
  const p = await seedParent({ name, email: `${name.toLowerCase()}@example.com` });
  await seedGuardianInFamily({ parentId: p.id, familyQboId });
  await seedPassword(p.authUserId, PASSWORD);
  return p;
}
const PASSWORD = "a password long enough to keep";
type SessionRow = { id: string; strongAt: Date | null };
const sessionsOf = async (authUserId: string): Promise<SessionRow[]> => db.select({ id: parentAuthSession.id,
  strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt) }).from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));
const provedSessions = async () => (await db.select({ id: parentAuthSession.id }).from(parentAuthSession).where(sql`${parentAuthSession.strongAt} is not null`)).length;
/** What the gate makes of a session now, as a page request would ask it (enrolment.test.ts reads it the same way). */
async function stateOf(sessionId: string) {
  const [s] = await db.select({ id: parentAuthSession.id, userId: parentAuthSession.userId, familyId: parentAuthSession.familyId }).from(parentAuthSession)
    .where(eq(parentAuthSession.id, sessionId));
  if (!s) return { status: "gone" as const };
  return resolveParentSession({ id: s.id, userId: s.userId, familyId: s.familyId === null ? null : asAppFamilyId(String(s.familyId)) }, DOOR_IP);
}

/**
 * Four guardians who can sign in, each with a session from before the switch: Ana with neither a passkey nor an app (an
 * emailed code's proved session on a remembered device, and an older one), Ben a passkey, Cai an authenticator app and
 * backup codes, Dee both; and two the counts leave out: a blocked person, and one with no row that counts. With
 * working mail.
 */
async function seedFour() {
  await seedWorkingMail();
  const ana = await seedCanSignIn("Ana", "10");
  const ben = await seedCanSignIn("Ben", "20");
  const cai = await seedCanSignIn("Cai", "30");
  const dee = await seedCanSignIn("Dee", "40");
  await seedPasskey(ben.id);
  await seedAuthenticator(cai.id); await seedBackupCodes(cai.id);
  await seedPasskey(dee.id); await seedAuthenticator(dee.id); await seedBackupCodes(dee.id);
  const blocked = await seedParent({ name: "Blocked", email: "blocked@example.com", blocked: true });
  await seedGuardianInFamily({ parentId: blocked.id, familyQboId: "10" });
  const nowhere = await seedParent({ name: "Nowhere", email: "nowhere@example.com" });
  const proved = new Date(Date.now() - 60_000);
  const anaDevice = await seedDevice(ana.id);
  await seedDevice(cai.id);
  const sessions = {
    anaCode: await seedParentSession(ana.authUserId, { familyQboId: "10", strongAt: proved, deviceId: anaDevice.id }),
    anaOld: await seedParentSession(ana.authUserId, { familyQboId: "10" }),
    ben: await seedParentSession(ben.authUserId, { familyQboId: "20", strongAt: proved }),
    cai: await seedParentSession(cai.authUserId, { familyQboId: "30", strongAt: proved }),
    dee: await seedParentSession(dee.authUserId, { familyQboId: "40" }),
  };
  return { ana, ben, cai, dee, blocked, nowhere, sessions };
}
/** Everything Ben, Cai and Dee sign in with, and Ana's and Cai's remembered devices. */
const heldBy = async (f: Awaited<ReturnType<typeof seedFour>>) => ({
  devices: [...await deviceRows(f.ana.id), ...await deviceRows(f.cai.id)],
  apps: [...await authenticatorRows(f.cai.id), ...await authenticatorRows(f.dee.id)],
  codes: [...await backupCodeRows(f.cai.id), ...await backupCodeRows(f.dee.id)],
  passkeys: [...await passkeyRows(f.ben.id), ...await passkeyRows(f.dee.id)],
  passwords: (await Promise.all([f.ana, f.ben, f.cai, f.dee].map((p) => credentialRows(p.authUserId)))).flat(),
});

describe("the club's sign-in level (slice SI-10b)", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; });

  it("counts who can sign in with a passkey, an app, both or neither, over exactly the people signinCounts() counts", async () => {
    expect(await factorCounts()).toEqual({ people: 0, passkey: 0, app: 0, neither: 0 });
    const { blocked, nowhere } = await seedFour();
    // An unfinished app set-up is no app; the blocked person and the one with no row that counts aren't counted, whatever they hold.
    const eve = await seedCanSignIn("Eve", "50");
    await seedAuthenticator(eve.id, { confirmed: false });
    await seedPasskey(blocked.id); await seedPasskey(nowhere.id);
    const counts = await factorCounts();
    expect(counts).toEqual({ people: 5, passkey: 2, app: 2, neither: 2 });
    expect(counts.people).toBe((await signinCounts()).people);
    // A family gone inactive takes its guardian out of both counts alike.
    await db.update(family).set({ active: false }).where(eq(family.id, (await db.select().from(guardian).where(eq(guardian.parentId, eve.id)))[0]!.familyId!));
    expect(await factorCounts()).toEqual({ people: 4, passkey: 2, app: 2, neither: 1 });
    expect((await factorCounts()).people).toBe((await signinCounts()).people);
  });

  it("switches to Strict with the count shown: signs out those with neither, clears every other proof, keeps every factor and device, mails nobody", async () => {
    const f = await seedFour();
    const { ana, ben, cai, dee, sessions } = f;
    await setSignins(true, admin);
    const held = await heldBy(f);
    expect(await setLevel("strict", 1, admin)).toEqual({ ok: true, signedOut: 1 });
    expect(await getParentSettings()).toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "strict" });
    // Ana's sessions are gone, the emailed code's among them; the others stay, with no proof.
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
    expect(await sessionsOf(ben.authUserId)).toEqual([{ id: sessions.ben.id, strongAt: null }]);
    expect(await sessionsOf(cai.authUserId)).toEqual([{ id: sessions.cai.id, strongAt: null }]);
    expect(await sessionsOf(dee.authUserId)).toEqual([{ id: sessions.dee.id, strongAt: null }]);
    expect(await heldBy(f)).toEqual(held);
    expect(outbox).toEqual([]);
    const saved = (await audits("settings.parents.save")).filter((r) => (r.after as { level?: string }).level === "strict");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ actorLabel: "admin@club.org", permission: "Settings.Parents.ReadWrite", targetType: "setting", targetId: PARENTS_KEY, ip: "203.0.113.9" });
    expect(saved[0]!.before).toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "standard" });
    expect(saved[0]!.after).toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "strict",
      counts: { people: 4, passkey: 2, app: 2, neither: 1 }, signedOut: 1, sessionsEnded: 2, proofsCleared: 2 });
    // Through the gate: a factor holder's session is whole; Ana's password leads to Strict's enrolment.
    for (const s of [sessions.ben, sessions.cai, sessions.dee]) expect((await stateOf(s.id)).status).toBe("ok");
    expect((await passwordStep(ana.email, { password: PASSWORD })).body).toEqual({ ok: true, next: "/one-more-step" });
    expect(outbox).toEqual([]);
  });

  it("refuses the switch to Strict when the count shown is not the count now: nothing stored, recorded or ended", async () => {
    const { ana } = await seedFour();
    for (const shown of [0, 2]) {
      expect(await setLevel("strict", shown, admin)).toEqual({ ok: false, errors: [LEVEL_COUNT_CHANGED] });
      expect((await getParentSettings()).level).toBe("standard");
    }
    expect(await audits("settings.parents.save")).toEqual([]);
    expect(await sessionsOf(ana.authUserId)).toHaveLength(2);
    expect(await provedSessions()).toBe(3);
  });

  it("does nothing for a press when Strict is stored already, whatever count it carries", async () => {
    const { ana } = await seedFour();
    await seedParentSettings({ level: "strict" });
    for (const shown of [1, 0, 7]) expect(await setLevel("strict", shown, admin)).toEqual({ ok: true, signedOut: 0 });
    expect(await audits("settings.parents.save")).toEqual([]);
    expect(await sessionsOf(ana.authUserId)).toHaveLength(2);
    expect(await provedSessions()).toBe(3);
  });

  it("switches back to Standard undoing nothing: nobody signed out, every factor kept, the row recorded", async () => {
    const f = await seedFour();
    const { ana, sessions } = f;
    await setSignins(true, admin);
    expect(await setLevel("strict", 1, admin)).toEqual({ ok: true, signedOut: 1 });
    // Ana signs in again at Strict: her password makes an enrolling session.
    expect((await passwordStep(ana.email, { password: PASSWORD })).body).toEqual({ ok: true, next: "/one-more-step" });
    const [enrolling] = await sessionsOf(ana.authUserId);
    const all = await db.select({ id: parentAuthSession.id }).from(parentAuthSession).orderBy(parentAuthSession.id);
    expect(all).toHaveLength(4);
    const held = await heldBy(f);
    expect(await setLevel("standard", null, admin)).toEqual({ ok: true, signedOut: 0 });
    expect((await getParentSettings()).level).toBe("standard");
    expect(await db.select({ id: parentAuthSession.id }).from(parentAuthSession).orderBy(parentAuthSession.id)).toEqual(all);
    expect(await heldBy(f)).toEqual(held);
    const back = (await audits("settings.parents.save")).at(-1)!;
    expect(back.before).toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "strict" });
    expect(back.after).toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "standard" });
    // The enrolling session ends at its next request (the gate's enrol_ended); the others are whole.
    expect(await stateOf(enrolling!.id)).toEqual({ status: "none" });
    for (const s of [sessions.ben, sessions.cai, sessions.dee]) expect((await stateOf(s.id)).status).toBe("ok");
    // A second press changes nothing and records nothing.
    expect(await setLevel("standard", null, admin)).toEqual({ ok: true, signedOut: 0 });
    expect(await audits("settings.parents.save")).toHaveLength(3);
    expect(outbox).toEqual([]);
  });

  it("may be chosen with sign-ins off, and signs out those with neither then too", async () => {
    const { ana, sessions } = await seedFour();
    expect((await getParentSettings()).signin).toBe(false);
    expect(await setLevel("strict", 1, admin)).toEqual({ ok: true, signedOut: 1 });
    expect(await getParentSettings()).toEqual({ ...CLOSED_PARENT_SETTINGS, level: "strict" });
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
    expect((await db.select({ id: parentAuthSession.id }).from(parentAuthSession)).map((r) => r.id).sort()).toEqual([sessions.ben.id, sessions.cai.id, sessions.dee.id].sort());
  });

  it("chooses Strict over an unreadable value with its count and confirm, storing the closed state's switches at Strict", async () => {
    const { ana } = await seedFour();
    await db.insert(setting).values({ key: PARENTS_KEY, value: { signin: true, welcome: false, requireActiveStudents: false, level: "relaxed" } });
    expect(await setLevel("strict", 0, admin)).toEqual({ ok: false, errors: [LEVEL_COUNT_CHANGED] });
    expect(await audits("settings.parents.save")).toEqual([]);
    expect(await setLevel("strict", 1, admin)).toEqual({ ok: true, signedOut: 1 });
    expect((await db.select().from(setting).where(eq(setting.key, PARENTS_KEY)))[0]!.value).toEqual({ ...CLOSED_PARENT_SETTINGS, level: "strict" });
    expect(await sessionsOf(ana.authUserId)).toEqual([]);
  });
});
