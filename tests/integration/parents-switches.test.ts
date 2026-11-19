import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { auditLog, guardian, heldAddress, jobRun, parent, parentAuthSession, parentAuthUser, setting, signinCode } from "@/lib/db/schema";
import { noAppRecordChanges } from "@/lib/families/changes";
import * as reconcileModule from "@/lib/parents/reconcile";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { ROSTER_JOB } from "@/lib/roster/source";
import { getParentSettings, PARENTS_KEY } from "@/lib/parents/settings";
import { runReconcile } from "../helpers/reconcile";
import { accessPreview, missingForSignins, peopleWithAccess, setRequireStudents, setReviewEmails, setSignins, setWelcome } from "@/lib/parents/switches";
import { sendOwedWelcomes } from "@/lib/parents/welcome";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { fam, par, seedCache, seedParentSettings, seedShape, stu } from "../helpers/roster-cache";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9", permission: "Settings.Parents.ReadWrite" };
const freshRun = () => db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
const RIVERA = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10")];
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);

const snapshot = async () => [await db.select().from(guardian).orderBy(guardian.id), await db.select().from(parent).orderBy(parent.id),
  await db.select().from(parentAuthUser).orderBy(parentAuthUser.id), await db.select().from(heldAddress).orderBy(heldAddress.email),
  await db.select().from(auditLog).orderBy(auditLog.id), await db.select().from(setting).orderBy(setting.key)];

