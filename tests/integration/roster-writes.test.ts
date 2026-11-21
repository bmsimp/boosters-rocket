import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, qboConnection, qboCustomer, setting, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { addFamily, askFamilyInactive, askRosterWrite, CREDIT_BALANCE, GUARDIAN_HERE, coverStamp, deactivateLinked, familyCover, familyHereWords, LINKED_DEACTIVATE, moveStudent, PLACE_DIFFERS, REFRESH_ASK_KEY,
  WRITE_COPY } from "@/lib/roster/writes";
import { runWriteQueue } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import { NOT_HERE } from "@/lib/roster/operations";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { saveShape } from "@/lib/roster/shape";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { formWithdrawal, signedFormEvidence, signedFormFile, volunteerSignup } from "@/lib/db/schema";
import { resetDb, seedParent, untilALockIsAwaited } from "../helpers/db";
import { formSetting, requestByCustomer, seedEvidence, seedFormRequirement, seedRequest } from "../helpers/forms";
import { appRecordRows, NO_CHANGES, recordOfCustomer, whatAFreshRunWouldChange } from "../helpers/app-records";
import { seedSeason } from "../helpers/season";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { fznCompany, FZN_SHAPE, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { holdTheRosterLock } from "../helpers/reconcile";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const sent = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0];
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const queue = () => db.select().from(writeQueue);
const audits = () => db.select().from(auditLog).orderBy(asc(auditLog.id));

let tag: string;
let op: ReturnType<typeof asOp>;
beforeEach(async () => {
  await resetDb(); stub.reset();
  // A customer read by id carries its own Balance, as QuickBooks' does: the portal reads it before making anyone inactive.
  stub.quirks.balances = true;
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
});

/**
 * The stamp a family's page binds into its form (stage 3's slice 9g): whom the cover it drew holds, sealed with the
 * family record's app id (coverStamp()), as the page makes it.
 */
const stampFor = async (familyQboId: string): Promise<string> => {
  const c = (await familyCover(familyQboId))!;
  return coverStamp(String(await recordOfCustomer(familyQboId, "family")), [c.family.qboId, ...c.under.map((u) => u.qboId)]);
};
/** The family action as the page's form sends it: the family record's app id and the stamp. */
const inactivate = async (familyQboId: string, stamp: string, o: Parameters<typeof askFamilyInactive>[3] = op) =>
  askFamilyInactive(String(await recordOfCustomer(familyQboId, "family")), stamp, tag, o);
/** A linked student (layered) made inactive as their family's page asks it: by the record, with no version (stage 3's slice 9g). */
const offStudent = async (studentQboId: string, o: Parameters<typeof deactivateLinked>[2] = op) =>
  deactivateLinked({ kind: "student", recordId: String(await recordOfCustomer(studentQboId, "student")) }, tag, o);
/** A linked member (flat) made inactive as their page asks it: by the member's own family record. */
const offMember = async (memberQboId: string, o: Parameters<typeof deactivateLinked>[2] = op) =>
  deactivateLinked({ kind: "family", recordId: String(await recordOfCustomer(memberQboId, "family")) }, tag, o);
/**
 * A family (layered books) or member (flat books) added as the Families list adds one (stage 3's slice 9d): the portal's
 * own record first, then sent to QuickBooks, by a staff member who may link families to accounting.
 */
const add = (role: "family" | "member", name: string, typeQboId: string | null = null) => addFamily({ role, name, typeQboId }, tag, { ...op, mayLink: true });
const familyNamed = async (name: string) => (await db.select().from(family).where(eq(family.name, name)))[0];
/** A student moved as a family's page moves one (stage 3's slice 9f): by the app's ids of the student and the family joined, saved in the portal first. */
const move = async (studentQboId: string, toFamilyQboId: string) =>
  moveStudent(String(await recordOfCustomer(studentQboId, "student")), String(await recordOfCustomer(toFamilyQboId, "family")), tag, op);
/** A student customer's link to its student record, for the version the portal last aligned with. */
const studentLinkOf = async (customerId: string) => (await db.select().from(accountingLink).where(and(eq(accountingLink.customerId, customerId), isNotNull(accountingLink.studentId))))[0];
/** An open invoice on a customer, for what it owes. */
const owes = (Id: string, customer: string, amount: number) => ({ Id, SyncToken: "0", CustomerRef: { value: customer }, TotalAmt: amount, Balance: amount });

