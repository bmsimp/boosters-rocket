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
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parent, parentAuthSession, qboConnection, qboCustomer, setting } from "@/lib/db/schema";
import { resolveParentSession } from "@/lib/auth/resolve";
import { recordNameWords } from "@/lib/families/words";
import type { ParentIdentity } from "@/lib/auth/resolve";
import type { ParentCtx } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { loadRosterPage } from "@/lib/roster/queries";
import { getRosterSource } from "@/lib/roster/source";
import ParentHome from "@/app/(parent)/page";
import FamilyPage from "@/app/(parent)/family/page";
import ParentLayout from "@/app/(parent)/layout";
import NotFound from "@/app/not-found";
import ChooseFamily from "@/app/choose-family/page";
import { resetDb, seedGuardian, seedParent, seedParentSession } from "../helpers/db";
import { FAMILY_A, FAMILY_B, identityAfterChoosingAgain, identityNow, moneyMarkers, seedParentIn, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { addToCache, fam, par, seedRosterRead, seedShape, stu } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";

const REALM = "9130000000000001", OTHER_REALM = "9130000000000002";
const ctxOf = (identity: ParentIdentity): ParentCtx => ({ ...identity, ip: null });
const A_STUDENTS = FAMILY_A.students.map((s) => s.name), B_STUDENTS = FAMILY_B.students.map((s) => s.name);
const setTreasurer = (treasurerEmail: string) => db.insert(setting).values({ key: "club", value: { name: "Test Boosters", shortName: "TB", color: "#5b2a86", treasurerEmail } });
const NOT_SET_UP = "set up here yet";
/** What a family with no link to the club's books reads where its money would be (as React writes the apostrophe). */
const NOT_CONNECTED = "The club hasn&#x27;t connected your payments to the portal yet.";
/** A person whose one link names `familyQboId`, with a session that chose it, and the records brought into step: what the gate makes of them. */
async function gateOf(familyQboId: string, email: string) {
  const person = await seedParent({ name: "Hand Made", email, welcomedAt: new Date() });
  await seedGuardian({ parentId: person.id, familyQboId, status: "active" });
  await syncAppRecords();
  // The session stores the row's own family record, as the sign-in does; with no roster company there is none.
  const [row] = await db.select({ familyId: guardian.familyId }).from(guardian).where(eq(guardian.parentId, person.id));
  const session = await seedParentSession(person.authUserId, { familyId: row?.familyId ?? null });
  return resolveParentSession({ id: session.id, userId: person.authUserId, familyId: row?.familyId ?? null });
}

// Nothing here reaches Intuit: the stub is what seedConnected() needs to write a connection row, and what a read of a
// family's invoices would be sent to (the families here have ids QuickBooks never gives, so none is sent).
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

describe("loadMyFamily: one family from the app's own records, for its own parent", () => {
  it("returns the family's name, its students by name, and the parent's name, sign-in address and phone as the portal holds them", async () => {
    const { a, b } = await seedTwoFamilies();
    await seedRosterRead();
    expect(await loadMyFamily(ctxOf(a.identity))).toEqual({
      name: "Alderquist Family",
      // Each student by their own app record, the id Home matches a standing by, and no QuickBooks id.
      students: [{ id: await recordOfCustomer(FAMILY_A.students[0]!.qboId, "student"), name: "Aurelio Alderquist" },
        { id: await recordOfCustomer(FAMILY_A.students[1]!.qboId, "student"), name: "Azalea Alderquist" }],
      me: { name: "Ansgar Alderquist", email: FAMILY_A.parent.email, phone: FAMILY_A.parent.phone, edits: "own" },
    });
    // Each parent gets their own family and not a string of the other's.
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      const got = JSON.stringify(await loadMyFamily(ctxOf(mine.identity)));
      expect(got).toContain(mine.spec.family.name);
      for (const marker of theirs.markers) expect(got).not.toContain(marker);
    }
  });

  it("shows the phone the portal holds for the person, whatever the roster cache holds of their record (stage 3's slice 11a)", async () => {
    const a = await seedSignedInParent();
    await db.update(qboCustomer).set({ phone: "512-555-0999" }).where(eq(qboCustomer.qboId, FAMILY_A.parent.qboId));
    expect((await loadMyFamily(ctxOf(a.identity)))!.me).toEqual({ name: "Ansgar Alderquist", email: FAMILY_A.parent.email, phone: FAMILY_A.parent.phone, edits: "own" });
    await db.update(parent).set({ phone: null }).where(eq(parent.id, a.identity.parentId));
    expect((await loadMyFamily(ctxOf(a.identity)))!.me).toEqual({ name: "Ansgar Alderquist", email: FAMILY_A.parent.email, phone: null, edits: "own" });
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
    await syncAppRecords();
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ students: [] });
  });

  it("with no parent type, the details are the family's, shared by every guardian of it", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([fam("NP-FAM", "Noparent Family", { email: "home@noparent.example, work@noparent.example", phone: "512-555-0199" }), stu("NP-S1", "Nico Noparent", "NP-FAM"),
      par("NP-P1", "Nora Noparent", "NP-FAM", "nora@noparent.example")]);
    const fromFamily = await seedParentIn({ familyQboId: "NP-FAM", name: "Noparent Family", email: "home@noparent.example", phone: "512-555-0101", sourceQboId: "NP-FAM" });
    await db.update(family).set({ phone: "512-555-0199" }).where(eq(family.id, fromFamily.identity.familyId));
    // The person's own phone is not shown: in books with no parent type the family's is the one they share.
    expect(await loadMyFamily(ctxOf(fromFamily.identity))).toEqual({ name: "Noparent Family", students: [{ id: await recordOfCustomer("NP-S1", "student"), name: "Nico Noparent" }],
      me: { name: "Noparent Family", email: "home@noparent.example", phone: "512-555-0199", edits: "family" } });
    // Another guardian of the family, whatever record their row names, shares them.
    const other = await seedParentIn({ familyQboId: "NP-FAM", name: "Nora Noparent", email: "nora@noparent.example", sourceQboId: "NP-P1" });
    expect((await loadMyFamily(ctxOf(other.identity)))!.me).toEqual({ name: "Nora Noparent", email: "nora@noparent.example", phone: "512-555-0199", edits: "family" });
  });

  it("in a flat club the member is its own family: its own record, no students, nothing under it", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([
      { qboId: "FLAT-M1", displayName: "Marisol Thackeray", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "FLAT-SUB", displayName: "Tobias Thackeray", typeQboId: "S", parentQboId: "FLAT-M1" },
      { qboId: "FLAT-M2", displayName: "Other Member", typeQboId: "M", email: "other@flat.example" },
    ]);
    const m = await seedParentIn({ familyQboId: "FLAT-M1", name: "Marisol Thackeray", email: "marisol@flat.example", sourceQboId: "FLAT-M1" });
    // The member's details are the family's own record's: none until the take-in or a guardian sets them.
    expect(await loadMyFamily(ctxOf(m.identity))).toEqual({ name: "Marisol Thackeray", students: null,
      me: { name: "Marisol Thackeray", email: "marisol@flat.example", phone: null, edits: "family" } });
    await db.update(family).set({ phone: "512-555-0144" }).where(eq(family.id, m.identity.familyId));
    expect((await loadMyFamily(ctxOf(m.identity)))!.me).toMatchObject({ phone: "512-555-0144", edits: "family" });
    // A customer that isn't a member type is not a family in a flat club: its record is inactive, so nobody is let in to it.
    expect(await gateOf("FLAT-SUB", "tobias@flat.example")).toEqual({ status: "none" });
  });

  it("gives the person their own details whatever record their row names, and none of another family's", async () => {
    const { a, b } = await seedTwoFamilies();
    // The row's own link, pointed at `customerId` (none for null), as a link made by hand might be.
    const link = async (customerId: string | null) => {
      const realmId = (await getRosterSource())!;
      await db.delete(accountingLink).where(eq(accountingLink.guardianId, a.identity.guardianId));
      if (customerId !== null) await db.insert(accountingLink).values({ system: "quickbooks", realmId, customerId, guardianId: a.identity.guardianId, origin: "carried_over" });
    };
    const mine = { name: "Ansgar Alderquist", email: FAMILY_A.parent.email, phone: FAMILY_A.parent.phone, edits: "own" };
    const me = async () => {
      const got = await loadMyFamily(ctxOf(a.identity));
      for (const marker of b.markers) expect(JSON.stringify(got)).not.toContain(marker);
      return got!.me;
    };
    expect(await me()).toEqual(mine);
    // Family B's parent, family B itself, a student of their own family, an ID that names nothing, a link made by hand:
    // the details are the person's own in the portal, so what the row names changes nothing of them.
    for (const source of [FAMILY_B.parent.qboId, FAMILY_B.family.qboId, FAMILY_A.students[0]!.qboId, FAMILY_A.family.qboId, "NO-SUCH-CUSTOMER", null]) {
      await link(source);
      expect(await me(), `a link that names ${source}`).toEqual(mine);
    }
    // Their own record inactive and renamed in the cache: nothing of it is shown.
    await db.update(qboCustomer).set({ active: false, displayName: "Ansgar Alderquist (deleted)", phone: "512-555-0998" }).where(eq(qboCustomer.qboId, FAMILY_A.parent.qboId));
    expect(await me()).toEqual(mine);
    expect(await db.select().from(auditLog)).toEqual([]);
  });

  it("is null for a family whose record is inactive; a sign-in made by hand to a customer that isn't a family is not let in at all", async () => {
    const a = await seedSignedInParent();
    // A link can name any ID: one the cache doesn't hold, a student, a parent. Their records are inactive (or none is a
    // family's), so the gate finds no family to enter (src/lib/auth/resolve.ts).
    for (const familyQboId of ["NOT-IN-QUICKBOOKS", FAMILY_A.students[0]!.qboId, FAMILY_A.parent.qboId]) {
      expect(await gateOf(familyQboId, `hand.made.${familyQboId.toLowerCase()}@example.com`), familyQboId).toEqual({ status: "none" });
    }
    await db.update(qboCustomer).set({ active: false, displayName: "Alderquist Family (deleted)" }).where(eq(qboCustomer.qboId, FAMILY_A.family.qboId));
    await syncAppRecords();
    expect(await loadMyFamily(ctxOf(a.identity))).toBeNull();
  });

  it("shows nothing of a cache read from another company while QuickBooks is connected, as the staff roster does: the records follow the cache's company", async () => {
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
    await seedRosterRead({ realmId: OTHER_REALM });
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null, accessTokenCiphertext: null, accessTokenKeyId: null });
    // The records were made again from that cache's company, so the record the session chose went inactive. No import
    // moves a guardian row (stage 3's slice 12b1), so the row is put in the record of that company by hand, as stage 4's
    // reviewed import would: the gate sends the session to choose again, and it enters the family the row names now.
    await db.update(guardian).set({ familyId: await recordOfCustomer(FAMILY_A.family.qboId, "family") }).where(eq(guardian.id, a.identity.guardianId));
    const now = await identityAfterChoosingAgain(a.session.id);
    expect(await loadMyFamily(ctxOf(now))).toMatchObject({ name: "Alderquist Family", me: { name: "Ansgar Alderquist" } });
    expect((await loadRosterPage()).roster).not.toBeNull();
  });

  it("shows the portal's own details when there is no membership shape, or it names a customer type QuickBooks no longer has: the shape says only whose", async () => {
    const a = await seedSignedInParent();
    await seedRosterRead();
    await db.update(family).set({ phone: "512-555-0177" }).where(eq(family.id, a.identity.familyId));
    // The family, its students and the details are the app's own records, shown whatever the shape; the shape says
    // only whether the books have a parent type, and so whether the details are the person's or the family's.
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "GONE", parentTypeId: "P" });
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ name: "Alderquist Family", me: { phone: FAMILY_A.parent.phone, edits: "own" } });
    expect((await loadRosterPage()).roster).toBeNull();
    await seedShape({ kind: "flat", memberTypeIds: ["F", "GONE"] });
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ name: "Alderquist Family", students: null, me: { phone: "512-555-0177", edits: "family" } });
    await db.delete(setting).where(eq(setting.key, "membership.shape"));
    expect(await loadMyFamily(ctxOf(a.identity))).toMatchObject({ name: "Alderquist Family", students: null, me: { phone: FAMILY_A.parent.phone, edits: "own" } });
    expect((await loadRosterPage()).roster).toBeNull();
  });
});

