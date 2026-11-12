import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, parentAuthSession, parentAuthUser, qboCustomer, setting, signinCode } from "@/lib/db/schema";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { refreshRoster } from "@/lib/roster/refresh";
import { loadRosterPage, rosterEntry } from "@/lib/roster/queries";
import { runReconcile } from "../helpers/reconcile";
import { getParentSettings } from "@/lib/parents/settings";
import { familySignins, getPerson, listPeople } from "@/lib/parents/directory";
import { expirePreviousCompany, getPreviousCompany, PREVIOUS_COMPANY_KEY } from "@/lib/parents/company-change";
import { resetDb, seedGuardian, seedParent, seedParentSession } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const setRosterSourceForTest = (realmId: string) => db.transaction((tx) => setRosterSource(tx, realmId));
const OLD_LABEL = "A family in the previous QuickBooks company";
/** Leo's link closed before the switch (no active students), under family 30 through customer 31. */
const seedClosedLeo = async () => {
  const leo = await seedParent({ name: "Leo Rivera", email: "leo@example.com", welcomedAt: new Date("2026-10-01T12:00:00Z") });
  const link = await seedGuardian({ parentId: leo.id, familyQboId: "30", sourceQboId: "31", status: "disabled", disabledReason: "no_active_students", statusBeforeDisable: "active" });
  return { leo, link };
};
const OLD = [fam("12", "Rivera Family"), par("13", "Ana Rivera", "12", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), par("22", "Mei Chen", "20", "mei@example.com")];

