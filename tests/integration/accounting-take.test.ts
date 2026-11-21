import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
// Mail goes to an outbox: the guardians told that a moved student's places were given up.
type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, qboConnection, student, volunteerSignup, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, QUEUE_IN_THE_WAY, type LinkRow, type LinksView, type TakeOffer } from "@/lib/accounting/mapping";
import { LINK_COPY } from "@/lib/accounting/link-writes";
import { takeStamp } from "@/lib/accounting/stamp";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { refreshRoster } from "@/lib/roster/refresh";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { FAMILY_BEING_CHANGED, FAMILY_WAITING, MOVE_PENDING, SENDING_LOCK, STUDENT_BEING_CHANGED, TAKE_CHANGED, takeFromBooks, WRITE_COPY } from "@/lib/roster/writes";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { takeDifferenceAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedGuardian, seedParent, seedWorkingMail } from "../helpers/db";
import { formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason } from "../helpers/season";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { auditsOf, connectRoster, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Take QuickBooks' into the app (stage 4's slice M4a of the app-owned families spec; section 5, "Differences"; open
 * questions 1, 12 and 14; takeFromBooks() in src/lib/roster/writes.ts, the press takeDifferenceAction()): on Accounting
 * links, a name, a record the books have inactive and the family a student is under are taken into the portal's own
 * record, sending nothing to QuickBooks, each audited `accounting.difference.take`. The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Rivera Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12 (Student), Chen Family 20
 * with Mei Chen 21 (Parent). The books change only through a roster read of the stub (readAgain(), changeInBooks(), as
 * each accounting test defines them for itself), which makes no record; customers added before any record is changed
 * in the portal are imported (syncAppRecords()), never after.
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };
/** Holds one of the advisory locks a send holds, for as long as `run` takes, on another connection. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

const INACTIVE_HERE = "That is inactive in the portal, so nothing was changed.";
let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
/** The row's take of this field, as the page draws it now. */
const offerOf = async (name: string, field: TakeOffer["field"]): Promise<TakeOffer> => {
  const t = rowOf(await loadAccountingLinks(), name).takes.find((x) => x.field === field);
  if (!t) throw new Error(`the row ${name} offers no take of ${field}`);
  return t;
};
/** The press as the page binds it, or as the browser could call it with these values. */
const pressWith = (field: TakeOffer["field"], kind: "family" | "student", recordId: string, stamp: string, t = tag) =>
  takeFromBooks(field === "place" ? { field, studentId: recordId, stamp } : { field, kind, recordId, stamp }, t, linkOp());
const press = (o: TakeOffer) => pressWith(o.field, o.kind, o.recordId, o.stamp);
const takes = () => auditsOf("accounting.difference.take");
const familyRow = async (id: AppFamilyId) => (await db.select().from(family).where(eq(family.id, id)))[0]!;
const studentRow = async (id: AppStudentId) => (await db.select().from(student).where(eq(student.id, id)))[0]!;
/** Every request made to the books since the calls were last cleared, but the roster's own reads: what a press could have sent. */
const sentSince = () => stub.apiCalls().filter((c) => c.method !== "GET");

let rivera: AppFamilyId, chen: AppFamilyId, leo: AppStudentId;
let ana: Awaited<ReturnType<typeof seedAnaRivera>>["ana"];
beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = [];
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
});
/** The layered company, Ana Rivera's guardian row in the Rivera family. */
async function layered() {
  tag = await connectRoster(stub);
  ({ ana } = await seedAnaRivera());
  [rivera, chen, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("12", "student")];
}