describe("staff change the roster in QuickBooks, and the cache follows QuickBooks' answer (v1 spec §6.1)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("makes a family: a customer of the family type, and nothing else, then the family is on the roster", async () => {
    const r = await add("family", " Okafor  Family ");
    expect(r).toEqual({ ok: true, message: "Okafor Family is saved in the portal, made in QuickBooks and linked to its new customer." });
    expect(sent()).toEqual([{ DisplayName: "Okafor Family", CustomerTypeRef: { value: "1" } }]);
    const made = stub.customers.find((c) => c.DisplayName === "Okafor Family")!;
    expect(await cached(made.Id as string)).toMatchObject({ displayName: "Okafor Family", typeQboId: "1", parentQboId: null, active: true, syncToken: "0" });
    const [row] = await auditsOf("roster.customer.create");
    expect(row).toMatchObject({ door: "staff", actorLabel: "registrar@club.org", permission: "Roster.Family.ReadWrite", targetType: "qbo_customer", targetId: made.Id, ip: "203.0.113.9",
      before: null, after: { role: "family", name: "Okafor Family", active: true, familyQboId: null, syncToken: "0" } });
  });

  it("adds a student under a family: ParentRef, Job and BillWithParent, with the student type", async () => {
    const r = await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: "2" }, tag, op);
    expect(r.ok).toBe(true);
    // The type is the shape's, whatever the page sent.
    expect(sent()).toEqual([{ DisplayName: "Rosa Rivera", CustomerTypeRef: { value: "3" }, ParentRef: { value: "10" }, Job: true, BillWithParent: true }]);
    const made = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!;
    expect(await cached(made.Id as string)).toMatchObject({ parentQboId: "10", typeQboId: "3", email: null });
  });

  it("renames with the version the page was shown, sending the name alone", async () => {
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).toEqual({ ok: true, message: "Renamed in QuickBooks." });
    expect(sent()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, DisplayName: "Leon Rivera" }]);
    expect(inStub("12")).toMatchObject({ DisplayName: "Leon Rivera", ParentRef: { value: "10" }, CustomerTypeRef: { value: "3" }, Active: true });
    expect(await cached("12")).toMatchObject({ displayName: "Leon Rivera", syncToken: "1", parentQboId: "10" });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ before: { name: "Leo Rivera", syncToken: "0" }, after: { name: "Leon Rivera", syncToken: "1" } });
  });

  it("moves a student to another family: saved in the portal first, with what follows the student, then sent with the link's version", async () => {
    const [leo, rivera, chen] = [await recordOfCustomer("12", "student"), await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family")];
    const r = await move("12", "20");
    expect(r).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal and in QuickBooks." });
    expect(sent()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, ParentRef: { value: "20" }, Job: true, BillWithParent: true }]);
    expect(await cached("12")).toMatchObject({ parentQboId: "20", syncToken: "1" });
    expect((await auditsOf("roster.student.move"))[0]).toMatchObject({ before: { familyQboId: "10" }, after: { familyQboId: "20" } });
    expect((await auditsOf("roster.student.move.followed"))[0]).toMatchObject({ targetType: "student", targetId: String(leo),
      after: { studentId: String(leo), fromFamilyId: String(rivera), toFamilyId: String(chen), cause: `roster.record.moved#${leo}` } });
    expect((await auditsOf("roster.record.moved"))[0]).toMatchObject({ targetType: "student", targetId: String(leo), before: { familyId: String(rivera) },
      after: { familyId: String(chen), quickbooks: "sending", customerQboId: "12", comparedWith: "10" } });
    expect((await queue()).map((i) => [i.state, i.familyId, i.studentId])).toEqual([["done", rivera, leo]]);
  });

  it("moves a student with an open form, a signed form and a place on a shift to come: the forms and the place follow the move", async () => {
    const season = await seedSeason({ name: "Moving season", steps: [{ name: "Join" }] });
    const stepId = season.stepIds["Join"]!;
    const openReq = await seedFormRequirement({ stepId, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplmedical" }) });
    const signedReq = await seedFormRequirement({ stepId, title: "Photo consent", appliesTo: "student", form: formSetting({ id: "envelope_tmplphoto" }), position: 60 });
    const open = await seedRequest({ requirementId: openReq, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_movedopen1" });
    const signed = await seedRequest({ requirementId: signedReq, familyQboId: "10", subjectQboId: "12", state: "complete", envelopeId: "envelope_movedsigned" });
    const evidence = await seedEvidence(signed, { tag: "moved" });
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const { shifts: [shift] } = await seedEvent({ inDays: 20 });
    const place = await seedSignup({ shiftId: shift!.id, familyQboId: "10", signedUpBy: ana.id, student: { qboId: "12", name: "Leo Rivera" } });

    expect(await move("12", "20")).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal and in QuickBooks." });

    // The open form starts again under the new family, and its document waits for the worker to withdraw it.
    expect(await requestByCustomer(open)).toMatchObject({ familyQboId: "20", state: "not_opened", envelopeId: null });
    expect(await db.select().from(formWithdrawal)).toEqual([expect.objectContaining({ envelopeId: "envelope_movedopen1" })]);
    // The signed form moves with its evidence, every byte kept.
    expect(await requestByCustomer(signed)).toMatchObject({ familyQboId: "20", state: "complete", envelopeId: "envelope_movedsigned" });
    const [kept] = await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.id, evidence.id));
    // It names the new family's record now; its own copy of the QuickBooks ids stays as it was stored.
    expect(kept).toMatchObject({ requestId: signed, familyId: await recordOfCustomer("20", "family"), familyQboId: "10", subjectQboId: "12" });
    expect(await db.select().from(signedFormFile).where(eq(signedFormFile.evidenceId, evidence.id))).toHaveLength(4);
    // The place on a shift still to come is given up; the old family keeps nothing of the student's there.
    const [after] = await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, place.id));
    expect(after!.cancelledAt).not.toBeNull();
    expect((await auditsOf("roster.student.move.followed"))[0]).toMatchObject({ targetId: String(await recordOfCustomer("12", "student")),
      after: { formsMoved: 1, formsReset: 1, formsToWithdraw: 1, placesGivenUp: 1 } });
  });

  it("makes a family inactive in one action: everyone under it first, then the family, and its parents can no longer enter it", async () => {
    await seedParentSettings(SIGNINS_ON);
    const { ana } = await seedAnaRivera();
    expect(await enterableGuardianRows(ana.id)).toHaveLength(1);
    stub.calls.length = 0;
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: true, message: "Made inactive in QuickBooks: Ana Rivera and Leo Rivera, then Rivera Family." } });
    // QuickBooks is asked what each owes first, then sent three writes: the two under the family, then the family.
    expect(sent()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, Active: false }, { Id: "12", SyncToken: "0", sparse: true, Active: false },
      { Id: "10", SyncToken: "0", sparse: true, Active: false }]);
    const calls = stub.apiCalls().map((c) => `${c.method} ${c.path.replace(/^.*\/v3\/company\/\d+\//, "")}`);
    expect(calls.slice(0, 3).sort()).toEqual(["GET customer/10", "GET customer/11", "GET customer/12"]);
    // The family is read once more before its own write, for the version QuickBooks has now.
    expect(calls.slice(3)).toEqual(["POST customer", "POST customer", "GET customer/10", "POST customer"]);
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: false });
    // Her row stays as it was: the gate keeps her out of a family whose record is inactive, and closes nothing.
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id)))[0]).toMatchObject({ status: "invited", disabledReason: null });
    expect(await enterableGuardianRows(ana.id)).toEqual([]);
    expect((await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY)))).toHaveLength(1);
    // Each write is audited as one write is, the family last; and one row says how the whole of it went.
    const rows = (await auditsOf("roster.customer.deactivate")).reverse();
    expect(rows.map((a) => [a.targetId, (a.after as { role: string }).role])).toEqual([["11", "parent"], ["12", "student"], ["10", "family"]]);
    expect(rows[2]!.after).toMatchObject({ active: false, refreshAsked: true });
    expect((await auditsOf("roster.family.deactivate"))[0]).toMatchObject({ targetId: "10", permission: "Roster.Family.ReadWrite", after: { outcome: "done", made: ["11", "12", "10"], notMade: [] } });
    expect(await queue()).toEqual([]);
  });

  it("lists everyone active under the family at any depth, deepest first, and leaves out the inactive", async () => {
    const company = fznCompany();
    (company.customers as Record<string, unknown>[]).push(
      { Id: "13", DisplayName: "Rivera Project", Active: true, SyncToken: "2", ParentRef: { value: "12" }, Job: true, MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" } },
      { Id: "14", DisplayName: "Old Rivera Student", Active: false, SyncToken: "0", ParentRef: { value: "10" }, Job: true, CustomerTypeRef: { value: "3" }, MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" } },
    );
    await resetDb(); stub.reset(); stub.quirks.balances = true;
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    tag = await connectRoster(stub, { company });
    const c = (await familyCover("10"))!;
    expect(c.family).toMatchObject({ qboId: "10", name: "Rivera Family" });
    expect(c.under.map((u) => [u.qboId, u.depth])).toEqual([["13", 2], ["11", 1], ["12", 1]]);
    expect(await inactivate("10", await stampFor("10"), op)).toMatchObject({ result: { ok: true } });
    expect(sent().map((b) => b.Id)).toEqual(["13", "11", "12", "10"]);
    expect((await auditsOf("roster.customer.deactivate")).find((a) => a.targetId === "13")!.after).toMatchObject({ role: "other" });
  });

  it("refuses a stamp of another cover (someone added under the family since, or another family's), and a family made inactive alone", async () => {
    const rivera = String(await recordOfCustomer("10", "family"));
    const shown = await stampFor("10");
    // A cover the page didn't draw: one leaving Leo out, and the stamp of another family's cover.
    expect(await inactivate("10", coverStamp(rivera, ["10", "11"]))).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } });
    expect(await inactivate("10", "A".repeat(22))).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } });
    expect(await askRosterWrite({ op: "deactivate", qboId: "10", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [familyHereWords("Rivera Family")] });
    expect(familyHereWords("Rivera Family")).toContain("“Make Rivera Family inactive”"); // the button as the page names it
    expect(await inactivate("20", shown)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } }); // another family's list
    const leo = String(await recordOfCustomer("12", "student"));
    expect(await askFamilyInactive(leo, shown, tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.gone] } });  // a student isn't a family
    expect(await askFamilyInactive("10", shown, tag, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.gone] } }); // a QuickBooks id isn't one
    expect(await askFamilyInactive(rivera, shown, "a-tag-of-another-company", op)).toEqual({ changed: false, result: { ok: false, errors: [ROSTER_MOVED] } });
    // Someone added under the family in QuickBooks since the page was drawn, and taken into the cache by a read.
    stub.customers.push({ Id: "15", DisplayName: "Rosa Rivera", Active: true, SyncToken: "0", ParentRef: { value: "10" }, Job: true, CustomerTypeRef: { value: "3" } });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    expect(await inactivate("10", shown)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } });
    expect(stub.apiCalls().filter((c) => c.method === "GET" && c.path.includes("/customer/"))).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("refuses while a change to anyone under the family is waiting", async () => {
    await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" });
    expect(await inactivate("10", await stampFor("10"), op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.waiting] } });
    expect(posts()).toEqual([]);
  });

  it("a guardian's own Parent customer isn't changed from its QuickBooks form (stage 3's slice 9h); the portal's own sign-in for them stays", async () => {
    await seedParentSettings(SIGNINS_ON);
    const { ana } = await seedAnaRivera();
    // Ana's row is linked to customer 11: it is changed through her (removing her, renaming her), never by its form.
    expect(await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [GUARDIAN_HERE] });
    expect(posts()).toEqual([]);
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id)))[0]).toMatchObject({ status: "invited", disabledReason: null });
    expect(await enterableGuardianRows(ana.id)).toHaveLength(1);
    expect((await db.select().from(auditLog)).filter((a) => a.action === "parent.access.ended")).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]); // only a family's asks for a refresh
  });
});

