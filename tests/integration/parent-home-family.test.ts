import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asParentChoosing, atPath, pageOutcome, renderPage } from "../helpers/signed-in";

// Home shows what the family owes, and stale or missing figures mean a read from QuickBooks: here that is the stub.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { createElement } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parentAuthSession, qboConnection, qboCustomer, setting } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";
import type { ParentIdentity } from "@/lib/auth/resolve";
import type { ParentCtx } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { loadRosterPage } from "@/lib/roster/queries";
import ParentHome from "@/app/(parent)/page";
import FamilyPage from "@/app/(parent)/family/page";
import ParentLayout from "@/app/(parent)/layout";
import NotFound from "@/app/not-found";
import ChooseFamily from "@/app/choose-family/page";
import { resetDb, seedGuardian } from "../helpers/db";
import { FAMILY_A, FAMILY_B, identityNow, moneyMarkers, seedFamilyMoney, seedParentIn, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { addToCache, fam, par, seedRosterRead, seedShape, stu } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";

const REALM = "9130000000000001", OTHER_REALM = "9130000000000002";
const ctxOf = (identity: ParentIdentity): ParentCtx => ({ ...identity, ip: null });
const A_STUDENTS = FAMILY_A.students.map((s) => s.name), B_STUDENTS = FAMILY_B.students.map((s) => s.name);
const setTreasurer = (treasurerEmail: string) => db.insert(setting).values({ key: "club", value: { name: "Test Boosters", shortName: "TB", color: "#5b2a86", treasurerEmail } });
const NOT_SET_UP = "set up here yet";

// Nothing here reaches Intuit: the stub is what seedConnected() needs to write a connection row, and what a read of a
// family's invoices would be sent to (the families here have ids QuickBooks never gives, so none is sent).
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

describe("loadMyFamily: one family from the roster cache, for its own parent", () => {
  it("returns the family's name, its students by name, the parent's own record and when the roster was read", async () => {
    const { a, b } = await seedTwoFamilies();
    const readAt = await seedRosterRead();
    expect(await loadMyFamily(ctxOf(a.identity))).toEqual({
      name: "Alderquist Family",
      // Each student with their own app record beside them, the id Home matches a standing by.
      students: [{ qboId: FAMILY_A.students[0]!.qboId, id: await recordOfCustomer(FAMILY_A.students[0]!.qboId, "student"), name: "Aurelio Alderquist" },
        { qboId: FAMILY_A.students[1]!.qboId, id: await recordOfCustomer(FAMILY_A.students[1]!.qboId, "student"), name: "Azalea Alderquist" }],
      me: { name: "Ansgar Alderquist", email: FAMILY_A.parent.email, phone: FAMILY_A.parent.phone, edits: "own" },
      rosterReadAt: readAt.toISOString(),
    });
    // Each parent gets their own family and not a string of the other's.
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      const got = JSON.stringify(await loadMyFamily(ctxOf(mine.identity)));
      expect(got).toContain(mine.spec.family.name);
      for (const marker of theirs.markers) expect(got).not.toContain(marker);
    }
  });

  it("says nothing about when the roster was read until a refresh has succeeded", async () => {
    const a = await seedSignedInParent();
    expect((await loadMyFamily(ctxOf(a.identity)))?.rosterReadAt).toBeNull();
  });

  it("finds the family row by its ID, wherever it comes in the rows", async () => {
    await seedShape();
    // The sub-customers are stored before the family, so they come back first.
    await addToCache([stu("ORD-S1", "Aaron Orderly", "ORD-FAM"), par("ORD-P1", "Abby Orderly", "ORD-FAM", "abby@orderly.example")]);
    await addToCache([fam("ORD-FAM", "Orderly Family")]);
    const p = await seedParentIn({ familyQboId: "ORD-FAM", name: "Abby Orderly", email: "abby@orderly.example", sourceQboId: "ORD-P1" });
    expect(await loadMyFamily(ctxOf(p.identity))).toMatchObject({ name: "Orderly Family", students: [{ name: "Aaron Orderly" }], me: { name: "Abby Orderly" } });
  });

  it("leaves out an inactive student, and a family nested under this one with everyone in it", async () => {
    const a = await seedSignedInParent();
    const A = FAMILY_A.family.qboId;
    await addToCache([
      stu("GONE-STUDENT", "Algernon Alderquist (deleted)", A, { active: false }),
      fam("NESTED-FAMILY", "Nestling Family", { parentQboId: A }),
      stu("NESTED-STUDENT", "Nell Nestling", "NESTED-FAMILY"),
      { qboId: "SCHOOL-UNDER", displayName: "Lincoln High", typeQboId: "M", parentQboId: A },
    ]);
    const got = await loadMyFamily(ctxOf(a.identity));
    expect(got!.students!.map((s) => s.name)).toEqual(A_STUDENTS);
    expect(JSON.stringify(got)).not.toMatch(/deleted|Algernon|Nestl|Nell|Lincoln/);
  });

  it("gives no students list when QuickBooks has no student type, and an empty one when the family has no active student", async () => {
    const a = await seedSignedInParent();
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" });
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ name: "Alderquist Family", students: null, me: { name: "Ansgar Alderquist" } });
    await seedShape();
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.typeQboId, "S"));
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ students: [] });
  });

  it("with no parent type, the family customer is the parent's own record", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([fam("NP-FAM", "Noparent Family", { email: "home@noparent.example, work@noparent.example", phone: "512-555-0199" }), stu("NP-S1", "Nico Noparent", "NP-FAM"),
      par("NP-P1", "Nora Noparent", "NP-FAM", "nora@noparent.example")]);
    const fromFamily = await seedParentIn({ familyQboId: "NP-FAM", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "NP-FAM" });
    expect(await loadMyFamily(ctxOf(fromFamily.identity))).toEqual({ name: "Noparent Family", students: [{ qboId: "NP-S1", id: await recordOfCustomer("NP-S1", "student"), name: "Nico Noparent" }],
      me: { name: "Noparent Family", email: "home@noparent.example, work@noparent.example", phone: "512-555-0199", edits: "family" }, rosterReadAt: null });
    // A link that names a record the shape doesn't call a parent is not the person's own record.
    const stale = await seedParentIn({ familyQboId: "NP-FAM", name: "Nora Noparent", email: "nora@noparent.example", sourceQboId: "NP-P1" });
    expect((await loadMyFamily(ctxOf(stale.identity)))!.me).toBeNull();
  });

  it("in a flat club the member is its own family: its own record, no students, nothing under it", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([
      { qboId: "FLAT-M1", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "FLAT-SUB", displayName: "Tobias Thackeray", typeQboId: "S", parentQboId: "FLAT-M1" },
      { qboId: "FLAT-M2", displayName: "Other Member", typeQboId: "M", email: "other@flat.example" },
    ]);
    const m = await seedParentIn({ familyQboId: "FLAT-M1", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "FLAT-M1" });
    expect(await loadMyFamily(ctxOf(m.identity))).toEqual({ name: "Marisol Thackeray", students: null,
      me: { name: "Marisol Thackeray", email: "marisol@flat.example", phone: "512-555-0144", edits: "family" }, rosterReadAt: null });
    // A customer that isn't a member type is not a family in a flat club.
    const notMember = await seedParentIn({ familyQboId: "FLAT-SUB", name: "Tobias Thackeray", email: "tobias@flat.example" });
    expect(await loadMyFamily(ctxOf(notMember.identity))).toBeNull();
  });

  it("takes the parent's own record only from their own link, and only when it sits in their family", async () => {
    const { a, b } = await seedTwoFamilies();
    const link = (sourceQboId: string | null) => db.update(guardian).set({ sourceQboId }).where(eq(guardian.id, a.identity.guardianId));
    const me = async (identity = a.identity) => {
      const got = await loadMyFamily(ctxOf(identity));
      for (const marker of b.markers) expect(JSON.stringify(got)).not.toContain(marker);
      return got!.me;
    };
    expect(await me()).toMatchObject({ name: "Ansgar Alderquist" });
    // Family B's parent, family B itself, a student of their own family, an ID that names nothing, a link made by hand.
    for (const source of [FAMILY_B.parent.qboId, FAMILY_B.family.qboId, FAMILY_A.students[0]!.qboId, FAMILY_A.family.qboId, "NO-SUCH-CUSTOMER", null]) {
      await link(source);
      expect(await me(), `a link that names ${source}`).toBeNull();
    }
    // Their own record, inactive: QuickBooks has renamed it, and it is not shown.
    await link(FAMILY_A.parent.qboId);
    await db.update(qboCustomer).set({ active: false, displayName: "Ansgar Alderquist (deleted)" }).where(eq(qboCustomer.qboId, FAMILY_A.parent.qboId));
    expect(await me()).toBeNull();
    // A context that names family B's link, or B's person, beside family A: nothing of B comes back.
    await db.update(qboCustomer).set({ active: true, displayName: "Ansgar Alderquist" }).where(eq(qboCustomer.qboId, FAMILY_A.parent.qboId));
    expect(await me({ ...a.identity, guardianId: b.identity.guardianId })).toBeNull();
    expect(await me({ ...a.identity, parentId: b.identity.parentId })).toBeNull();
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("is null for a family that isn't in the cache, is inactive, or isn't a family: a sign-in made by hand can name any ID", async () => {
    const a = await seedSignedInParent();
    for (const familyQboId of ["NOT-IN-QUICKBOOKS", FAMILY_A.students[0]!.qboId, FAMILY_A.parent.qboId]) {
      const p = await seedParentIn({ familyQboId, name: "Hand Made", email: `hand.made.${familyQboId.toLowerCase()}@example.com` });
      expect(await loadMyFamily(ctxOf(p.identity)), familyQboId).toBeNull();
    }
    await db.update(qboCustomer).set({ active: false, displayName: "Alderquist Family (deleted)" }).where(eq(qboCustomer.qboId, FAMILY_A.family.qboId));
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
  });

  it("shows nothing of a cache read from another company while QuickBooks is connected, as the staff roster does", async () => {
    const a = await seedSignedInParent();
    await seedConnected(stub, { realmId: REALM });
    // Connected, and the cache doesn't say which company it came from (seedSignedInParent() says it was read from REALM).
    await db.delete(setting).where(eq(setting.key, "roster.source"));
    await seedRosterRead();
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
    expect((await loadRosterPage()).roster).toBeNull();
    // It says another company.
    await seedRosterRead({ realmId: OTHER_REALM });
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
    expect((await loadRosterPage()).roster).toBeNull();
    // It says the connected company.
    await seedRosterRead({ realmId: REALM });
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ name: "Alderquist Family" });
    expect((await loadRosterPage()).roster).not.toBeNull();
  });

  it("still shows the last roster when QuickBooks is disconnected", async () => {
    const a = await seedSignedInParent();
    await seedConnected(stub, { realmId: REALM });
    const readAt = await seedRosterRead({ realmId: OTHER_REALM });
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null, accessTokenCiphertext: null, accessTokenKeyId: null });
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ name: "Alderquist Family", rosterReadAt: readAt.toISOString() });
    expect((await loadRosterPage()).roster).not.toBeNull();
  });

  it("shows nothing when there is no membership shape, or it names a customer type QuickBooks no longer has", async () => {
    const a = await seedSignedInParent();
    await seedRosterRead();
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "GONE", parentTypeId: "P" });
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
    expect((await loadRosterPage()).roster).toBeNull();
    await seedShape({ kind: "flat", memberTypeIds: ["F", "GONE"] });
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
    await db.delete(setting).where(eq(setting.key, "membership.shape"));
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
    expect((await loadRosterPage()).roster).toBeNull();
  });
});

