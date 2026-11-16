import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// The edit page reads the parent's own record from QuickBooks as it opens: here that is the stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboConnection, setting } from "@/lib/db/schema";
import { CONTACT_FIELDS } from "@/lib/parents/contact-fields";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import ParentHome from "@/app/(parent)/page";
import FamilyPage from "@/app/(parent)/family/page";
import FamilyDetailsPage from "@/app/(parent)/family/details/page";
import { inQuickBooks, seedContactFamilies } from "../helpers/contact";
import { resetDb } from "../helpers/db";
import { CHENOWETH, RIVERA } from "../helpers/money";
import { seedParentIn, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const [R_FAMILY, R_PARENT] = [RIVERA.family.qboId, RIVERA.parent.qboId];
const CANT_REACH = "We can&#x27;t reach the club&#x27;s books right now, so your details can&#x27;t be changed here just yet. Please try again in a little while.";
const BY_THE_CLUB = "For now, the club makes changes for you.";
const LINK = `<a class="btn btn-line" href="/family/details">Update my details</a>`;
const customerReads = () => stub.apiCalls().filter((c) => /\/customer\/\d+$/.test(c.path)).map((c) => `${c.method} ${c.path.replace(/^\/v3\/company\/\d+/, "")}`);
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));
const field = (name: string, value: string) => new RegExp(`<input [^>]*name="${name}" value="${value}"/>`);

describe("the page where a parent changes their phone and address", () => {
  it("shows them as QuickBooks has them now, in a form that holds no id, and reading it is not audited", async () => {
    const { r, c } = await seedContactFamilies(stub);
    // QuickBooks has moved on since the roster was read: the page shows QuickBooks, not the cache.
    Object.assign(inQuickBooks(stub, R_PARENT), { PrimaryPhone: { FreeFormNumber: "512-555-0777" }, SyncToken: "4" });
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain('<h1 class="page-title">Update your details</h1>');
    expect(html).toContain("Your phone and mailing address, as the club&#x27;s books have them. A change here goes straight to the club.");
    expect(html).toContain(`<dt>Name</dt><dd>${RIVERA.parent.name}</dd><dt>Email</dt><dd>${RIVERA.parent.email}</dd></dl>`);
    // Their sign-in email is theirs to change too (tests/integration/email-change.test.ts), from its own page.
    expect(html).toContain("You can change the email you sign in with yourself. The club changes names. Ask the club and they&#x27;ll update yours.");
    expect(html).toContain(`<a class="btn btn-line" href="/family/email">Change my sign-in email</a>`);
    expect(html).toMatch(field("phone", "512-555-0777"));
    expect(html).toMatch(field("line1", "12 Heron Lane"));
    expect(html).toMatch(field("line2", ""));
    expect(html).toMatch(field("city", "Austin"));
    expect(html).toMatch(field("region", "TX"));
    expect(html).toMatch(field("postalCode", "78745"));
    expect(html).toMatch(field("country", ""));
    for (const { label, max } of CONTACT_FIELDS) { expect(html).toContain(`<span>${label}`); expect(html).toContain(`maxLength="${max}"`); }
    expect(html).toContain("Address line 2 (optional)");
    expect(html).toContain(">Save my details</button>");
    expect(html).toContain(`<a class="btn btn-line" href="/family">Back to Family</a>`);
    expect(html).not.toContain(CANT_REACH);
    expect(html).not.toContain(RIVERA.parent.phone); // the cache's older number
    // Whose record it is stays on the server: no QuickBooks id is in the page, and nothing of the other family.
    expect([...html.matchAll(/<input [^>]*>/g)].map((m) => /name="([^"]*)"/.exec(m[0])?.[1])).toEqual(CONTACT_FIELDS.map((f) => f.name));
    for (const id of [R_PARENT, R_FAMILY, ...RIVERA.students.map((s) => s.qboId)]) expect(html).not.toContain(id);
    for (const marker of c.markers) expect(html, marker).not.toContain(marker);
    // One read, of their own record, and no audit row for looking at their own details.
    expect(customerReads()).toEqual([`GET /customer/${R_PARENT}`]);
    expect(await audits()).toEqual([]);
  });

  it("names the treasurer for a change of name or email when the club has set one", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.insert(setting).values({ key: "club", value: { name: "Test Boosters", shortName: "TB", color: "#5b2a86", treasurerEmail: "treasurer@club.example" } });
    asParent(r.identity);
    expect(await renderPage(FamilyDetailsPage)).toContain(`The club changes names. Email the treasurer at <a href="mailto:treasurer@club.example">treasurer@club.example</a> and they&#x27;ll update yours.`);
    // While parent sign-ins are off, the email is the club's to change as well.
    await seedParentSettings({ signin: false });
    expect(await renderPage(FamilyDetailsPage)).toContain(`The club changes names and email addresses. Email the treasurer at <a href="mailto:treasurer@club.example">treasurer@club.example</a> and they&#x27;ll update them.`);
  });

  it.each([
    ["QuickBooks can't be reached", async () => { stub.dropApi = true; }, 1],
    ["QuickBooks keeps failing", async () => { stub.failNext = 5; }, 2],
    ["only an Admin can fix the connection", async () => { await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)", lastErrorAt: new Date() }); }, 0],
    ["QuickBooks was disconnected", async () => { await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null, accessTokenCiphertext: null, accessTokenKeyId: null }); }, 0],
    ["the record is inactive in QuickBooks now", async () => { Object.assign(inQuickBooks(stub, R_PARENT), { Active: false }); }, 1],
  ] as [string, () => Promise<void>, number][])("when %s: it says so kindly, shows what the roster has, and has no form", async (_what, arrange, asked) => {
    const { r, c } = await seedContactFamilies(stub);
    await arrange();
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain(`<p class="offline-note" role="status">${CANT_REACH}</p>`);
    expect(html).toContain(`<dt>Name</dt><dd>${RIVERA.parent.name}</dd><dt>Email</dt><dd>${RIVERA.parent.email}</dd><dt>Phone</dt><dd class="num">${RIVERA.parent.phone}</dd>`);
    expect(html).not.toMatch(/<form\b|<input\b|Save my details/);
    expect(html).toContain(`href="/family">Back to Family</a>`);
    for (const marker of c.markers) expect(html, marker).not.toContain(marker);
    expect(stub.apiCalls().filter((call) => call.path.includes("/customer"))).toHaveLength(asked);
    expect(await audits()).toEqual([]);
  });

  it("asks nothing of QuickBooks for a record whose id isn't a QuickBooks number, and says the same", async () => {
    // The two standard families have made-up ids. This is also what the browser tests see (scripts/seed-e2e.ts), whose
    // connection holds made-up tokens: the page never sends Intuit a request for them.
    const { a, b } = await seedTwoFamilies();
    await seedConnected(stub);
    asParent(a.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain(CANT_REACH);
    expect(html).toContain(`<dd class="num">${a.spec.parent.phone}</dd>`);
    expect(html).not.toMatch(/<form\b|<input\b/);
    for (const marker of b.markers) expect(html, marker).not.toContain(marker);
    expect(stub.calls).toHaveLength(0);
  });

  it("a parent whose sign-in was made by hand sees how to ask the club, and no form", async () => {
    await seedContactFamilies(stub);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(hand.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain('<h1 class="page-title">Update your details</h1>');
    expect(html).toContain(`<dt>Name</dt><dd>Hand Made</dd><dt>Email</dt><dd>hand.made@family-r.example</dd>`);
    expect(html).toContain(`${BY_THE_CLUB} Ask the club and they&#x27;ll update it.`);
    expect(html).not.toMatch(/<form\b|<input\b|Save my details|Update my details/);
    // Nothing of the family's own parent, whose record this is not.
    expect(html).not.toContain(RIVERA.parent.name);
    expect(html).not.toContain(RIVERA.parent.phone);
    expect(stub.calls).toHaveLength(0);
  });

  it("a family the portal may not show gets the same, and nothing is asked of QuickBooks", async () => {
    const { r } = await seedContactFamilies(stub);
    await db.delete(setting).where(eq(setting.key, "membership.shape"));
    asParent(r.identity);
    const html = await renderPage(FamilyDetailsPage);
    expect(html).toContain(BY_THE_CLUB);
    expect(html).not.toMatch(/<form\b|<input\b/);
    expect(html).not.toContain(RIVERA.parent.phone);
    expect(stub.apiCalls().filter((call) => call.path.includes("/customer"))).toHaveLength(0);
  });

  it("opening it again and again stops asking QuickBooks, and the first refusal is audited once", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    const max = RATE_LIMITS.contact_open_parent.max;
    for (let i = 0; i < max; i++) expect(await renderPage(FamilyDetailsPage)).toContain("Save my details");
    expect(customerReads()).toHaveLength(max);
    for (let i = 0; i < 3; i++) expect(await renderPage(FamilyDetailsPage)).toContain(CANT_REACH);
    expect(customerReads()).toHaveLength(max);
    expect((await audits()).map((a) => [a.action, a.targetId, a.after, a.actorId])).toEqual([["parent.contact.read.refused", R_PARENT, { code: "rate_limited" }, r.identity.parentId]]);
  });
});

