import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, guardian, jobRun, parentAuthSession, parentAuthUser } from "@/lib/db/schema";
import { ROSTER_JOB } from "@/lib/roster/source";
import { getParentSettings, PARENTS_KEY } from "@/lib/parents/settings";
import { runReconcile } from "@/lib/parents/reconcile";
import { accessPreview, peopleWithAccess, setRequireStudents, setReviewEmails, setSignins } from "@/lib/parents/switches";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { fam, par, seedCache, seedShape, stu } from "../helpers/roster-cache";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9", permission: "Settings.Parents.ReadWrite" };
const freshRun = () => db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
const RIVERA = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10")];
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);

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

  it("previews who would get access, what needs fixing and which sign-ins would end, before anything is on", async () => {
    await ready([...RIVERA, par("13", "No Mail", "10", null), par("14", "Two Mail", "10", "a@example.com, b@example.com"),
      fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), fam("30", "Empty Family")]);
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    const p = await accessPreview();
    // ana@example.com is under families 10 and 20 and held in both, so only Two Mail (a@example.com, family 10) is granted.
    expect(p).toMatchObject({ people: 1, families: 1, welcomeNow: 1,
      noEmail: [{ qboId: "13", name: "No Mail" }], manyAddresses: [{ qboId: "14", name: "Two Mail" }],
      noSignin: [{ qboId: "20", name: "Chen Family" }, { qboId: "30", name: "Empty Family" }],
      ending: [{ name: "Hand Seeded", email: "seeded@example.com", familyQboId: "POC-FAMILY-1" }] });
    expect(p.held.map((h) => h.email)).toEqual(["ana@example.com"]);
    expect(await db.select().from(guardian)).toHaveLength(1);              // the preview changed nothing
    expect(await db.select().from(auditLog)).toEqual([]);
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
    await seedParentSession(u!.id, { familyQboId: "10" });
    expect(await setSignins(false, admin)).toEqual({ ok: true });
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await getParentSettings()).toMatchObject({ signin: false, everEnabled: true });
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: false, sessionsEnded: 1 });
    await seedCache([]);                                                   // would close the link if the reconcile still ran
    expect((await runReconcile({ cause: "test" })).ran).toBe(false);
    expect((await db.select().from(guardian))[0]!.status).toBe("invited");
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