describe("a name taken from the books", () => {
  beforeEach(layered);

  it("the family's: the record renamed, nothing sent, one take row, and the difference gone", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household" });
    await readAgain();
    const offer = await offerOf("Rivera Family", "name");
    expect(offer).toMatchObject({ kind: "family", recordId: String(rivera), about: "Rivera Family's name",
      words: ["Takes “Rivera Household” as this family's name in the portal, as the books have it. Nothing is sent to the books."] });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Renamed Rivera Household in the portal, as the books have it. Nothing was sent to the books." });
    expect(stub.apiCalls()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Household", active: true });
    const [row, ...more] = await takes();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ targetType: "family", targetId: String(rivera), permission: "Accounting.Link.ReadWrite", before: { name: "Rivera Family" },
      after: { field: "name", kind: "family", familyId: String(rivera), customerQboId: "10", name: "Rivera Household", replaced: [] } });
    expect(await auditsOf("roster.record.renamed")).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(rowOf(await loadAccountingLinks(), "Rivera Household").differences).toEqual([]);
  });

  it("a student's, taking the place of a rename the books refused, which is closed and said", async () => {
    // The portal renamed Leo, and the books refused it: kept on Reconciliation. The books' name is taken instead.
    await db.update(student).set({ name: "Leon Rivera" }).where(eq(student.id, leo));
    const kept = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" }, { state: "refused", code: "fault_6240" });
    const offer = await offerOf("Rivera Family", "name");
    expect(offer).toMatchObject({ kind: "student", recordId: String(leo), about: "Leon Rivera's name" });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true,
      message: "Renamed Leo Rivera in the portal, as the books have it. Nothing was sent to the books. The rename kept on the Reconciliation page is closed, as this takes its place." });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ name: "Leo Rivera", familyId: rivera });
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, kept.id)))[0]).toMatchObject({ state: "given_up" });
    expect(await takes()).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo), before: { name: "Leon Rivera" },
      after: { field: "name", kind: "student", familyId: String(rivera), studentId: String(leo), customerQboId: "12", name: "Leo Rivera", replaced: [kept.id] } })]);
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
  });

  it("refused, changing nothing: a stale stamp, a name the portal can't take, one another family holds, a rename waiting, the record made inactive, the lock held", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household" });
    changeInBooks("12", { DisplayName: "Leo M. Rivera" });
    await readAgain();
    const familyOffer = await offerOf("Rivera Family", "name");
    const leos = rowOf(await loadAccountingLinks(), "Rivera Family").takes.find((t) => t.kind === "student")!;
    // The books renamed again by a read after the page was drawn.
    changeInBooks("10", { DisplayName: "Rivera House" });
    await readAgain();
    stub.calls.length = 0;
    expect(await press(familyOffer)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    // A name with a colon, or over 100 characters: no press is offered, and one called anyway is refused in words.
    for (const [books, why] of [["Leo: Rivera", "A name can't have a colon in it"], ["L".repeat(101), "That name is too long"]] as const) {
      changeInBooks("12", { DisplayName: books });
      await readAgain();
      expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes.filter((t) => t.kind === "student")).toEqual([]);
      const r = await pressWith("name", "student", String(leo), takeStamp("name", String(leo), "12", [books]));
      expect(r).toMatchObject({ ok: false, errors: [expect.stringContaining(why)] });
      expect((r as { errors: string[] }).errors[0]).toContain("Rename the record on its page instead, or the customer in QuickBooks.");
    }
    // A name another active family of the portal holds: no press, and refused, with no other name offered.
    await db.update(family).set({ name: "Rivera House" }).where(eq(family.id, chen));
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes.filter((t) => t.kind === "family")).toEqual([]);
    expect(await pressWith("name", "family", String(rivera), takeStamp("name", String(rivera), "10", ["Rivera House"]))).toEqual({ ok: false,
      errors: ["Another family in the portal is called “Rivera House”, and every family's name must be different, so nothing was taken. Rename one of them on its page, or the customer in QuickBooks."] });
    await db.update(family).set({ name: "Chen Family" }).where(eq(family.id, chen));
    // A rename waiting for the customer: no press while it is on its way, and one drawn before is refused.
    changeInBooks("12", { DisplayName: "Leo M. Rivera" });
    await readAgain();
    const drawn = rowOf(await loadAccountingLinks(), "Rivera Family").takes.find((t) => t.kind === "student")!;
    expect(drawn.stamp).toBe(leos.stamp);
    const waiting = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo Rivera", was: "Leo Rivera" }, { state: "waiting" });
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes.filter((t) => t.kind === "student")).toEqual([]);
    expect(await press(drawn)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    // The lock held: a change of the record under way.
    expect(await holding(SENDING_LOCK, String(leo), () => press(drawn))).toEqual({ ok: false, errors: [STUDENT_BEING_CHANGED] });
    const theFamily = await offerOf("Rivera Family", "name");
    expect(await holding(SENDING_LOCK, String(rivera), () => press(theFamily))).toEqual({ ok: false, errors: [FAMILY_BEING_CHANGED] });
    // The record made inactive meanwhile (the test's own write: nothing else reads it before the press).
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    expect(await press(drawn)).toEqual({ ok: false, errors: [INACTIVE_HERE] });
    expect(sentSince()).toEqual([]);
    expect(await takes()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Family" });
    expect(await studentRow(leo)).toMatchObject({ name: "Leo Rivera" });
  });
});

