import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asParent, renderPage } from "../helpers/signed-in";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice, parentEmailChange, parentSigninToken, qboCustomer, setting, signinCode } from "@/lib/db/schema";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { refreshRoster } from "@/lib/roster/refresh";
import { PARENTS_KEY } from "@/lib/parents/settings";
import { familySignins } from "@/lib/parents/directory";
import { hashLinkToken } from "@/lib/parents/signin-links";
import ParentHome from "@/app/(parent)/page";
import FormsPage from "@/app/(parent)/forms/page";
import { GET as parentDownload } from "@/app/(parent)/forms/[id]/signed/route";
import { resetDb, seedGuardian, seedParent, seedParentSession } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, storeShape, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { seedEmailChange } from "../helpers/email-change";
import { identityNow, seedTwoFamilies } from "../helpers/parent";
import { mintLink, seedCode, seedDevice, seedPassword } from "../helpers/signin-links";

/**
 * What a change of company does to sign-ins (section 3 of the app-owned families spec, Appendix B, open question 16):
 * nothing. Since stage 4's slice M7a the clear (clearRosterOfOtherCompanyLocked(), src/lib/roster/source.ts) keeps every
 * membership open in its family, every session, device, code and set-up or reset link, every welcome, the sign-in
 * switches and every change of sign-in address. Until then it closed every link, signed everyone out and switched
 * sign-ins off, and this file proved that; it now proves the opposite. A change of company is still refused until stage
 * 4's slice M8 (open question 18), so these tests call the clear directly.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: "203.0.113.9" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const setRosterSourceForTest = (realmId: string) => db.transaction((tx) => setRosterSource(tx, realmId));
/** The setting the previous-company snapshot was kept in, before it was retired with the match review. */
const SNAPSHOT_KEY = "parents.previous_company";
/** Leo's link closed before the switch (no active students), under family 30 through customer 31. */
const seedClosedLeo = async () => {
  const leo = await seedParent({ name: "Leo Rivera", email: "leo@example.com", welcomedAt: new Date("2026-10-01T12:00:00Z") });
  const link = await seedGuardian({ parentId: leo.id, familyQboId: "30", sourceQboId: "31", status: "disabled", disabledReason: "no_active_students", statusBeforeDisable: "active" });
  return { leo, link };
};
const OLD = [fam("12", "Rivera Family"), par("13", "Ana Rivera", "12", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com"), par("22", "Mei Chen", "20", "mei@example.com")];

/** Every row of every sign-in table, ids and times and all, and the parents' settings: for "touched none of it". */
const signinRows = async () => ({
  people: await db.select().from(parent).orderBy(asc(parent.id)),
  memberships: await db.select().from(guardian).orderBy(asc(guardian.id)),
  users: await db.select().from(parentAuthUser).orderBy(asc(parentAuthUser.id)),
  accounts: await db.select().from(parentAuthAccount).orderBy(asc(parentAuthAccount.id)),
  sessions: await db.select().from(parentAuthSession).orderBy(asc(parentAuthSession.id)),
  devices: await db.select().from(parentDevice).orderBy(asc(parentDevice.id)),
  codes: await db.select().from(signinCode).orderBy(asc(signinCode.id)),
  links: await db.select().from(parentSigninToken).orderBy(asc(parentSigninToken.id)),
  emailChanges: await db.select().from(parentEmailChange).orderBy(asc(parentEmailChange.id)),
  settings: await db.select().from(setting).where(eq(setting.key, PARENTS_KEY)),
});

describe("connecting a different QuickBooks company touches no sign-in", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    await seedShape(); await seedParentSettings({ ...SIGNINS_ON, welcome: true }); await seedCache(OLD);
    await setRosterSourceForTest("1111");
    // The people and their memberships, as the portal holds them: Ana in both families, Mei in one, all signed in before.
    const welcomedAt = new Date("2026-11-01T12:00:00Z");
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com", welcomedAt });
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com", welcomedAt, welcomeOwed: true });
    await seedGuardian({ parentId: ana.id, familyQboId: "12", sourceQboId: "13" });
    await seedGuardian({ parentId: ana.id, familyQboId: "20", sourceQboId: "21" });
    await seedGuardian({ parentId: mei.id, familyQboId: "20", sourceQboId: "22" });
    await syncAppRecords();
  });

  it("keeps every membership open in its family, every session, device, code and link, every welcome, the switches and every change of sign-in address", async () => {
    const [ana] = await db.select().from(parent).where(eq(parent.email, "ana@example.com"));
    const [u] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.email, "ana@example.com"));
    const [row] = await db.select().from(guardian).where(eq(guardian.parentId, ana!.id)).limit(1);
    await seedParentSession(u!.id, { familyQboId: "12" });
    await seedClosedLeo();
    await seedCode(ana!.id);
    await seedCode(ana!.id, { usedAt: new Date() });
    const used = await mintLink(ana!.id, "setup");
    await db.update(parentSigninToken).set({ usedAt: new Date() }).where(eq(parentSigninToken.tokenHash, hashLinkToken("setup", used)));
    await mintLink(ana!.id, "reset");
    await seedDevice(ana!.id);
    await seedPassword(u!.id, "a password long enough to keep");
    await seedEmailChange({ parentId: ana!.id, guardianId: row!.id, familyId: row!.familyId, newEmail: "ana.new@example.com" });
    const before = await signinRows();
    // Something of each is there to keep: every open row names its app family.
    expect(before.memberships.filter((g) => g.status !== "disabled").every((g) => g.familyId !== null)).toBe(true);
    expect([before.sessions.length, before.devices.length, before.codes.length, before.links.length, before.emailChanges.length]).toEqual([1, 1, 2, 2, 1]);
    expect(before.accounts.some((x) => x.providerId === "credential")).toBe(true);
    expect(before.people.filter((p) => p.welcomedAt !== null)).toHaveLength(3);
    expect(before.people.filter((p) => p.welcomeOwed)).toHaveLength(1);

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    expect(await signinRows()).toEqual(before);
    expect(await audits("parent.access.cleared")).toEqual([]);
    expect(await audits("roster.cleared")).toHaveLength(1);
  });

  it("writes no snapshot of the old company, at a first change or a second", async () => {
    const before = await signinRows();
    await clearRosterOfOtherCompany("2222", admin);
    await clearRosterOfOtherCompany("3333", admin);
    expect(await db.select().from(setting).where(eq(setting.key, SNAPSHOT_KEY))).toEqual([]);
    expect(await signinRows()).toEqual(before);
    expect((await audits("roster.cleared")).map((r) => r.before)).toEqual([{ realmId: "1111" }, { realmId: "2222" }]);
  });

  it("gives nobody a sign-in from the new company's customers, even under the old IDs and addresses, and keeps each person in their own family", async () => {
    await seedClosedLeo();
    const rivera = await recordOfCustomer("12", "family");
    const before = await signinRows();
    const signinsBefore = await familySignins(rivera);
    expect(signinsBefore.length).toBeGreaterThan(0);
    await clearRosterOfOtherCompany("2222", admin);
    // The new company happens to reuse the old IDs, with the old addresses on them: its roster read keeps the cache and
    // makes no record (since stage 3's slice 9c), so nothing of the portal's records follows it.
    await db.insert(qboCustomer).values([
      { qboId: "12", displayName: "Stranger Family", active: true, parentQboId: null, typeQboId: OLD[0]!.typeQboId, syncToken: "0" },
      { qboId: "13", displayName: "Someone Else", active: true, parentQboId: "12", typeQboId: OLD[1]!.typeQboId, email: "ana@example.com", syncToken: "0" },
      { qboId: "32", displayName: "Stranger", active: true, parentQboId: "12", typeQboId: OLD[1]!.typeQboId, email: "stranger@example.com", syncToken: "0" },
    ]);
    expect(await db.select().from(parent).where(eq(parent.email, "stranger@example.com"))).toEqual([]);
    expect(await signinRows()).toEqual(before);
    // Ana is in the Rivera family the portal holds, as before: the app's family, not the new company's customer 12.
    expect(await familySignins(rivera)).toEqual(signinsBefore);
    for (const action of ["parent.create", "parent.access.granted", "parent.email.changed"]) expect(await audits(action)).toEqual([]);
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
    const before = await signinRows();
    expect(await clearRosterOfOtherCompany("1111", admin)).toBe(false);
    expect((await db.select().from(guardian)).every((l) => l.status === "active")).toBe(true);
    expect(await signinRows()).toEqual(before);
    expect(await audits("roster.cleared")).toEqual([]);
  });
});

