import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.41" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
  usePathname: () => "/staff/roster",
  useSearchParams: () => new URLSearchParams(),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, setting, student, writeQueue } from "@/lib/db/schema";
import RosterPage from "@/app/staff/(app)/roster/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { addStudentAction, addStudentHereAction, createAction, createAndLinkAction, deactivateAction, deactivateHereAction, deactivateLinkedAction, giveUpAction, moveAction, renameHereAction, renameLinkedAction, tryAgainAction } from "@/app/staff/(app)/roster/write-actions";
import { addGuardianAction } from "@/app/staff/(app)/parents/actions";
import { setRequireStudents } from "@/lib/parents/switches";
import { addFamilyByHand, BY_HAND_COPY, changeByHand } from "@/lib/families/by-hand";
import { BY_HAND, howToAdd } from "@/lib/families/how-to-add";
import { accountingOn } from "@/plugins";
import { asAppFamilyId, type AppFamilyId } from "@/lib/families/ids";
import { accountingOff, resetDb, seedStaff } from "../helpers/db";
import { rowNamed } from "../helpers/table";

// Families and students with no books (stage 5's slice P2, docs/superpowers/specs/2026-11-28-accounting-plugin-design.md
// section 2): with no accounting plugin on, staff run the roster by hand from the Families pages. Each change saves at
// once with its audit row, and nothing leaves the portal. With QuickBooks on, adding goes the way it went
// (tests/integration/families-by-hand.test.ts and the other roster tests, which run with QuickBooks on).

const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const familyNamed = async (name: string) => (await db.select().from(family).where(eq(family.name, name)))[0]!;
const studentNamed = async (name: string) => (await db.select().from(student).where(eq(student.name, name)))[0]!;
const list = async (q?: string) => renderToStaticMarkup(await RosterPage({ searchParams: Promise.resolve(q ? { q } : {}) }));
const entry = async (id: AppFamilyId) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id: String(id) }) }));
const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null, permission: "Settings.Parents.ReadWrite" };

let fetched: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  await resetDb();
  await accountingOff();
  const s = await seedStaff({ email: "registrar@club.org", name: "Reg Istrar", admin: true });
  who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
  // Nothing leaves the portal: no request to QuickBooks, the relay or anyone else.
  fetched = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetched).not.toHaveBeenCalled();
  fetched.mockRestore();
});

describe("how a family is added", () => {
  it("is QuickBooks' way while it is on, and the core's by hand while no books are kept", async () => {
    expect(await howToAdd()).toBe(BY_HAND);
    await db.update(setting).set({ value: ["quickbooks"] }).where(eq(setting.key, "plugins.on"));
    expect((await accountingOn())?.key).toBe("quickbooks");
    expect(await howToAdd()).not.toBe(BY_HAND);
    expect(await howToAdd()).toBe((await accountingOn())!.slots["families.howToAdd"]);
  });
});