describe("a name and inactive in flat books: the member", () => {
  beforeEach(async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    [rivera, chen] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family")];
  });

  it("its name taken, said as the member's", async () => {
    changeInBooks("10", { DisplayName: "The Riveras" });
    await readAgain();
    const offer = await offerOf("Rivera Family", "name");
    expect(offer.words).toEqual(["Takes “The Riveras” as this member's name in the portal, as the books have it. Nothing is sent to the books."]);
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Renamed The Riveras in the portal, as the books have it. Nothing was sent to the books." });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ name: "The Riveras" });
    expect(await takes()).toHaveLength(1);
  });

  it("taken as inactive: its guardians can't sign in to it after, and the answer says so", async () => {
    // A guardian of the member's record, written here (no import after it).
    const pat = await seedParent({ name: "Pat Rivera", email: "pat@example.com" });
    const row = await seedGuardian({ parentId: pat.id, familyQboId: "10" });
    await db.update(guardian).set({ familyId: rivera }).where(eq(guardian.id, row.id));
    changeInBooks("10", { Active: false });
    await readAgain();
    expect((await enterableGuardianRows(pat.id)).map((g) => g.id)).toEqual([row.id]);
    const offer = await offerOf("Rivera Family", "inactive");
    expect(offer).toMatchObject({ kind: "family", recordId: String(rivera),
      words: ["Makes Rivera Family inactive in the portal, as the books have it. Its guardians can't sign in to the member then. Nothing is sent to the books."] });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Made Rivera Family inactive in the portal, as the books have it. Nothing was sent to the books. Its guardians can't sign in to the member now." });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: false });
    expect(await enterableGuardianRows(pat.id)).toEqual([]);
    expect(await takes()).toEqual([expect.objectContaining({ targetType: "family", targetId: String(rivera), before: { active: true },
      after: { field: "inactive", kind: "family", familyId: String(rivera), customerQboId: "10", students: [], replaced: [], active: false } })]);
  });
});

describe("a record the books have inactive, taken as inactive", () => {
  beforeEach(layered);

  it("a student: made inactive, nothing sent; with the students rule in force, the family's last active student closes its door, and the answer says so", async () => {
    await seedParentSettings({ requireActiveStudents: true });
    changeInBooks("12", { Active: false });
    await readAgain();
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    const offer = await offerOf("Rivera Family", "inactive");
    expect(offer).toMatchObject({ kind: "student", recordId: String(leo), about: "Leo Rivera's active status",
      words: ["Makes Leo Rivera inactive in the portal, as the books have them. Nothing is sent to the books."] });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true,
      message: "Made Leo Rivera inactive in the portal, as the books have them. Nothing was sent to the books. Rivera Family has no active student now, so its guardians can't sign in to it until it has one again." });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: false, familyId: rivera });
    expect(await familyRow(rivera)).toMatchObject({ active: true });
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    expect(await takes()).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo),
      after: { field: "inactive", kind: "student", studentId: String(leo), familyId: String(rivera), customerQboId: "12", replaced: [], active: false } })]);
    expect(await auditsOf("roster.record.follows")).toEqual([]);
  });

  it("a family, with its active students (one with no link, one linked to a customer inactive in the books), a kept make-inactive closed, one row each", async () => {
    const [ivy] = await db.insert(student).values({ familyId: rivera, name: "Ivy Rivera", active: true }).returning({ id: student.id });
    const kept = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "refused", code: "fault_6220" });
    changeInBooks("10", { Active: false });
    changeInBooks("12", { Active: false });
    await readAgain();
    expect((await enterableGuardianRows(ana.id)).map((g) => g.familyId)).toEqual([rivera]);
    const offer = rowOf(await loadAccountingLinks(), "Rivera Family").takes.find((t) => t.field === "inactive" && t.kind === "family")!;
    expect(offer.words).toEqual(["Makes Rivera Family inactive in the portal, with its 2 students Ivy Rivera, Leo Rivera, as the books have it. Its guardians can't sign in to the family then. Nothing is sent to the books."]);
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Made Rivera Family inactive in the portal, with its 2 students Ivy Rivera, Leo Rivera, as the books have it. Nothing was sent to the books. "
      + "Its guardians can't sign in to the family now. The make-inactive kept on the Reconciliation page is closed, as this takes its place." });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: false });
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect(await studentRow(ivy!.id)).toMatchObject({ active: false });
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, kept.id)))[0]).toMatchObject({ state: "given_up" });
    const rows = await takes();
    expect(rows.map((r) => `${r.targetType}:${r.targetId}`).sort()).toEqual([`family:${rivera}`, `student:${ivy!.id}`, `student:${leo}`].sort());
    expect(rows.find((r) => r.targetId === String(leo))!.after).toMatchObject({ field: "inactive", customerQboId: "12", withFamily: true, replaced: [kept.id] });
    expect(rows.find((r) => r.targetId === String(ivy!.id))!.after).toMatchObject({ field: "inactive", customerQboId: null, replaced: [] });
    expect(rows.find((r) => r.targetId === String(rivera))!.after).toMatchObject({ field: "inactive", kind: "family", students: [String(ivy!.id), String(leo)], replaced: [] });
  });

  it("a family whose student the books still have active: no press, a sentence naming them, and a press called anyway refused in the same words", async () => {
    changeInBooks("10", { Active: false });
    await readAgain();
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    const at = row.differences.findIndex((d) => d.kind === "active" && d.of === "family");
    const words = "Leo Rivera is still active in the books, so the family can't be taken as inactive until they are made inactive there or moved.";
    expect(row.takes.filter((t) => t.field === "inactive")).toEqual([]);
    expect(row.takeNotes).toEqual([{ at, words }]);
    stub.calls.length = 0;
    expect(await pressWith("inactive", "family", String(rivera), takeStamp("inactive", String(rivera), "10", [String(leo)]))).toEqual({ ok: false, errors: [words] });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: true });
    expect(await studentRow(leo)).toMatchObject({ active: true });
    expect(await takes()).toEqual([]);
  });
});

