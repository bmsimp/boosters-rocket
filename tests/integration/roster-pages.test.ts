import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
const revalidated = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/cache", () => ({ revalidatePath: () => { revalidated.count += 1; } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboCustomerType, role, roleRule, roleAssignment, jobRun } from "@/lib/db/schema";
import RosterPage from "@/app/staff/(app)/roster/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { refreshRosterAction } from "@/app/staff/(app)/roster/actions";
import { AccessDenied } from "@/lib/guards";
import { disconnect } from "@/lib/quickbooks/connection";
import { loadRosterPage } from "@/lib/roster/queries";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb, seedStaff, seedParent, seedGuardian } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { rowNamed } from "../helpers/table";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { addToCache, fam, seedRosterRead, seedShape, stu } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const list = async (q?: string) => renderToStaticMarkup(await RosterPage({ searchParams: Promise.resolve(q ? { q } : {}) }));
/** A family's page is addressed by its app family record: the one this customer's family link names. */
const idOf = async (customer: string) => String(await recordOfCustomer(customer, "family"));
const entry = async (customer: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id: await idOf(customer) }) }));
const thrown = async (p: Promise<unknown>) => (await p.catch((e: { url?: string; notFound?: boolean }) => e)) as { url?: string; notFound?: boolean };

describe("the roster pages", () => {
  let reader: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); stub.reset(); Object.assign(stub, fznCompany());
    reader = await seedStaff({ email: "registrar@club.org", name: "Reg Istrar" });
    const [r] = await db.insert(role).values({ key: "roster", name: "Roster" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "Roster.*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: reader.id });
    who.staff = { door: "staff", staffUserId: reader.id, name: reader.name, email: reader.email };
  });
  // The roster read, and the app's own records imported from it (a read makes none since stage 3's slice 9c), as
  // migration 0023 made them for a club with this roster.
  const ready = async () => {
    await seedConnected(stub);
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
    await syncAppRecords();
  };

  it("refuses staff without Roster.Read", async () => {
    const other = await seedStaff({ email: "volunteer@club.org" });
    who.staff = { door: "staff", staffUserId: other.id, name: other.name, email: other.email };
    expect((await thrown(RosterPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(RosterEntryPage({ params: Promise.resolve({ id: "10" }) }))).url).toBe("/refused");
    await expect(refreshRosterAction()).rejects.toBeInstanceOf(AccessDenied);
    expect(await audits("roster.family.read")).toEqual([]);
  });

  it("says what is missing before there is a roster", async () => {
    expect(await list()).toContain("QuickBooks isn&#x27;t connected yet.");
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await list()).toContain("The membership shape hasn&#x27;t been chosen yet.");
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2"));
    const html = await list();
    expect(html).toContain("The membership shape names a customer type QuickBooks no longer has");
    expect(html).not.toContain("Rivera Family");
  });

  it("lists families with their counts, marks inactive ones, and leaves out customers outside the shape", async () => {
    await ready();
    const html = await list();
    expect(html.indexOf("Chen Family")).toBeLessThan(html.indexOf("Rivera Family"));
    expect(html).toContain(`href="/staff/roster/${await idOf("10")}"`);
    expect(html).not.toContain('href="/staff/roster/10"'); // never by its customer
    // A row each: the family, its students and parents, and whether it is linked to QuickBooks and active there (stage 3's slice 9d).
    expect(rowNamed(html, "Rivera Family")).toEqual(["Rivera Family", "1", "1", "Linked: active"]);
    expect(rowNamed(html, "Old Family")).toEqual(["Old Family", "0", "0", "Linked: inactive"]);
    expect(html).not.toContain("Lincoln High");
    expect(html).not.toContain("ana@example.com"); // contact details are on the family's own page
    expect(html).toContain("3 families, 1 student, 2 parents; 2 customers outside the portal");
  });

  it("finds families by name, treating what was typed as plain text", async () => {
    await ready();
    const html = await list("RIVER");
    expect(html).toContain("Rivera Family");
    expect(rowNamed(html, "Chen Family")).toEqual(["Chen Family", expect.any(String)]); // only in Needs attention, which is not filtered
    expect(rowNamed(html, "Rivera Family")).toEqual(["Rivera Family", "1", "1", "Linked: active"]);
    expect(await list("%")).toContain("No family matches");
    expect(await list("_")).toContain("No family matches"); // not a one-character wildcard
    expect(await list("Rivera' or '1'='1")).toContain("No family matches");
    const angle = await list("<b>Rivera</b>");
    expect(angle).toContain("No family matches &quot;&lt;b&gt;Rivera&lt;/b&gt;&quot;");
    expect(angle).not.toContain("<b>Rivera</b>");
    const long = await list("x".repeat(150)); // only the first 100 characters are used, and shown
    expect(long).toContain(`No family matches &quot;${"x".repeat(100)}&quot;`);
    expect(long).not.toContain("x".repeat(101));
  });

  it("shows Needs attention with plain words, linking only to things that have a page", async () => {
    await ready();
    const html = await list();
    expect(html).toContain("No student is listed under this family in QuickBooks.");
    expect(html).toContain("This student or parent isn&#x27;t directly under a family in QuickBooks.");
    expect(html).not.toContain('href="/staff/roster/50"'); // a stray student has no page
    expect(html).toContain(`href="/staff/roster/${await idOf("20")}"`); // a family flagged links to its page, by its record
  });

  it("renders hostile names as text", async () => {
    stub.customers.push(
      { Id: "90", DisplayName: "<img src=x onerror=alert(1)>", Active: true, SyncToken: "0", CustomerTypeRef: { value: "1" } },
      { Id: "91", DisplayName: 'Smith & "Sons"', Active: true, SyncToken: "0", CustomerTypeRef: { value: "2" }, ParentRef: { value: "90" } },
    );
    await ready();
    const html = await list();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Smith &amp; &quot;Sons&quot;"); // in Needs attention: a parent with no email
    const page = await entry("90");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("Smith &amp; &quot;Sons&quot;");
  });

  it("a family's page shows its students, its parents and the portal sign-ins, and the visit is audited", async () => {
    await ready();
    const ana = await seedParent({ name: "Ana R.", email: "ana.portal@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "invited" });
    await syncAppRecords(); // each membership in its family record, as the import puts it
    const html = await entry("10");
    expect(html).toContain("Rivera Family");
    expect(html).toContain("Leo Rivera");
    expect(html).toContain("ana@example.com");
    expect(html).toContain("555-0101");
    expect(html).toContain("ana.portal@example.com");
    // The sign-in's standing, in words (parents spec §4), on the person's own row of the sign-ins table. This reader's
    // role is Roster.*, which holds Roster.Family.ReadWrite, so the row goes on to offer Remove (who is offered it, and
    // who isn't, is tests/integration/staff-guardians.test.ts's). Since slice 9h the row says where QuickBooks stands for
    // the person's own Parent customer: Ana was seeded with no link and nothing queued, and no customer under the family
    // has her name, so nothing is coming (tests/integration/guardians-in-quickbooks.test.ts holds the other words).
    const row = [...html.matchAll(/<tr role="row">([\s\S]*?)<\/tr>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
      .find((r) => r.includes("ana.portal@example.com"));
    expect(row).toMatch(/^Ana R\. Email ana\.portal@example\.com Sign-in Can sign in \(hasn&#x27;t yet\) In QuickBooks No Parent customer in QuickBooks is linked to them, and none is being made: the mapping screen will offer to link one\. Remove Ana R\. /);
    expect((await audits("roster.family.read"))).toHaveLength(1);
    expect((await audits("roster.family.read"))[0]).toMatchObject({ actorId: reader.id, actorLabel: "registrar@club.org", permission: "Roster.Read",
      targetType: "family", targetId: await idOf("10"), ip: "203.0.113.40" });
  });

  it("a family's page leads to its money, season and volunteering credit for staff who may open each, and to none of them otherwise", async () => {
    await ready();
    const links = (html: string) => [...html.matchAll(/href="(\/staff\/(?:balances|seasons\/progress\/family|volunteer\/credit)\/[^"]+)"/g)].map((m) => m[1]);
    expect(links(await entry("10"))).toEqual([]);
    // Its buy-outs page is Roster.Read's, the roster page's own: the one link every reader of the page gets.
    const alone = await entry("10");
    const at = await idOf("10");
    expect(alone).toContain("More about this family");
    expect([...alone.matchAll(/href="(\/staff\/roster\/[^"/]+\/[^"]+)"/g)].map((m) => m[1])).toEqual([`/staff/roster/${at}/buyouts`]);
    const [r] = await db.insert(role).values({ key: "more", name: "More" }).returning();
    await db.insert(roleRule).values(["Finance.Balance.Read", "Season.Progress.Read", "Volunteer.Credit.ReadWrite"].map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: reader.id });
    expect(links(await entry("10"))).toEqual([`/staff/balances/${at}`, `/staff/seasons/progress/family/${at}`, `/staff/volunteer/credit/${at}`]);
  });

  it("is not found, and writes no audit row or error, for anything that isn't a family record of the roster", async () => {
    await ready();
    // A family's QuickBooks id (the old address), text that isn't a uuid, a student's record, a uuid that names nothing,
    // and family records (made inactive, as 0023 made one) of a customer that isn't a family: a school, a parent.
    // "%E0%A4%A" is not valid percent-encoding: it must be a plain not-found, never an error page.
    const ids = ["10", "nope", "10%27", "%E0%A4%A", "%", String(await recordOfCustomer("12", "student")), crypto.randomUUID(), await idOf("30"), await idOf("11")];
    for (const id of ids) expect((await thrown(RosterEntryPage({ params: Promise.resolve({ id }) }))).notFound, id).toBe(true);
    expect(await audits("roster.family.read")).toEqual([]);
  });

  it("flat: lists members and opens one", async () => {
    await seedConnected(stub);
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
    await syncAppRecords();
    const html = await list();
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Find a member");
    expect(html).not.toContain("Rivera Family");
    expect(await entry("11")).toContain("ana@example.com");
  });

  it("says the roster is no longer current after a disconnect, with the date, on every roster page", async () => {
    await ready();
    const before = await entry("10");
    expect(before).toContain("Last read from QuickBooks");
    expect(before).toContain("Refresh now");
    expect(await list()).toContain("Refresh now");
    await disconnect({ actor: worker.actor, ip: null });
    for (const html of [await list(), await entry("10")]) {
      expect(html).toContain("QuickBooks is disconnected, so this roster is no longer current. It was last read ");
      expect(html).toContain("Last read from QuickBooks");
      expect(html).not.toContain("Refresh now");
    }
    expect(await list()).toContain("Rivera Family");
  });

  it("Refresh now reads QuickBooks again, at most once every 5 minutes", async () => {
    await ready();
    await db.update(jobRun).set({ startedAt: new Date(Date.now() - 6 * 60_000) });
    revalidated.count = 0;
    expect(await refreshRosterAction()).toEqual({ ok: true, message: "Read 9 customers from QuickBooks." });
    expect(revalidated.count).toBe(1);
    expect(await refreshRosterAction()).toEqual({ ok: false, error: "A refresh ran less than 5 minutes ago. Try again shortly." });
    // A refusal renders nothing again, so a family's page doesn't record a second read for one visit.
    expect(revalidated.count).toBe(1);
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ actorId: reader.id, ip: "203.0.113.40" });
  });

  it("Refresh now counts one customer as one customer", async () => {
    await seedConnected(stub);
    stub.customers = stub.customers.slice(0, 1);
    expect(await refreshRosterAction()).toEqual({ ok: true, message: "Read 1 customer from QuickBooks." });
  });

  it("Refresh now right after a failed read says a refresh ran, not that the roster was refreshed", async () => {
    await seedConnected(stub);
    stub.failQueryFrom = 1;
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed" });
    expect(await refreshRosterAction()).toEqual({ ok: false, error: "A refresh ran less than 5 minutes ago. Try again shortly." });
  });

  it("Needs attention names a sign-in to an unknown QuickBooks ID without showing the parent's email", async () => {
    await ready();
    const lost = await seedParent({ name: "Lost Person", email: "lost.person@example.com" });
    await seedGuardian({ parentId: lost.id, familyQboId: "NO-SUCH-ID" });
    await syncAppRecords(); // each membership in its family record, as the import puts it
    const html = await list();
    expect(html).toContain("Lost Person");
    expect(html).toContain("NO-SUCH-ID");
    expect(html).not.toContain("lost.person@example.com");
    expect(html).not.toContain("Lost Person (");
    expect(await audits("roster.family.read")).toEqual([]);
  });

  it("says the roster hasn't been read yet when a shape is set but nothing has been read, and still offers Refresh now", async () => {
    await seedConnected(stub);
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    const html = await list();
    expect(html).toContain("The roster hasn&#x27;t been read from QuickBooks yet.");
    expect(html).not.toContain("No family matches");
    expect(html).toContain("Refresh now");
  });

  it("says QuickBooks lists no customers of the type when the roster is read and empty, but keeps No family matches for a search", async () => {
    stub.customers = stub.customers.filter((c: { CustomerTypeRef?: { value: string } }) => c.CustomerTypeRef?.value !== "1");
    await ready();
    const html = await list();
    expect(html).toContain("QuickBooks lists no customers of the family type.");
    expect(html).not.toContain("No family matches");
    await saveShape({ kind: "flat", memberTypeIds: ["5"] }, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
    expect(await list()).toContain("QuickBooks lists no customers of the member types.");
  });

  it("says QuickBooks lists families the portal has none of, and that a read doesn't bring them in", async () => {
    // A cache read before the portal recorded the roster's company, shown while QuickBooks is disconnected: the counts
    // are QuickBooks' own, but the list is of the app's records, and no read makes one (stage 3's slice 9c).
    await seedShape(); await addToCache([fam("10", "Rivera Family"), stu("12", "Maya Rivera", "10")]); await seedRosterRead();
    const html = await list();
    expect(html).toContain("1 family");
    expect(html).toContain("QuickBooks lists families, but none of them is one of the portal&#x27;s own families: a read of QuickBooks doesn&#x27;t bring customers into the portal.");
    expect(html).not.toContain("QuickBooks lists no customers of the family type.");
    expect(html).not.toContain("Rivera Family</a>");
  });

  it("holds back the sign-in rule while the cache names no company, and keeps QuickBooks' own tidy rules", async () => {
    // No company recorded, so the import makes no family record and every guardian row's family is null: the sign-in
    // rule can't hold a sign-in to anything yet, and waits for a read that records the company.
    await seedShape();
    await addToCache([fam("10", "Rivera Family"), stu("12", "Maya Rivera", "10"), fam("20", "Gone Family", { active: false }), stu("22", "Gil Gone", "20")]);
    await seedRosterRead();
    const ana = await seedParent({ name: "Ana Rivera" }), gil = await seedParent({ name: "Gail Gone" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" }); await seedGuardian({ parentId: gil.id, familyQboId: "20" });
    await syncAppRecords();
    const rules = async () => (await loadRosterPage()).attention.map((a) => `${a.rule}:${a.qboId ?? a.name}`);
    expect((await loadRosterPage()).signIns.map((s) => [s.name, s.familyId, s.customerQboId]).sort()).toEqual([["Ana Rivera", null, null], ["Gail Gone", null, null]]);
    const before = await rules();
    expect(before).toContain("family_no_parent:10");
    expect(before.filter((r) => r.startsWith("signin_unknown"))).toEqual([]);
    expect(await list()).not.toContain("isn&#x27;t attached to any family the portal keeps");
    // Once a read records the company (seedRosterRead() imports the records after it, as 0023 made them), the rule
    // judges every sign-in: both are held to a family of the roster. The inactive family's open sign-in asks nothing of staff: nobody can enter that family.
    await seedRosterRead({ realmId: "1111" });
    const after = await rules();
    expect(after).toContain("family_no_parent:10");
    expect(after.filter((r) => r.startsWith("signin_unknown") || r.endsWith(":20"))).toEqual([]);
  });

  it("keeps No family matches for a search that finds nothing", async () => {
    await ready();
    expect(await list("zzz")).toContain("No family matches &quot;zzz&quot;.");
  });

  it("only promises the daily read while connected", async () => {
    await ready();
    for (const html of [await list(), await entry("10")]) expect(html).toContain("The worker reads it again every day.");
    await disconnect({ actor: worker.actor, ip: null });
    for (const html of [await list(), await entry("10")]) expect(html).not.toContain("The worker reads it again every day.");
  });

  it("after a disconnect, tells an Admin where to reconnect and anyone else who can, on both pages", async () => {
    await ready();
    await disconnect({ actor: worker.actor, ip: null });
    for (const html of [await list(), await entry("10")]) {
      expect(html).toContain("An Admin can reconnect it under QuickBooks.");
      expect(html).not.toContain("Open QuickBooks settings");
    }
    const admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
    for (const html of [await list(), await entry("10")]) {
      expect(html).toContain('<a href="/staff/settings/quickbooks">Open QuickBooks settings</a>');
      expect(html).not.toContain("An Admin can reconnect it");
    }
  });

  it("after a failed refresh, points at the fix after the failure sentence", async () => {
    await ready();
    stub.failQueryFrom = 1;
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed" });
    const html = await list();
    expect(html).toContain("The latest try failed:");
    expect(html).toMatch(/The latest try failed:.*An Admin can/);
  });
});