describe("a family's guardian, the moment after a change of company", () => {
  const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

  it("is still let in to their own family, sees its money as not connected, and still downloads its signed form", async () => {
    await resetDb(); stub.reset();
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    const { a, b } = await seedTwoFamilies();
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    // The gate, run again on A's own session: it still counts, in A's own app family.
    const identity = await identityNow(a.session.id);
    expect(identity.familyId).toBe(a.identity.familyId);
    asParent(identity);
    // Home: the money box says the family isn't connected to the club's books (its link ended), with no figures and no Pay.
    const home = textOf(await renderPage(ParentHome));
    expect(home).toContain("Hi, Ansgar");
    expect(home).toContain("The club hasn't connected your payments to the portal yet. Until then, the treasurer can tell you what you owe.");
    for (const invoice of a.spec.invoices!) expect(home).not.toContain(invoice.number);
    // Forms: once the new company's membership shape is saved (the clear cleared the old one, as QuickBooks' own), the
    // family's own forms are listed by the app's records, and the signed one downloads, its evidence kept as its family's.
    await storeShape();
    const html = await renderPage(FormsPage);
    expect(textOf(html)).toContain("the forms for Alderquist Family");
    expect(html).toContain(`/forms/${a.forms!.ids.complete}/signed`);
    for (const theirs of Object.values(b.forms!.ids)) expect(html).not.toContain(theirs);
    const own = await parentDownload(new Request(`http://localhost/forms/${a.forms!.ids.complete}/signed`), { params: Promise.resolve({ id: a.forms!.ids.complete }) });
    expect(own.status).toBe(200);
    expect(Buffer.from(await own.arrayBuffer()).equals(a.forms!.evidence.sealed)).toBe(true);
    // B's form is still B's alone.
    const theirs = await parentDownload(new Request(`http://localhost/forms/${b.forms!.ids.complete}/signed`), { params: Promise.resolve({ id: b.forms!.ids.complete }) });
    expect(theirs.status).toBe(404);
  });
});