describe("the family a student is under, taken from the books", () => {
  beforeEach(layered);

  /** Leo's forms, a place on a shift still to come, and a per-student buy-out with an unpaid invoice, all in the Rivera family. */
  async function leosThings() {
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Join" }] });
    const req = await seedFormRequirement({ stepId: season.stepIds.Join!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmpltake" }) });
    const open = await seedRequest({ requirementId: req, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_takeopen" });
    const { shifts: [soon] } = await seedEvent({ name: "Fall fair", inDays: 20 });
    const place = await seedSignup({ shiftId: soon!.id, familyQboId: "10", signedUpBy: ana.id, student: { qboId: "12", name: "Leo Rivera" } });
    const perStudent = await seedBuyoutRequirement({ appliesTo: "student" });
    await seedBuyout({ requirementId: perStudent, familyQboId: "10", subjectQboId: "12", chosenBy: ana.id, invoiceQboId: "5001" });
    return { open, place };
  }
  const MOVE_WORDS = "Moves Leo Rivera to Chen Family in the portal, where the books have them, as a move made on the family's page does: their forms not yet complete start again under Chen Family, "
    + "their volunteer places still to come are given up and their guardians told by email, and an unpaid volunteer buy-out invoice of theirs is voided in the books. Nothing about the student is sent to the books.";
  const MOVED = "Moved Leo Rivera to Chen Family in the portal, as the books have them. Nothing about the student was sent to the books. "
    + "Leo Rivera's unpaid volunteer buy-out invoice is to be voided in the books, since the family that chose it is no longer theirs.";

  for (const from of ["Rivera Family", "Chen Family"] as const) {
    it(`from ${from}'s row (${from === "Rivera Family" ? "where Leo is" : "a student the books have under this family"}): moved as a portal move is, with its follow-ups, sending nothing`, async () => {
      const { open, place } = await leosThings();
      changeInBooks("12", under("20"));
      await readAgain();
      const view = await loadAccountingLinks();
      const fromRivera = rowOf(view, "Rivera Family").takes.find((t) => t.field === "place")!;
      const fromChen = rowOf(view, "Chen Family").takes.find((t) => t.field === "place")!;
      // One move, the same press from either row.
      expect(fromRivera).toMatchObject({ kind: "student", recordId: String(leo), about: "Leo Rivera's family", words: [MOVE_WORDS] });
      expect(fromChen).toMatchObject({ kind: "student", recordId: String(leo), words: [MOVE_WORDS], stamp: fromRivera.stamp });
      expect(rowOf(view, "Rivera Family").differences[fromRivera.at]).toMatchObject({ kind: "place" });
      expect(rowOf(view, "Chen Family").differences[fromChen.at]).toMatchObject({ kind: "student_elsewhere" });
      stub.calls.length = 0;
      expect(await press(from === "Rivera Family" ? fromRivera : fromChen)).toEqual({ ok: true, message: MOVED });
      expect(sentSince()).toEqual([]);
      expect(await studentRow(leo)).toMatchObject({ familyId: chen, active: true });
      // The follow-ups, once, as a move made on the family's page.
      expect(await requestNow(open)).toMatchObject({ state: "not_opened", envelopeId: null, familyId: chen });
      expect((await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, place.id)))[0]!.cancelledAt).not.toBeNull();
      expect(mail.outbox.map((m) => [m.to, m.subject])).toEqual([["ana@example.com", "Your place has been freed: Fall fair"]]);
      expect(await auditsOf("roster.student.move.followed")).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo),
        after: expect.objectContaining({ fromFamilyId: String(rivera), toFamilyId: String(chen), cause: `accounting.difference.take#${leo}`, formsReset: 1, placesGivenUp: 1, buyoutsToVoid: 1 }) })]);
      expect(await takes()).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo), before: { familyId: String(rivera) },
        after: { field: "place", kind: "student", studentId: String(leo), familyId: String(chen), fromFamilyId: String(rivera), customerQboId: "12", familyQboId: "20", replaced: [] } })]);
      // No portal move's row, no move on the queue, and no move sent.
      expect(await auditsOf("roster.record.moved")).toEqual([]);
      expect(await auditsOf("roster.student.move")).toEqual([]);
      expect(await db.select().from(writeQueue).where(sql`${writeQueue.request}->>'op' = 'move'`)).toEqual([]);
      // The one thing for the books: the unpaid buy-out invoice's void, on the queue, as every move's follow-ups put it there.
      expect((await db.select().from(writeQueue)).map((q) => [q.request.op, "invoiceQboId" in q.request ? q.request.invoiceQboId : null, q.state])).toEqual([["invoice_void", "5001", "waiting"]]);
      // The audit page's record filter finds the take's own row under the family left and the family joined.
      const take = (await takes())[0]!;
      for (const f of [rivera, chen]) {
        expect((await auditPage(parseAuditFilters({ record: `family:${f}` }), {}, 500)).rows.map((r) => r.id)).toContain(take.id);
      }
      // The difference is gone from both rows.
      const after = await loadAccountingLinks();
      expect(after.rows.flatMap((r) => r.differences).filter((d) => d.kind === "place" || d.kind === "student_elsewhere")).toEqual([]);
    });
  }

  it("refused, changing nothing: no family record for the books' family, an inactive target, a stale stamp, a move of the student waiting", async () => {
    // Oak Family (80), imported before anything is changed in the portal; Patel Family (70), read only, with no record.
    await readAgain(qc("80", "Oak Family", "1"));
    await syncAppRecords();
    await readAgain(qc("70", "Patel Family", "1"));
    changeInBooks("12", under("70"));
    await readAgain();
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.takes.filter((t) => t.field === "place")).toEqual([]);
    expect(row.takeNotes).toEqual([{ at: row.differences.findIndex((d) => d.kind === "place"), words: "No active family of the portal is linked to Patel Family." }]);
    stub.calls.length = 0;
    expect(await pressWith("place", "student", String(leo), takeStamp("place", String(leo), "12", ["12", "70", String(rivera), String(rivera)]))).toEqual({ ok: false,
      errors: ["No family of the portal is linked to the family the books have this student under, so nothing was taken. Look at the row again."] });
    // A stale stamp: the books moved Leo again, to Oak, after the page was drawn.
    changeInBooks("12", under("20"));
    await readAgain();
    const toChen = await offerOf("Rivera Family", "place");
    changeInBooks("12", under("80"));
    await readAgain();
    expect(await press(toChen)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    // An inactive target: Chen made inactive meanwhile (the test's own write).
    changeInBooks("12", under("20"));
    await readAgain();
    const again = await offerOf("Rivera Family", "place");
    await db.update(family).set({ active: false }).where(eq(family.id, chen));
    expect(await press(again)).toEqual({ ok: false, errors: [WRITE_COPY.notOurs] });
    await db.update(family).set({ active: true }).where(eq(family.id, chen));
    // A move of the student waiting: no press while it is on its way, and the one drawn is refused.
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen }, { state: "waiting" });
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes.filter((t) => t.field === "place")).toEqual([]);
    expect(await press(again)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
    expect(await takes()).toEqual([]);
    expect(await auditsOf("roster.student.move.followed")).toEqual([]);
  });
});

