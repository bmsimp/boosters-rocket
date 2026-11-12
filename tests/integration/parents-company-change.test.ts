import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, guardian, heldAddress, parent, parentAuthSession, parentAuthUser } from "@/lib/db/schema";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { runReconcile } from "@/lib/parents/reconcile";
import { getParentSettings } from "@/lib/parents/settings";
import { expirePreviousCompany, getPreviousCompany } from "@/lib/parents/company-change";
import { resetDb, seedParentSession } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const setRosterSourceForTest = (realmId: string) => db.transaction((tx) => setRosterSource(tx, realmId));
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
    expect(row!.after).toMatchObject({ reason: "different_company", links: 3, people: 2, sessionsEnded: 1, holdsDeleted: 1, welcomesCleared: 2 });
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
});