describe("connecting a different QuickBooks company", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    await seedShape(); await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(OLD);
    await setRosterSourceForTest("1111");
    await db.insert(heldAddress).values({ email: "ana@example.com", approvedFamilyQboIds: ["12", "20"], note: "Both hers." });
    await runReconcile({ cause: "test" });
    await db.update(guardian).set({ status: "active" });
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z"), welcomeOwed: false });
  });

  it("closes every link, signs parents out, switches sign-ins and welcomes off, and keeps the people", async () => {
    const [u] = await db.select().from(parentAuthUser);
    await seedParentSession(u!.id, { familyQboId: "12" });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    const links = await db.select().from(guardian);
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.status === "disabled" && l.disabledReason === "company_changed" && l.statusBeforeDisable === "active")).toBe(true);
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false, everEnabled: true });
    expect((await db.select().from(parent)).map((p) => p.name).sort()).toEqual(["Ana Rivera", "Mei Chen"]);
    const [row] = await audits("parent.access.cleared");
    expect(row).toMatchObject({ door: "staff", actorLabel: "admin@club.org", ip: "203.0.113.9" });
    expect(row!.after).toMatchObject({ reason: "different_company", links: 3, people: 2, sessionsEnded: 1, holdsDeleted: 1, welcomesCleared: 2, closedLinksMarked: 0, codesDeleted: 0 });
    expect(row!.after).not.toHaveProperty("snapshotReplaced");
  });

  it("marks a link that had closed before the switch as the old company's too, keeping what it was before it closed", async () => {
    const { link } = await seedClosedLeo();
    await clearRosterOfOtherCompany("2222", admin);
    const [row] = await db.select().from(guardian).where(eq(guardian.id, link.id));
    expect(row).toMatchObject({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active", familyQboId: "30", sourceQboId: "31" });
    expect((await audits("parent.access.cleared"))[0]!.after).toMatchObject({ links: 3, closedLinksMarked: 1 });
    expect((await getPreviousCompany())!.families.map((f) => f.qboId)).toEqual(["12", "20"]);     // the snapshot is of the links that were open
  });

  it("never hands a closed old-company link's person to a stranger who has the same IDs in the new company", async () => {
    const { leo, link } = await seedClosedLeo();
    await clearRosterOfOtherCompany("2222", admin);
    await seedShape();
    await seedCache([fam("30", "Stranger Family"), par("31", "Stranger", "30", "stranger@example.com")]);
    await seedParentSettings(SIGNINS_ON);
    await runReconcile({ cause: "test" });
    const [still] = await db.select().from(parent).where(eq(parent.id, leo.id));
    expect(still).toMatchObject({ email: "leo@example.com", name: "Leo Rivera" });
    const [stranger] = await db.select().from(parent).where(eq(parent.email, "stranger@example.com"));
    expect(stranger!.id).not.toBe(leo.id);
    expect(await db.select().from(guardian).where(eq(guardian.parentId, stranger!.id)))
      .toEqual([expect.objectContaining({ familyQboId: "30", sourceQboId: "31", status: "invited" })]);
    expect((await db.select().from(guardian).where(eq(guardian.id, link.id)))[0]).toMatchObject({ status: "disabled", disabledReason: "company_changed" });
    expect(await audits("parent.email.changed")).toEqual([]);
  });

  it("reuses a closed old-company link whose address reappears under the same IDs only as a new invited link", async () => {
    const { leo, link } = await seedClosedLeo();
    await clearRosterOfOtherCompany("2222", admin);
    await seedShape();
    await seedCache([fam("30", "Rivera Family"), par("31", "Leo Rivera", "30", "leo@example.com")]);
    await seedParentSettings(SIGNINS_ON);
    await runReconcile({ cause: "test" });
    const [row] = await db.select().from(guardian).where(eq(guardian.id, link.id));
    expect(row).toMatchObject({ parentId: leo.id, status: "invited", disabledReason: null, statusBeforeDisable: null });
    const granted = (await audits("parent.access.granted")).filter((a) => a.targetId === link.id);
    expect(granted.at(-1)!.after).toMatchObject({ status: "invited", reopenedFrom: "company_changed" });
  });

  it("deletes every unused sign-in code", async () => {
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    await db.insert(signinCode).values({ parentId: ana!.id, codeHash: "x", expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(signinCode).values({ parentId: ana!.id, codeHash: "y", expiresAt: new Date(), usedAt: new Date() });
    await clearRosterOfOtherCompany("2222", admin);
    expect((await db.select().from(signinCode)).map((c) => c.codeHash)).toEqual(["y"]);
    expect((await audits("parent.access.cleared"))[0]!.after).toMatchObject({ codesDeleted: 1 });
  });

  it("says so when a second company change replaces an earlier snapshot", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    await clearRosterOfOtherCompany("3333", admin);
    expect((await audits("parent.access.cleared"))[1]!.after).toMatchObject({ snapshotReplaced: true, links: 0 });
    expect(await getPreviousCompany()).toMatchObject({ realmId: "2222", newRealmId: "3333", families: [] });
  });

  it("keeps the old company's links out of the new company's roster pages, and labels them on the person's page", async () => {
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    await clearRosterOfOtherCompany("2222", admin);
    await seedConnected(stub, { realmId: "2222" });
    await seedShape();
    await seedCache([fam("12", "Stranger Family"), par("13", "Someone Else", "12", "stranger@example.com")]);
    expect(await familySignins("12", { detailed: true })).toEqual([]);
    expect(await familySignins("20", { detailed: false })).toEqual([]);
    const page = await loadRosterPage();
    expect(page.roster).not.toBeNull();
    expect(page.attention.filter((a) => a.rule === "signin_unknown" || a.rule === "inactive_with_signin")).toEqual([]);
    expect(JSON.stringify(page)).not.toContain("Ana Rivera");
    expect(JSON.stringify(page)).not.toContain("Mei Chen");
    expect((await rosterEntry("12"))!.signIns).toEqual([]);
    const person = await getPerson(ana!.id);
    expect(person!.families.map((f) => [f.familyName, f.kind, f.words])).toEqual([
      [OLD_LABEL, "cannot", "Can't sign in: a different QuickBooks company was connected"],
      [OLD_LABEL, "cannot", "Can't sign in: a different QuickBooks company was connected"]]);
    expect(JSON.stringify(await listPeople())).not.toContain("Stranger Family");
  });

  it("a refresh that finds the cache came from another company clears it first, as connecting would have", { timeout: 30_000 }, async () => {
    Object.assign(stub, fznCompany());
    await seedConnected(stub, { realmId: "2222" });        // the new company is stored, but the clear never ran
    const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
    expect(await refreshRoster(worker)).toMatchObject({ ok: true, customers: 9 });
    expect((await db.select().from(guardian)).every((l) => l.status === "disabled" && l.disabledReason === "company_changed")).toBe(true);
    expect(await db.select().from(heldAddress)).toEqual([]);
    expect(await getPreviousCompany()).toMatchObject({ realmId: "1111", newRealmId: "2222" });
    expect((await getPreviousCompany())!.families.map((f) => f.name)).toEqual(["Rivera Family", "Chen Family"]);
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false });
    expect(await audits("parent.access.cleared")).toEqual([expect.objectContaining({ door: "system", actorLabel: "worker" })]);
    expect(await audits("roster.cleared")).toEqual([expect.objectContaining({ after: { reason: "different_company", realmId: "2222" } })]);
    const cache = await db.select().from(qboCustomer);
    expect(cache.map((c) => c.qboId).sort()).toEqual(["10", "11", "12", "20", "21", "30", "40", "50", "60"]);
    expect(cache.every((c) => c.email === null && c.phone === null)).toBe(true);     // no shape after the clear: no contact details
    expect((await db.select().from(setting).where(eq(setting.key, "roster.source")))[0]!.value).toEqual({ realmId: "2222" });
    expect(await audits("roster.refresh")).toHaveLength(1);
  });

  it("forgets every approval and every welcome, so nothing from the old company applies to the new one by accident", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    expect(await db.select().from(heldAddress)).toEqual([]);
    expect((await db.select().from(parent)).every((p) => p.welcomedAt === null && !p.welcomeOwed)).toBe(true);
    // The new company happens to reuse the old IDs for other families, with the same address under two of them.
    await seedShape();
    await seedCache([fam("12", "Stranger Family"), par("13", "Someone Else", "12", "ana@example.com"), fam("20", "Another Family"), par("21", "Other", "20", "ana@example.com")]);
    await seedParentSettings(SIGNINS_ON);
    await runReconcile({ cause: "test" });
    expect((await db.select().from(guardian)).filter((l) => l.status !== "disabled")).toEqual([]);   // held: the old approval is gone
  });

  it("saves a snapshot of the old company's families, people and approvals", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    const snap = await getPreviousCompany();
    expect(snap).toMatchObject({ realmId: "1111", newRealmId: "2222", approvals: [{ email: "ana@example.com", familyQboIds: ["12", "20"] }] });
    expect(snap!.families.map((f) => [f.qboId, f.name, f.people.map((p) => p.email), f.decision])).toEqual([
      ["12", "Rivera Family", ["ana@example.com"], null], ["20", "Chen Family", ["ana@example.com", "mei@example.com"], null]]);
    expect(snap!.families[0]!.people[0]!.welcomedAt).toBe("2026-11-01T12:00:00.000Z");
  });

  it("does none of it when the same company is connected again", async () => {
    expect(await clearRosterOfOtherCompany("1111", admin)).toBe(false);
    expect((await db.select().from(guardian)).every((l) => l.status === "active")).toBe(true);
    expect(await getPreviousCompany()).toBeNull();
  });

  it("deletes the snapshot after 90 days, or when an Admin says so, and audits it", async () => {
    await clearRosterOfOtherCompany("2222", admin);
    expect(await expirePreviousCompany(new Date(Date.now() + 89 * 86_400_000))).toBe(false);
    expect(await expirePreviousCompany(new Date(Date.now() + 91 * 86_400_000))).toBe(true);
    expect(await getPreviousCompany()).toBeNull();
    expect((await audits("settings.parents.save")).at(-1)!.after).toEqual({ previousCompany: "deleted", reason: "expired" });
  });

  it("still deletes a snapshot it can't read, 90 days after it was last written", async () => {
    await db.insert(setting).values({ key: PREVIOUS_COMPANY_KEY, value: { broken: true } });
    expect(await expirePreviousCompany(new Date(Date.now() + 89 * 86_400_000))).toBe(false);
    expect(await expirePreviousCompany(new Date(Date.now() + 91 * 86_400_000))).toBe(true);
    expect(await db.select().from(setting).where(eq(setting.key, PREVIOUS_COMPANY_KEY))).toEqual([]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toEqual({ previousCompany: "deleted", reason: "expired" });
  });
});