describe("who may press it", () => {
  beforeEach(layered);

  it("the linking permission with Roster.Read, and no more: either alone is refused as the guard refuses, and every argument is checked", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household" });
    await readAgain();
    const offer = await offerOf("Rivera Family", "name");
    const onlyLink = await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]);
    const onlyRead = await staffWith("onlyread@club.org", ["Roster.Read"]);
    for (const who of [onlyLink, onlyRead]) {
      asStaff(who);
      await expect(takeDifferenceAction("name", "family", offer.recordId, tag, offer.stamp)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === onlyLink.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    expect(refusals.filter((a) => a.actorId === onlyRead.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    // The linker holds the linking permission and Roster.Read, not Roster.Family.ReadWrite.
    asStaff(linker);
    const NOT_FROM_PAGE = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const args of [
      ["title", "family", offer.recordId, tag, offer.stamp], ["name", "parent", offer.recordId, tag, offer.stamp], ["place", "family", offer.recordId, tag, offer.stamp],
      [7, "family", offer.recordId, tag, offer.stamp], ["name", "family", "x".repeat(65), tag, offer.stamp], ["name", "family", "", tag, offer.stamp],
      ["name", "family", offer.recordId, null, offer.stamp], ["name", "family", offer.recordId, tag, "s".repeat(65)], ["name", "family", offer.recordId, tag, { stamp: offer.stamp }],
    ] as unknown[][]) {
      expect(await (takeDifferenceAction as unknown as (...a: unknown[]) => Promise<unknown>)(...args), JSON.stringify(args)).toEqual(NOT_FROM_PAGE);
    }
    expect(await takes()).toEqual([]);
    expect(await takeDifferenceAction("name", "family", offer.recordId, tag, offer.stamp)).toEqual({ ok: true, message: "Renamed Rivera Household in the portal, as the books have it. Nothing was sent to the books." });
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Household" });
    expect(await takes()).toEqual([expect.objectContaining({ actorId: linker.id })]);
  });
});