describe("with no books, staff", () => {
  it("add a family, audited, sending nothing, and are refused a name another active family has", async () => {
    expect(await createAction("none", "family", "  Rivera   Family ")).toEqual({ ok: true, message: "Added Rivera Family. Add its students and guardians on its page." });
    const f = await familyNamed("Rivera Family");
    expect(f.active).toBe(true);
    const [row] = await audits("roster.family.added");
    expect(row).toMatchObject({ door: "staff", permission: "Roster.Family.ReadWrite", targetType: "family", targetId: String(f.id),
      after: { familyId: String(f.id), name: "Rivera Family", role: "family", books: "none" } });
    expect(await createAction("none", "family", "rivera family")).toEqual({ ok: false, offer: "rivera family (2)",
      errors: ["Another family is called “rivera family”, and every family's name must be different. You could use “rivera family (2)” instead."] });
    expect(await createAction("none", "family", "   ")).toEqual({ ok: false, errors: ["Enter a name."] });
    // A colon is QuickBooks' rule, not the portal's.
    expect((await createAction("none", "family", "Rivera: Smith")).ok).toBe(true);
    // A member is the books' idea.
    expect(await createAction("none", "member", "Solo")).toEqual({ ok: false, errors: [BY_HAND_COPY.familyOnly] });
    expect(await db.select().from(writeQueue)).toEqual([]);
  });

  it("add, rename and make inactive a student, and rename and make inactive a family with its students", async () => {
    await createAction("none", "family", "Chen Family");
    const f = await familyNamed("Chen Family");
    // Either of the family page's forms adds the portal's student.
    expect(await addStudentHereAction("none", String(f.id), "Mei Chen")).toEqual({ ok: true, message: "Added Mei Chen to Chen Family." });
    expect(await addStudentAction("none", String(f.id), "Li Chen")).toEqual({ ok: true, message: "Added Li Chen to Chen Family." });
    const mei = await studentNamed("Mei Chen");
    expect(mei.familyId).toEqual(f.id);
    expect((await audits("roster.student.added")).map((r) => r.after)).toEqual([
      { studentId: String(mei.id), familyId: String(f.id), name: "Mei Chen", books: "none" }, expect.objectContaining({ name: "Li Chen" })]);

    expect(await renameHereAction("none", "student", String(mei.id), "Mei L. Chen")).toEqual({ ok: true, message: "Renamed Mei Chen to Mei L. Chen." });
    // The forms of a linked record reach the same change while no books are kept.
    expect(await renameLinkedAction("none", "family", String(f.id), "The Chens")).toEqual({ ok: true, message: "Renamed Chen Family to The Chens." });
    expect(await renameHereAction("none", "family", String(f.id), "The Chens")).toEqual({ ok: false, errors: [BY_HAND_COPY.alreadyNamed] });
    expect((await audits("roster.record.renamed")).map((r) => r.after)).toEqual([
      { kind: "student", studentId: String(mei.id), familyId: String(f.id), name: "Mei L. Chen", books: "none" },
      { kind: "family", familyId: String(f.id), name: "The Chens", books: "none" }]);

    expect(await deactivateLinkedAction("none", "student", String(mei.id))).toEqual({ ok: true, message: "Made Mei L. Chen inactive." });
    expect(await renameHereAction("none", "student", String(mei.id), "Again")).toEqual({ ok: false, errors: [BY_HAND_COPY.inactive] });
    expect(await deactivateHereAction("none", "family", String(f.id))).toEqual({ ok: true, message: "Made The Chens inactive, with its student." });
    expect((await db.select().from(student).where(eq(student.familyId, f.id))).map((s) => s.active)).toEqual([false, false]);
    expect((await audits("roster.record.made_inactive")).map((r) => r.targetType)).toEqual(["student", "family"]);
    expect(await addStudentHereAction("none", String(f.id), "Late")).toEqual({ ok: false, errors: [BY_HAND_COPY.inactive] });
    expect(await db.select().from(writeQueue)).toEqual([]);
  });

  it("move a student, with the move's follow-ups, and say what it did to who signs in", async () => {
    await setRequireStudents(true, admin);
    await createAction("none", "family", "From Family");
    await createAction("none", "family", "To Family");
    const from = await familyNamed("From Family"), to = await familyNamed("To Family");
    expect(await addStudentHereAction("none", String(from.id), "Sam")).toEqual({ ok: true,
      message: "Added Sam to From Family. From Family has an active student now, so its guardians can sign in to it." });
    const sam = await studentNamed("Sam");
    expect(await moveAction("none", String(sam.id), String(to.id))).toEqual({ ok: true,
      message: "Moved Sam to To Family. From Family has no active student now, so its guardians can't sign in to it until it has one again. To Family has an active student now, so its guardians can sign in to it." });
    expect((await studentNamed("Sam")).familyId).toEqual(to.id);
    expect((await audits("roster.record.moved"))[0]!.after).toEqual({ kind: "student", studentId: String(sam.id), familyId: String(to.id), fromFamilyId: String(from.id), books: "none" });
    expect((await audits("roster.student.move.followed"))[0]!.after).toMatchObject({ studentId: String(sam.id), formsMoved: 0, placesGivenUp: 0 });
    expect(await moveAction("none", String(sam.id), String(to.id))).toEqual({ ok: false, errors: [BY_HAND_COPY.alreadyThere] });
    expect(await moveAction("none", String(sam.id), "00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, errors: [BY_HAND_COPY.notToFamily] });
  });

  it("add a guardian to a family the portal keeps", async () => {
    await createAction("none", "family", "Ortiz Family");
    const f = await familyNamed("Ortiz Family");
    const r = await addGuardianAction(String(f.id), "Ana Ortiz", "ana@example.com");
    expect(r.ok).toBe(true);
    expect((await db.select().from(guardian).where(eq(guardian.familyId, f.id)))).toHaveLength(1);
    // Its save's event (records.events) has no handler with no books: nothing is queued for any books.
    expect(await db.select().from(writeQueue)).toEqual([]);
  });

  it("are refused, changing nothing, once the books were turned on after the page was drawn", async () => {
    await createAction("none", "family", "Kim Family");
    const f = await familyNamed("Kim Family");
    await db.update(setting).set({ value: ["quickbooks"] }).where(eq(setting.key, "plugins.on"));
    const op = { actor: { door: "staff" as const, id: who.staff!.staffUserId, label: who.staff!.email }, ip: null, permission: "Roster.Family.ReadWrite" };
    expect(await addFamilyByHand({ role: "family", name: "Late Family", typeQboId: null }, op)).toEqual({ ok: false, errors: [BY_HAND_COPY.booksOn] });
    expect(await changeByHand({ op: "rename_family", familyId: String(f.id), name: "Changed" }, op)).toEqual({ ok: false, errors: [BY_HAND_COPY.booksOn] });
    expect((await familyNamed("Kim Family")).name).toBe("Kim Family");
    expect(await audits("roster.record.renamed")).toEqual([]);
  });

  it("are offered none of QuickBooks' own presses, which answer as a press no page offered", async () => {
    await createAction("none", "family", "Ng Family");
    const f = await familyNamed("Ng Family");
    const NOT = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
    expect(await createAndLinkAction("none", String(f.id))).toEqual(NOT);
    expect(await deactivateAction("none", "10", "0")).toEqual(NOT);
    expect(await tryAgainAction("00000000-0000-4000-8000-000000000000")).toEqual(NOT);
    expect(await giveUpAction("00000000-0000-4000-8000-000000000000", "note")).toEqual(NOT);
  });

  it("are refused for ids that name no record", async () => {
    const nobody = "00000000-0000-4000-8000-000000000000";
    expect(await addStudentHereAction("none", nobody, "X")).toEqual({ ok: false, errors: [BY_HAND_COPY.gone] });
    expect(await renameHereAction("none", "student", nobody, "X")).toEqual({ ok: false, errors: [BY_HAND_COPY.gone] });
    expect(await deactivateHereAction("none", "family", nobody)).toEqual({ ok: false, errors: [BY_HAND_COPY.gone] });
  });
});

describe("the Families pages with no books", () => {
  it("list every family with its counts and standing, find by name, and offer adding one, naming no books", async () => {
    await createAction("none", "family", "Rivera Family");
    await createAction("none", "family", "Chen Family");
    const rivera = await familyNamed("Rivera Family");
    await addStudentHereAction("none", String(rivera.id), "Leo Rivera");
    await addGuardianAction(String(rivera.id), "Ana Rivera", "ana@example.com");
    await deactivateHereAction("none", "family", String((await familyNamed("Chen Family")).id));
    const html = await list();
    expect(rowNamed(html, "Rivera Family")).toEqual(["Rivera Family", "1", "1", "Active"]);
    expect(rowNamed(html, "Chen Family")).toEqual(["Chen Family", "0", "0", "Inactive"]);
    expect(html).toContain(`href="/staff/roster/${rivera.id}"`);
    expect(html).toContain("Add a family");
    expect(html).not.toMatch(/QuickBooks|the books|customer/i);
    const found = await list("RIVER");
    expect(found).toContain("Rivera Family");
    expect(found).not.toContain("Chen Family");
    expect(await list("<b>")).toContain("No family matches &quot;&lt;b&gt;&quot;");
  });

  it("show a family's students, its changes and its sign-ins, recording the read first, naming no books", async () => {
    await createAction("none", "family", "Rivera Family");
    const f = await familyNamed("Rivera Family");
    await addStudentHereAction("none", String(f.id), "Leo Rivera");
    await addGuardianAction(String(f.id), "Ana Rivera", "ana@example.com");
    const html = await entry(f.id);
    expect(rowNamed(html, "Leo Rivera")!.slice(0, 2)).toEqual(["Leo Rivera", "Active"]);
    expect(rowNamed(html, "Leo Rivera")![2]).toMatch(/^Change Leo Rivera/); // the row's own Drawer
    for (const words of ["Change the family", "Rename or make Rivera Family inactive", "Add a student", "Change Leo Rivera", "Portal sign-ins", "Ana Rivera", "Add a guardian"]) expect(html).toContain(words);
    expect(html).not.toMatch(/QuickBooks|the books|customer|invoice|buy-out/i);
    expect((await audits("roster.family.read")).map((r) => r.targetId)).toEqual([String(f.id)]);
  });

  it("answer not found for an address that names no family", async () => {
    await expect(entry(asAppFamilyId("00000000-0000-4000-8000-000000000000"))).rejects.toMatchObject({ notFound: true });
    expect(await audits("roster.family.read")).toEqual([]);
  });
});