describe("each write QuickBooks took changes the app's own record too, in its transaction, and its audit row says which (stage 3's slice 9c)", () => {
  const linkOf = async (customerId: string) => db.select().from(accountingLink).where(eq(accountingLink.customerId, customerId));
  const familyRow = async (id: AppFamilyId | null) => (id === null ? undefined : (await db.select().from(family).where(eq(family.id, id)))[0]);
  const studentRow = async (id: AppStudentId | null) => (id === null ? undefined : (await db.select().from(student).where(eq(student.id, id)))[0]);

  describe("layered books", () => {
    beforeEach(async () => { tag = await connectRoster(stub); });

    it("a new family: the record saved first, active and named as sent, linked to the customer QuickBooks made, as created by the staff member who asked", async () => {
      await add("family", " Okafor  Family ");
      const made = stub.customers.find((c) => c.DisplayName === "Okafor Family")!;
      const [link] = await linkOf(made.Id as string);
      expect(link).toMatchObject({ system: "quickbooks", realmId: REALM, origin: "created", linkedBy: op.staffUserId, studentId: null, guardianId: null });
      expect(await familyRow(link!.familyId)).toMatchObject({ name: "Okafor Family", active: true });
      // One record: the one saved first (stage 3's slice 9d), with its own audit row, then linked.
      expect(await db.select().from(family).where(eq(family.name, "Okafor Family"))).toHaveLength(1);
      expect((await auditsOf("roster.family.added"))[0]).toMatchObject({ targetType: "family", targetId: String(link!.familyId), permission: "Roster.Family.ReadWrite",
        after: { familyId: String(link!.familyId), name: "Okafor Family", role: "family", quickbooks: "sending" } });
      expect((await auditsOf("roster.customer.create"))[0]!.after).toMatchObject({ appRecord: { kind: "family", familyId: String(link!.familyId), linked: true, linkId: link!.id } });
      // What an import of the roster would make of it is what the write made.
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a new student: an active record in the family the new customer's family is linked to, with its own student link", async () => {
      await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op);
      const made = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!;
      const [link] = await linkOf(made.Id as string);
      expect(link).toMatchObject({ origin: "created", linkedBy: op.staffUserId, familyId: null, guardianId: null });
      expect(await studentRow(link!.studentId)).toMatchObject({ name: "Rosa Rivera", active: true, familyId: await recordOfCustomer("10", "family") });
      expect((await auditsOf("roster.customer.create"))[0]!.after).toMatchObject({ appRecord: { kind: "student", studentId: String(link!.studentId),
        familyId: String(await recordOfCustomer("10", "family")), made: true } });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a rename: the family's or the student's record takes the new name; a parent's changes no record", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      await askRosterWrite({ op: "rename", qboId: "10", syncToken: "0", name: "Rivera-Diaz Family" }, tag, op);
      await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
      expect(await familyRow(rivera)).toMatchObject({ name: "Rivera-Diaz Family", active: true });
      expect(await studentRow(leo)).toMatchObject({ name: "Leon Rivera", active: true, familyId: rivera });
      const renames = await auditsOf("roster.customer.rename");
      expect(renames.find((a) => a.targetId === "10")!.after).toMatchObject({ appRecord: { kind: "family", familyId: String(rivera), set: { name: "Rivera-Diaz Family" } } });
      expect(renames.find((a) => a.targetId === "12")!.after).toMatchObject({ appRecord: { kind: "student", studentId: String(leo), set: { name: "Leon Rivera" } } });
      const before = await appRecordRows();
      await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana M. Rivera" }, tag, op);
      expect(await appRecordRows()).toEqual(before);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a move: the student's record goes to the family moved to at the save, with its follow-ups once; QuickBooks taking it changes no record", async () => {
      const leo = await recordOfCustomer("12", "student"), chen = await recordOfCustomer("20", "family");
      await move("12", "20");
      expect(await studentRow(leo)).toMatchObject({ familyId: chen, active: true });
      expect((await auditsOf("roster.student.move"))[0]!.after).not.toHaveProperty("appRecord");
      expect(await auditsOf("roster.student.move.followed")).toHaveLength(1);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a student made inactive: their record is inactive; a parent made inactive changes no record", async () => {
      const leo = await recordOfCustomer("12", "student");
      await offStudent("12");
      expect(await studentRow(leo)).toMatchObject({ active: false, familyId: await recordOfCustomer("10", "family") });
      expect((await auditsOf("roster.customer.deactivate"))[0]!.after).toMatchObject({ appRecord: { kind: "student", studentId: String(leo), set: { active: false } } });
      const before = await appRecordRows();
      await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op);
      expect(await appRecordRows()).toEqual(before);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a family made inactive with everyone under it: each student's record as its step goes through, the family's at the end", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      expect(await inactivate("10", await stampFor("10"), op)).toMatchObject({ result: { ok: true } });
      expect(await studentRow(leo)).toMatchObject({ active: false });
      expect(await familyRow(rivera)).toMatchObject({ active: false });
      const rows = (await auditsOf("roster.customer.deactivate")).reverse();
      expect(rows.map((a) => [a.targetId, (a.after as { appRecord?: { kind: string } }).appRecord?.kind ?? null])).toEqual([["11", null], ["12", "student"], ["10", "family"]]);
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a family whose own last step's answer is lost: held on the queue, and the queue makes the family's record inactive once a read shows it", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      stub.onApiRequest = (c) => { stub.loseUpdateAnswer = c.method === "POST" && /"Id":"10"/.test(c.body); };
      const r = await inactivate("10", await stampFor("10"), op);
      stub.onApiRequest = null; stub.loseUpdateAnswer = false;
      expect((r.result as { errors: string[] }).errors.at(-1)).toBe("Whether Rivera Family is still active shows once the roster is read again.");
      expect(await studentRow(leo)).toMatchObject({ active: false });
      expect(await familyRow(rivera)).toMatchObject({ active: true });
      expect(await queue()).toEqual([expect.objectContaining({ sent: true, targetQboId: "10", familyId: rivera, studentId: null, state: "waiting" })]);
      await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 60_000) });
      stub.calls.length = 0;
      await runWriteQueue();
      expect(posts()).toEqual([]); // QuickBooks made it: found by the read, never sent again
      expect((await queue())[0]).toMatchObject({ state: "done" });
      expect(await familyRow(rivera)).toMatchObject({ active: false });
    });

    it("someone QuickBooks shows inactive already: nothing is sent, and their record is made inactive, as the queue makes it", async () => {
      const leo = await recordOfCustomer("12", "student");
      stub.customers.find((c) => c.Id === "12")!.Active = false; // made inactive in QuickBooks; the cache doesn't know yet
      expect(await offStudent("12")).toEqual({ ok: true, message: WRITE_COPY.inactiveFollowed });
      expect(posts()).toEqual([]);
      expect(await studentRow(leo)).toMatchObject({ active: false });
      expect((await auditsOf("roster.record.follows"))[0]).toMatchObject({ targetId: "12", permission: "Roster.Family.ReadWrite",
        after: { op: "deactivate", role: "student", code: "already_inactive", appRecord: { kind: "student", studentId: String(leo), set: { active: false } } } });
      expect(await auditsOf("roster.write.refused")).toEqual([]);
      // Asked again from the same page: the portal's own record is inactive now, so nothing is read or sent.
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      stub.calls.length = 0;
      expect(await offStudent("12")).toEqual({ ok: false, errors: ["That is inactive in the portal, so nothing was changed."] });
      expect(stub.apiCalls()).toEqual([]);
    });

    it("the family action: whoever QuickBooks shows inactive already is passed over and their record made inactive", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      stub.customers.find((c) => c.Id === "12")!.Active = false;
      expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: true, message: "Made inactive in QuickBooks: Ana Rivera, then Rivera Family." });
      expect(sent().map((b) => b.Id)).toEqual(["11", "10"]);
      expect(await studentRow(leo)).toMatchObject({ active: false });
      expect(await familyRow(rivera)).toMatchObject({ active: false });
      expect((await auditsOf("roster.record.follows")).map((a) => a.targetId)).toEqual(["12"]);
    });

    it("a student QuickBooks moved into the family keeps the record the app holds in their own family when this one is made inactive", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      // Leo moved to the Chen family in QuickBooks alone: the app still holds him in the Rivera family's record.
      Object.assign(stub.customers.find((c) => c.Id === "12")!, { ParentRef: { value: "20" }, SyncToken: "1" });
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect((await inactivate("20", await stampFor("20"), op)).result).toMatchObject({ ok: true });
      expect(sent().map((b) => b.Id)).toEqual(["12", "21", "20"]);
      expect(await studentRow(leo)).toMatchObject({ active: true, familyId: rivera });
      // His link is left with the version the portal last aligned with: the step changed no record of his, so the link
      // never claims QuickBooks' inactive version for a record that is still active.
      expect((await studentLinkOf("12"))!.syncedToken).toBe("0");
      expect((await auditsOf("roster.customer.deactivate")).find((a) => a.targetId === "12")!.after).not.toHaveProperty("appRecord");
      expect((await auditsOf("roster.customer.deactivate")).find((a) => a.targetId === "12")!.after).not.toHaveProperty("linkVersion");
      expect(await familyRow(await recordOfCustomer("20", "family"))).toMatchObject({ active: false });
    });

    it("a rename to the name QuickBooks has already: nothing is sent, and the record takes it; a second ask changes nothing", async () => {
      const leo = await recordOfCustomer("12", "student");
      Object.assign(stub.customers.find((c) => c.Id === "12")!, { DisplayName: "Leon Rivera", SyncToken: "1" }); // renamed in QuickBooks alone
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect(await studentRow(leo)).toMatchObject({ name: "Leo Rivera" });
      expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "1", name: "Leon Rivera" }, tag, op)).toEqual({ ok: true, message: WRITE_COPY.namedFollowed });
      expect(posts()).toEqual([]);
      expect(await studentRow(leo)).toMatchObject({ name: "Leon Rivera" });
      expect((await auditsOf("roster.record.follows"))[0]!.after).toMatchObject({ op: "rename", code: "already_named", appRecord: { kind: "student", set: { name: "Leon Rivera" } } });
      expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "1", name: "Leon Rivera" }, tag, op)).toEqual({ ok: false, errors: ["That is its name already, so there was nothing to change."] });
    });

    it("a student is moved only into one of the app's own active families: an id that is no family record, or an inactive one, is refused before anything is saved or sent", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      // A family added in QuickBooks alone has no record since slice 9c, so the page has no id to send for it.
      expect(await moveStudent(String(leo), "00000000-0000-4000-8000-000000000000", tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOurs] });
      expect(await moveStudent(String(leo), String(leo), tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOurs] }); // a student isn't a family
      expect(await moveStudent(String(rivera), String(rivera), tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.gone] }); // a family isn't a student
      expect(await moveStudent("12", String(rivera), tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.gone] });             // a QuickBooks id isn't one
      expect(await move("12", "10")).toEqual({ ok: false, errors: ["The student is in that family already, so there was nothing to change."] });
      // Nor into a family of the app's that is inactive, though its customer is active.
      await db.update(family).set({ active: false }).where(eq(family.id, await recordOfCustomer("20", "family")));
      expect(await move("12", "20")).toEqual({ ok: false, errors: [WRITE_COPY.notOurs] });
      expect(posts()).toEqual([]);
      expect(await studentRow(leo)).toMatchObject({ familyId: rivera, active: true });
      expect(await auditsOf("roster.student.move.followed")).toEqual([]);
      expect(await auditsOf("roster.record.moved")).toEqual([]);
    });

    it("a family QuickBooks made inactive itself: the action sends nothing and makes its record inactive, audited with before and after; pressed again, nothing more", async () => {
      const rivera = await recordOfCustomer("10", "family");
      for (const id of ["11", "12", "10"]) Object.assign(inStub(id), { Active: false, SyncToken: "1" });
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect(await familyRow(rivera)).toMatchObject({ active: true }); // a read changes no record
      const r = await inactivate("10", await stampFor("10"), op);
      expect(r).toEqual({ changed: true, result: { ok: true, message: "Rivera Family is inactive in QuickBooks already, so nothing was sent. The portal's own family is inactive now too. The roster is being read again to show it." } });
      expect(posts()).toEqual([]);
      expect(await familyRow(rivera)).toMatchObject({ active: false });
      const follows = await auditsOf("roster.record.follows");
      expect(follows.map((a) => [a.targetId, a.before, a.after])).toEqual([["10", { kind: "family", familyId: String(rivera), name: "Rivera Family", active: true },
        { op: "deactivate", role: "family", code: "already_inactive", appRecord: { kind: "family", familyId: String(rivera), set: { active: false } } }]]);
      expect((await auditsOf("roster.family.deactivate"))[0]!.after).toMatchObject({ outcome: "done", code: "already_inactive", alreadyInactive: ["10"] });
      expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: false, errors: ["That family is inactive in QuickBooks already, so there was nothing to change."] });
    });

    it("a move QuickBooks has that the portal's record doesn't (given up on the queue, or made in QuickBooks): moving there sends nothing, and the record, forms and places follow once", async () => {
      const rivera = await recordOfCustomer("10", "family"), chen = await recordOfCustomer("20", "family"), leo = await recordOfCustomer("12", "student");
      const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
      const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null });
      const requestId = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_leoapart" });
      Object.assign(inStub("12"), { ParentRef: { value: "20" }, SyncToken: "1" });
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
      // An ordinary move since slice 9f: to the family QuickBooks has him in, nothing is sent and there is no item.
      expect(await move("12", "20")).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal. QuickBooks has them in that family already, so nothing was sent." });
      expect(posts()).toEqual([]);
      expect(await queue()).toEqual([]);
      expect(await studentRow(leo)).toMatchObject({ familyId: chen, active: true });
      expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "20", state: "not_opened" });
      expect((await auditsOf("roster.student.move.followed")).map((a) => (a.after as { cause: string }).cause)).toEqual([`roster.record.moved#${leo}`]);
      expect((await auditsOf("roster.record.moved"))[0]!.after).toMatchObject({ fromFamilyId: String(rivera), familyId: String(chen), quickbooks: "has_it" });
      expect(await auditsOf("roster.record.follows")).toEqual([]);
      // Asked again: nothing more to change.
      expect(await move("12", "20")).toEqual({ ok: false, errors: ["The student is in that family already, so there was nothing to change."] });
    });

    it("a move QuickBooks has elsewhere, into a family of the portal's with no link: kept, nothing sent, the portal's record moved", async () => {
      const leo = await recordOfCustomer("12", "student");
      // Leo moved in QuickBooks to the Chen family, and the portal moves him on to a family of its own with no link.
      Object.assign(inStub("12"), { ParentRef: { value: "20" }, SyncToken: "1" });
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
      const linked = await db.select().from(accountingLink).where(eq(accountingLink.familyId, okafor!.id));
      expect(linked).toEqual([]);
      expect(await moveStudent(String(leo), String(okafor!.id), tag, op)).toMatchObject({ ok: true, status: "attention" });
      expect(posts()).toEqual([]);
      expect(await studentRow(leo)).toMatchObject({ familyId: okafor!.id });
      expect((await queue()).map((i) => [i.state, i.lastCode])).toEqual([["refused", "no_family_customer"]]);
      expect(inStub("12")).toMatchObject({ ParentRef: { value: "20" } });
    });

    it("a student QuickBooks has under a family that isn't the app's, moved to one of the app's families: the record moves at the save, and the move is held by the field, nothing sent over QuickBooks' place", async () => {
      const rivera = await recordOfCustomer("10", "family"), chen = await recordOfCustomer("20", "family"), leo = await recordOfCustomer("12", "student");
      const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
      const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null });
      const requestId = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_leookafor" });
      // A family made in QuickBooks alone, which has no record since slice 9c, and Leo moved under it there.
      stub.customers.push({ Id: "70", DisplayName: "Okafor Family", Active: true, SyncToken: "0", CustomerTypeRef: { value: "1" } });
      Object.assign(inStub("12"), { ParentRef: { value: "70" }, SyncToken: "1" });
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
      // The cache has him under Okafor, not the Rivera family the portal moves him from: read live first, and held.
      const r = await move("12", "20");
      expect(r).toMatchObject({ ok: true, status: "attention" });
      expect((r as { message: string }).message).toContain("QuickBooks has the student under “Okafor Family” now.");
      expect(posts()).toEqual([]);
      expect(inStub("12")).toMatchObject({ ParentRef: { value: "70" } });
      expect(await studentRow(leo)).toMatchObject({ familyId: chen, active: true });
      expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "20" });
      expect((await auditsOf("roster.student.move.followed")).map((a) => a.after)).toEqual([expect.objectContaining({ fromFamilyId: String(rivera), toFamilyId: String(chen) })]);
      expect((await queue()).map((i) => [i.state, i.lastCode, i.request])).toEqual([["refused", PLACE_DIFFERS, expect.objectContaining({ op: "move", fromFamilyQboId: "10", toFamilyQboId: "20" })]]);
    });

    it("a student QuickBooks has under a family that isn't the app's, asked to move to the family the portal holds them in: nothing to change, nothing sent", async () => {
      stub.customers.push({ Id: "70", DisplayName: "Okafor Family", Active: true, SyncToken: "0", CustomerTypeRef: { value: "1" } });
      Object.assign(inStub("12"), { ParentRef: { value: "70" }, SyncToken: "1" });
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect(await move("12", "10")).toEqual({ ok: false, errors: ["The student is in that family already, so there was nothing to change."] });
      expect(posts()).toEqual([]);
      expect(await auditsOf("roster.student.move.followed")).toEqual([]);
    });

    it("nothing is sent for a family or student whose own record is inactive in the portal", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      await db.update(family).set({ active: false }).where(eq(family.id, rivera));
      expect(await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOursToAdd] });
      expect(await askRosterWrite({ op: "rename", qboId: "10", syncToken: "0", name: "Rivera-Diaz Family" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.inactiveHere] });
      expect(await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana M. Rivera" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.inactiveHere] });
      expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: false, errors: [WRITE_COPY.inactiveHere] });
      await db.update(family).set({ active: true }).where(eq(family.id, rivera));
      await db.update(student).set({ active: false }).where(eq(student.id, leo));
      expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.inactiveHere] });
      expect(await move("12", "20")).toEqual({ ok: false, errors: ["That is inactive in the portal, so nothing was changed."] });
      expect(await offStudent("12")).toEqual({ ok: false, errors: ["That is inactive in the portal, so nothing was changed."] });
      expect(posts()).toEqual([]);
    });

    it("a family whose make-inactive stops part way keeps its record active, and the student made inactive is inactive", async () => {
      const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
      // The family's own write is the one QuickBooks turns away.
      stub.onApiRequest = (c) => { stub.updateFault = c.method === "POST" && /"Id":"10"/.test(c.body) ? "6000" : null; };
      expect((await inactivate("10", await stampFor("10"), op)).result.ok).toBe(false);
      expect(await studentRow(leo)).toMatchObject({ active: false });
      expect(await familyRow(rivera)).toMatchObject({ active: true });
    });
  });

  describe("flat books", () => {
    beforeEach(async () => { tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } }); });

    it("a new member: an active family record and its link, as created by the staff member", async () => {
      await add("member", "Okafor Household", "3");
      const made = stub.customers.find((c) => c.DisplayName === "Okafor Household")!;
      const [link] = await linkOf(made.Id as string);
      expect(link).toMatchObject({ origin: "created", linkedBy: op.staffUserId, studentId: null });
      expect(await familyRow(link!.familyId)).toMatchObject({ name: "Okafor Household", active: true });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });

    it("a member renamed, then made inactive: their family record follows each", async () => {
      const ana = await recordOfCustomer("11", "family");
      await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana R. Rivera" }, tag, op);
      expect(await familyRow(ana)).toMatchObject({ name: "Ana R. Rivera", active: true });
      expect((await offMember("11")).ok).toBe(true);
      expect(sent().at(-1)).toEqual({ Id: "11", SyncToken: "1", sparse: true, Active: false }); // the link's own version, aligned by the rename
      expect(await familyRow(ana)).toMatchObject({ name: "Ana R. Rivera", active: false });
      expect((await auditsOf("roster.customer.deactivate"))[0]!.after).toMatchObject({ appRecord: { kind: "family", familyId: String(ana), set: { active: false } } });
      expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    });
  });
});