describe("Home", () => {
  it("greets the parent and shows the family's name, its students and the parent's own details", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("Hi, Ansgar</h1>");
    expect(html).toContain("Alderquist Family</h2>");
    expect(html).toContain("Your students");
    for (const name of A_STUDENTS) expect(html).toContain(`<b>${name}</b>`);
    expect(html).toContain("Your details");
    expect(html).toContain(`<dt>Name</dt><dd>Ansgar Alderquist</dd><dt>Email</dt><dd>${FAMILY_A.parent.email}</dd><dt>Phone</dt><dd class="num">${FAMILY_A.parent.phone}</dd>`);
    expect(html).toContain("Ask the club");
    for (const name of B_STUDENTS) expect(html).not.toContain(name);
    for (const marker of b.markers) expect(html).not.toContain(marker);
    // No placeholder, and nothing that has no data yet: no forms counts, no part or grade. (The season is
    // tests/integration/seasons-parent.test.ts.)
    expect(html).not.toMatch(/will show here|\bforms\b|grade/i);
    // The roster has not been read by a refresh yet, so the page doesn't say when it was.
    expect(html).not.toContain("roster-asof");
  });

  it("shows what the family owes first, under the family's name, with the way to the Payments page", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    // The season ruler, then the boxes in the order a phone shows them: money, students, details.
    expect([...html.matchAll(/<section class="([^"]+)"/g)].map((m) => m[1])).toEqual(["season", "box money", "box students-box", "box details-box"]);
    expect(html).toContain(`<section class="box money" aria-labelledby="money-h"><h2 id="money-h">Alderquist Family</h2>`);
    // The family's name stands once, as that heading (the Display link's label and the details hold the parent's own name).
    expect(html.split("Alderquist Family")).toHaveLength(2);
    expect(html).toContain(`<div class="amt num">$14,283.16</div>`);
    expect(html).toMatch(/Owed now\. From QuickBooks, as of <time/);
    for (const words of moneyMarkers(FAMILY_A, "open")) expect(html).toContain(words);
    expect(html).toContain(`href="https://connect.intuit.com/t/scs-v1-alderquist-7101"`);
    // What was paid is on the Payments page, which the box leads to.
    expect(html).not.toContain("INV-ALDERQUIST-7103");
    expect(html).toContain(`<a class="btn btn-line" href="/payments">See your payments</a>`);
    for (const marker of b.markers) expect(html).not.toContain(marker);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("with no figures to show, the money box says so calmly and the rest of the page is as it was", async () => {
    const a = await seedSignedInParent();
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<h2 id="money-h">Alderquist Family</h2><p class="help" role="status">We can&#x27;t show what you owe right now. Please check back in a little while.</p>`);
    expect(html).toContain("Your students");
    expect(html).toContain("Your details");
    expect(stub.apiCalls()).toEqual([]);
  });

  it("shows no money for a family the roster may not show: not in the cache, or a cache from another company", async () => {
    await seedShape();
    const stray = await seedParentIn({ familyQboId: "NOT-IN-QUICKBOOKS", name: "Hester Handmade", email: "hester@handmade.example" });
    // Figures stored under that id are not shown either: the page says only that the family isn't set up yet.
    await seedFamilyMoney({ ...FAMILY_B, family: { qboId: "NOT-IN-QUICKBOOKS", name: "Nobody" } });
    asParent(stray.identity);
    let html = await renderPage(ParentHome);
    expect(html).toContain(NOT_SET_UP);
    expect(html).not.toMatch(/class="box money"|owe|INV-|\$\d/);

    await resetDb();
    const { a } = await seedTwoFamilies();
    await seedConnected(stub, { realmId: OTHER_REALM });
    asParent(a.identity);
    html = await renderPage(ParentHome);
    expect(html).toContain(NOT_SET_UP);
    expect(html).not.toMatch(/class="box money"|owe|INV-|\$\d/);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("sends a visitor with no session to sign in, and has no return address to carry: Home is where everyone lands", async () => {
    expect(await pageOutcome(ParentHome)).toEqual({ redirect: "/sign-in" });
    expect(await pageOutcome(FamilyPage)).toEqual({ redirect: "/sign-in?next=%2Ffamily" });
  });

  it("says how to change the details: the treasurer's address when the club has set one", async () => {
    const a = await seedSignedInParent();
    await setTreasurer("treasurer@club.example");
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`Email the treasurer at <a href="mailto:treasurer@club.example">treasurer@club.example</a>`);
    expect(html).not.toContain("Ask the club");
  });

  it("says when the roster was last read, once it has been", async () => {
    const a = await seedSignedInParent();
    const readAt = await seedRosterRead();
    asParent(a.identity);
    expect(await renderPage(ParentHome)).toMatch(new RegExp(`QuickBooks, as of <time datetime="${readAt.toISOString()}"`, "i"));
  });

  it("records nothing: a parent viewing their own family is not audited", async () => {
    const a = await seedSignedInParent();
    asParent(a.identity);
    await renderPage(ParentHome);
    await renderPage(FamilyPage);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("layered with no student type: no students box, and no guess at who the students are", async () => {
    const a = await seedSignedInParent();
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: "P" });
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("Alderquist Family");
    expect(html).toContain("Your details");
    expect(html).not.toContain("Your students");
    for (const name of A_STUDENTS) expect(html).not.toContain(name);
  });

  it("layered with no parent type: the family customer's record is the details, and a household is greeted without a name", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([fam("NP-FAM", "Noparent Family", { email: "home@noparent.example", phone: "512-555-0199" }), stu("NP-S1", "Nico Noparent", "NP-FAM")]);
    const p = await seedParentIn({ familyQboId: "NP-FAM", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "NP-FAM" });
    asParent(p.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<h1 class="page-title">Hi</h1>`);
    expect(html).toContain("<b>Nico Noparent</b>");
    expect(html).toContain(`<dd class="num">512-555-0199</dd>`);
  });

  it("flat: the member's own record, and no students box", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([
      { qboId: "FLAT-M1", displayName: "Thackeray, Marisol", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "FLAT-SUB", displayName: "Tobias Thackeray", typeQboId: "S", parentQboId: "FLAT-M1" },
    ]);
    const m = await seedParentIn({ familyQboId: "FLAT-M1", name: "Thackeray, Marisol", email: "marisol@flat.example", sourceQboId: "FLAT-M1" });
    asParent(m.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toContain("Thackeray, Marisol");
      expect(html).toContain(`<dd class="num">512-555-0144</dd>`);
      expect(html).not.toContain("Your students");
      expect(html).not.toContain("Tobias");
    }
    expect(await renderPage(ParentHome)).toContain("Hi, Marisol</h1>");
  });

  it("a sign-in with no QuickBooks record shows the name and address the portal knows, and no phone", async () => {
    await seedShape();
    await addToCache([fam("HM-FAM", "Handmade Family"), stu("HM-S1", "Hugo Handmade", "HM-FAM")]);
    const p = await seedParentIn({ familyQboId: "HM-FAM", name: "Hester Handmade", email: "hester@handmade.example", phone: "512-555-0111" });
    asParent(p.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("<b>Hugo Handmade</b>");
    expect(html).toContain("<dt>Name</dt><dd>Hester Handmade</dd><dt>Email</dt><dd>hester@handmade.example</dd></dl>");
    expect(html).not.toContain("Phone");
  });

  it("a family with no active student says so, calmly", async () => {
    const a = await seedSignedInParent();
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.typeQboId, "S"));
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("Your students");
    expect(html).toContain("no active students listed for your family");
    for (const name of A_STUDENTS) expect(html).not.toContain(name);
  });

  it("leaves an inactive student out, and never shows QuickBooks' (deleted) name", async () => {
    const a = await seedSignedInParent();
    await db.update(qboCustomer).set({ active: false, displayName: "Azalea Alderquist (deleted)" }).where(eq(qboCustomer.qboId, FAMILY_A.students[1]!.qboId));
    asParent(a.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toContain("<b>Aurelio Alderquist</b>");
      expect(html).not.toContain("Azalea");
      expect(html).not.toContain("deleted");
    }
  });

  it("a family that isn't in the roster doesn't crash: both pages say the club hasn't finished setting it up", async () => {
    await seedShape();
    await setTreasurer("treasurer@club.example");
    const p = await seedParentIn({ familyQboId: "NOT-IN-QUICKBOOKS", name: "Hester Handmade", email: "hester@handmade.example" });
    asParent(p.identity);
    const home = await renderPage(ParentHome);
    expect(home).toContain("Hi, Hester</h1>");
    expect(home).toContain(NOT_SET_UP);
    expect(home).toContain(`<a href="mailto:treasurer@club.example">`);
    expect(home).not.toMatch(/Your students|Your details|NOT-IN-QUICKBOOKS|Family account/);
    const family = await renderPage(FamilyPage);
    expect(family).toContain(NOT_SET_UP);
    expect(family).toContain("Your account");
    expect(family).toContain("<dd>hester@handmade.example</dd>");
    expect(family).not.toMatch(/Your students|Your details|NOT-IN-QUICKBOOKS|Family account/);
  });

  it("a cache from another company shows none of it, and the same calm words", async () => {
    const a = await seedSignedInParent();
    await seedConnected(stub, { realmId: REALM });
    await seedRosterRead({ realmId: OTHER_REALM });
    asParent(a.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toContain(NOT_SET_UP);
      // The session's own name is still there; nothing from the cache is.
      for (const cached of ["Alderquist Family", ...A_STUDENTS, FAMILY_A.parent.phone, "as of", "QuickBooks"]) expect(html, cached).not.toContain(cached);
    }
    await seedRosterRead({ realmId: REALM });
    expect(await renderPage(ParentHome)).toContain("<b>Aurelio Alderquist</b>");
  });

  it("writes hostile QuickBooks text as text, never as markup or an address", async () => {
    const IMG = "<img src=x onerror=alert(1)>", SCRIPT = "<script>alert(2)</script>";
    await seedShape();
    await addToCache([
      fam("H-FAM", `${IMG} Family`),
      par("H-PAR", `Hana ${SCRIPT}`, "H-FAM", `hana@hostile.example"><b>bold</b>`, { phone: `555<svg onload=alert(3)>` }),
      stu("H-STU", `Hal ${IMG}`, "H-FAM"),
    ]);
    const p = await seedParentIn({ familyQboId: "H-FAM", name: `Hana ${SCRIPT}`, email: "hana@hostile.example", sourceQboId: "H-PAR" });
    asParent(p.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Family");
      expect(html).toContain("<b>Hal &lt;img src=x onerror=alert(1)&gt;</b>");
      expect(html).toContain("Hana &lt;script&gt;alert(2)&lt;/script&gt;");
      expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
      expect(html).toContain("555&lt;svg onload=alert(3)&gt;");
      expect(html).not.toMatch(/<img|<script|<svg|<b>bold/);
      // The QuickBooks address is text, not a link.
      expect(html).not.toContain("mailto:hana");
    }
    const frame = await renderPage(ParentLayout, { children: createElement("main", null, "the page") });
    expect(frame).not.toMatch(/<img|<script>alert/);
  });
});

