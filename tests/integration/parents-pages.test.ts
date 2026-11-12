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
import { auditLog, heldAddress, jobRun, parent, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { runReconcile } from "@/lib/parents/reconcile";
import { loadRosterPage } from "@/lib/roster/queries";
import { ROSTER_JOB, setRosterSource } from "@/lib/roster/source";
import ParentsPage from "@/app/staff/(app)/parents/page";
import PersonPage from "@/app/staff/(app)/parents/[id]/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import StaffHome from "@/app/staff/(app)/page";
import ChooseFamily from "@/app/choose-family/page";
import { decideHoldAction, reverseHoldAction, blockAction, unblockAction, resendWelcomeAction } from "@/app/staff/(app)/parents/actions";
import { resetDb, seedGuardian, seedStaff } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";

const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const thrown = async (p: Promise<unknown>) => (await p.catch((e: { url?: string; notFound?: boolean }) => e)) as { url?: string; notFound?: boolean };

const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("13", "Shared Sam", "10", "sam@example.com"),
  fam("20", "Chen <b>Family</b>"), par("21", "Shared Sam", "20", "sam@example.com")];
const parentsPage = async (q?: string) => renderToStaticMarkup(await ParentsPage({ searchParams: Promise.resolve(q ? { q } : {}) }));
const personPage = async (id: string) => renderToStaticMarkup(await PersonPage({ params: Promise.resolve({ id }) }));
const familyPage = async (id: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id }) }));
/** The staff home holds async server components, which only a rendering that waits for data can render. */
// Its text-node separators (<!-- -->) are dropped, as renderToStaticMarkup would not write them.
const staffHome = async () => (await new Response((await prerender(await StaffHome())).prelude).text()).replaceAll("<!-- -->", "");
const BROWSER = "That didn't go through. Reload the page and try again.";