describe("nobody with a balance is made inactive (the owner's decision of 2026-11-17)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });
  const treasurer = async () => asOp(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Finance.Balance.Read"]));

  it("a balance on the family: nothing is sent, and staff are told who, with the amount only for Finance.Balance.Read", async () => {
    stub.invoices = [owes("901", "10", 42.5)];
    const shown = await stampFor("10");
    expect(await inactivate("10", shown, op)).toEqual({ changed: false, result: { ok: false,
      errors: ["Rivera Family has an open balance in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] } });
    expect(await inactivate("10", shown, { ...(await treasurer()), showAmounts: true })).toEqual({ changed: false, result: { ok: false,
      errors: ["Rivera Family owes $42.50 in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] } });
    expect(posts()).toEqual([]);
    expect(await cached("10")).toMatchObject({ active: true });
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "refused", code: "open_balance", made: [], notMade: ["11", "12", "10"] });
    expect(JSON.stringify(await audits())).not.toContain("42.5");
  });

  it("a balance on one member of the family: nobody is made inactive, the others neither", async () => {
    stub.invoices = [owes("902", "12", 15)];
    const r = await inactivate("10", await stampFor("10"), { ...op, showAmounts: true });
    expect(r.result).toEqual({ ok: false, errors: ["Leo Rivera owes $15.00 in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: true });
  });

  it("a credit stops it too (stage 3's slice 9g): any balance, owed or a credit, and nothing is sent", async () => {
    // A credit: the customer's own Balance below zero, as QuickBooks shows an unapplied payment or credit memo.
    stub.invoices = [owes("903", "12", -20)];
    expect((await inactivate("10", await stampFor("10"))).result).toEqual({ ok: false, errors: ["Leo Rivera has a credit in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] });
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "refused", code: CREDIT_BALANCE, made: [], notMade: ["11", "12", "10"] });
    expect((await inactivate("10", await stampFor("10"), { ...(await treasurer()), showAmounts: true })).result)
      .toEqual({ ok: false, errors: ["Leo Rivera has a credit of $20.00 in QuickBooks.", `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] });
    // One owing and one with a credit: both named, and the row's code says something is owed.
    stub.invoices = [owes("903", "12", -20), owes("909", "11", 5)];
    expect((await inactivate("10", await stampFor("10"))).result).toEqual({ ok: false, errors: ["Ana Rivera has an open balance in QuickBooks.", "Leo Rivera has a credit in QuickBooks.",
      `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] });
    // One student alone, and a Parent customer, the same way.
    stub.invoices = [owes("903", "12", -20), owes("910", "21", -3)];
    expect(await offStudent("12")).toEqual({ ok: false, errors: [`Leo Rivera has a credit in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "deactivate", role: "student", code: CREDIT_BALANCE });
    expect(await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, { ...op, showAmounts: true }))
      .toEqual({ ok: false, errors: [`Mei Chen has a credit of $3.00 in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(WRITE_COPY.balanceFix).toMatch(/a credit used or refunded/);
    expect(posts()).toEqual([]);
    expect(await queue()).toEqual([]);
    for (const id of ["10", "11", "12", "21"]) expect(await cached(id)).toMatchObject({ active: true });
  });

  it("a linked student or member is never made inactive by a customer's id and a page's version: only by the record", async () => {
    stub.calls.length = 0; // the roster read in beforeEach asked its own queries
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [LINKED_DEACTIVATE] });
    expect(stub.apiCalls()).toEqual([]);
    expect(await offStudent("12")).toEqual({ ok: true, message: "Made inactive in QuickBooks." });
    expect(sent()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, Active: false }]);
    // Anything but a record's uuid is no record; a family's record asked as a student, or a layered family as a member, is refused.
    expect(await deactivateLinked({ kind: "student", recordId: "12" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.gone] });
    expect(await deactivateLinked({ kind: "student", recordId: String(await recordOfCustomer("20", "family")) }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.gone] });
    expect(await deactivateLinked({ kind: "family", recordId: String(await recordOfCustomer("20", "family")) }, tag, op)).toEqual({ ok: false, errors: [familyHereWords("Chen Family")] });
    expect(sent()).toHaveLength(1);
  });

  it("one student or parent with a balance is not made inactive either, and nothing is sent", async () => {
    stub.invoices = [owes("904", "12", 30)];
    expect(await offStudent("12"))
      .toEqual({ ok: false, errors: [`Leo Rivera has an open balance in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(await offStudent("12", { ...op, showAmounts: true }))
      .toEqual({ ok: false, errors: [`Leo Rivera owes $30.00 in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "deactivate", role: "student", code: "open_balance" });
  });

  it("a balance that appears between the read and the write: QuickBooks' refusal (6220) is told in the same words, not as a code", async () => {
    // QuickBooks answers the read with no balance; the invoice lands just before the write.
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.invoices = [owes("905", "12", 30)]; };
    const one = await offStudent("12");
    expect(one).toEqual({ ok: false, errors: ["QuickBooks says there is a balance on Leo Rivera's account, so they weren't made inactive. It has to be settled in QuickBooks first: paid or written off, or a credit used or refunded. Then try again."] });
    expect(JSON.stringify(one)).not.toMatch(/6220/);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "deactivate", code: "fault_6220" });
    expect(await queue()).toEqual([]);
    // In the family action, the first one under it: nobody is made inactive, and the family is still active.
    stub.invoices = []; stub.onApiRequest = (c) => { if (c.method === "POST") stub.invoices = [owes("906", "11", 30)]; };
    const fam = await inactivate("10", await stampFor("10"), op);
    expect(fam).toEqual({ changed: false, result: { ok: false, errors: ["Nobody was made inactive.",
      "QuickBooks says there is a balance on Ana Rivera's account, so they weren't made inactive. It has to be settled in QuickBooks first: paid or written off, or a credit used or refunded. Then try again.",
      "Not made inactive yet: Leo Rivera.", "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] } });
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "fault_6220", made: [], notMade: ["11", "12", "10"] });
  });

  it("what is owed couldn't be read: refused in words, nothing sent and nothing queued (open question 11), for a family, a student and a Parent customer", async () => {
    stub.dropApi = true;
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnread] });
    expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnread] });
    expect(await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnread] });
    expect((await auditsOf("roster.write.refused")).map((a) => (a.after as { code: string }).code)).toEqual(["unreachable", "unreachable"]);
    expect(await queue()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("an answer with no balance in it isn't taken for nothing owed", async () => {
    stub.quirks.balances = false;
    expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect(posts()).toEqual([]);
  });
});

describe("making a family inactive can stop part way, says what is now true, and carries on when pressed again", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });
  const CARRY_ON = "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active.";

  it("a refusal part way: who was made inactive, who wasn't and why, and the family still active; pressed again, it finishes", async () => {
    const shown = await stampFor("10");
    stub.onApiRequest = (c) => { stub.updateFault = c.method === "POST" && /"Id":"12"/.test(c.body) ? "6000" : null; };
    const first = await inactivate("10", shown, op);
    expect(first).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera.",
      "QuickBooks wouldn't make Leo Rivera inactive, so it wasn't changed. Check it in QuickBooks.", CARRY_ON] } });
    expect(await cached("11")).toMatchObject({ active: false });
    expect(await cached("12")).toMatchObject({ active: true });
    expect(await cached("10")).toMatchObject({ active: true });
    expect(sent().map((b) => b.Id)).toEqual(["11", "12"]); // the family was never sent
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "fault_6000", made: ["11"], notMade: ["12", "10"] });
    expect(await queue()).toEqual([]);
    // The page is made again after the stop (`changed`), so its stamp covers whoever is still active: pressed with the
    // old one, the cover no longer reads so and nothing is sent; pressed from the page as made again, Ana is passed over
    // and Leo and then the family are made inactive.
    stub.onApiRequest = null; stub.updateFault = null; stub.calls.length = 0;
    expect(await inactivate("10", shown, op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.coverChanged] } });
    expect(stub.apiCalls()).toEqual([]);
    expect(await inactivate("10", await stampFor("10"), op)).toEqual({ changed: true, result: { ok: true, message: "Made inactive in QuickBooks: Leo Rivera, then Rivera Family." } });
    expect(sent().map((b) => b.Id)).toEqual(["12", "10"]);
    expect(await cached("10")).toMatchObject({ active: false });
  });

  it("QuickBooks still refusing the family (800: someone under it the cache doesn't show yet): said in words, and the roster read again", async () => {
    // A customer under the family that QuickBooks has and the cache doesn't: QuickBooks refuses the family.
    stub.onApiRequest = (c) => { if (c.method === "POST" && /"Id":"10"/.test(c.body)) stub.customers.push({ Id: "19", DisplayName: "New Rivera", Active: true, SyncToken: "0", ParentRef: { value: "10" }, Job: true }); };
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera and Leo Rivera.",
      "QuickBooks won't make Rivera Family inactive while customers under it are still active, and it has someone under Rivera Family the roster here doesn't show yet, so Rivera Family wasn't changed. The roster is being read again: try again in a few minutes.", CARRY_ON] } });
    // Not a loop: the worker is asked to read the roster, after which the page lists the one QuickBooks has.
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    stub.onApiRequest = null;
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    expect((await familyCover("10"))!.under.map((u) => u.qboId)).toEqual(["19"]);
    expect(JSON.stringify(r)).not.toMatch(/\b800\b/);
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toMatchObject({ outcome: "stopped", code: "fault_800" });
  });

  it("QuickBooks can't be reached part way: it stops, the lost answer is held on the queue as possibly made, the queue finishes it after a read, and pressing again carries on", async () => {
    const shown = await stampFor("10");
    const leo = await recordOfCustomer("12", "student");
    // The second write reaches QuickBooks, which makes Leo inactive, and the answer never comes back.
    stub.onApiRequest = (c) => { stub.loseUpdateAnswer = c.method === "POST" && /"Id":"12"/.test(c.body); };
    const first = await inactivate("10", shown, op);
    expect(first.changed).toBe(true);
    expect(first.result).toEqual({ ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera.",
      "The portal can't tell whether QuickBooks made Leo Rivera inactive: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice.",
      "Rivera Family is still active. Once the change waiting for Leo Rivera has gone through (the Reconciliation page lists it until then), press “Make Rivera Family inactive” again to carry on with whoever is still active."] });
    // Held as one QuickBooks may have made, filed under the family and Leo's record: since stage 3's slice 9c no read
    // makes his record inactive, so the queue must.
    expect(await queue()).toEqual([expect.objectContaining({ state: "waiting", sent: true, lastCode: "unreachable", targetQboId: "12",
      familyId: await recordOfCustomer("10", "family"), studentId: leo, askedBy: op.staffUserId })]);
    expect((await auditsOf("roster.write.queued"))[0]!.after).toMatchObject({ op: "deactivate", role: "student", code: "unreachable", sent: true });
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    expect(await cached("12")).toMatchObject({ active: true }); // left until the roster is read again: never guessed
    // The step that may have gone through is recorded apart, never as not made.
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "unreachable", made: ["11"], notMade: ["10"], maybe: ["12"] });
    // Pressed again before the queue has found it: refused, as anything with a change waiting is.
    stub.onApiRequest = null; stub.loseUpdateAnswer = false;
    expect(await inactivate("10", await stampFor("10"), op)).toEqual({ changed: false, result: { ok: false, errors: [WRITE_COPY.waiting] } });
    // The worker reads the roster (Leo is inactive there), finds the change made, sends nothing, and makes his record inactive.
    stub.calls.length = 0;
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 60_000) });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect((await queue())[0]).toMatchObject({ state: "done" });
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ active: false });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found", appRecord: { kind: "student", studentId: String(leo), set: { active: false } } });
    // Pressed again, the family alone is sent.
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: true, message: "Made Rivera Family inactive in QuickBooks." });
    expect(sent().map((b) => b.Id)).toEqual(["10"]);
  });

  it("QuickBooks turning the first write away unread (429): nothing was made inactive, the family is still active, nothing is queued", async () => {
    const shown = await stampFor("10");
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.rateLimitNext = 1; };
    const r = await inactivate("10", shown, op);
    expect(r).toEqual({ changed: false, result: { ok: false, errors: ["Nobody was made inactive.",
      "QuickBooks couldn't take that just now, so Ana Rivera wasn't changed. Try again in a few minutes.", "Not made inactive yet: Leo Rivera.", CARRY_ON] } });
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: true });
    expect(await queue()).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]);
  });
});

