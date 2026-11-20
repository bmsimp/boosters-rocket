import { describe, it, expect, vi, beforeEach } from "vitest";

const who = vi.hoisted(() => ({
  staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string },
  parentState: { status: "none" } as unknown,
}));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => who.parentState, hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
const revalidated = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/cache", () => ({ revalidatePath: () => { revalidated.count += 1; } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, guardian, jobRun, parent, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";
import { AccessDenied } from "@/lib/guards";
import { loadRosterPage } from "@/lib/roster/queries";
import { ROSTER_JOB, setRosterSource } from "@/lib/roster/source";
import ParentsPage from "@/app/staff/(app)/parents/page";
import PersonPage from "@/app/staff/(app)/parents/[id]/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import StaffHome from "@/app/staff/(app)/page";
import ChooseFamily from "@/app/choose-family/page";
import { blockAction, unblockAction, resendWelcomeAction } from "@/app/staff/(app)/parents/actions";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { resetDb, seedGuardian, seedParent, seedStaff } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { rowNamed, tableRows } from "../helpers/table";

const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const thrown = async (p: Promise<unknown>) => (await p.catch((e: { url?: string; notFound?: boolean }) => e)) as { url?: string; notFound?: boolean };

const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("13", "Shared Sam", "10", "sam@example.com"),
  fam("20", "Chen <b>Family</b>"), par("21", "Shared Sam", "20", "sam@example.com")];
const parentsPage = async (q?: string) => renderToStaticMarkup(await ParentsPage({ searchParams: Promise.resolve(q ? { q } : {}) }));
const personPage = async (id: string) => renderToStaticMarkup(await PersonPage({ params: Promise.resolve({ id }) }));
/** A family's roster page, addressed by the app family record this customer's family link names. */
const familyPage = async (customer: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id: String(await recordOfCustomer(customer, "family")) }) }));
/** The staff home holds async server components, which only a rendering that waits for data can render. */
// Its text-node separators (<!-- -->) are dropped, as renderToStaticMarkup would not write them.
const staffHome = async () => (await new Response((await prerender(await StaffHome())).prelude).text()).replaceAll("<!-- -->", "");
const BROWSER = "That didn't go through. Reload the page and try again.";
/** The words an old row closed by the retired held-address review carries. */
const HELD_WORDS = "Can't sign in: the address was under more than one family, and held for staff to review";
/** The roster flags the sign-in rules from QuickBooks made, retired with them. */
const RETIRED_FLAGS = ["bad_email", "many_addresses", "name_differs", "held_address", "family_no_signin", "same_address_in_family"];

