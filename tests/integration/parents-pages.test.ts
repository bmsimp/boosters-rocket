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
import { auditLog, guardian, jobRun, parent, parentAuthPasskey, parentAuthSession, parentAuthUser, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";
import { AccessDenied } from "@/lib/guards";
import { loadRosterPage } from "@/lib/roster/queries";
import { ROSTER_JOB, setRosterSource } from "@/lib/roster/source";
import ParentsPage from "@/app/staff/(app)/parents/page";
import PersonPage from "@/app/staff/(app)/parents/[id]/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import StaffHome from "@/app/staff/(app)/page";
import ChooseFamily from "@/app/choose-family/page";
import { blockAction, unblockAction, resendWelcomeAction, resetSigninAction } from "@/app/staff/(app)/parents/actions";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { resetDb, seedGuardian, seedInactiveFamily, seedParent, seedStaff } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { rowNamed, tableRows } from "../helpers/table";
import { seedPassword } from "../helpers/signin-links";
import { seedPasskey } from "../helpers/passkey";
import { seedAuthenticator } from "../helpers/authenticator";
import * as sendModule from "@/lib/mail/send";

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
    expect(html).toContain("Hasn&#x27;t chosen a password yet");
    expect(html).toContain("a change made in QuickBooks no longer gives anyone a sign-in or ends one");
    expect(html).not.toContain("Email addresses are changed in QuickBooks");
    expect(rowNamed(html, "Ana Rivera")).toEqual(["Ana Rivera", "ana@example.com", "Never", "Not sent yet", "Rivera Family: Hasn't chosen a password yet"]);
    expect(await parentsPage("zzz")).toContain("Nobody matches");
    const ana = await anaRow();
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") }).where(eq(parent.id, ana.id));
    await db.insert(auditLog).values({ door: "parent", actorId: ana.id, actorLabel: ana.email, action: "signin", targetType: "parent", targetId: ana.id, at: new Date("2026-11-05T12:00:00Z") });
    const dated = await parentsPage();
    expect(dated).toContain('<time dateTime="2026-11-05T12:00:00.000Z" title="2026-11-05T12:00:00.000Z">');
    expect(dated).toContain('Sent <time dateTime="2026-11-01T12:00:00.000Z" title="2026-11-01T12:00:00.000Z">');
    expect(rowNamed(dated, "Ana Rivera")!.slice(2, 4)).toEqual([expect.stringMatching(/^2026-11-05/), expect.stringMatching(/^Sent 2026-11-01/)]);
  });

  it("says how many who can sign in have a passkey, an app or neither, naming nobody, and where an Admin asks for one", async () => {
    // Section 9 of the app-owned families spec ("Sign-in"): staff see the counts; the sign-in release's slice SI-10b.
    const counts = (html: string) => { const at = html.indexOf("<p>Of the "); return at < 0 ? "" : html.slice(at, html.indexOf("</p>", at)).replaceAll("&#x27;", "'"); };
    const readsBefore = (await db.select().from(auditLog)).length;
    // Ana can sign in, with neither; Sam's rows are closed, so Sam isn't counted. The registrar holds no Settings.Parents.ReadWrite.
    expect(counts(await parentsPage())).toBe("<p>Of the 1 person who can sign in, 0 have a passkey and 0 an authenticator app (someone with both is counted twice); 1 has neither.");
    const ana = await anaRow();
    await seedPasskey(ana.id); await seedAuthenticator(ana.id);
    const sam = (await db.select().from(parent).where(eq(parent.email, "sam@example.com")))[0]!;
    await db.update(guardian).set({ status: "invited", disabledReason: null, statusBeforeDisable: null }).where(eq(guardian.parentId, sam.id));
    expect(counts(await parentsPage())).toBe("<p>Of the 2 people who can sign in, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither.");
    // An Admin is told where the level is chosen; at Strict, everyone is told what happens to those with neither.
    as(await seedStaff({ email: "ada@club.org", name: "Ada Admin", admin: true }));
    expect(counts(await parentsPage())).toBe("<p>Of the 2 people who can sign in, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither. You can ask everyone for one under Settings, Parent sign-ins, step 3, once most have one.");
    await seedParentSettings({ level: "strict" });
    const strict = " The club is at Strict: anyone with neither adds one the next time they sign in.";
    expect(counts(await parentsPage())).toBe(`<p>Of the 2 people who can sign in, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither.${strict}`);
    as(registrar);
    expect(counts(await parentsPage())).toBe(`<p>Of the 2 people who can sign in, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither.${strict}`);
    await seedParentSettings({ level: "standard" });
    expect(counts(await parentsPage())).not.toContain("step 3");
    // With parent sign-ins off nobody can sign in: the counts are of who could once they are on (slice SI-11), the rest as it was.
    await seedParentSettings({ signin: false });
    expect(counts(await parentsPage())).toBe("<p>Of the 2 people who could sign in once sign-ins are on, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither.");
    await seedParentSettings({ level: "strict" });
    expect(counts(await parentsPage())).toBe(`<p>Of the 2 people who could sign in once sign-ins are on, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither.${strict}`);
    await seedParentSettings({ signin: true, level: "standard" });
    expect(counts(await parentsPage())).toBe("<p>Of the 2 people who can sign in, 1 has a passkey and 1 an authenticator app (someone with both is counted twice); 1 has neither.");
    // Counts only: reading them writes no audit row.
    expect((await db.select().from(auditLog)).length).toBe(readsBefore);
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
    // Since the sign-in release's slice SI-4: whether a password is chosen, and what the resend sends for this person.
    expect(html).toContain("<dt>Password</dt><dd>Not chosen yet</dd>");
    expect(html).toContain("with a new link to choose their password. The link works once, for 7 days");
    expect(html).not.toContain("and a code");
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
    expect(await blockAction(ana.id, "Custody order on file.")).toEqual({ ok: true, message: "Blocked. They are signed out, and can't sign in, get a sign-in code or use a password link." });
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

  it("with a password chosen, the pages say they can sign in, and the resend says to sign in with it", async () => {
    const ana = await anaRow();
    await seedPassword((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id)))[0]!.id, "a phrase Ana chose some time ago");
    expect(rowNamed(await parentsPage(), "Ana Rivera")!.at(-1)).toBe("Rivera Family: Can sign in (hasn't yet)");
    const html = await personPage(ana.id);
    expect(html).toContain("<dt>Password</dt><dd>Chosen</dd>");
    expect(html).toContain("that they sign in with this address and the password they chose.");
    expect(html).not.toContain("link to choose their password");
  });

  it("a person welcomed before who is owed the Admin's set-up mail reads as waiting for it", async () => {
    const ana = await anaRow();
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z"), welcomeOwed: true }).where(eq(parent.id, ana.id));
    expect(await personPage(ana.id)).toContain(". An email with a link to choose a password is waiting to be sent");
  });

  it("a resend is refused while parent sign-ins are switched off", async () => {
    const ana = await anaRow();
    await seedParentSettings({ signin: false });
    expect(await resendWelcomeAction(ana.id)).toEqual({ ok: false, errors: ["This person can't sign in to any family right now, so no email was sent."] });
    const html = await personPage(ana.id);
    expect(html).toContain("Parent sign-ins are switched off, so no welcome can be sent.");
    expect(html).not.toContain("Resend welcome email");
  });

  it("a resend says in words whether it carried a link to choose a password, and never the link", async () => {
    const ana = await anaRow();
    // The mail is taken as handed over without sending it: the words are what is tested here.
    const spy = vi.spyOn(sendModule, "sendMail").mockResolvedValue({ ok: true });
    try {
      const sent = await resendWelcomeAction(ana.id);
      expect(sent).toEqual({ ok: true, message: "Sent, with a link to choose a password." });
      expect(JSON.stringify(sent)).not.toContain("/sign-in/set-up/");
      await seedPassword((await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, ana.id)))[0]!.id, "a phrase Ana chose some time ago");
      expect(await resendWelcomeAction(ana.id)).toEqual({ ok: true, message: "Sent. They have a password, so it says to sign in with it." });
    } finally { spy.mockRestore(); }
  });

  it("a family's roster page lists the family's guardian rows, open and closed, in words; only Parents.ReadWrite gets links", async () => {
    const ana = await anaRow();
    const detailed = await familyPage("10");
    const box = detailed.slice(detailed.indexOf('id="entry-signins-h"'), detailed.indexOf("</section>", detailed.indexOf('id="entry-signins-h"')));
    expect(box).toContain("Hasn&#x27;t chosen a password yet");
    expect(box).toContain(HELD_WORDS.replaceAll("'", "&#x27;"));
    expect(box).not.toContain("Chen");
    expect(box).toContain(`href="/staff/parents/${ana.id}"`);
    as(reader);
    const plain = await familyPage("10");
    expect(plain).toContain("Hasn&#x27;t chosen a password yet");
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
    // A row whose family record has no name: the portal knows none for it.
    const unknown = await seedGuardian({ parentId: ana.id, familyId: await seedInactiveFamily() });
    who.parentState = { status: "choose", parentId: ana.id, sessionId: "s1", name: ana.name,
      families: [{ guardianId: rivera!.id, familyQboId: "10" }, { guardianId: unknown.id, familyQboId: "NOPE" }] };
    const html = renderToStaticMarkup(await ChooseFamily());
    expect(html).toContain("Rivera Family");
    // React writes the words' apostrophe as &#x27;.
    expect(html).toContain(recordNameWords(null, "family").replaceAll("'", "&#x27;"));
    expect(html).not.toContain("Family account");
    expect(html).not.toContain("NOPE");
  });

  // An Admin's reset of a parent's sign-in (the sign-in release, slice SI-9a): the section on the person's page and its
  // action. The reset itself is tests/integration/signin-reset.test.ts's.
  describe("the Reset sign-in section", () => {
    /** The section's HTML alone, from its heading to its end, with React's apostrophes written back. */
    const resetSection = (html: string) => { const at = html.indexOf('id="pr-h"'); return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at)).replaceAll("&#x27;", "'"); };
    const authUserOf = async (parentId: string) => (await db.select().from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.id;
    const asAdmin = async () => as(await seedStaff({ email: "ada@club.org", name: "Ada Admin", admin: true }));

    it("is shown to an Admin only, with what the person signs in with as counts: no passkey's name and no address", async () => {
      const ana = await anaRow();
      const user = await authUserOf(ana.id);
      await seedPassword(user, "a phrase Ana chose some time ago");
      await db.insert(parentAuthPasskey).values({ id: crypto.randomUUID(), name: "Ana's secret laptop", publicKey: "pQECAyYgASFYIA", userId: user, credentialID: "cred-ana-1",
        counter: 0, deviceType: "multiDevice", backedUp: true });
      await db.insert(parentAuthSession).values({ id: crypto.randomUUID(), token: crypto.randomUUID(), userId: user, expiresAt: new Date(Date.now() + 86_400_000) });
      // Parents.* and Roster.* hold no Admin-only permission: no section.
      expect(resetSection(await personPage(ana.id))).toBe("");
      await asAdmin();
      const html = await personPage(ana.id);
      const section = resetSection(html);
      for (const shown of ["Reset sign-in</h2>", "<dt>Password</dt><dd>Chosen</dd>", "<dt>Passkeys</dt><dd>1</dd>", "<dt>Authenticator app</dt><dd>Off</dd>",
        "<dt>Backup codes left</dt><dd>0</dd>", "<dt>Phones and computers remembered</dt><dd>0</dd>", "<dt>Signed in now</dt><dd>On 1 phone or computer</dd>"]) expect(section).toContain(shown);
      expect(section).toContain("Resetting signs this person out everywhere and removes their password, passkeys, authenticator app and backup codes, and the phones and computers the portal remembered for them. They're emailed a new link to choose a password, which works once, for 7 days.");
      expect(section).toContain("Before you reset, call them back on a number the club already holds (on this page, on their family's page, or in the club's own records), never one the caller gives you, and make sure they asked for this.");
      expect(section).toContain("Only Admins can do this, and every other Admin sees it on their home page for a week.");
      expect(section).toContain("I called them back on a number the club already holds, and they asked for this");
      expect(section).toContain("Why? (staff only)");
      expect(section).toContain(">Reset sign-in</button>");
      expect(html.replaceAll("&#x27;", "'")).not.toContain("Ana's secret laptop");
      expect(section).not.toContain("ana@example.com");
      expect(section).not.toContain("cred-ana-1");
    });

    it("says at Strict what the link leads to, and Standard's words at Standard", async () => {
      await asAdmin();
      const ana = await anaRow();
      const standard = resetSection(await personPage(ana.id));
      expect(standard).toContain("which works once, for 7 days. Choosing it signs them in on that phone or computer; on another one they sign in with that password and a code emailed to them. They can then add a passkey or an authenticator app again. Their families, forms and everything else stay as they are.");
      await seedParentSettings({ level: "strict" });
      const strict = resetSection(await personPage(ana.id));
      expect(strict).toContain("which works once, for 7 days. The club is at Strict: once they've chosen a password, the portal asks them to add a passkey or an authenticator app before they see anything else. Their families, forms and everything else stay as they are.");
      expect(strict).not.toContain("Choosing it signs them in");
    });

    it("says why there is nothing to reset for a blocked person, one who can't sign in, and while sign-ins are off", async () => {
      await asAdmin();
      const ana = await anaRow();
      await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
      expect(resetSection(await personPage(ana.id))).toContain("This person is blocked, so there's nothing to reset. Unblock them first if they should sign in again.");
      await db.update(parent).set({ blocked: false }).where(eq(parent.id, ana.id));
      await seedParentSettings({ signin: false });
      expect(resetSection(await personPage(ana.id))).toContain("Parent sign-ins are switched off, so there's nothing to reset.");
      await seedParentSettings(SIGNINS_ON);
      await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.parentId, ana.id));
      const section = resetSection(await personPage(ana.id));
      expect(section).toContain("This person can't sign in to any family right now, so there's nothing to reset.");
      expect(section).not.toContain(">Reset sign-in</button>");
    });

    it("its action needs the Admin-only permission, refuses what no page sends, and answers each outcome in words", async () => {
      const ana = await anaRow();
      await expect(resetSigninAction(ana.id, "She lost her phone.", true)).rejects.toBeInstanceOf(AccessDenied);
      await asAdmin();
      const loose = resetSigninAction as unknown as (...a: unknown[]) => Promise<unknown>;
      for (const args of [[{ id: ana.id }, "reason", true], ["not-an-id", "reason", true], [ana.id, 5, true], [ana.id, "x".repeat(2001), true], [ana.id, "reason", "yes"]]) {
        expect(await loose(...args)).toEqual({ ok: false, errors: [BROWSER] });
      }
      const ASK = "Tick the box to say you called them back, and say why, in a few words. Only staff see it.";
      expect(await resetSigninAction(ana.id, "She lost her phone.", false)).toEqual({ ok: false, errors: [ASK] });
      expect(await resetSigninAction(ana.id, "   ", true)).toEqual({ ok: false, errors: [ASK] });
      expect(await audits("parent.signin.reset")).toEqual([]);
      expect(revalidated.count).toBe(0);
      // Outgoing mail isn't set up here: the reset stands, and the answer says the email couldn't be sent and what to do.
      expect(await resetSigninAction(ana.id, "She lost her phone.", true)).toEqual({ ok: true, status: "attention",
        message: "Their sign-in was reset and they're signed out everywhere, but the email with the link couldn't be sent. Check outgoing mail under Settings, Outgoing mail, then, in a minute, send them a link with Resend welcome email. A welcome email the portal sends them meanwhile won't carry one." });
      expect((await audits("parent.signin.reset"))[0]).toMatchObject({ targetId: ana.id, permission: "Parents.SignInReset.ReadWrite", after: { reason: "She lost her phone.", calledBack: true } });
      expect(revalidated.count).toBe(1);
      // The mail taken as handed over without sending it: the words are what is tested here.
      const spy = vi.spyOn(sendModule, "sendMail").mockResolvedValue({ ok: true });
      try {
        const done = await resetSigninAction(ana.id, "She lost her phone.", true);
        expect(done).toEqual({ ok: true, message: "Reset. They're signed out everywhere, and a link to choose a new password is on its way to ana@example.com." });
        expect(JSON.stringify(done)).not.toContain("/sign-in/set-up/");
      } finally { spy.mockRestore(); }
    });

    it("refuses in words a blocked person, sign-ins switched off, one who can't sign in and a person no longer in the portal", async () => {
      await asAdmin();
      const ana = await anaRow();
      await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
      expect(await resetSigninAction(ana.id, "She lost her phone.", true)).toEqual({ ok: false, errors: ["This person is blocked. Unblock them first if they should sign in again."] });
      await db.update(parent).set({ blocked: false }).where(eq(parent.id, ana.id));
      await seedParentSettings({ signin: false });
      expect(await resetSigninAction(ana.id, "She lost her phone.", true)).toEqual({ ok: false, errors: ["Parent sign-ins are switched off, so nothing was reset."] });
      await seedParentSettings(SIGNINS_ON);
      await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.parentId, ana.id));
      expect(await resetSigninAction(ana.id, "She lost her phone.", true)).toEqual({ ok: false, errors: ["This person can't sign in to any family right now, so there's nothing to reset."] });
      expect(await resetSigninAction("00000000-0000-4000-8000-00000000dead", "She lost her phone.", true)).toEqual({ ok: false, errors: ["That person isn't in the portal any more."] });
      expect(await audits("parent.signin.reset")).toEqual([]);
    });
  });
});