describe("what QuickBooks shows of each record, read before anything is sent, and the family's own last step", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("a QuickBooks that raises a family's version when a customer under it changes: the family is sent with the version just read", async () => {
    stub.quirks.parentVersionFollows = true;
    expect((await inactivate("10", await stampFor("10"), op)).result).toMatchObject({ ok: true });
    // Two customers under it were made inactive, so the family's version went from 0 to 2 before its own write.
    expect(sent().at(-1)).toEqual({ Id: "10", SyncToken: "2", sparse: true, Active: false });
    expect(await cached("10")).toMatchObject({ active: false });
  });

  it("a QuickBooks that leaves the family's version alone: the family is sent with the version just read, which is the same", async () => {
    expect((await inactivate("10", await stampFor("10"), op)).result).toMatchObject({ ok: true });
    expect(sent().at(-1)).toEqual({ Id: "10", SyncToken: "0", sparse: true, Active: false });
  });

  it("each step carries its own link's version, never a page's: a stale one is read again and, still active with no balance, sent once more (stage 3's slice 9g)", async () => {
    stub.customers.find((c) => c.Id === "12")!.SyncToken = "3"; // changed in QuickBooks since the roster was read
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: true, message: "Made inactive in QuickBooks: Ana Rivera and Leo Rivera, then Rivera Family." } });
    // Ana has no link of her kind: sent with the version her read showed. Leo: his link's own (0), refused as stale,
    // read again (3) and sent once more with it.
    expect(sent()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, Active: false }, { Id: "12", SyncToken: "0", sparse: true, Active: false },
      { Id: "12", SyncToken: "3", sparse: true, Active: false }, { Id: "10", SyncToken: "0", sparse: true, Active: false }]);
    expect((await studentLinkOf("12"))!.syncedToken).toBe("4");
    expect((await auditsOf("roster.customer.deactivate")).find((a) => a.targetId === "12")!.after).toMatchObject({ resent: "stale" });
    // A Parent customer alone keeps its page's version (Mei, outside Rivera's cover, still active): one QuickBooks has
    // moved on from is read again and shown.
    stub.customers.find((c) => c.Id === "21")!.SyncToken = "5";
    expect(await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op)).toMatchObject({ ok: false, errors: [WRITE_COPY.changed], current: { name: "Mei Chen" } });
  });

  it("someone QuickBooks shows inactive already is passed over, and the roster is asked to be read again", async () => {
    stub.customers.find((c) => c.Id === "11")!.Active = false; // made inactive in QuickBooks; the cache doesn't know yet
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: true, message: "Made inactive in QuickBooks: Leo Rivera, then Rivera Family." });
    expect(sent().map((b) => b.Id)).toEqual(["12", "10"]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toMatchObject({ outcome: "done", alreadyInactive: ["11"] });
    // One alone: said, and shown as QuickBooks has it.
    stub.customers.find((c) => c.Id === "21")!.Active = false;
    expect(await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op))
      .toMatchObject({ ok: false, errors: ["That is inactive in QuickBooks already, so there was nothing to change."], current: { active: false } });
  });

  it("the family's last step refused as changed (5010) says it changed while this was running, and the page is made again", async () => {
    // Someone in QuickBooks at that very moment, twice: each send meets a newer version than the read just before it.
    stub.beforeUpdate = (c) => { if (c.Id === "10") c.SyncToken = String(Number(c.SyncToken) + 1); };
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera and Leo Rivera.",
      "Rivera Family changed in QuickBooks while this was running, so it wasn't made inactive. Press “Make Rivera Family inactive” again.",
      "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] } });
    expect(sent().filter((b) => b.Id === "10").map((b) => b.SyncToken)).toEqual(["0", "1"]); // sent once more, never a third time
    expect(await cached("10")).toMatchObject({ active: true, syncToken: "2" });
    expect(await queue()).toEqual([]);
  });

  it("the very first step refused as changed (5010): read again, still active with no balance, and sent once more with the version just read", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "11") c.SyncToken = "4"; };
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: true, message: "Made inactive in QuickBooks: Ana Rivera and Leo Rivera, then Rivera Family." } });
    expect(sent().map((b) => [b.Id, b.SyncToken])).toEqual([["11", "0"], ["11", "4"], ["12", "0"], ["10", "0"]]);
  });

  it("a step's stale answer whose read shows them inactive there: passed over, nothing more sent, the record follows", async () => {
    const leo = await recordOfCustomer("12", "student");
    // Made inactive in QuickBooks at the very moment the portal sends it.
    stub.beforeUpdate = (c) => { if (c.Id === "12") { c.Active = false; c.SyncToken = "1"; } };
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: true, message: "Made inactive in QuickBooks: Ana Rivera, then Rivera Family. "
      + "QuickBooks had Leo Rivera made inactive meanwhile, so nothing more was sent for them. The portal's own record of Leo Rivera is inactive now too." });
    expect(sent().map((b) => b.Id)).toEqual(["11", "12", "10"]);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1); // the roster is read again
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ active: false });
    expect((await studentLinkOf("12"))!.syncedToken).toBe("0"); // not the portal's send that made it so
    expect((await auditsOf("roster.record.follows")).map((a) => a.targetId)).toEqual(["12"]);
  });

  it("the family made inactive in QuickBooks before its own last read: nothing sent for it, the read stored, the roster asked to be read again, and the family follows", async () => {
    const rivera = await recordOfCustomer("10", "family");
    stub.onApiRequest = (c) => { if (c.method === "POST" && /"Id":"12"/.test(c.body)) Object.assign(inStub("10"), { Active: false, SyncToken: "1" }); };
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: true,
      message: "Made inactive in QuickBooks: Ana Rivera and Leo Rivera. Rivera Family is inactive in QuickBooks now, so nothing more was sent for it. The portal's own family is inactive now too." });
    expect(sent().map((b) => b.Id)).toEqual(["11", "12"]);
    expect(await cached("10")).toMatchObject({ active: false, syncToken: "1" });
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    expect((await db.select().from(family).where(eq(family.id, rivera)))[0]).toMatchObject({ active: false });
  });

  it("someone a stale answer's read found inactive is named when a later step stops it", async () => {
    stub.beforeUpdate = (c) => {
      if (c.Id === "11") { c.Active = false; c.SyncToken = "1"; } // Ana made inactive in QuickBooks as the portal sends hers
      if (c.Id === "12" && c.SyncToken === "0") { c.SyncToken = "1"; stub.invoices = [owes("913", "12", 8)]; }
    };
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Nobody was made inactive.", "QuickBooks had Ana Rivera made inactive meanwhile, so nothing more was sent for them.",
      `Leo Rivera has an open balance in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`,
      "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] } });
    expect(sent().map((b) => b.Id)).toEqual(["11", "12"]);
  });

  it("a balance that appears meanwhile: on a step's read after a stale answer, and on the family's own read before its last step", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12" && c.SyncToken === "0") { c.SyncToken = "1"; stub.invoices = [owes("911", "12", 8)]; } };
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r.result).toEqual({ ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera.", `Leo Rivera has an open balance in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`,
      "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] });
    expect(sent().map((b) => b.Id)).toEqual(["11", "12"]); // never sent again with a balance standing
    // The family's own: an invoice lands on it after its members' writes, before its own read.
    stub.beforeUpdate = null; stub.invoices = []; stub.calls.length = 0;
    stub.onApiRequest = (c) => { if (c.method === "POST" && /"Id":"12"/.test(c.body)) stub.invoices = [owes("912", "10", 4)]; };
    const fam = await inactivate("10", await stampFor("10"), op);
    expect(fam.result).toEqual({ ok: false, errors: ["Made inactive in QuickBooks: Leo Rivera.", `Rivera Family has an open balance in QuickBooks. It wasn't made inactive. ${WRITE_COPY.balanceFix}`,
      "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] });
    // Leo's link still holds the version before the first press's stale answer: sent with it, then once more.
    expect(sent().map((b) => [b.Id, b.SyncToken])).toEqual([["12", "0"], ["12", "1"]]);
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toMatchObject({ outcome: "stopped", code: "open_balance", made: ["12"], notMade: ["10"] });
    expect(await cached("10")).toMatchObject({ active: true });
  });

  it("a stale answer on a later step whose read again can't be made: says Ana was made inactive and Leo wasn't changed, never that nothing was", async () => {
    // Leo changed in QuickBooks as the portal sends his (a 5010), and QuickBooks can't be reached for the read after it.
    stub.beforeUpdate = (c) => { if (c.Id === "12" && c.SyncToken === "0") { c.SyncToken = "1"; stub.dropApi = true; } };
    const r = await inactivate("10", await stampFor("10"), op);
    expect(r).toEqual({ changed: true, result: { ok: false, errors: ["Made inactive in QuickBooks: Ana Rivera.",
      "QuickBooks couldn't be asked what Leo Rivera owes just now, so Leo Rivera wasn't changed. Try again in a few minutes.",
      "Rivera Family is still active. Press “Make Rivera Family inactive” again to carry on with whoever is still active."] } });
    expect(JSON.stringify(r)).not.toMatch(/nothing was changed/);
    stub.dropApi = false; stub.beforeUpdate = null;
    expect(sent().map((b) => [b.Id, b.SyncToken])).toEqual([["11", "0"], ["12", "0"]]); // never sent again unread
    expect((await auditsOf("roster.family.deactivate"))[0]!.after).toEqual({ outcome: "stopped", code: "unreachable", made: ["11"], notMade: ["12", "10"] });
    expect(await cached("11")).toMatchObject({ active: false });
    expect(await cached("12")).toMatchObject({ active: true });
    expect(await cached("10")).toMatchObject({ active: true });
    expect(await queue()).toEqual([]);
  });

  it("a balance read QuickBooks refuses outright says so, without asking to wait, and nothing is queued", async () => {
    stub.customers = stub.customers.filter((c) => c.Id !== "12"); // QuickBooks no longer answers for Leo: a 400
    expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.balanceRefused] });
    expect((await inactivate("10", await stampFor("10"), op)).result).toEqual({ ok: false, errors: [WRITE_COPY.balanceRefused] });
    expect(WRITE_COPY.balanceRefused).not.toMatch(/try again in a few minutes/i);
    expect(await queue()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("two staff pressing at once: one makes them inactive, the other is stopped, and nobody is sent twice to any effect", async () => {
    const shown = await stampFor("10");
    const other = asOp(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const [a, b] = await Promise.all([inactivate("10", shown, op), inactivate("10", shown, other)]);
    expect([a, b].filter((x) => x.result.ok)).toHaveLength(1);
    for (const id of ["10", "11", "12"]) expect(await cached(id)).toMatchObject({ active: false });
    expect((await auditsOf("roster.customer.deactivate")).map((x) => x.targetId).sort()).toEqual(["10", "11", "12"]);
  });

  it("waits for a roster read holding the lock, sending nothing meanwhile, then goes ahead", async () => {
    const shown = await stampFor("10");
    const lock = await holdTheRosterLock();
    let pending: Promise<unknown>;
    try {
      pending = inactivate("10", shown, op);
      await untilALockIsAwaited();
      expect(stub.apiCalls().filter((c) => c.method === "POST" || c.path.includes("/customer/"))).toEqual([]);
    } finally { await lock.release(); }
    expect(await pending!).toMatchObject({ result: { ok: true } });
  });
});

describe("a make-inactive waiting on the queue reads what is owed before it is sent", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("one who owes is never sent: the item is stuck, with a code of its own", async () => {
    stub.invoices = [owes("907", "21", 25)];
    const item = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: "20" });
    stub.calls.length = 0;
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: "open_balance", sent: false });
    expect(stub.apiCalls().map((c) => c.method)).toContain("GET");
    expect(posts()).toEqual([]);
    expect(await cached("21")).toMatchObject({ active: true });
  });

  it("one who owes nothing is read, then sent", async () => {
    const item = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: "20" });
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(sent()).toEqual([{ Id: "21", SyncToken: "0", sparse: true, Active: false }]);
  });
});