describe("the page", () => {
  beforeEach(layered);

  it("draws each offered take's words and press (since slice M4b an inactive record active in the books too), and none for a waiting change, another place, a student or guardian on one side only", async () => {
    // Imported before anything is changed in the portal: Zoe (13) and Max (14) under Rivera; Oak Family (80) with Ash Oak (81).
    await readAgain(qc("13", "Zoe Rivera", "3", under("10")), qc("14", "Max Rivera", "3", under("10")), qc("80", "Oak Family", "1"), qc("81", "Ash Oak", "3", under("80")));
    await syncAppRecords();
    // Zoe's record inactive in the portal, active in the books; a rename of Chen waiting to reach the books.
    await db.update(student).set({ active: false }).where(eq(student.id, await recordOfCustomer("13", "student")));
    await seedQueued({ op: "rename", role: "family", qboId: "20", syncToken: "0", name: "Chen Household", was: "Chen Family" }, { state: "waiting" });
    // In the books: Rivera renamed, Leo under Chen, Max at the top of the tree, Kim a student customer with no record,
    // Chen renamed (the waiting change), Oak inactive while Ash Oak stays active.
    changeInBooks("10", { DisplayName: "Rivera Household" });
    changeInBooks("12", under("20"));
    changeInBooks("14", { ParentRef: undefined, Job: false });
    changeInBooks("20", { DisplayName: "Chen Household" });
    changeInBooks("80", { Active: false });
    await readAgain(qc("15", "Kim Rivera", "3", under("10")));
    const view = await loadAccountingLinks();
    const kinds = (name: string) => rowOf(view, name).differences.map((d) => d.kind);
    expect(kinds("Rivera Family")).toEqual(expect.arrayContaining(["name", "place", "active", "student_customer"]));
    expect(kinds("Chen Family")).toEqual(expect.arrayContaining(["name", "student_elsewhere", "parent_customers"]));
    expect(kinds("Oak Family")).toEqual(["active"]);
    asStaff(linker);
    const whole = await renderPage(AccountingLinksPage);
    const at = whole.indexOf('id="links-list-h"');
    const list = whole.slice(at, whole.indexOf("</section>", at)).replaceAll("&#x27;", "'").replaceAll("<!-- -->", "");
    const presses = [...list.matchAll(/Take QuickBooks' into the app<span class="visually-hidden">: ([^<]*)<\/span>/g)].map((m) => m[1]).sort();
    expect(presses).toEqual(["Rivera Family's name", "Zoe Rivera's active status"]);
    // Since slice M4b, Zoe's record, inactive here and active in the books, is taken as active, alone (the students rule is off: no hold).
    expect(list).toContain("Makes Zoe Rivera active in the portal, as the books have them. Nothing is sent to the books.");
    expect(list).toContain("Takes “Rivera Household” as this family's name in the portal, as the books have it. Nothing is sent to the books.");
    // Leo's move, from Rivera's row and from Chen's, would be refused while the rename of Chen's customer waits: no
    // press, and the queue's sentence in its place, on both rows.
    expect(list).not.toContain("Moves Leo Rivera to Chen Family");
    expect(list.split(QUEUE_IN_THE_WAY).length - 1).toBe(2);
    expect(list).toContain("Ash Oak is still active in the books, so the family can't be taken as inactive until they are made inactive there or moved.");
    // Nothing for Chen's waiting rename, Max at the top, Kim with no record, Mei Chen's Parent customer.
    expect(list).not.toMatch(/Chen Family's name<\/span>|Max Rivera's family<\/span>|Kim Rivera<\/span>/);
    expect(whole).toContain("with Take QuickBooks&#x27; into the app, which changes only the portal&#x27;s records, except that a student&#x27;s move voids an unpaid volunteer buy-out invoice of theirs in the books, as any move does; every other difference is only shown.");
  });

  it("draws a move's press and a record's inactive press with their words when nothing on the queue stands in the way", async () => {
    // Leo under Chen in the books; Chen's own row offers the same move. Oak Family (80) inactive in the books, with no student.
    await readAgain(qc("80", "Oak Family", "1"));
    await syncAppRecords();
    changeInBooks("12", under("20"));
    changeInBooks("80", { Active: false });
    await readAgain();
    asStaff(linker);
    const whole = await renderPage(AccountingLinksPage);
    const at = whole.indexOf('id="links-list-h"');
    const list = whole.slice(at, whole.indexOf("</section>", at)).replaceAll("&#x27;", "'").replaceAll("<!-- -->", "");
    const presses = [...list.matchAll(/Take QuickBooks' into the app<span class="visually-hidden">: ([^<]*)<\/span>/g)].map((m) => m[1]).sort();
    expect(presses).toEqual(["Leo Rivera's family", "Leo Rivera's family", "Oak Family's active status"]);
    expect(list).toContain("Moves Leo Rivera to Chen Family in the portal, where the books have them, as a move made on the family's page does:");
    expect(list).toContain("Makes Oak Family inactive in the portal, as the books have it. Its guardians can't sign in to the family then. Nothing is sent to the books.");
    expect(list).not.toContain(QUEUE_IN_THE_WAY);
  });
});

describe("a press the queue would refuse is not drawn", () => {
  beforeEach(layered);

  it("a student's inactive, while a move of theirs is kept, or a change of their customer waits: the queue's sentence, and a press called anyway refused", async () => {
    changeInBooks("12", { Active: false });
    await readAgain();
    const drawn = await offerOf("Rivera Family", "inactive");
    const atOf = (row: LinkRow) => row.differences.findIndex((d) => d.kind === "active" && d.of === "student");
    // A move of Leo the books refused, kept on Reconciliation.
    const kept = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen },
      { state: "refused", code: "fault_6240" });
    let row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.takes.filter((t) => t.field === "inactive")).toEqual([]);
    expect(row.takeNotes).toEqual([{ at: atOf(row), words: QUEUE_IN_THE_WAY }]);
    stub.calls.length = 0;
    expect(await press(drawn)).toEqual({ ok: false, errors: [expect.stringContaining("A move of this student hasn't reached QuickBooks yet")] });
    await db.delete(writeQueue).where(eq(writeQueue.id, kept.id));
    // A rename of Leo's customer waiting: his name has no difference, but his inactive is held back by it too.
    const waiting = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo Rivera", was: "Leo Rivera" }, { state: "waiting" });
    row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.takes).toEqual([]);
    expect(row.takeNotes).toEqual([{ at: atOf(row), words: QUEUE_IN_THE_WAY }]);
    expect(await press(drawn)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes.map((t) => t.field)).toEqual(["inactive"]);
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: true });
    expect(await takes()).toEqual([]);
  });

  it("a family's inactive, while a change of its student's customer waits, or a move out of it is kept", async () => {
    changeInBooks("10", { Active: false });
    changeInBooks("12", { Active: false });
    await readAgain();
    const drawn = rowOf(await loadAccountingLinks(), "Rivera Family").takes.find((t) => t.field === "inactive" && t.kind === "family")!;
    const atOf = (row: LinkRow) => row.differences.findIndex((d) => d.kind === "active" && d.of === "family");
    const waiting = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo Rivera", was: "Leo Rivera" }, { state: "waiting" });
    let row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.takes.filter((t) => t.kind === "family")).toEqual([]);
    expect(row.takeNotes).toContainEqual({ at: atOf(row), words: QUEUE_IN_THE_WAY });
    stub.calls.length = 0;
    expect(await press(drawn)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    const kept = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen },
      { state: "refused", code: "fault_6240" });
    row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.takes.filter((t) => t.kind === "family")).toEqual([]);
    expect(row.takeNotes).toContainEqual({ at: atOf(row), words: QUEUE_IN_THE_WAY });
    expect(await press(drawn)).toEqual({ ok: false, errors: [MOVE_PENDING] });
    await db.delete(writeQueue).where(eq(writeQueue.id, kept.id));
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: true });
    expect(await takes()).toEqual([]);
  });

  it("a move, while a change of either family's customer waits", async () => {
    changeInBooks("12", under("20"));
    await readAgain();
    const drawn = await offerOf("Rivera Family", "place");
    for (const [qboId, name] of [["10", "Rivera Family"], ["20", "Chen Family"]] as const) {
      const waiting = await seedQueued({ op: "rename", role: "family", qboId, syncToken: "0", name: `${name} Household`, was: name }, { state: "waiting" });
      const view = await loadAccountingLinks();
      for (const r of [rowOf(view, "Rivera Family"), rowOf(view, "Chen Family")]) {
        expect(r.takes.filter((t) => t.field === "place")).toEqual([]);
        expect(r.takeNotes).toContainEqual({ at: r.differences.findIndex((d) => d.kind === "place" || d.kind === "student_elsewhere"), words: QUEUE_IN_THE_WAY });
      }
      stub.calls.length = 0;
      expect(await press(drawn)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
      await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    }
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
    expect(await takes()).toEqual([]);
  });
});