describe("Home", () => {
  it("is headed with the family's name, and shows its students and the parent's own details", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<h1 class="page-title">Alderquist Family</h1>`);
    expect(html).toContain("Your students");
    for (const name of A_STUDENTS) expect(html).toContain(`<span class="list-title">${name}</span>`);
    expect(html).toContain("Your details");
    expect(html).toContain(`<dt>Name</dt><dd>Ansgar Alderquist</dd><dt>Email</dt><dd>${FAMILY_A.parent.email}</dd><dt>Phone</dt><dd class="num">${FAMILY_A.parent.phone}</dd>`);
    expect(html).toContain("ask the club.");
    for (const name of B_STUDENTS) expect(html).not.toContain(name);
    for (const marker of b.markers) expect(html).not.toContain(marker);
    // No placeholder, and nothing that has no data yet: no forms counts, no part or grade. (The season is
    // tests/integration/seasons-parent.test.ts; a form still to sign is a To do row with the way to the Forms page.)
    expect(html).not.toMatch(/will show here|\d+ forms\b|grade/i);
    // The details are the portal's own: nothing says they came from QuickBooks (stage 3's slice 11a).
    expect(html).not.toContain("roster-asof");
    expect(html).not.toContain("your contact details");
  });

  it("shows what the family owes first, in To do with each invoice's Pay, then the total once, with the way to the Payments page", async () => {
    const { a, b } = await seedTwoFamilies();
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    // The season ruler, the club's messages (A hasn't read the one message seedTwoFamilies() posts), then the sections
    // in the order a phone shows them: To do, the students, the total owed, the details.
    expect([...html.matchAll(/<section class="([^"]+)"/g)].map((m) => m[1])).toEqual(["season", "box home-messages", "home-todo", "home-students", "box money", "box details-box"]);
    // The family's name stands once, as the page's heading (the Display link's label and the details hold the parent's own name).
    expect(html.split("Alderquist Family")).toHaveLength(2);
    // The open invoices are To do's first rows, each with a compact Pay: the soonest-due one primary, the others secondary.
    const todo = html.slice(html.indexOf(`<section class="home-todo"`), html.indexOf(`<section class="home-students"`));
    for (const words of moneyMarkers(FAMILY_A, "open")) expect(html).toContain(words);
    for (const words of moneyMarkers(FAMILY_A, "open").filter((w) => w !== "$14,283.16")) expect(todo).toContain(words);
    expect(todo).toContain(`href="https://connect.intuit.com/t/scs-v1-alderquist-7101"`);
    expect(todo).toMatch(/<a class="btn btn-sm pay" href="https:\/\/connect\.intuit\.com\//);
    // The total is said once, beside its heading, with where and when the figures are from.
    expect(html).toContain(`<section class="box money" aria-labelledby="money-h"><div class="card-head"><div><h2 id="money-h">Total owed</h2></div><div class="card-actions"><span class="amt num">$14,283.16</span></div></div>`);
    expect(html.split("$14,283.16")).toHaveLength(2);
    expect(html).toMatch(/Owed now\. From QuickBooks, as of <time/);
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
    expect(html).toContain(`<h2 id="money-h">What you owe</h2><p class="help" role="status">We can&#x27;t show what you owe right now. Please check back in a little while.</p>`);
    expect(html).toContain("Your students");
    expect(html).toContain("Your details");
    expect(html).not.toContain(NOT_CONNECTED); // a linked family never reads the unlinked family's words
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a family with no link to the club's books: the money box says the club hasn't connected its payments, and the rest of the page is as it was", async () => {
    const a = await seedSignedInParent();
    // From stage 3's later slices a family may have no link; here it is made by hand, and nothing brings it into step after.
    await db.delete(accountingLink).where(eq(accountingLink.familyId, a.identity.familyId));
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<h2 id="money-h">What you owe</h2><p class="help" role="status">${NOT_CONNECTED} Until then, the treasurer can tell you what you owe.</p></section>`);
    expect(html).not.toMatch(/INV-|\$\d|connect\.intuit\.com|See your payments|offline-note|We can&#x27;t show what you owe/);
    // Everything else is the family's own records, as before.
    expect(html).toContain(`<h1 class="page-title">Alderquist Family</h1>`);
    expect(html).toContain("Your students");
    for (const name of A_STUDENTS) expect(html).toContain(`<span class="list-title">${name}</span>`);
    expect(html).toContain("Your details");
    expect(stub.apiCalls()).toEqual([]);
  });

  it("shows no money for a family whose record is inactive, and no figures while QuickBooks is connected to another company", async () => {
    const { a, b } = await seedTwoFamilies();
    // Made inactive some way the reconcile doesn't follow: the page says only that the family isn't set up yet.
    await db.update(family).set({ active: false }).where(eq(family.id, a.identity.familyId));
    asParent(a.identity);
    let html = await renderPage(ParentHome);
    expect(html).toContain(NOT_SET_UP);
    expect(html).not.toMatch(/class="box money"|owe|INV-|\$\d/);

    // Another company connected: the family's link answers nothing there, so no figures are shown or asked for.
    await seedConnected(stub, { realmId: OTHER_REALM });
    asParent(b.identity);
    html = await renderPage(ParentHome);
    expect(html).toContain("We can&#x27;t show what you owe right now.");
    expect(html).not.toContain(NOT_CONNECTED);
    expect(html).not.toMatch(/INV-|\$\d/);
    for (const marker of moneyMarkers(FAMILY_B)) expect(html).not.toContain(marker);
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
    expect(html).toContain(`ask the treasurer at <a href="mailto:treasurer@club.example">treasurer@club.example</a>`);
    expect(html).not.toContain("ask the club");
  });

  it("says nothing of QuickBooks about the details once the roster has been read either: they are the portal's own", async () => {
    const a = await seedSignedInParent();
    await seedRosterRead();
    asParent(a.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).not.toContain("roster-asof");
      expect(html).not.toMatch(/From the club&#x27;s QuickBooks, as of <time[^>]*>[^<]*<\/time>: your contact details/);
    }
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

  it("layered with no parent type: the family's details are shown, under the household's own name", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await addToCache([fam("NP-FAM", "Noparent Family", { email: "home@noparent.example", phone: "512-555-0199" }), stu("NP-S1", "Nico Noparent", "NP-FAM")]);
    const p = await seedParentIn({ familyQboId: "NP-FAM", name: "Noparent Family", email: "home@noparent.example", sourceQboId: "NP-FAM" });
    await db.update(family).set({ phone: "512-555-0199" }).where(eq(family.id, p.identity.familyId));
    asParent(p.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<h1 class="page-title">Noparent Family</h1>`);
    expect(html).not.toContain("Hi,");
    expect(html).toContain(`<span class="list-title">Nico Noparent</span>`);
    expect(html).toContain(`<dd class="num">512-555-0199</dd>`);
  });

  it("flat: the member's own details, and no students box", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([
      { qboId: "FLAT-M1", displayName: "Thackeray, Marisol", typeQboId: "M", email: "marisol@flat.example", phone: "512-555-0144" },
      { qboId: "FLAT-SUB", displayName: "Tobias Thackeray", typeQboId: "S", parentQboId: "FLAT-M1" },
    ]);
    const m = await seedParentIn({ familyQboId: "FLAT-M1", name: "Thackeray, Marisol", email: "marisol@flat.example", sourceQboId: "FLAT-M1" });
    await db.update(family).set({ phone: "512-555-0144" }).where(eq(family.id, m.identity.familyId));
    asParent(m.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toContain("Thackeray, Marisol");
      expect(html).toContain(`<dd class="num">512-555-0144</dd>`);
      expect(html).not.toContain("Your students");
      expect(html).not.toContain("Tobias");
    }
    expect(await renderPage(ParentHome)).toContain(`<h1 class="page-title">Thackeray, Marisol</h1>`);
  });

  it("a guardian with no QuickBooks record sees the details the portal holds for them, and the way to change them", async () => {
    await seedShape();
    await addToCache([fam("HM-FAM", "Handmade Family"), stu("HM-S1", "Hugo Handmade", "HM-FAM")]);
    const p = await seedParentIn({ familyQboId: "HM-FAM", name: "Hester Handmade", email: "hester@handmade.example", phone: "512-555-0111" });
    asParent(p.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain(`<span class="list-title">Hugo Handmade</span>`);
    expect(html).toContain(`<dt>Name</dt><dd>Hester Handmade</dd><dt>Email</dt><dd>hester@handmade.example</dd><dt>Phone</dt><dd class="num">512-555-0111</dd></dl>`);
    expect(html).toContain(`<a class="btn btn-line" href="/family/details">Update my details</a>`);
    // With no phone set, none is shown.
    await db.update(parent).set({ phone: null }).where(eq(parent.id, p.identity.parentId));
    expect(await renderPage(ParentHome)).toContain("<dt>Name</dt><dd>Hester Handmade</dd><dt>Email</dt><dd>hester@handmade.example</dd></dl>");
  });

  it("a family with no active student says so, calmly", async () => {
    const a = await seedSignedInParent();
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.typeQboId, "S"));
    await syncAppRecords();
    asParent(a.identity);
    const html = await renderPage(ParentHome);
    expect(html).toContain("Your students");
    expect(html).toContain("no active students listed for your family");
    for (const name of A_STUDENTS) expect(html).not.toContain(name);
  });

  it("leaves an inactive student out, and never shows QuickBooks' (deleted) name", async () => {
    const a = await seedSignedInParent();
    await db.update(qboCustomer).set({ active: false, displayName: "Azalea Alderquist (deleted)" }).where(eq(qboCustomer.qboId, FAMILY_A.students[1]!.qboId));
    await syncAppRecords();
    asParent(a.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toMatch(/<span class="list-title">Aurelio Alderquist<\/span>/);
      expect(html).not.toContain("Azalea");
      expect(html).not.toContain("deleted");
    }
  });

  it("a family whose record went inactive under a signed-in parent doesn't crash: both pages say the club hasn't finished setting it up", async () => {
    const a = await seedSignedInParent();
    await setTreasurer("treasurer@club.example");
    await db.update(family).set({ active: false }).where(eq(family.id, a.identity.familyId));
    asParent(a.identity);
    const home = await renderPage(ParentHome);
    expect(home).toContain("Hi, Ansgar</h1>");
    expect(home).toContain(NOT_SET_UP);
    expect(home).toContain(`<a href="mailto:treasurer@club.example">`);
    expect(home).not.toMatch(/Your students|Your details|Alderquist Family|Aurelio|Family account/);
    const page = await renderPage(FamilyPage);
    expect(page).toContain(NOT_SET_UP);
    expect(page).toContain("Your account");
    expect(page).toContain(`<dd>${FAMILY_A.parent.email}</dd>`);
    expect(page).not.toMatch(/Your students|Your details|Alderquist Family|Aurelio|Family account/);
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
    expect(await renderPage(ParentHome)).toContain(`<span class="list-title">Aurelio Alderquist</span>`);
  });

  it("writes hostile QuickBooks text as text, never as markup or an address", async () => {
    const IMG = "<img src=x onerror=alert(1)>", SCRIPT = "<script>alert(2)</script>";
    await seedShape();
    await addToCache([
      fam("H-FAM", `${IMG} Family`),
      // The field still holds her address first, so the record is hers (fieldSignsIn()); the rest of it is markup.
      par("H-PAR", `Hana ${SCRIPT}`, "H-FAM", `hana@hostile.example, "><b>bold</b>`, { phone: `555<svg onload=alert(3)>` }),
      stu("H-STU", `Hal ${IMG}`, "H-FAM"),
    ]);
    // Her phone is the portal's own (taken in from that record once): markup there is text too.
    const p = await seedParentIn({ familyQboId: "H-FAM", name: `Hana ${SCRIPT}`, email: "hana@hostile.example", phone: `555<svg onload=alert(3)>`, sourceQboId: "H-PAR" });
    asParent(p.identity);
    for (const page of [ParentHome, FamilyPage]) {
      const html = await renderPage(page);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Family");
      expect(html).toMatch(/<span class="list-title">Hal &lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
      expect(html).toContain("Hana &lt;script&gt;alert(2)&lt;/script&gt;");
      expect(html).toContain("555&lt;svg onload=alert(3)&gt;");
      expect(html).not.toMatch(/<img|<script|<svg onload|<b>bold/);
      // The address is text, not a link, and only her sign-in address is shown: nothing else of the record's email field.
      expect(html).not.toContain("mailto:hana");
      expect(html).not.toContain("bold");
    }
    const frame = await renderPage(ParentLayout, { children: createElement("main", null, "the page") });
    expect(frame).not.toMatch(/<img|<script>alert/);
  });
});