describe("the staff pages for parents", () => {
  let registrar: Awaited<ReturnType<typeof seedStaff>>, reader: Awaited<ReturnType<typeof seedStaff>>;
  const as = (s: typeof registrar) => { who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email }; };
  beforeEach(async () => {
    who.parentState = { status: "none" }; revalidated.count = 0;
    await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); await seedCache(ALL);
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
    await runReconcile({ cause: "test" });
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

  it("refuses the Parents pages and every action without Parents.ReadWrite", async () => {
    as(reader);
    const [ana] = await db.select().from(parent);
    expect((await thrown(ParentsPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: ana!.id }) }))).url).toBe("/refused");
    await expect(decideHoldAction("sam@example.com", "same_person", ["10", "20"], "note")).rejects.toBeInstanceOf(AccessDenied);
    await expect(reverseHoldAction("sam@example.com", "note")).rejects.toBeInstanceOf(AccessDenied);
    await expect(blockAction(ana!.id, "reason")).rejects.toBeInstanceOf(AccessDenied);
    await expect(unblockAction(ana!.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(resendWelcomeAction(ana!.id)).rejects.toBeInstanceOf(AccessDenied);
    expect(await audits("parent.read")).toEqual([]);
  });

  it("lists what is waiting with both families and the names on the records, as text", async () => {
    const html = await parentsPage();
    expect(html).toContain("To review (1)");
    expect(html).toContain("sam@example.com");
    expect(html).toContain("Rivera Family");
    expect(html).toContain("Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(html).not.toContain("<b>Family</b>");
    expect(html).toContain("Same person");
    expect(html).toContain("Not the same person");
  });

  it("lists people and finds them, and says where names and addresses are changed", async () => {
    const html = await parentsPage();
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Can sign in (hasn&#x27;t yet)");
    expect(html).toContain("Names and email addresses are changed in QuickBooks");
    expect(html).toContain('<span class="when">Never signed in · Not welcomed yet</span>');
    expect(await parentsPage("zzz")).toContain("Nobody matches");
    const [ana] = await db.select().from(parent);
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") });
    await db.insert(auditLog).values({ door: "parent", actorId: ana!.id, actorLabel: ana!.email, action: "signin", targetType: "parent", targetId: ana!.id, at: new Date("2026-11-05T12:00:00Z") });
    const dated = await parentsPage();
    expect(dated).toContain('<span class="when">Last signed in <time dateTime="2026-11-05T12:00:00.000Z" title="2026-11-05T12:00:00.000Z">');
    expect(dated).toContain(' · Welcomed <time dateTime="2026-11-01T12:00:00.000Z" title="2026-11-01T12:00:00.000Z">');
  });

  it("deciding and reversing go through the actions, and the page follows", async () => {
    expect(await decideHoldAction("sam@example.com", "same_person", ["10", "20"], "Sam confirmed by phone.")).toEqual({ ok: true, message: "Saved. They can sign in to each of those families now." });
    expect(await parentsPage()).toContain("Nothing is waiting");
    expect((await audits("parent.hold.decided"))[0]).toMatchObject({ actorId: registrar.id, permission: "Parents.ReadWrite", ip: "203.0.113.40" });
    expect(await decideHoldAction("sam@example.com", "same_person", ["10", "20"], "Again.")).toEqual({ ok: false, errors: ["That address isn't held any more. Reload the page."] });
    expect(await decideHoldAction("sam@example.com", "same_person", ["10", "20"], "  ")).toEqual({ ok: false, errors: ["Add a short note saying how you know."] });
    expect(await reverseHoldAction("sam@example.com", "Wrong after all.")).toEqual({ ok: true, message: "Reversed. The address is held again." });
    expect(await parentsPage()).toContain("To review (1)");
  });

  it("refuses a decision on a different set of families than the address is under now", async () => {
    expect(await decideHoldAction("sam@example.com", "same_person", ["10"], "Sam confirmed by phone.")).toEqual({ ok: false, errors: ["That address has changed since this page loaded. Reload the page and look again."] });
    expect(await decideHoldAction("sam@example.com", "not_same", ["10", "20", "30"], "Sam confirmed by phone.")).toEqual({ ok: false, errors: ["That address has changed since this page loaded. Reload the page and look again."] });
    expect(await audits("parent.hold.decided")).toEqual([]);
  });

  it("refuses arguments no page sends, without touching the database", async () => {
    const decide = decideHoldAction as (...a: unknown[]) => Promise<unknown>;
    const refused = { ok: false, errors: [BROWSER] };
    for (const args of [
      ["sam@example.com", "same_person", "10,20", "Sam confirmed by phone."],
      ["sam@example.com", "same_person", { 0: "10", 1: "20", length: 2 }, "Sam confirmed by phone."],
      ["sam@example.com", "same_person", ["10", 20], "Sam confirmed by phone."],
      ["sam@example.com", "same_person", ["10", "x".repeat(65)], "Sam confirmed by phone."],
      ["sam@example.com", "same_person", Array.from({ length: 51 }, (_, i) => String(i)), "Sam confirmed by phone."],
      [["sam@example.com"], "same_person", ["10", "20"], "Sam confirmed by phone."],
      ["sam@example.com", "maybe", ["10", "20"], "Sam confirmed by phone."],
      ["sam@example.com", "same_person", ["10", "20"], { note: "x" }],
      ["sam@example.com", "same_person", ["10", "20"], "x".repeat(2001)],
    ]) expect(await decide(...args)).toEqual(refused);
    const [ana] = await db.select().from(parent);
    const loose = (f: unknown) => f as (...a: unknown[]) => Promise<unknown>;
    expect(await loose(reverseHoldAction)(42, "note")).toEqual(refused);
    expect(await loose(reverseHoldAction)("sam@example.com", "x".repeat(2001))).toEqual(refused);
    expect(await loose(blockAction)({ id: ana!.id }, "reason")).toEqual(refused);
    expect(await loose(blockAction)("x".repeat(65), "reason")).toEqual(refused);
    expect(await loose(blockAction)("not-an-id", "reason")).toEqual(refused);
    expect(await loose(blockAction)(ana!.id, "x".repeat(2001))).toEqual(refused);
    expect(await loose(unblockAction)([ana!.id])).toEqual(refused);
    expect(await loose(resendWelcomeAction)(null)).toEqual(refused);
    expect(await db.select().from(heldAddress)).toMatchObject([{ email: "sam@example.com", approvedFamilyQboIds: [], rejectedFamilyQboIds: [] }]);
    expect((await db.select().from(parent))[0]).toMatchObject({ blocked: false });
    expect((await db.select().from(auditLog)).filter((r) => r.action.startsWith("parent.") && r.action !== "parent.hold.opened" && r.action !== "parent.access.granted")).toEqual([]);
    expect(revalidated.count).toBe(0);
  });

  it("a person's page shows their families and is recorded as a read", async () => {
    const [ana] = await db.select().from(parent);
    const html = await personPage(ana!.id);
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Rivera Family");
    expect(html).toContain('href="/staff/roster/10"');
    expect(html).toContain("Resend welcome email");
    expect(html).toContain("Block");
    expect(await audits("parent.read")).toEqual([expect.objectContaining({ actorId: registrar.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: ana!.id })]);
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: "not-an-id" }) }))).notFound).toBe(true);
    expect((await thrown(PersonPage({ params: Promise.resolve({ id: "00000000-0000-4000-8000-00000000dead" }) }))).notFound).toBe(true);
    expect(await audits("parent.read")).toHaveLength(1); // an unknown ID records no read
  });

  it("names a link from a previous QuickBooks company without looking up or linking its old family ID", async () => {
    const [ana] = await db.select().from(parent);
    // "20" is that company's ID; in the connected company it names Chen <b>Family</b>, which is not where this link came from.
    await seedGuardian({ parentId: ana!.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    const html = await personPage(ana!.id);
    expect(html).toContain("A family in the previous QuickBooks company");
    expect(html).not.toContain('href="/staff/roster/20"');
    expect(html).not.toContain("Chen");
    const people = (await parentsPage("ana")).split('id="people-h"')[1]!; // To review above it names Chen as Sam's other family
    expect(people).toContain("A family in the previous QuickBooks company: Can&#x27;t sign in: a different QuickBooks company was connected");
    expect(people).not.toContain("Chen");
  });

  it("blocks with a reason and unblocks, through the actions", async () => {
    const [ana] = await db.select().from(parent);
    expect(await blockAction(ana!.id, "  ")).toEqual({ ok: false, errors: ["Say why, in a few words. Only staff see it."] });
    expect(await blockAction(ana!.id, "Custody order on file.")).toEqual({ ok: true, message: "Blocked. They are signed out and can't get a code." });
    const html = await personPage(ana!.id);
    expect(html).toContain("Blocked");
    expect(html).toContain("Custody order on file.");
    expect(html).toContain("Unblock");
    expect(await unblockAction(ana!.id)).toEqual({ ok: true, message: "Unblocked." });
    const refreshed = revalidated.count;
    // Not blocked: nothing changes, and the page is not rendered again, so no further read is recorded.
    expect(await unblockAction(ana!.id)).toEqual({ ok: true, message: "This person isn't blocked." });
    expect(revalidated.count).toBe(refreshed);
    expect(await audits("parent.unblock")).toHaveLength(1);
    expect(await blockAction("00000000-0000-4000-8000-00000000dead", "Custody order on file.")).toEqual({ ok: false, errors: ["That person isn't in the portal any more."] });
  });

  it("a resend is refused while parent sign-ins are switched off", async () => {
    const [ana] = await db.select().from(parent);
    await seedParentSettings({ signin: false });
    expect(await resendWelcomeAction(ana!.id)).toEqual({ ok: false, errors: ["This person can't sign in to any family right now, so no email was sent."] });
    const html = await personPage(ana!.id);
    expect(html).toContain("Parent sign-ins are switched off, so no welcome can be sent.");
    expect(html).not.toContain("Resend welcome email");
  });

  it("a family's roster page shows each sign-in's standing; only Parents.ReadWrite sees the other family and gets links", async () => {
    const [ana] = await db.select().from(parent);
    const detailed = await familyPage("10");
    expect(detailed).toContain("Held: this address is also under Chen &lt;b&gt;Family&lt;/b&gt;");
    expect(detailed).toContain(`href="/staff/parents/${ana!.id}"`);
    as(reader);
    const plain = await familyPage("10");
    expect(plain).toContain("Can sign in (hasn&#x27;t yet)");
    expect(plain).toContain("Held: this address is also under another family");
    expect(plain).not.toContain("Chen");
    expect(plain).not.toContain("/staff/parents/");
  });

  // Server rendering never reports a repeated key; the key's parts (the source ID) are checked in parents-directory.test.ts.
  it("lists two same-named people with no address in one family as two rows", async () => {
    await seedCache([...ALL, par("14", "Pat Rivera", "10", null), par("15", "Pat Rivera", "10", null)]);
    await runReconcile({ cause: "test" });
    const html = await familyPage("10");
    expect(html.match(/<span class="what">Pat Rivera<\/span><span class="when">Can&#x27;t sign in: no email address in QuickBooks<\/span>/g)).toHaveLength(2);
  });

  it("the staff home tells people who can act that something is waiting, and nobody else", async () => {
    expect(await staffHome()).toContain("1 address to review");
    as(reader);
    const plain = await staffHome();
    expect(plain).toContain("Hi, Rae");
    expect(plain).not.toContain("to review");
  });

  it("Needs attention on the roster lists the new kinds without naming a held address's families", async () => {
    const page = await loadRosterPage();
    expect(page.attention.map((a) => a.rule)).toEqual(expect.arrayContaining(["held_address", "family_no_signin"]));
    const held = page.attention.find((a) => a.rule === "held_address")!;
    expect(`${held.name}${held.detail}`).not.toMatch(/Rivera|Chen|sam@example\.com/);
  });

  it("the family chooser names each family from the roster, and a stand-in for one it doesn't know", async () => {
    const [ana] = await db.select().from(parent);
    who.parentState = { status: "choose", parentId: ana!.id, sessionId: "s1", name: ana!.name,
      families: [{ guardianId: "g1", familyQboId: "10" }, { guardianId: "g2", familyQboId: "NOPE" }] };
    const html = renderToStaticMarkup(await ChooseFamily());
    expect(html).toContain("Rivera Family");
    expect(html).toContain("Family account NOPE");
  });
});