describe("names: a taken one is answered with a free one to offer, never by failing (v1 spec §6.1)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("a name any customer has, inactive ones and those outside the portal too, is offered with a suffix, and nothing is sent", async () => {
    const families = (await db.select().from(family)).length;
    for (const [name, offer] of [["rivera family", "rivera family (2)"], ["Old Family", "Old Family (2)"], ["Lincoln High", "Lincoln High (2)"]]) {
      const r = await add("family", name!);
      expect(r).toEqual({ ok: false, offer, errors: [expect.stringContaining(`You could use “${offer}”`)] });
    }
    expect(posts()).toEqual([]);
    // Nothing was saved either: a name the portal can see is taken never leaves a family behind.
    expect(await db.select().from(family)).toHaveLength(families);
    // Staff accept the offer: it is sent as it was offered.
    expect((await add("family", "Old Family (2)")).ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Old Family (2)", CustomerTypeRef: { value: "1" } }]);
  });

  it("a name a waiting change will give someone is taken too", async () => {
    await seedQueued({ op: "create", role: "student", name: "Rosa Rivera", typeQboId: "3", familyQboId: "10", email: null });
    const r = await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op);
    expect(r).toMatchObject({ ok: false, offer: "Rosa Rivera (2)" });
  });

  it("a rename may keep its own name in another case, and not take another's", async () => {
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "LEO RIVERA" }, tag, op)).toMatchObject({ ok: true });
    expect(await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Ana Rivera" }, tag, op)).toMatchObject({ ok: false, offer: "Ana Rivera (2)" });
  });

  it("a name QuickBooks still refuses as taken (a vendor or employee has it, 6240) is offered with the next suffix", async () => {
    stub.otherNames = ["Quinn Family"];
    const r = await add("family", "Quinn Family");
    // The family is saved in the portal first: it stays, unlinked, and the answer says so, offering the free name to
    // rename it to before "Create in QuickBooks and link" (stage 3's slice 9d).
    expect(r).toEqual({ ok: true, unlinked: true, message: expect.stringContaining("Rename the family on its page, for instance to “Quinn Family (2)”") });
    expect(r).not.toHaveProperty("offer");
    expect(await queue()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "create", code: "fault_6240" });
    const quinn = await familyNamed("Quinn Family");
    expect(quinn).toMatchObject({ active: true });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.familyId, quinn!.id))).toEqual([]);
  });

  it("a name with a colon, a tab or a line break, or too long, is refused before anything is sent", async () => {
    for (const name of ["Rivera:Leo", "Leo\tRivera", "Leo\nRivera", "x".repeat(101), "  "]) {
      expect((await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name }, tag, op)).ok).toBe(false);
    }
    expect(posts()).toEqual([]);
  });
});