describe("Family", () => {
  it("shows the same students and details, and the account the portal signs the parent in with", async () => {
    const { a, b } = await seedTwoFamilies();
    const readAt = await seedRosterRead();
    asParent(a.identity);
    const html = await renderPage(FamilyPage);
    expect(html).toContain(`<h1 class="page-title">Alderquist Family</h1>`);
    for (const name of A_STUDENTS) expect(html).toContain(`<b>${name}</b>`);
    expect(html).toContain(`<dd class="num">${FAMILY_A.parent.phone}</dd>`);
    expect(html).toContain("Your account");
    expect(html).toContain(`How you sign in to the portal</p><dl class="details"><dt>Name</dt><dd>Ansgar Alderquist</dd><dt>Email</dt><dd>${FAMILY_A.parent.email}</dd></dl>`);
    expect(html).toMatch(new RegExp(`QuickBooks, as of <time datetime="${readAt.toISOString()}"`, "i"));
    // One family: nothing about switching.
    expect(html).not.toMatch(/Your families|choose-family/);
    for (const marker of b.markers) expect(html).not.toContain(marker);
  });

  it("a person in more than one family is offered Switch family, and only the family being viewed is named", async () => {
    const a = await seedSignedInParent();
    await addToCache([fam("CEDAR-FAM", "Cedarholm Family"), par("CEDAR-P1", "Ansgar Alderquist", "CEDAR-FAM", FAMILY_A.parent.email), stu("CEDAR-S1", "Cosima Cedarholm", "CEDAR-FAM")]);
    await seedGuardian({ parentId: a.identity.parentId, familyQboId: "CEDAR-FAM", status: "active", sourceQboId: "CEDAR-P1" });
    const both = await identityNow(a.session.id);
    expect(both.families).toHaveLength(2);
    asParent(both);
    const html = await renderPage(FamilyPage);
    expect(html).toContain("Your families");
    expect(html).toContain("a guardian in 2 families.");
    expect(html).toContain("looking at Alderquist Family now.");
    expect(html).toContain(`<a class="btn btn-line" href="/choose-family">Switch family</a>`);
    for (const page of [html, await renderPage(ParentHome), await renderPage(ParentLayout, { children: createElement("main", null, "the page") })]) {
      expect(page).not.toMatch(/Cedarholm|Cosima|CEDAR-/);
    }
  });

  it("names a family the portal has no name for, among two such, with the same numbered words on the Viewing line as on its chooser button", async () => {
    const a = await seedSignedInParent();
    // Two more families, neither on the roster: their records have no name. They sort after the Alderquist family's
    // customer, so the chooser lists them second and third.
    for (const familyQboId of ["ZZ-UNNAMED-1", "ZZ-UNNAMED-2"]) await seedGuardian({ parentId: a.identity.parentId, familyQboId, status: "active" });
    await syncAppRecords();
    await db.update(parentAuthSession).set({ familyQboId: "ZZ-UNNAMED-2" }).where(eq(parentAuthSession.id, a.session.id));
    const who = await identityNow(a.session.id);
    expect(who.families.map((f) => f.familyQboId)).toEqual([FAMILY_A.family.qboId, "ZZ-UNNAMED-1", "ZZ-UNNAMED-2"]);
    asParent(who);
    const unknown = recordNameWords(null, "family").replaceAll("'", "&#x27;");
    const chooser = await renderPage(ChooseFamily);
    expect(chooser).toContain(">Alderquist Family</button>");
    expect(chooser).toContain(`>${unknown} (1)</button>`);
    // The family being viewed is the third: its button is marked current, and reads "(2)".
    expect(chooser).toContain(`aria-current="true">${unknown} (2)</button>`);
    const frame = await renderPage(ParentLayout, { children: createElement("main", null, "the page") });
    expect(frame).toContain(`Viewing ${unknown} (2). `);
    expect(frame).not.toContain(`${unknown} (1)`);
    expect(frame).not.toMatch(/ZZ-UNNAMED/);
  });
});

