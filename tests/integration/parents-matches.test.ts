import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMatch, guardian, heldAddress, parent, qboConnection, setting } from "@/lib/db/schema";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { runReconcile } from "../helpers/reconcile";
import { deletePreviousCompany, PREVIOUS_COMPANY_KEY } from "@/lib/parents/company-change";
import { acceptStrongMatches, decideMatch, matchReview } from "@/lib/parents/matches";
import { decideHold } from "@/lib/parents/holds";
import { resetDb } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const setRosterSourceForTest = (realmId: string) => db.transaction((tx) => setRosterSource(tx, realmId));
const OLD = [fam("12", "Rivera Family"), par("13", "Ana Rivera", "12", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), par("22", "Mei Chen", "20", "mei@example.com")];
const NEW = [fam("87", "Rivera Family"), par("88", "Ana Rivera", "87", "ana@example.com"), fam("90", "Chen Family"), par("91", "Ana Rivera", "90", "ana@example.com"), par("92", "Mei Chen", "90", "mei@example.com"), fam("95", "Brand New Family")];
const settingsAdmin = { ...admin, permission: "Settings.Parents.ReadWrite" };

describe("the match review", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    await seedShape(); await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(OLD);
    await setRosterSourceForTest("1111");
    await db.insert(heldAddress).values({ email: "ana@example.com", approvedFamilyQboIds: ["12", "20"], note: "Both hers." });
    await runReconcile({ cause: "test" });
    await db.update(guardian).set({ status: "active" });
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z"), welcomeOwed: false });
    await clearRosterOfOtherCompany("2222", admin);
    await seedConnected(stub, { realmId: "2222" });
    await seedShape(); await seedCache(NEW);
  });

  it("suggests each old family's counterpart with the reason", async () => {
    const r = await matchReview();
    expect(r!.suggestions.map((s) => [s.old.name, s.suggested?.qboId, s.nameMatches, s.addressesMatched, s.strong])).toEqual([
      ["Rivera Family", "87", true, 1, true], ["Chen Family", "90", true, 2, true]]);
    expect(r!.families.map((f) => f.qboId)).toEqual(["95", "90", "87"]);            // by name: Brand New, Chen, Rivera
  });

  it("gives the page no company ID and nothing of the snapshot it doesn't show", async () => {
    const text = JSON.stringify(await matchReview());
    for (const hidden of ["1111", "2222", "realmId", "parentId", "welcomedAt", "approvals", "2026-11-01"]) expect(text).not.toContain(hidden);
  });

  it("accepting a match records it for good, carries the approval and the welcome over, and grants nothing by itself", async () => {
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
    expect(await decideMatch("20", "90", settingsAdmin)).toEqual({ ok: true });
    expect((await db.select().from(familyMatch)).map((m) => [m.oldRealmId, m.oldFamilyQboId, m.newRealmId, m.newFamilyQboId]).sort())
      .toEqual([["1111", "12", "2222", "87"], ["1111", "20", "2222", "90"]]);
    expect((await db.select().from(heldAddress))[0]).toMatchObject({ email: "ana@example.com", approvedFamilyQboIds: ["87", "90"] });
    expect((await db.select().from(parent)).every((p) => p.welcomedAt !== null)).toBe(true);
    expect((await db.select().from(guardian)).filter((l) => l.status !== "disabled")).toEqual([]);     // sign-ins are still off
    const decided = await audits("parent.match.decided");
    expect(decided[0]).toMatchObject({ door: "staff", permission: "Settings.Parents.ReadWrite", targetType: "family_match", targetId: "12", ip: "203.0.113.9" });
    expect(decided.map((d) => d.after)).toEqual([
      { decision: "matched", oldFamilyQboId: "12", newFamilyQboId: "87", approvalsCarried: 1, approvalsSkipped: 0, welcomesRestored: 1 },     // Ana
      { decision: "matched", oldFamilyQboId: "20", newFamilyQboId: "90", approvalsCarried: 1, approvalsSkipped: 0, welcomesRestored: 1 }]);   // Mei; Ana's is back already

    await seedParentSettings({ signin: true, welcome: true });
    const r = await runReconcile({ cause: "test" });
    expect(r).toMatchObject({ granted: 3, welcomeOwed: 0 });                                             // Ana in both, Mei in one; nobody is welcomed twice
  });

  it("never carries an approval over a refusal staff made in the new company", async () => {
    await seedParentSettings({ signin: true });
    expect(await decideHold("ana@example.com", "not_same", ["87", "90"], "Two different people.", { ...admin, permission: "Parents.ReadWrite" })).toEqual({ ok: true });
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
    expect((await db.select().from(heldAddress).where(eq(heldAddress.email, "ana@example.com")))[0])
      .toMatchObject({ approvedFamilyQboIds: [], rejectedFamilyQboIds: ["87", "90"] });
    const open = (await db.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)))
      .filter((r) => r.p.email === "ana@example.com" && r.g.status !== "disabled");
    expect(open).toEqual([]);
    expect((await audits("parent.match.decided"))[0]!.after).toMatchObject({ approvalsCarried: 0, approvalsSkipped: 1 });
  });

  it("a carried approval says who carried it and why, and keeps the note of a real decision", async () => {
    await db.insert(heldAddress).values({ email: "mei@example.com", note: "Real decision." });
    const snap = (await db.select().from(setting).where(eq(setting.key, PREVIOUS_COMPANY_KEY)))[0]!.value as { approvals: unknown[] };
    await db.update(setting).set({ value: { ...snap, approvals: [...snap.approvals, { email: "mei@example.com", familyQboIds: ["20"] }] } }).where(eq(setting.key, PREVIOUS_COMPANY_KEY));
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
    expect(await decideMatch("20", "90", settingsAdmin)).toEqual({ ok: true });
    const rows = new Map((await db.select().from(heldAddress)).map((h) => [h.email, h]));
    expect(rows.get("ana@example.com")).toMatchObject({ approvedFamilyQboIds: ["87", "90"], decidedBy: admin.actor.id, note: "Carried over from the previous QuickBooks company by an accepted match." });
    expect(rows.get("ana@example.com")!.decidedAt).not.toBeNull();
    expect(rows.get("mei@example.com")).toMatchObject({ approvedFamilyQboIds: ["90"], decidedBy: admin.actor.id, note: "Real decision." });
  });

  it("matching a family again after the club went back and forth between companies replaces the earlier match", async () => {
    await db.insert(familyMatch).values({ oldRealmId: "1111", oldFamilyQboId: "12", newRealmId: "9999", newFamilyQboId: "5", decidedBy: null, decidedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
    const rows = await db.select().from(familyMatch);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldRealmId: "1111", oldFamilyQboId: "12", newRealmId: "2222", newFamilyQboId: "87", decidedBy: admin.actor.id });
    expect(rows[0]!.decidedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a person who is not part of an accepted match is new: owed a welcome once welcomes are on", async () => {
    await seedParentSettings({ signin: true, welcome: true });
    expect((await runReconcile({ cause: "test" })).welcomeOwed).toBe(1);                                 // Mei; Ana is held (no approval carried over)
  });

  it("refuses a family that isn't there, one already used, and a second decision on a matched family", async () => {
    expect(await decideMatch("12", "999", settingsAdmin)).toEqual({ ok: false, errors: ["Choose a family from the list."] });
    expect(await decideMatch("nope", "87", settingsAdmin)).toEqual({ ok: false, errors: ["That family isn't in the previous company's list."] });
    await decideMatch("12", "87", settingsAdmin);
    expect(await decideMatch("20", "87", settingsAdmin)).toEqual({ ok: false, errors: ["That family is already matched to another one."] });
    expect(await decideMatch("12", "90", settingsAdmin)).toEqual({ ok: false, errors: ["That family is already matched."] });
    expect(await audits("parent.match.decided")).toHaveLength(1);
  });

  it("refuses anything from a browser that isn't a plain family ID, and changes nothing", async () => {
    for (const [o, n] of [[undefined, "87"], [12, "87"], ["12", 87], ["12", undefined], ["12", ["87"]], [{ toString: () => "12" }, "87"], ["__proto__", "87"], ["12", "__proto__"]] as unknown[][]) {
      expect((await decideMatch(o as string, n as string | null, settingsAdmin)).ok).toBe(false);
    }
    expect(await db.select().from(familyMatch)).toEqual([]);
    expect(await audits("parent.match.decided")).toEqual([]);
  });

  it("rejecting records the decision and nothing else; a rejected family can still be matched later", async () => {
    expect(await decideMatch("12", null, settingsAdmin)).toEqual({ ok: true });
    expect(await db.select().from(familyMatch)).toEqual([]);
    expect((await matchReview())!.suggestions[0]).toMatchObject({ decision: "rejected" });
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: true });
  });

  it("accepts every strong suggestion at once", async () => {
    expect(await acceptStrongMatches(settingsAdmin)).toEqual({ accepted: 2 });
    expect(await db.select().from(familyMatch)).toHaveLength(2);
    expect(await acceptStrongMatches(settingsAdmin)).toEqual({ accepted: 0 });
  });

  it("has nothing to review once the snapshot is gone, or when another company is connected", async () => {
    await db.update(qboConnection).set({ realmId: "3333" });
    expect(await matchReview()).toBeNull();
    expect(await decideMatch("12", "87", settingsAdmin)).toEqual({ ok: false, errors: ["That family isn't in the previous company's list."] });
    await db.update(qboConnection).set({ realmId: "2222" });
    expect(await deletePreviousCompany({ ...settingsAdmin, reason: "admin" })).toBe(true);
    expect(await matchReview()).toBeNull();
    expect((await audits("settings.parents.save")).at(-1)).toMatchObject({ permission: "Settings.Parents.ReadWrite", after: { previousCompany: "deleted", reason: "admin" } });
  });
});