describe("a record that changed in QuickBooks meanwhile is never overwritten (v1 spec §6.3)", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("is refused by QuickBooks (5010), read again, shown with its current values, and not queued", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12") { c.DisplayName = "Leo R. Rivera"; c.SyncToken = "3"; } };
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.changed], current: { name: "Leo R. Rivera", active: true, familyName: "Rivera Family" } });
    expect(inStub("12")).toMatchObject({ DisplayName: "Leo R. Rivera", SyncToken: "3" });
    expect(await cached("12")).toMatchObject({ displayName: "Leo R. Rivera", syncToken: "3" }); // the cache took the newer record
    expect(await queue()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "rename", code: "fault_5010" });
  });
});

describe("what QuickBooks refuses, or can't be asked, is said and not queued; what may go through later is queued (v1 spec §4)", () => {
  it("a value QuickBooks won't take is refused", async () => {
    tag = await connectRoster(stub);
    stub.updateFault = "6000";
    const r = await offStudent("12");
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.refused] });
    expect(await queue()).toEqual([]);
    expect(await cached("12")).toMatchObject({ active: true });
  });

  it("not connected, a connection only an Admin can mend, and another company are said, and nothing is sent", async () => {
    tag = await connectRoster(stub);
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. (invalid_grant)" });
    expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.needsAdmin] });
    await db.update(qboConnection).set({ lastError: null, refreshTokenCiphertext: null });
    expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    await db.delete(qboConnection);
    await connectRoster(stub);
    await db.transaction((tx) => setRosterSource(tx, "4444")); // the cache came from another company
    const other = await offStudent("12");
    expect(other).toEqual({ ok: false, errors: [ROSTER_MOVED] }); // the page was shown the other roster
    expect(posts()).toEqual([]);
    expect(await queue()).toEqual([]);
  });

  it("a page shown another company's roster changes nothing", async () => {
    tag = await connectRoster(stub);
    expect(await askRosterWrite({ op: "deactivate", qboId: "12", syncToken: "0" }, "a-tag-of-another-company", op)).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    expect(posts()).toEqual([]);
  });

  it("a write whose answer is lost is queued as one QuickBooks may have made; the cache is left until the roster is read again", async () => {
    tag = await connectRoster(stub);
    stub.loseUpdateAnswer = true;
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).toEqual({ ok: true, queued: true, message: WRITE_COPY.queued });
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
    expect(await cached("12")).toMatchObject({ displayName: "Leo Rivera" });
    const [item] = await queue();
    expect(item).toMatchObject({ state: "waiting", sent: true, tries: 1, targetQboId: "12", familyId: await recordOfCustomer("10", "family"), studentId: await recordOfCustomer("12", "student"),
      realmId: REALM, askedByLabel: "registrar@club.org",
      request: { op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" } });
    expect(item!.lastCode).toMatch(/^(unreachable|timeout)$/);
    expect(item!.nextTryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await auditsOf("roster.write.queued"))[0]).toMatchObject({ targetId: item!.id, after: { op: "rename", sent: true } });
  });

  it("an unreachable QuickBooks and a 5xx are queued as possibly made; a 429 as not made", async () => {
    tag = await connectRoster(stub);
    stub.dropApi = true;
    expect((await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op))).toMatchObject({ ok: true, queued: true });
    stub.dropApi = false;
    // The 500 answers the write itself, not the read of what Mei owes before it.
    stub.onApiRequest = (c) => { if (c.method === "POST") { stub.failNext = 1; stub.onApiRequest = null; } };
    expect((await askRosterWrite({ op: "deactivate", qboId: "21", syncToken: "0" }, tag, op))).toMatchObject({ ok: true, queued: true });
    stub.rateLimitNext = 1;
    expect(await add("family", "Patel Family")).toMatchObject({ ok: true, queued: true });
    const items = await queue();
    expect(items.map((i) => [i.request.op, i.sent, i.lastCode])).toEqual([["rename", true, "unreachable"], ["deactivate", true, "http_500"], ["create", false, "http_429"]]);
    // Each filed under the app's records it is for: Leo and his family; Mei's family (a parent has no record of her own);
    // the new family's own record, saved first (stage 3's slice 9d).
    const [rivera, chen, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("12", "student")];
    const patel = (await familyNamed("Patel Family"))!.id;
    expect(items.map((i) => [i.request.op, i.familyId, i.studentId])).toEqual([["rename", rivera, leo], ["deactivate", chen, null], ["create", patel, null]]);
  });

  it("a connection row held elsewhere while the token needs renewing is busy: a write is queued as not sent, a make-inactive's balance read refused, and the staff member never waits for it", async () => {
    tag = await connectRoster(stub);
    await db.update(qboConnection).set({ accessExpiresAt: new Date(Date.now() + 60_000) }); // within 5 minutes of expiring: the write must refresh first
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>((r) => { release = r; }), taken = new Promise<void>((r) => { locked = r; });
    const holding = db.transaction(async (tx) => { await tx.select().from(qboConnection).for("update"); locked(); await held; });
    await taken;
    stub.calls.length = 0;
    try {
      // The balance can't be read: refused, nothing queued (open question 11).
      expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnread] });
      expect(await queue()).toEqual([]);
      const r = await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Mei L. Chen", parentOnly: true }, tag, op);
      expect(r).toMatchObject({ ok: true, queued: true });
    } finally { release(); await holding; }
    expect(await queue()).toEqual([expect.objectContaining({ sent: false, lastCode: "token_busy" })]);
    expect(posts()).toEqual([]);
  });

  it("a second change to a record with one waiting is refused until it is done", async () => {
    tag = await connectRoster(stub);
    await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" });
    expect(await offStudent("12")).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.update(writeQueue).set({ state: "stuck" });
    expect(await move("12", "20")).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.update(writeQueue).set({ state: "done" });
    expect((await offStudent("12")).ok).toBe(true);
  });

  it("nobody is added to, or moved into, a family whose own change is still waiting", async () => {
    tag = await connectRoster(stub);
    await seedQueued({ op: "deactivate", role: "family", qboId: "20", syncToken: "0" });
    expect(await askRosterWrite({ op: "create", role: "student", name: "Wen Chen", familyQboId: "20", email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(await move("12", "20")).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(posts()).toEqual([]);
    await db.update(writeQueue).set({ state: "given_up" });
    expect((await move("12", "20")).ok).toBe(true);
  });
});

describe("every id the page sends is looked up on the roster, in the role the change needs", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });
  const no = async (ask: Parameters<typeof askRosterWrite>[0], error: string) => expect(await askRosterWrite(ask, tag, op)).toEqual({ ok: false, errors: [error] });

  it("refuses customers outside the portal, strays, ids that aren't there, and the wrong role, before anything is sent", async () => {
    await no({ op: "rename", qboId: "30", syncToken: "0", name: "Lincoln Prep" }, WRITE_COPY.gone);    // a school
    await no({ op: "deactivate", qboId: "50", syncToken: "0" }, WRITE_COPY.gone);                      // a student under no family
    await no({ op: "deactivate", qboId: "60", syncToken: "0" }, WRITE_COPY.gone);                      // a customer of no type
    await no({ op: "deactivate", qboId: "999", syncToken: "0" }, WRITE_COPY.gone);
    await no({ op: "create", role: "student", name: "Rosa", familyQboId: "12", email: null, typeQboId: null }, WRITE_COPY.gone);  // a student isn't a family
    await no({ op: "create", role: "student", name: "Rosa", familyQboId: "30", email: null, typeQboId: null }, WRITE_COPY.gone);
    await no({ op: "create", role: "student", name: "Rosa", familyQboId: "40", email: null, typeQboId: null }, "This family is inactive in QuickBooks, so nobody can be added to it.");
    await no({ op: "deactivate", qboId: "40", syncToken: "0" }, "That is inactive in QuickBooks already, so there was nothing to change.");
    await no({ op: "create", role: "member", name: "Rosa", familyQboId: null, email: null, typeQboId: "1" }, WRITE_COPY.notOffered);
    expect(posts()).toEqual([]);
  });

  it("an id that isn't digits is never sent: the client refuses it", async () => {
    await db.update(qboCustomer).set({ qboId: "E2E-12" }).where(eq(qboCustomer.qboId, "12"));
    stub.calls.length = 0;
    const r = await askRosterWrite({ op: "deactivate", qboId: "E2E-12", syncToken: "0" }, tag, op);
    expect(r).toEqual({ ok: false, errors: [WRITE_COPY.notSent] });
    expect(stub.apiCalls()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ code: "bad_id" });
  });
});

