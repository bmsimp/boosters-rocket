import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// The page shows the portal's own details (stage 3's slice 11a) and asks QuickBooks nothing: the stub is connected so a
// request that was sent would be seen, never reach Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, qboConnection, qboCustomer, setting } from "@/lib/db/schema";
import { CONTACT_FIELDS } from "@/lib/parents/contact-fields";
import ParentHome from "@/app/(parent)/page";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import { seedContactFamilies, setFamilyDetails, setPersonDetails } from "../helpers/contact";
import { resetDb } from "../helpers/db";
import { CHENOWETH, RIVERA } from "../helpers/money";
import { PERSON_ADDRESS, seedParentIn, seedTwoFamilies } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, storeShape } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const [R_FAMILY, R_PARENT] = [RIVERA.family.qboId, RIVERA.parent.qboId];
const LINK = `<a class="btn btn-line" href="/family/details">Update my details</a>`;
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));
const field = (name: string, value: string) => new RegExp(`<input [^>]*name="${name}" value="${value}"/>`);

describe("the page where a parent changes their phone and address", () => {
  it("shows the portal's own details in a form that holds no id, says nothing of the club's books, and reading it is not audited", async () => {
    const { r, c } = await seedContactFamilies(stub);
    await setPersonDetails(r.identity.parentId, { line1: "12 Heron Lane", city: "Austin", region: "TX", postalCode: "78745" }, 2);
    // What QuickBooks and the cache hold of their record is not what the page shows.
    await db.update(qboCustomer).set({ phone: "512-555-0777" }).where(eq(qboCustomer.qboId, R_PARENT));
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain('<h1 class="page-title">Update your details</h1>');
    expect(html).toContain("These are the details the club uses to reach you.");
    expect(html).not.toMatch(/club&#x27;s books|QuickBooks/);
    expect(html).toContain(`<dt>Name</dt><dd>${RIVERA.parent.name}</dd><dt>Email</dt><dd>${RIVERA.parent.email}</dd></dl>`);
    // Their sign-in email is theirs to change too (tests/integration/email-change.test.ts), from its own page.
    expect(html).toContain("You can change your sign-in email below. To change your name, ask the club.");
    expect(html).toContain(`<a class="btn btn-line" href="/family/email">Change my sign-in email</a>`);
    expect(html).toMatch(field("phone", RIVERA.parent.phone));
    expect(html).toMatch(field("line1", "12 Heron Lane"));
    expect(html).toMatch(field("line2", ""));
    expect(html).toMatch(field("city", "Austin"));
    expect(html).toMatch(field("region", "TX"));
    expect(html).toMatch(field("postalCode", "78745"));
    expect(html).toMatch(field("country", ""));
    for (const { name, label, max } of CONTACT_FIELDS) { expect(html).toContain(`<label class="field-label" for="contact-${name}">${label}`); expect(html).toContain(`maxLength="${max}"`); }
    expect(html).toContain("Address line 2 (optional)");
    expect(html).toContain(">Save my details</button>");
    expect(html).toContain(`<a class="btn btn-line" href="/family">Back to Family</a>`);
    expect(html).not.toContain("512-555-0777"); // the cache's number
    // Whose details they are stays on the server: no id is in the page, and nothing of the other family.
    expect([...html.matchAll(/<input [^>]*>/g)].map((m) => /name="([^"]*)"/.exec(m[0])?.[1])).toEqual(CONTACT_FIELDS.map((f) => f.name));
    for (const id of [R_PARENT, R_FAMILY, r.identity.parentId, String(r.identity.familyId), ...RIVERA.students.map((s) => s.qboId)]) expect(html).not.toContain(id);
    for (const marker of c.markers) expect(html, marker).not.toContain(marker);
    // Nothing asked of QuickBooks, and no audit row for looking at their own details.
    expect(stub.apiCalls()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("names the treasurer for a change of name or email when the club has set one", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.insert(setting).values({ key: "club", value: { name: "Test Boosters", shortName: "TB", color: "#5b2a86", treasurerEmail: "treasurer@club.example" } });
    asParent(r.identity);
    expect(await renderPage(FamilyDetailsPage)).toContain(`To change your name, ask the treasurer at <a href="mailto:treasurer@club.example">treasurer@club.example</a>.`);
    // While parent sign-ins are off, the email is the club's to change as well.
    await seedParentSettings({ signin: false });
    expect(await renderPage(FamilyDetailsPage)).toContain(`To change your name or email, ask the treasurer at <a href="mailto:treasurer@club.example">treasurer@club.example</a>.`);
  });

  it.each([
    ["QuickBooks can't be reached", async () => { stub.dropApi = true; }],
    ["QuickBooks was disconnected", async () => { await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null, accessTokenCiphertext: null, accessTokenKeyId: null }); }],
    ["there is no membership shape", async () => { await db.delete(setting).where(eq(setting.key, "membership.shape")); }],
    ["their QuickBooks record is inactive", async () => { await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, R_PARENT)); }],
  ] as [string, () => Promise<void>][])("when %s: the form is there all the same, with the portal's own details", async (_what, arrange) => {
    const { r, c } = await seedContactFamilies(stub);
    await arrange();
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toMatch(field("phone", RIVERA.parent.phone));
    expect(html).toContain(">Save my details</button>");
    for (const marker of c.markers) expect(html, marker).not.toContain(marker);
    expect(stub.apiCalls()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("the two standard families each get their own details, and none of the other's", async () => {
    const { a, b } = await seedTwoFamilies();
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      asParent(mine.identity);
      const html = await renderPage(FamilyDetailsPage);
      const address = PERSON_ADDRESS[mine.spec.parent.qboId]!;
      expect(html).toMatch(field("phone", mine.spec.parent.phone));
      expect(html).toMatch(field("line1", address.line1));
      expect(html).toMatch(field("city", address.city));
      for (const marker of theirs.markers) expect(html, marker).not.toContain(marker);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("a guardian staff added, with no QuickBooks record of their own, gets the form with their own details", async () => {
    await seedContactFamilies(stub);
    const added = await seedParentIn({ familyQboId: R_FAMILY, name: "Hollis Handmade", email: "hollis.handmade@family-r.example", phone: "512-555-0123" });
    asParent(added.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain(`<dt>Name</dt><dd>Hollis Handmade</dd><dt>Email</dt><dd>hollis.handmade@family-r.example</dd>`);
    expect(html).toMatch(field("phone", "512-555-0123"));
    expect(html).toContain(">Save my details</button>");
    // Nothing of the family's own parent, whose details these are not.
    expect(html).not.toContain(RIVERA.parent.name);
    expect(html).not.toContain(RIVERA.parent.phone);
    expect(stub.calls).toHaveLength(0);
  });

  it("books with no parent type: the family's details, said to be shared, under a heading that says whose", async () => {
    const { r } = await seedContactFamilies(stub);
    await storeShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await setFamilyDetails(r.identity.familyId, { phone: "512-555-0199", line1: "4 Riverside Way" });
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain("Every parent in your family shares these details, so a change here changes them for all of you.");
    expect(html).toContain("Your family&#x27;s phone and mailing address</h2>");
    expect(html).toMatch(field("phone", "512-555-0199"));
    expect(html).toMatch(field("line1", "4 Riverside Way"));
    expect(html).not.toContain(RIVERA.parent.phone); // the person's own phone, not theirs to share
  });

  it("a family the portal may not show gets the not-set-up box, and no form", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.update(family).set({ active: false }).where(eq(family.id, r.identity.familyId));
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain("set up here yet");
    expect(html).not.toMatch(/<form\b|<input\b/);
    expect(html).not.toContain(RIVERA.parent.phone);
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("Your details, on Family and on Home", () => {
  it("links to the edit page, with no id in the link, and shows the portal's own phone", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    // Both say the sign-in email is theirs to change too: Family offers it in the box below, Home sends them to Family.
    const words = new Map([[FamilyPage, "You can change your phone, mailing address and sign-in email below. To change your name,"],
      [ParentHome, "You can change your phone, mailing address and sign-in email on your Family page. To change your name,"]]);
    for (const [page, said] of words) {
      const html = await renderPage(page);
      expect(html).toContain(`<dt>Phone</dt><dd class="num">${RIVERA.parent.phone}</dd>`);
      expect(html).toContain(`<p class="help">${said} ask the club.</p><div class="box-foot">${LINK}</div></section>`);
      expect(html).not.toContain("roster-asof");
    }
  });

  it("links for a guardian staff added with no QuickBooks record too", async () => {
    await seedContactFamilies(stub);
    const added = await seedParentIn({ familyQboId: R_FAMILY, name: "Hollis Handmade", email: "hollis.handmade@family-r.example" });
    asParent(added.identity);
    for (const page of [FamilyPage, ParentHome]) {
      const html = await renderPage(page);
      expect(html).toContain(LINK);
      // On Family the sign-in email is in Your account, once on the page; Home's details box shows it.
      if (page === FamilyPage) expect(html).toContain("<dt>Name</dt><dd>Hollis Handmade</dd></dl>");
      else expect(html).toContain("<dt>Name</dt><dd>Hollis Handmade</dd><dt>Email</dt><dd>hollis.handmade@family-r.example</dd></dl>");
      expect(html.match(/<dd>hollis\.handmade@family-r\.example<\/dd>/g)).toHaveLength(1);
    }
  });

  it("says the family's phone and address are the parent's to change in books with no parent type", async () => {
    const { r } = await seedContactFamilies(stub);
    await storeShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await setFamilyDetails(r.identity.familyId, { phone: "512-555-0199" });
    asParent(r.identity);
    const html = await renderPage(FamilyPage);
    expect(html).toContain("You can change your family&#x27;s phone and mailing address, and your sign-in email below.");
    // The phone is the family's, beside the person's own name and email: said so.
    expect(html).toContain(`<dt>Family phone</dt><dd class="num">512-555-0199</dd>`);
    expect(html).not.toContain("<dt>Phone</dt>");
    expect(html).toContain(LINK);
  });

  it("each family's parent sees their own phone, and none of the other's", async () => {
    const { c } = await seedContactFamilies(stub);
    asParent(c.identity);
    const html = await renderPage(FamilyPage);
    expect(html).toContain(LINK);
    expect(html).toContain(CHENOWETH.parent.phone);
    expect(html).not.toContain(RIVERA.parent.phone);
  });
});