describe("Family", () => {
  it("shows the same students and details, and the account the portal signs the parent in with", async () => {
    const { a, b } = await seedTwoFamilies();
    await seedRosterRead();
    asParent(a.identity);
    const html = await renderPage(FamilyPage);
    expect(html).toContain(`<h1 class="page-title">Alderquist Family</h1>`);
    for (const name of A_STUDENTS) expect(html).toContain(`<span class="list-title">${name}</span>`);
    expect(html).toContain(`<dd class="num">${FAMILY_A.parent.phone}</dd>`);
    expect(html).toContain("Your account");
    // The sign-in email is shown once on the page, in Your account beside how it is used; Your details has the name.
    expect(html).toContain(`<dt>Name</dt><dd>Ansgar Alderquist</dd><dt>Phone</dt>`);
    expect(html.match(/<dt>Email<\/dt>/g)).toHaveLength(1);
    expect(html).toContain(`How you sign in to the portal</p><dl class="details"><dt>Email</dt><dd>${FAMILY_A.parent.email}</dd></dl>`);
    expect(html).not.toContain("roster-asof");
    // One family: nothing about switching.
    expect(html).not.toMatch(/Your families|choose-family/);
    for (const marker of b.markers) expect(html).not.toContain(marker);
  });

  it("a person in more than one family is offered Switch family, and only the family being viewed is named", async () => {
    const a = await seedSignedInParent();
    await addToCache([fam("CEDAR-FAM", "Cedarholm Family"), par("CEDAR-P1", "Ansgar Alderquist", "CEDAR-FAM", FAMILY_A.parent.email), stu("CEDAR-S1", "Cosima Cedarholm", "CEDAR-FAM")]);
    await seedGuardian({ parentId: a.identity.parentId, familyQboId: "CEDAR-FAM", status: "active", sourceQboId: "CEDAR-P1" });
    await syncAppRecords();
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
    // customer, so the chooser lists them second and third. Their records are made active here, as a family the app
    // owns can be with no name known (only an active family is one the chooser offers).
    for (const familyQboId of ["ZZ-UNNAMED-1", "ZZ-UNNAMED-2"]) await seedGuardian({ parentId: a.identity.parentId, familyQboId, status: "active" });
    await syncAppRecords();
    const unnamed = [await recordOfCustomer("ZZ-UNNAMED-1", "family"), await recordOfCustomer("ZZ-UNNAMED-2", "family")];
    await db.update(family).set({ active: true }).where(inArray(family.id, unnamed));
    await db.update(parentAuthSession).set({ familyId: unnamed[1]! }).where(eq(parentAuthSession.id, a.session.id));
    const who = await identityNow(a.session.id);
    expect(who.families.map((f) => String(f.familyId))).toEqual([String(a.identity.familyId), ...unnamed.map(String)]);
    expect(String(who.familyId)).toBe(String(unnamed[1]));
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