describe("what surrounds the parent pages", () => {
  const frame = () => renderPage(ParentLayout, { children: createElement("main", null, "the page") });
  /** The links in one of the navs, in order, and whether each is marked as the page that is open. */
  const links = (html: string, nav: string) => [...(new RegExp(`<nav class="${nav}"[^>]*>([\\s\\S]*?)</nav>`).exec(html)?.[1] ?? "").matchAll(/<a ([^>]*)>/g)]
    .map((m) => ({ href: /href="([^"]*)"/.exec(m[1]!)?.[1], current: /aria-current="page"/.test(m[1]!) }));
  const account = (html: string) => /<a ([^>]*class="account"[^>]*)>/.exec(html)?.[1] ?? "";

  it("lists only the pages that exist, in the tabs and in the top nav", async () => {
    const a = await seedSignedInParent();
    asParent(a.identity);
    const html = await frame();
    for (const nav of ["tabs", "top-nav"]) expect(links(html, nav), nav).toEqual([{ href: "/", current: true }, { href: "/forms", current: false }, { href: "/payments", current: false }, { href: "/volunteer", current: false }, { href: "/family", current: false }]);
  });

  it("marks the tab of the page that is open, and the account control on the Display page", async () => {
    const a = await seedSignedInParent();
    asParent(a.identity);
    atPath("/family");
    let html = await frame();
    for (const nav of ["tabs", "top-nav"]) expect(links(html, nav), nav).toEqual([{ href: "/", current: false }, { href: "/forms", current: false }, { href: "/payments", current: false }, { href: "/volunteer", current: false }, { href: "/family", current: true }]);
    expect(account(html)).toContain(`href="/display"`);
    expect(account(html)).not.toContain("aria-current");
    atPath("/display");
    html = await frame();
    expect(account(html)).toContain(`aria-current="page"`);
    for (const nav of ["tabs", "top-nav"]) expect(links(html, nav), nav).toEqual([{ href: "/", current: false }, { href: "/forms", current: false }, { href: "/payments", current: false }, { href: "/volunteer", current: false }, { href: "/family", current: false }]);
  });

  it("the not-found page keeps the club bar and the tabs for a signed-in parent, and is plain for anyone else", async () => {
    const { a, b } = await seedTwoFamilies();
    const READY = "We can&#x27;t find that page";
    asParent(a.identity);
    const signedIn = await renderPage(NotFound);
    expect(signedIn).toContain(READY);
    expect(signedIn).toContain(`<header class="bar">`);
    expect(signedIn).toContain(`<nav class="tabs"`);
    expect(signedIn).toContain("Your account and display settings, Ansgar Alderquist");
    for (const marker of b.markers) expect(signedIn).not.toContain(marker);

    asParentChoosing(a.identity);
    const choosing = await renderPage(NotFound);
    expect(choosing).toContain(READY);
    expect(choosing).not.toMatch(/class="bar"|class="tabs"|Ansgar|Alderquist/);
  });

  it("the not-found page shows a visitor with no session nothing but its words", async () => {
    await seedTwoFamilies();
    const html = await renderPage(NotFound);
    expect(html).toContain("We can&#x27;t find that page");
    // True for every cause, and never that the page is still to be built: every parent page is.
    expect(html).toContain("The link may be out of date");
    expect(html).toContain("ask the person running the shift");
    expect(html).not.toMatch(/ready yet|still building/);
    expect(html).not.toMatch(/class="bar"|class="tabs"|Alderquist|Brackenmoor/);
  });
});