describe("a take's own checks, under the roster lock", () => {
  beforeEach(layered);

  it("inactive, refused changing nothing: a stamp gone stale (a student added to the family, a customer active again), a family's or a student's create waiting", async () => {
    changeInBooks("10", { Active: false });
    changeInBooks("12", { Active: false });
    await readAgain();
    const view = rowOf(await loadAccountingLinks(), "Rivera Family");
    const theFamily = view.takes.find((t) => t.field === "inactive" && t.kind === "family")!;
    const leos = view.takes.find((t) => t.field === "inactive" && t.kind === "student")!;
    expect(leos.recordId).toBe(String(leo));
    stub.calls.length = 0;
    // A student record added to the family after the page was drawn (the test's own write: nothing imports after it).
    const [ivy] = await db.insert(student).values({ familyId: rivera, name: "Ivy Rivera", active: true }).returning({ id: student.id });
    expect(await press(theFamily)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    const withIvy = takeStamp("inactive", String(rivera), "10", [String(ivy!.id), String(leo)].sort());
    // Ivy's own create waiting on the queue (filed under her record by the test's own write, as a student's add files it).
    const ivyCreate = await seedQueued({ op: "create", role: "student", name: "Ivy Rivera", typeQboId: "3", familyQboId: "10", email: null });
    await db.update(writeQueue).set({ studentId: ivy!.id }).where(eq(writeQueue.id, ivyCreate.id));
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").takes.filter((t) => t.kind === "family")).toEqual([]);
    expect(await pressWith("inactive", "family", String(rivera), withIvy)).toEqual({ ok: false, errors: [expect.stringContaining("Making this student in QuickBooks is still waiting")] });
    await db.delete(writeQueue).where(eq(writeQueue.id, ivyCreate.id));
    // The family's own create waiting.
    const familyCreate = await seedQueued({ op: "create", role: "family", name: "Rivera Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: rivera });
    const blocked = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(blocked.takes.filter((t) => t.field === "inactive")).toEqual([]);
    expect(blocked.takeNotes.map((n) => n.words)).toContain(QUEUE_IN_THE_WAY);
    expect(await pressWith("inactive", "family", String(rivera), withIvy)).toEqual({ ok: false, errors: [FAMILY_WAITING] });
    await db.delete(writeQueue).where(eq(writeQueue.id, familyCreate.id));
    // Leo's customer active again in the books after the page was drawn.
    changeInBooks("12", { Active: true });
    await readAgain();
    expect(await press(leos)).toEqual({ ok: false, errors: [TAKE_CHANGED] });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: true });
    expect(await studentRow(leo)).toMatchObject({ active: true });
    expect(await takes()).toEqual([]);
  });

  it("needs no live connection, refuses while the books are connected to another company, and refuses a page drawn before the roster's company changed", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household" });
    await readAgain();
    const offer = await offerOf("Rivera Family", "name");
    stub.calls.length = 0;
    expect(await pressWith(offer.field, offer.kind, offer.recordId, offer.stamp, "a tag from another read")).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    await db.update(qboConnection).set({ realmId: "9130000000000099" });
    expect(await press(offer)).toEqual({ ok: false, errors: [WRITE_COPY.otherCompany] });
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Family" });
    // QuickBooks disconnected: a take reads nothing live and sends nothing, so it goes through.
    await db.delete(qboConnection);
    expect(await press(offer)).toEqual({ ok: true, message: "Renamed Rivera Household in the portal, as the books have it. Nothing was sent to the books." });
    expect(sentSince()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Household" });
    expect(await takes()).toHaveLength(1);
  });

  it("a move takes the place of one the books refused, and says the doors it closes and opens while the students rule is in force", async () => {
    await seedParentSettings({ requireActiveStudents: true });
    const kept = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen },
      { state: "refused", code: "fault_6240" });
    changeInBooks("12", under("20"));
    await readAgain();
    const offer = await offerOf("Rivera Family", "place");
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal, as the books have them. Nothing about the student was sent to the books. "
      + "Rivera Family has no active student now, so its guardians can't sign in to it until it has one again. Chen Family has an active student now, so its guardians can sign in to it." });
    expect(sentSince()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: chen });
    expect((await db.select().from(writeQueue).where(eq(writeQueue.id, kept.id)))[0]).toMatchObject({ state: "given_up" });
    expect(await takes()).toEqual([expect.objectContaining({ targetId: String(leo), after: expect.objectContaining({ field: "place", replaced: [kept.id] }) })]);
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
    expect(await auditsOf("roster.record.moved")).toEqual([]);
  });
});