describe("each membership shape allows what it allows (v1 spec §6.1)", () => {
  it("layered with no parent type: students can be added", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    expect((await askRosterWrite({ op: "create", role: "student", name: "Rosa Rivera", familyQboId: "10", email: null, typeQboId: null }, tag, op)).ok).toBe(true);
  });

  it("layered with no student type: no student is added or moved", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } });
    expect(await askRosterWrite({ op: "create", role: "student", name: "Rosa", familyQboId: "10", email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    // A student record the portal holds (one with no link) isn't moved either: the shape offers no move (moveStudent()).
    const [kim] = await db.insert(student).values({ familyId: await recordOfCustomer("10", "family"), name: "Kim Rivera", active: true }).returning({ id: student.id });
    expect(await moveStudent(String(kim!.id), String(await recordOfCustomer("20", "family")), tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    expect((await db.select().from(student).where(eq(student.id, kim!.id)))[0]).toMatchObject({ familyId: await recordOfCustomer("10", "family") });
    expect(NOT_HERE.noStudents).toMatch(/can't tell a student/);
    expect(posts()).toEqual([]);
  });

  it("flat with several member types: a member is made with the type staff chose, and must be one", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    expect(await add("member", "Sky Lee")).toEqual({ ok: false, errors: ["Choose which kind of member this is."] });
    expect(await add("member", "Sky Lee", "1")).toEqual({ ok: false, errors: ["Choose which kind of member this is."] });
    expect((await add("member", "Sky Lee", "3")).ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Sky Lee", CustomerTypeRef: { value: "3" } }]);
    expect(await add("family", "Lee Family")).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    // A family's or member's create is never sent QuickBooks first any more: only for the record saved first.
    expect(await askRosterWrite({ op: "create", role: "member", name: "Lee Household", familyQboId: null, email: null, typeQboId: "3" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    expect(await askRosterWrite({ op: "create", role: "student", name: "Kim", familyQboId: "11", email: null, typeQboId: null }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
    // A member is renamed and made inactive like anyone.
    expect((await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana R. Rivera" }, tag, op)).ok).toBe(true);
    expect((await offMember("12")).ok).toBe(true);
    expect(await askRosterWrite({ op: "deactivate", qboId: "11", syncToken: "1" }, tag, op)).toEqual({ ok: false, errors: [LINKED_DEACTIVATE] }); // a member goes by the record
  });

  it("flat with one member type: that type, without asking", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2"] } });
    expect((await add("member", "Sky Lee")).ok).toBe(true);
    expect(sent()).toEqual([{ DisplayName: "Sky Lee", CustomerTypeRef: { value: "2" } }]);
  });

  it("flat: a member's change that has to wait is filed under the member's own family record", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2"] } });
    stub.rateLimitNext = 1;
    expect(await askRosterWrite({ op: "rename", qboId: "11", syncToken: "0", name: "Ana R. Rivera" }, tag, op)).toMatchObject({ ok: true, queued: true });
    expect((await queue()).map((i) => [i.request.op, i.targetQboId, i.familyId, i.studentId])).toEqual([["rename", "11", await recordOfCustomer("11", "family"), null]]);
  });
});

describe("nothing of a refusal is kept but its code", () => {
  it("QuickBooks' words never reach the audit log", async () => {
    tag = await connectRoster(stub);
    stub.updateFault = "6000";
    await offStudent("12");
    expect(JSON.stringify(await audits())).not.toMatch(/must never store/);
    expect(fznCompany().customers.length).toBeGreaterThan(0);
  });
});

// Stage 4's slice M7a2: every staff insert into the queue holds the roster lock and is held to the roster's company. A
// change of company is refused wherever one is connected or read until slice M8, so these call its clear directly, as
// the request reaches QuickBooks.
describe("a change of company while a staff write is on its way", () => {
  const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null };
  const NOTE = "Given up: the club connected a different QuickBooks company, so nothing more was sent for this.";
  /** Runs the change of company's clear as the first POST reaches QuickBooks, then `then` on the stub. */
  const clearAsItArrives = (then: (body: string) => void, only: (body: string) => boolean = () => true) => {
    stub.onApiRequest = async (c) => {
      if (c.method !== "POST" || !only(c.body)) return;
      stub.onApiRequest = null;
      expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
      then(c.body);
    };
  };

  it("a write QuickBooks couldn't take goes on the queue given up, with the note, and the staff member is told it won't be tried again", async () => {
    tag = await connectRoster(stub);
    clearAsItArrives(() => { stub.failNext = 1; });
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.givenUpForCompany] });
    const [item] = await queue();
    expect(item).toMatchObject({ state: "given_up", note: NOTE, sent: true, lastCode: "http_500", nextTryAt: null, realmId: REALM, targetQboId: "12" });
    expect(item!.finishedAt).not.toBeNull();
    expect((await auditsOf("roster.write.queued"))[0]).toMatchObject({ targetId: item!.id, after: { op: "rename", sent: true, state: "given_up", why: "company_changed" } });
    // Nothing more is sent for it: the worker tries only the roster's company's items.
    stub.calls.length = 0;
    await runWriteQueue(new Date(Date.now() + 3_600_000));
    expect(posts()).toEqual([]);
    expect((await queue())[0]).toMatchObject({ state: "given_up", note: NOTE });
  });

  it("a family action's step whose answer is lost goes on the queue given up, no refresh is asked for, and the words say it won't be tried again", async () => {
    tag = await connectRoster(stub);
    const shown = await stampFor("10");
    // Ana's step goes through; as Leo's reaches QuickBooks, the club changes company, and his answer never comes back.
    clearAsItArrives(() => { stub.loseUpdateAnswer = true; }, (body) => /"Id":"12"/.test(body));
    const first = await inactivate("10", shown, op);
    expect(first.result.ok).toBe(false);
    expect(first.result.ok ? [] : first.result.errors).toContain("The portal can't tell whether QuickBooks made Leo Rivera inactive: its answer didn't arrive, and the club has connected a different QuickBooks company since, so it won't be tried again.");
    expect(await queue()).toEqual([expect.objectContaining({ state: "given_up", note: NOTE, sent: true, lastCode: "unreachable", targetQboId: "12", nextTryAt: null })]);
    expect((await auditsOf("roster.write.queued"))[0]!.after).toMatchObject({ op: "deactivate", role: "student", sent: true, state: "given_up", why: "company_changed" });
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]);
  });

  it("an old company's item given up for a customer holds back no write to the new company's customer of the same id", async () => {
    tag = await connectRoster(stub);
    const [rivera, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("12", "student")];
    // A rename of Leo still waiting in the old company when the clear runs.
    await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo R.", was: "Leo Rivera" }, { sent: true });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    // The new company: QuickBooks connected to it, the roster read from it (the stub answers its customers by the same
    // ids), and the kept family and student linked to its customers 10 and 12.
    await db.update(qboConnection).set({ realmId: "2222" });
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    await db.insert(accountingLink).values([{ system: "quickbooks", realmId: "2222", customerId: "10", familyId: rivera, origin: "carried_over" },
      { system: "quickbooks", realmId: "2222", customerId: "12", studentId: leo, origin: "carried_over" }]);
    tag = await currentRosterTag();
    expect((await queue()).map((i) => i.state)).toEqual(["given_up"]);
    const r = await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, tag, op);
    expect(r).not.toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(r).toMatchObject({ ok: true });
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
  });
});
