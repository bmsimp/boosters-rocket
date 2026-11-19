import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, parentAuthSession, parentAuthUser, setting, signinCode } from "@/lib/db/schema";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { refreshRoster } from "@/lib/roster/refresh";
import { loadRosterPage, rosterEntry } from "@/lib/roster/queries";
import { getParentSettings } from "@/lib/parents/settings";
import { familySignins, getPerson, listPeople } from "@/lib/parents/directory";
import { resetDb, seedGuardian, seedParent, seedParentSession } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const setRosterSourceForTest = (realmId: string) => db.transaction((tx) => setRosterSource(tx, realmId));
/** The setting the previous-company snapshot was kept in, before it was retired with the match review. */
const SNAPSHOT_KEY = "parents.previous_company";
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
    // The people and their memberships, as the portal holds them: Ana in both families, Mei in one, all signed in before.
    const welcomedAt = new Date("2026-11-01T12:00:00Z");
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com", welcomedAt });
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com", welcomedAt });
    await seedGuardian({ parentId: ana.id, familyQboId: "12", sourceQboId: "13" });
    await seedGuardian({ parentId: ana.id, familyQboId: "20", sourceQboId: "21" });
    await seedGuardian({ parentId: mei.id, familyQboId: "20", sourceQboId: "22" });
    // A held address left from before the review was retired: nothing reads or writes the table any more.
    await db.insert(heldAddress).values({ email: "ana@example.com", approvedFamilyQboIds: ["12", "20"], note: "Both hers." });
    await syncAppRecords();
  });

  it("closes every link, signs parents out, switches sign-ins and welcomes off, and keeps the people", async () => {
    const [u] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.email, "ana@example.com"));
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
    expect(row!.after).toMatchObject({ reason: "different_company", fromRealmId: "1111", toRealmId: "2222", links: 3, people: 2, sessionsEnded: 1, welcomesCleared: 2,
      closedLinksMarked: 0, codesDeleted: 0 });
    expect(row!.after).not.toHaveProperty("holdsDeleted");
    expect(row!.after).not.toHaveProperty("familiesKept");
  });

  it("marks a link that had closed before the switch as the old company's too, keeping what it was before it closed", async () => {
    const { link } = await seedClosedLeo();
    await clearRosterOfOtherCompany("2222", admin);
    const [row] = await db.select().from(guardian).where(eq(guardian.id, link.id));
    expect(row).toMatchObject({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active", familyQboId: "30", sourceQboId: "31" });
    expect((await audits("parent.access.cleared"))[0]!.after).toMatchObject({ links: 3, closedLinksMarked: 1 });
  });

  it("writes no snapshot of the old company and leaves the retired held addresses as they were", async () => {
    const held = await db.select().from(heldAddress);
    await clearRosterOfOtherCompany("2222", admin);
    expect(await db.select().from(setting).where(eq(setting.key, SNAPSHOT_KEY))).toEqual([]);
    expect(await db.select().from(heldAddress)).toEqual(held);
    // A second change of company finds nothing open, and still keeps nothing of the first.
    await clearRosterOfOtherCompany("3333", admin);
    expect((await audits("parent.access.cleared"))[1]!.after).toMatchObject({ links: 0, fromRealmId: "2222", toRealmId: "3333" });
    expect(await db.select().from(setting).where(eq(setting.key, SNAPSHOT_KEY))).toEqual([]);
  });

  it("gives nobody a sign-in from the new company's customers, even under the old IDs and addresses", async () => {
    const { leo, link } = await seedClosedLeo();
    await clearRosterOfOtherCompany("2222", admin);
    expect((await db.select().from(parent)).every((p) => p.welcomedAt === null && !p.welcomeOwed)).toBe(true);
    // The new company happens to reuse the old IDs, with the old addresses on them.
    await seedShape();
    await seedCache([fam("12", "Stranger Family"), par("13", "Someone Else", "12", "ana@example.com"), fam("30", "Rivera Family"), par("31", "Leo Rivera", "30", "leo@example.com"),
      par("32", "Stranger", "30", "stranger@example.com")]);
    await seedParentSettings(SIGNINS_ON);
    await setRosterSourceForTest("2222");
    await syncAppRecords();
    expect((await db.select().from(guardian)).filter((l) => l.status !== "disabled")).toEqual([]);
    expect(await db.select().from(parent).where(eq(parent.email, "stranger@example.com"))).toEqual([]);
    expect((await db.select().from(parent).where(eq(parent.id, leo.id)))[0]).toMatchObject({ email: "leo@example.com", name: "Leo Rivera" });
    expect((await db.select().from(guardian).where(eq(guardian.id, link.id)))[0]).toMatchObject({ status: "disabled", disabledReason: "company_changed" });
    for (const action of ["parent.create", "parent.access.granted", "parent.email.changed"]) expect(await audits(action)).toEqual([]);
  });

  it("deletes every unused sign-in code", async () => {
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    await db.insert(signinCode).values({ parentId: ana!.id, codeHash: "x", expiresAt: new Date(Date.now() + 600_000) });
    await db.insert(signinCode).values({ parentId: ana!.id, codeHash: "y", expiresAt: new Date(), usedAt: new Date() });
    await clearRosterOfOtherCompany("2222", admin);
    expect((await db.select().from(signinCode)).map((c) => c.codeHash)).toEqual(["y"]);
    expect((await audits("parent.access.cleared"))[0]!.after).toMatchObject({ codesDeleted: 1 });
  });

  it("keeps the old company's links out of the new company's roster pages, and labels them on the person's page", async () => {
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    await clearRosterOfOtherCompany("2222", admin);
    await seedConnected(stub, { realmId: "2222" });
    await seedShape();
    await seedCache([fam("12", "Stranger Family"), par("13", "Someone Else", "12", "stranger@example.com")]);
    expect(await familySignins(await recordOfCustomer("12", "family"))).toEqual([]);
    expect(await familySignins(await recordOfCustomer("20", "family"))).toEqual([]); // a record the old links never name
    const page = await loadRosterPage();
    expect(page.roster).not.toBeNull();
    expect(page.attention.filter((a) => a.rule === "signin_unknown")).toEqual([]);
    expect(JSON.stringify(page)).not.toContain("Ana Rivera");
    expect(JSON.stringify(page)).not.toContain("Mei Chen");
    expect((await rosterEntry(await recordOfCustomer("12", "family")))!.signIns).toEqual([]);
    const person = await getPerson(ana!.id);
    expect(person!.families.map((f) => [f.familyName, f.kind, f.words])).toEqual([
      [OLD_LABEL, "cannot", "Can't sign in: a different QuickBooks company was connected"],
      [OLD_LABEL, "cannot", "Can't sign in: a different QuickBooks company was connected"]]);
    expect(JSON.stringify(await listPeople())).not.toContain("Stranger Family");
  });

  // From stage 2 of the app-owned families spec until stage 4 ships (open question 18), another company's roster is
  // never read over this one's: the seasons keep their records against this company's families. So a connection to
  // another company stored without the clear (from before the refusal, or by hand) clears nothing either.
  it("a refresh that finds the cache came from another company reads nothing and clears nothing", { timeout: 30_000 }, async () => {
    Object.assign(stub, fznCompany());
    const guardiansBefore = await db.select().from(guardian);
    await seedConnected(stub, { realmId: "2222" });        // the new company is stored, but the clear never ran
    const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed", error: expect.stringContaining("(roster_company)") });
    expect(await db.select().from(guardian)).toEqual(guardiansBefore);
    expect(await audits("parent.access.cleared")).toEqual([]);
    expect(await audits("roster.cleared")).toEqual([]);
    expect((await db.select().from(setting).where(eq(setting.key, "roster.source")))[0]!.value).toEqual({ realmId: "1111" });
    expect(await audits("roster.refresh")).toEqual([]);
  });

  it("does none of it when the same company is connected again", async () => {
    expect(await clearRosterOfOtherCompany("1111", admin)).toBe(false);
    expect((await db.select().from(guardian)).every((l) => l.status === "active")).toBe(true);
    expect(await audits("parent.access.cleared")).toEqual([]);
  });
});