describe("the staff pages for parents", () => {
  let registrar: Awaited<ReturnType<typeof seedStaff>>, reader: Awaited<ReturnType<typeof seedStaff>>;
  const as = (s: typeof registrar) => { who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email }; };
  beforeEach(async () => {
    who.parentState = { status: "none" }; revalidated.count = 0;
    await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); await seedCache(ALL);
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
    // The people as the portal holds them: Ana, invited to the Rivera family; Sam, whose two rows the retired
    // held-address review closed, and which stay closed with their words.
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    const sam = await seedParent({ name: "Shared Sam", email: "sam@example.com" });
    await seedGuardian({ parentId: sam.id, familyQboId: "10", sourceQboId: "13", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
    await seedGuardian({ parentId: sam.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
    await syncAppRecords();
    registrar = await seedStaff({ email: "reg@club.org", name: "Reg Istrar" });
    reader = await seedStaff({ email: "reader@club.org", name: "Rae Der" });
    const [parents] = await db.insert(role).values({ key: "parents", name: "Parents" }).returning();
    await db.insert(roleRule).values([{ roleId: parents!.id, kind: "include", pattern: "Parents.*" }, { roleId: parents!.id, kind: "include", pattern: "Roster.*" }]);
    await db.insert(roleAssignment).values({ roleId: parents!.id, staffUserId: registrar.id });
    const [roster] = await db.insert(role).values({ key: "roster", name: "Roster" }).returning();
    await db.insert(roleRule).values({ roleId: roster!.id, kind: "include", pattern: "Roster.*" });
    await db.insert(roleAssignment).values({ roleId: roster!.id, staffUserId: reader.id });
    as(registrar);
  });
  const anaRow = async () => (await db.select().from(parent).where(eq(parent.email, "ana@example.com")))[0]!;

  it("refuses the Parents pages and every action without Parents.ReadWrite", async () => {
    as(reader);
    const ana = await anaRow();
    expect((await thrown(ParentsPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: ana.id }) }))).url).toBe("/refused");
    await expect(blockAction(ana.id, "reason")).rejects.toBeInstanceOf(AccessDenied);
    await expect(unblockAction(ana.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(resendWelcomeAction(ana.id)).rejects.toBeInstanceOf(AccessDenied);
    expect(await audits("parent.read")).toEqual([]);
  });

  it("lists people, and nothing to review: the held-address review is gone, and an old held row reads in words", async () => {
    const html = await parentsPage();
    for (const gone of ["To review", "Decided", "Same person", "Not the same person", "Reverse this decision"]) expect(html).not.toContain(gone);
    expect(rowNamed(html, "Shared Sam")).toEqual(["Shared Sam", "sam@example.com", "Never", "Not sent yet",
      `Rivera Family: ${HELD_WORDS}Chen <b>Family</b>: ${HELD_WORDS}`]);
    expect(html).toContain("Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(html).not.toContain("<b>Family</b>");
  });

  it("lists people and finds them, and says who can sign in is the portal's own", async () => {
    const html = await parentsPage();
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Can sign in (hasn&#x27;t yet)");
    expect(html).toContain("a change made in QuickBooks no longer gives anyone a sign-in or ends one");
    expect(html).not.toContain("Email addresses are changed in QuickBooks");
    expect(rowNamed(html, "Ana Rivera")).toEqual(["Ana Rivera", "ana@example.com", "Never", "Not sent yet", "Rivera Family: Can sign in (hasn't yet)"]);
    expect(await parentsPage("zzz")).toContain("Nobody matches");
    const ana = await anaRow();
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") }).where(eq(parent.id, ana.id));
    await db.insert(auditLog).values({ door: "parent", actorId: ana.id, actorLabel: ana.email, action: "signin", targetType: "parent", targetId: ana.id, at: new Date("2026-11-05T12:00:00Z") });
    const dated = await parentsPage();
    expect(dated).toContain('<time dateTime="2026-11-05T12:00:00.000Z" title="2026-11-05T12:00:00.000Z">');
    expect(dated).toContain('Sent <time dateTime="2026-11-01T12:00:00.000Z" title="2026-11-01T12:00:00.000Z">');
    expect(rowNamed(dated, "Ana Rivera")!.slice(2, 4)).toEqual([expect.stringMatching(/^2026-11-05/), expect.stringMatching(/^Sent 2026-11-01/)]);
  });

  it("refuses arguments no page sends, without touching the database", async () => {
    const refused = { ok: false, errors: [BROWSER] };
    const ana = await anaRow();
    const loose = (f: unknown) => f as (...a: unknown[]) => Promise<unknown>;
    expect(await loose(blockAction)({ id: ana.id }, "reason")).toEqual(refused);
    expect(await loose(blockAction)("x".repeat(65), "reason")).toEqual(refused);
    expect(await loose(blockAction)("not-an-id", "reason")).toEqual(refused);
    expect(await loose(blockAction)(ana.id, "x".repeat(2001))).toEqual(refused);
    expect(await loose(unblockAction)([ana.id])).toEqual(refused);
    expect(await loose(resendWelcomeAction)(null)).toEqual(refused);
    expect((await db.select().from(parent)).every((p) => !p.blocked)).toBe(true);
    expect((await db.select().from(auditLog)).filter((r) => r.action.startsWith("parent."))).toEqual([]);
    expect(revalidated.count).toBe(0);
  });

  it("a person's page shows their families and is recorded as a read", async () => {
    const ana = await anaRow();
    const html = await personPage(ana.id);
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Rivera Family");
    // The family's page by its app record: the membership's own family.
    expect(html).toContain(`href="/staff/roster/${await recordOfCustomer("10", "family")}"`);
    expect(html).toContain("Resend welcome email");
    expect(html).toContain("Block");
    expect(html).not.toContain("followed by Refresh now on the roster");
    expect(await audits("parent.read")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: ana.id })]);
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: "not-an-id" }) }))).notFound).toBe(true);
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: "00000000-0000-4000-8000-00000000dead" }) }))).notFound).toBe(true);
    expect(await audits("parent.read")).toHaveLength(1); // an unknown ID records no read
  });

  it("a person's page shows their phone and mailing address as the portal holds them, with the form, only after its read is recorded; in books with no parent type, each family's page instead", async () => {
    const ana = await anaRow();
    await db.update(parent).set({ phone: "555-0123", addressLine1: "12 Heron Lane", addressCity: "Austin", contactVersion: 4 }).where(eq(parent.id, ana.id));
    let html = await personPage(ana.id);
    const details = html.slice(html.indexOf("pd-h"), html.indexOf("</section>", html.indexOf("pd-h")));
    expect(details).toContain("value=\"555-0123\"");
    expect(details).toContain("value=\"12 Heron Lane\"");
    expect(details).toContain("value=\"Austin\"");
    expect(details).toContain("Save details");
    expect(html).toContain("Their phone and mailing address are the portal&#x27;s own too, changed by them on their Family page or by staff");
    expect(await audits("parent.read")).toHaveLength(1);
    // Never on the list page.
    expect(await parentsPage()).not.toContain("555-0123");
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    html = await personPage(ana.id);
    expect(html).not.toContain("555-0123");
    expect(html).not.toContain("Save details");
    expect(html).toContain("a phone and mailing address are each family&#x27;s, shared by its guardians");
    const listed = html.slice(html.indexOf("pd-h"), html.indexOf("</section>", html.indexOf("pd-h")));
    expect(listed).toContain(`href="/staff/roster/${await recordOfCustomer("10", "family")}"`);
  });

  it("names a link from a previous QuickBooks company without looking up or linking its old family ID", async () => {
    const ana = await anaRow();
    // "20" is that company's ID; in the connected company it names Chen <b>Family</b>, which is not where this link came from.
    await seedGuardian({ parentId: ana.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    const html = await personPage(ana.id);
    expect(html).toContain("A family in the previous QuickBooks company");
    expect(html).not.toContain('href="/staff/roster/20"');
    expect(html).not.toContain(`href="/staff/roster/${await recordOfCustomer("20", "family")}"`);
    expect(html).not.toContain("Chen");
    const people = (await parentsPage("ana")).split('id="people-h"')[1]!;
    expect(people).toContain("A family in the previous QuickBooks company: Can&#x27;t sign in: a different QuickBooks company was connected");
    expect(people).not.toContain("Chen");
  });

  it("blocks with a reason and unblocks, through the actions", async () => {
    const ana = await anaRow();
    expect(await blockAction(ana.id, "  ")).toEqual({ ok: false, errors: ["Say why, in a few words. Only staff see it."] });
    expect(await blockAction(ana.id, "Custody order on file.")).toEqual({ ok: true, message: "Blocked. They are signed out and can't get a code." });
    const html = await personPage(ana.id);
    expect(html).toContain("Blocked");
    expect(html).toContain("Custody order on file.");
    expect(html).toContain("Unblock");
    expect(await unblockAction(ana.id)).toEqual({ ok: true, message: "Unblocked." });
    const refreshed = revalidated.count;
    // Not blocked: nothing changes, and the page is not rendered again, so no further read is recorded.
    expect(await unblockAction(ana.id)).toEqual({ ok: true, message: "This person isn't blocked." });
    expect(revalidated.count).toBe(refreshed);
    expect(await audits("parent.unblock")).toHaveLength(1);
    expect(await blockAction("00000000-0000-4000-8000-00000000dead", "Custody order on file.")).toEqual({ ok: false, errors: ["That person isn't in the portal any more."] });
  });

  it("a resend is refused while parent sign-ins are switched off", async () => {
    const ana = await anaRow();
    await seedParentSettings({ signin: false });
    expect(await resendWelcomeAction(ana.id)).toEqual({ ok: false, errors: ["This person can't sign in to any family right now, so no email was sent."] });
    const html = await personPage(ana.id);
    expect(html).toContain("Parent sign-ins are switched off, so no welcome can be sent.");
    expect(html).not.toContain("Resend welcome email");
  });

  it("a family's roster page lists the family's guardian rows, open and closed, in words; only Parents.ReadWrite gets links", async () => {
    const ana = await anaRow();
    const detailed = await familyPage("10");
    const box = detailed.slice(detailed.indexOf('id="entry-signins-h"'), detailed.indexOf("</section>", detailed.indexOf('id="entry-signins-h"')));
    expect(box).toContain("Can sign in (hasn&#x27;t yet)");
    expect(box).toContain(HELD_WORDS.replaceAll("'", "&#x27;"));
    expect(box).not.toContain("Chen");
    expect(box).toContain(`href="/staff/parents/${ana.id}"`);
    as(reader);
    const plain = await familyPage("10");
    expect(plain).toContain("Can sign in (hasn&#x27;t yet)");
    expect(plain).not.toContain("Chen");
    expect(plain).not.toContain("/staff/parents/");
  });

  it("lists no sign-in worked out from QuickBooks: a parent record with no address, or with one, is no row of its own", async () => {
    await seedCache([...ALL, par("14", "Pat Rivera", "10", null), par("15", "Pat Rivera", "10", null), par("16", "Quinn Rivera", "10", "quinn@example.com")]);
    const html = await familyPage("10");
    const box = html.slice(html.indexOf('id="entry-signins-h"'), html.indexOf("</section>", html.indexOf('id="entry-signins-h"')));
    for (const gone of ["Pat Rivera", "Quinn Rivera", "No email address", "no email address in QuickBooks"]) expect(box).not.toContain(gone);
    expect(tableRows(box).map((r) => r[0])).toEqual(["Ana Rivera", "Shared Sam"]);
  });

  it("the staff home says nothing of addresses to review, to anyone", async () => {
    expect(await staffHome()).not.toContain("to review");
    as(reader);
    const plain = await staffHome();
    expect(plain).toContain("Hi, Rae");
    expect(plain).not.toContain("to review");
  });

  it("Needs attention on the roster no longer lists the sign-in rules' flags from QuickBooks", async () => {
    const page = await loadRosterPage();
    expect(page.attention.filter((a) => (RETIRED_FLAGS as string[]).includes(a.rule))).toEqual([]);
  });

  it("the family chooser names each family from its app record, says so for one it doesn't know, and sends no QuickBooks id", async () => {
    const ana = (await db.select().from(parent)).find((p) => p.email === "ana@example.com")!;
    const [rivera] = await db.select().from(guardian).where(eq(guardian.parentId, ana.id));
    // A row with no family record behind it: the portal knows no name for it.
    const unknown = await seedGuardian({ parentId: ana.id, familyQboId: "NOPE" });
    who.parentState = { status: "choose", parentId: ana.id, sessionId: "s1", name: ana.name,
      families: [{ guardianId: rivera!.id, familyQboId: "10" }, { guardianId: unknown.id, familyQboId: "NOPE" }] };
    const html = renderToStaticMarkup(await ChooseFamily());
    expect(html).toContain("Rivera Family");
    // React writes the words' apostrophe as &#x27;.
    expect(html).toContain(recordNameWords(null, "family").replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Family account");
    expect(html).not.toContain("NOPE");
  });
});