describe("Your details, on Family and on Home", () => {
  it("links to the edit page for a parent with a QuickBooks record of their own, with no id in the link", async () => {
    const { r } = await seedContactFamilies(stub);
    asParent(r.identity);
    // Family says the sign-in email is theirs to change too, and offers it in the box below; Home keeps it short.
    const words = new Map([[FamilyPage, "You can change your phone and mailing address yourself, and your sign-in email below. The club changes your name for you."],
      [ParentHome, "You can change your phone and mailing address yourself. The club changes your name and email for you."]]);
    for (const [page, said] of words) {
      const html = await renderPage(page);
      expect(html).toContain(`<p class="help">${said} Ask the club and they&#x27;ll update it.</p><div class="box-foot">${LINK}</div></section>`);
      expect(html).not.toContain(BY_THE_CLUB);
    }
  });

  it("has no link for a sign-in made by hand: only the line about asking the club", async () => {
    await seedSignedInParent(RIVERA);
    const hand = await seedParentIn({ familyQboId: R_FAMILY, name: "Hand Made", email: "hand.made@family-r.example" });
    asParent(hand.identity);
    for (const page of [FamilyPage, ParentHome]) {
      const html = await renderPage(page);
      expect(html).toContain(`${BY_THE_CLUB} Ask the club and they&#x27;ll update it.`);
      expect(html).not.toContain("/family/details");
      expect(html).not.toContain("Update my details");
    }
  });

  it("links for the other family's parent too, each to the same address", async () => {
    const { c } = await seedContactFamilies(stub);
    asParent(c.identity);
    const html = await renderPage(FamilyPage);
    expect(html).toContain(LINK);
    expect(html).toContain(CHENOWETH.parent.phone);
    expect(html).not.toContain(RIVERA.parent.phone);
  });
});