describe("the parent switches", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); });
  const ready = async (customers = RIVERA) => { await seedConnected(stub); await seedShape(); await seedCache(customers); await freshRun(); await seedWorkingMail(); };

  it("says what is missing, and refuses to switch on, until QuickBooks, the shape, a fresh roster and mail are all there", async () => {
    expect((await accessPreview()).ready).toEqual({ connected: false, shape: false, rosterFresh: false, mail: false });
    expect(await setSignins(true, admin)).toEqual({ ok: false, errors: [
      "Connect QuickBooks first.", "Choose the membership shape first.", "Refresh the roster first: it hasn't been read in the last 2 days.", "Set up outgoing mail and send a test email first." ] });
    await ready();
    await db.update(jobRun).set({ finishedAt: new Date(Date.now() - 49 * 3_600_000) });
    expect((await accessPreview()).ready).toEqual({ connected: true, shape: true, rosterFresh: false, mail: true });
    expect((await getParentSettings()).signin).toBe(false);
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("names the real cause: no shape chosen, or a shape the roster can't be used with", async () => {
    await seedConnected(stub); await freshRun(); await seedWorkingMail();
    expect(await missingForSignins()).toEqual(["Choose the membership shape first."]);
    await seedShape();                                                      // chosen, but nothing has been read yet
    expect(await missingForSignins()).toEqual(["The roster can't be used yet: refresh it, and check the membership shape under QuickBooks."]);
    await seedCache(RIVERA);
    expect(await missingForSignins()).toEqual([]);
  });

  it("rolls back and saves nothing when the roster stops being usable while switching on", async () => {
    await ready();
    // reconcileAccess is spied to report ran: false, as it would if the roster became unusable after the readiness check.
    const spy = vi.spyOn(reconcileModule, "reconcileAccess").mockResolvedValueOnce({ ran: false, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0, appRecords: noAppRecordChanges() });
    try {
      expect(await setSignins(true, admin)).toEqual({ ok: false, errors: ["The roster changed while this was being switched on. Check the preview and try again."] });
    } finally { spy.mockRestore(); }
    expect(await getParentSettings()).toMatchObject({ signin: false, everEnabled: false });
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("switching off when sign-ins were never on does nothing", async () => {
    await ready();
    const u = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: u.id, familyQboId: "POC-FAMILY-1" });
    await seedParentSession(u.authUserId);
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await db.select().from(parentAuthSession)).toHaveLength(1);
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("switching off deletes every unused sign-in code and counts them", async () => {
    await ready(); await setSignins(true, admin);
    const [p] = await db.select().from(parent);
    await db.insert(signinCode).values({ parentId: p!.id, codeHash: "ab".repeat(32), expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(signinCode).values({ parentId: p!.id, codeHash: "cd".repeat(32), expiresAt: new Date(Date.now() + 600_000), usedAt: new Date() });
    await setSignins(false, admin);
    expect(await db.select().from(signinCode)).toHaveLength(1);              // only the used one remains
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, codesDeleted: 1 });
  });

  it("previews who would get access, what needs fixing and which sign-ins would end, before anything is on", async () => {
    await ready([...RIVERA, par("13", "No Mail", "10", null), par("14", "Two Mail", "10", "a@example.com, b@example.com"),
      fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), fam("30", "Empty Family")]);
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    const p = await accessPreview({ ending: true });
    // ana@example.com is under families 10 and 20 and held in both, so only Two Mail (a@example.com, family 10) is granted.
    expect(p).toMatchObject({ people: 1, families: 1, welcomeNow: 1,
      noEmail: [{ qboId: "13", name: "No Mail" }], manyAddresses: [{ qboId: "14", name: "Two Mail" }],
      noSignin: [{ qboId: "20", name: "Chen Family" }, { qboId: "30", name: "Empty Family" }],
      ending: [{ name: "Hand Seeded", email: "seeded@example.com", familyQboId: "POC-FAMILY-1" }] });
    expect(p.held.map((h) => h.email)).toEqual(["ana@example.com"]);
    expect(await db.select().from(guardian)).toHaveLength(1);              // the preview changed nothing
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("lists no ending sign-in for a customer whose address changed, because the reconcile handles that in place", async () => {
    await ready();
    await setSignins(true, admin);
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana.new@example.com"), stu("12", "Leo Rivera", "10")]);
    expect((await accessPreview({ ending: true })).ending).toEqual([]);
  });

  it("lists the sign-ins the reconcile would close, by the owner's name before the run", async () => {
    await ready();
    await setSignins(true, admin);
    await seedCache([fam("10", "Rivera Family"), stu("12", "Leo Rivera", "10")]);   // the parent left QuickBooks
    expect((await accessPreview({ ending: true })).ending).toEqual([{ name: "Ana Rivera", email: "ana@example.com", familyQboId: "10" }]);
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
  });

  it("changes nothing in the database, whether sign-ins have never been on or are on", async () => {
    const world = [...RIVERA, par("14", "Two Mail", "10", "a@example.com, b@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
    await ready(world);
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    let before = await snapshot();
    expect((await accessPreview({ ending: true })).ending).toHaveLength(1);
    expect(await snapshot()).toEqual(before);
    await seedParentSettings({ welcome: true });
    await setSignins(true, admin);
    await seedCache([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana.new@example.com"), par("14", "Two Mail", "10", "c@example.com"), fam("30", "New Family"), par("31", "New Parent", "30", "new@example.com")]);
    before = await snapshot();
    await accessPreview({ ending: true });
    expect(await snapshot()).toEqual(before);
  });

  it("runs the dry run only when asked for the ending list", async () => {
    await ready();
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    const spy = vi.spyOn(reconcileModule, "reconcileAccess");
    try {
      expect(await accessPreview()).toMatchObject({ ending: [], endingUnknown: false, people: 1 });
      expect(spy).not.toHaveBeenCalled();
      expect((await accessPreview({ ending: true })).ending).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it("counts no blocked person among the people who could sign in or would be welcomed", async () => {
    await ready([...RIVERA, par("13", "Bo Rivera", "10", "bo@example.com")]);
    await seedParent({ name: "Ana Rivera", email: "ana@example.com", blocked: true });
    expect(await accessPreview()).toMatchObject({ people: 1, families: 1, welcomeNow: 1 });          // Bo only
  });

  it("never waits for a running refresh: it says the ending list is not known yet", async () => {
    await ready();
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    let busy!: Awaited<ReturnType<typeof accessPreview>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      busy = await accessPreview({ ending: true });
    });
    expect(busy).toMatchObject({ ending: [], endingUnknown: true });
    expect(await accessPreview({ ending: true })).toMatchObject({ endingUnknown: false, ending: [{ email: "seeded@example.com" }] });
  });

  it("switching on runs the reconcile and is audited with the counts", async () => {
    await ready();
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await getParentSettings()).toMatchObject({ signin: true, everEnabled: true });
    expect(await db.select().from(guardian)).toHaveLength(1);
    const [row] = await audits("settings.parents.save");
    expect(row).toMatchObject({ door: "staff", actorLabel: "admin@club.org", permission: "Settings.Parents.ReadWrite", targetType: "setting", targetId: PARENTS_KEY, ip: "203.0.113.9" });
    expect(row!.before).toMatchObject({ signin: false });
    expect(row!.after).toMatchObject({ signin: true, granted: 1, ended: 0 });
  });

  it("switching off signs every parent out and stops the reconcile; links stay", async () => {
    await ready(); await setSignins(true, admin);
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id);
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await getParentSettings()).toMatchObject({ signin: false, everEnabled: true });
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, sessionsEnded: 1 });
    await seedCache([]);                                                   // would close the link if the reconcile still ran
    expect((await runReconcile({ cause: "test" })).ran).toBe(false);
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
  });

  it("switching off switches welcome emails off too, so switching on again emails nobody by surprise", async () => {
    await ready(); await setSignins(true, admin);
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
    await ready(); await setSignins(true, admin);
    await setWelcome(true, admin);
    expect(await setWelcome(false, admin)).toEqual({ ok: true });
    expect((await db.select().from(parent)).filter((p) => p.welcomeOwed)).toEqual([]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ welcome: false, owedCleared: 1 });
  });

  it("refuses to switch welcome emails on while sign-ins are off, and saves nothing", async () => {
    await ready();
    expect(await setWelcome(true, admin)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    await setSignins(true, admin); await setSignins(false, admin);
    const rows = (await audits("settings.parents.save")).length;
    expect(await setWelcome(true, admin)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    expect((await getParentSettings()).welcome).toBe(false);
    expect(await audits("settings.parents.save")).toHaveLength(rows);
    expect(await setWelcome(false, admin)).toEqual({ ok: true });            // off always works
  });

  it("a press that changes nothing does no work and records nothing", async () => {
    await ready([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo", "10")]);
    await setSignins(true, admin);
    const spy = vi.spyOn(reconcileModule, "reconcileAccess");
    try {
      expect(await setSignins(true, admin)).toEqual({ ok: true });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect(await setReviewEmails(false, admin)).toEqual({ ok: true });
    expect(await setReviewEmails(false, admin)).toEqual({ ok: true });
    const rows = await audits("settings.parents.save");
    expect(rows.filter((r) => (r.after as { signin?: boolean }).signin === true && !(r.before as { signin?: boolean }).signin)).toHaveLength(1);
    expect(rows.filter((r) => (r.after as Record<string, unknown>).requireActiveStudents === true && !(r.before as Record<string, unknown>).requireActiveStudents)).toHaveLength(1);
    expect(rows.filter((r) => (r.after as Record<string, unknown>).reviewEmails === false && (r.before as Record<string, unknown>).reviewEmails)).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  it("offers the active-students setting only when the shape names a student type, and shows what it would close", async () => {
    await ready([fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo", "10", { active: false })]);
    await setSignins(true, admin);
    expect((await accessPreview()).students).toEqual({ offered: true, families: 1, people: 1 });
    expect(await setRequireStudents(true, admin)).toEqual({ ok: true });
    expect((await db.select().from(guardian))[0]).toMatchObject({ status: "disabled", disabledReason: "no_active_students" });
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" });
    expect((await accessPreview()).students.offered).toBe(false);
    expect(await setRequireStudents(true, admin)).toEqual({ ok: false, errors: ["The membership shape doesn't say which customers are students, so this can't be used."] });
  });

  it("saves the review-email switch and audits it", async () => {
    expect(await setReviewEmails(false, admin)).toEqual({ ok: true });
    expect((await getParentSettings()).reviewEmails).toBe(false);
    expect((await audits("settings.parents.save"))[0]!.after).toMatchObject({ reviewEmails: false });
  });

  it("counts the people who can sign in now", async () => {
    await ready(); await setSignins(true, admin);
    expect(await peopleWithAccess()).toBe(1);
  });
});
