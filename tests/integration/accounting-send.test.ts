import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, qboConnection, student, volunteerSignup, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, QUEUE_IN_THE_WAY_OF_SEND, SEND_NOT_CONNECTED, sendNameQueuedNote, type LinkRow, type LinksView, type SendOffer } from "@/lib/accounting/mapping";
import { LINK_COPY } from "@/lib/accounting/link-writes";
import { sendStamp } from "@/lib/accounting/stamp";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { refreshRoster } from "@/lib/roster/refresh";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { FAMILY_BEING_CHANGED, FAMILY_BUSY, familySendStudentsWords, MOVE_PENDING, SEND_CHANGED, SEND_FAMILY_NOT_LINKED, SENDING_LOCK, sendNameQueuedWords, sendNameTakenWords, sendToBooks, STALE_TWICE, WRITE_COPY } from "@/lib/roster/writes";
import { sendDifferenceAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason } from "../helpers/season";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { auditsOf, connectRoster, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Send the app's to QuickBooks (stage 4's slice M5a of the app-owned families spec; section 5, "Differences"; open
 * questions 1, 10, 11, 12 and 14; sendToBooks() in src/lib/roster/writes.ts, the press sendDifferenceAction()): on
 * Accounting links, a record's name, the family a student is under, or a student or member inactive in the portal whose
 * customer the books have active is sent to QuickBooks over the books' value the row showed, through today's writes: a
 * rename and a move saved first and tried at once, a make-inactive QuickBooks first by the balance rule. The company is
 * fznCompany()'s (tests/helpers/qbo-stub.ts): Rivera Family 10 with Ana Rivera 11 (Parent) and Leo Rivera 12 (Student),
 * Chen Family 20 with Mei Chen 21 (Parent), every customer at SyncToken "0", each link aligned with it by the import.
 * The books change only through the stub (changeInBooks(), with a roster read, readAgain(), as each accounting test
 * defines them for itself; a SyncToken raised with a change, as QuickBooks raises it, so the link's own version is
 * stale and the send is settled by the field); customers added before any record is changed in the portal are imported
 * (syncAppRecords()), never after.
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
/** An open invoice (a positive amount) or a credit (a negative one) on a customer: its own Balance, as the stub reads it with `quirks.balances`. */
const balance = (Id: string, customer: string, amount: number) => ({ Id, SyncToken: "0", CustomerRef: { value: customer }, TotalAmt: amount, Balance: amount });
/** Runs the press while another session holds this lock, as a send under way (askFamilyInactive(), whileSending()) holds it. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

const INACTIVE_THERE = "QuickBooks has that customer inactive, so nothing was sent: the portal never makes a customer active again.";
let tag: string;
let sender: Awaited<ReturnType<typeof staffWith>>;
const sendOp = () => ({ actor: { door: "staff" as const, id: sender.id, label: sender.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: sender.id });
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
/** The row's send of this field, as the page draws it now (for a reader who may change families). */
const sendOf = async (name: string, field: SendOffer["field"], kind?: SendOffer["kind"]): Promise<SendOffer> => {
  const s = rowOf(await loadAccountingLinks(), name).sends.find((x) => x.field === field && (kind === undefined || x.kind === kind));
  if (!s) throw new Error(`the row ${name} offers no send of ${field}`);
  return s;
};
/** The press as the page binds it, or as the browser could call it with these values. */
const pressWith = (field: SendOffer["field"], kind: "family" | "student", recordId: string, stamp: string, t = tag) =>
  sendToBooks(field === "place" ? { field, studentId: recordId, stamp } : { field, kind, recordId, stamp }, t, sendOp());
const press = (o: SendOffer) => pressWith(o.field, o.kind, o.recordId, o.stamp);
const sends = () => auditsOf("accounting.difference.send");
/** Every write sent to the books since the calls were last cleared, as its body. */
const posts = () => stub.apiCalls().filter((c) => c.method === "POST").map((c) => JSON.parse(c.body) as Record<string, unknown>);
const familyRow = async (id: AppFamilyId) => (await db.select().from(family).where(eq(family.id, id)))[0]!;
const studentRow = async (id: AppStudentId) => (await db.select().from(student).where(eq(student.id, id)))[0]!;
const items = () => db.select().from(writeQueue);
const studentLinkVersion = async (customer: string) => (await db.select({ v: accountingLink.syncedToken }).from(accountingLink)
  .where(and(eq(accountingLink.customerId, customer), isNotNull(accountingLink.studentId))))[0]?.v;
const familyLinkVersion = async (customer: string) => (await db.select({ v: accountingLink.syncedToken }).from(accountingLink)
  .where(and(eq(accountingLink.customerId, customer), isNotNull(accountingLink.familyId))))[0]?.v;

let rivera: AppFamilyId, chen: AppFamilyId, leo: AppStudentId;
let ana: Awaited<ReturnType<typeof seedAnaRivera>>["ana"];
beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = [];
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
  // A customer read by id carries its own Balance, as QuickBooks' does: the portal reads it before making anyone inactive.
  stub.quirks.balances = true;
  sender = await staffWith("sender@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
});
/** The layered company, Ana Rivera's guardian row in the Rivera family. */
async function layered() {
  tag = await connectRoster(stub);
  ({ ana } = await seedAnaRivera());
  [rivera, chen, leo] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("12", "student")];
}

describe("a name sent to the books", () => {
  beforeEach(layered);

  it("the family's: queued, sent over the books' name with the version read live, the item done, a kept rename replaced, one send row", async () => {
    // A rename of the portal's that QuickBooks refused, kept on Reconciliation: the send takes its place.
    const kept = await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" }, { state: "refused", code: "fault_6240" });
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    expect(offer).toMatchObject({ kind: "family", recordId: String(rivera), about: "Rivera Family's name",
      words: ["Sends “Rivera Family” to the books as this family's name, in place of “Rivera Household” there. The books' name is replaced.",
        "The rename kept on the Reconciliation page is closed, as this takes its place."] });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Sent the portal's name “Rivera Family” to QuickBooks, in place of “Rivera Household”." });
    // The link's own version first, answered as stale; then the name read live, as the row showed it, and sent again with its version.
    const sent = posts();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ Id: "10", SyncToken: "0", DisplayName: "Rivera Family" });
    expect(sent[1]).toMatchObject({ Id: "10", SyncToken: "1", DisplayName: "Rivera Family" });
    expect(stub.customers.find((c) => c.Id === "10")).toMatchObject({ DisplayName: "Rivera Family" });
    const queued = (await items()).filter((q) => q.id !== kept.id);
    expect(queued.map((q) => [q.request.op, q.state, q.familyId, q.studentId])).toEqual([["rename", "done", rivera, null]]);
    expect(queued[0]!.request).toMatchObject({ op: "rename", qboId: "10", name: "Rivera Family", was: "Rivera Household" });
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "given_up" });
    const [row, ...more] = await sends();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ targetType: "family", targetId: String(rivera), permission: "Accounting.Link.ReadWrite", before: { name: "Rivera Household" },
      after: { field: "name", kind: "family", familyId: String(rivera), customerQboId: "10", name: "Rivera Family", queueId: queued[0]!.id, replaced: [kept.id] } });
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
    expect(await auditsOf("roster.customer.rename")).toEqual([expect.objectContaining({ after: expect.objectContaining({ queueId: queued[0]!.id, resent: "stale" }) })]);
    // The portal's record is as it was, and the difference is gone.
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Family", active: true });
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").differences).toEqual([]);
  });

  it("a student's: sent as the portal has it", async () => {
    changeInBooks("12", { DisplayName: "Leo M. Rivera", SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    expect(offer).toMatchObject({ kind: "student", recordId: String(leo), about: "Leo Rivera's name" });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Sent the portal's name “Leo Rivera” to QuickBooks, in place of “Leo M. Rivera”." });
    expect(posts().at(-1)).toMatchObject({ Id: "12", SyncToken: "1", DisplayName: "Leo Rivera" });
    expect((await items()).map((q) => [q.request.op, q.state, q.studentId])).toEqual([["rename", "done", leo]]);
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo),
      after: expect.objectContaining({ field: "name", kind: "student", studentId: String(leo), familyId: String(rivera), customerQboId: "12", name: "Leo Rivera" }) })]);
    expect(await studentRow(leo)).toMatchObject({ name: "Leo Rivera", familyId: rivera });
  });

  it("QuickBooks renaming it again between the page and the send: held by the field, kept, nothing sent over it", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    // Someone renames it in QuickBooks as the portal's request arrives: the link's version is stale, and the live name isn't the row's.
    stub.beforeUpdate = (c) => { c.DisplayName = "Rivera House"; c.SyncToken = "2"; stub.beforeUpdate = null; };
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, status: "attention", message: "The name “Rivera Family” wasn't sent to QuickBooks. "
      + "The portal held it back: QuickBooks' name changed again since this page was drawn (it has “Rivera House” now), so the portal's name wasn't sent over it. "
      + "The change is kept on the Reconciliation page, where you can send it again or give it up." });
    expect(posts()).toHaveLength(1);
    expect(stub.customers.find((c) => c.Id === "10")).toMatchObject({ DisplayName: "Rivera House" });
    expect((await items()).map((q) => [q.request.op, q.state, q.lastCode])).toEqual([["rename", "refused", "fault_5010"]]);
    expect(await sends()).toHaveLength(1);
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Family" });
  });

  it("refused, sending and saving nothing: a stale stamp, the portal's name held by another customer, a change waiting, the customer inactive in the books, not connected", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    stub.calls.length = 0;
    // A stale stamp: the books renamed it again, read after the page was drawn.
    changeInBooks("10", { DisplayName: "Rivera House", SyncToken: "2" });
    await readAgain();
    expect(await press(offer)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    const now = await sendOf("Rivera Family", "name");
    // Another customer of the portal's name (a school, read after the page): no other name is offered.
    await readAgain(qc("90", "Rivera Family", "4"));
    expect(await press(now)).toEqual({ ok: false, errors: [sendNameTakenWords("Rivera Family")] });
    stub.customers = stub.customers.filter((c) => c.Id !== "90");
    await readAgain();
    // A change waiting for the customer.
    const waiting = await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera House" }, { state: "waiting" });
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").sends).toEqual([]);
    expect(await press(now)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    // The customer inactive in the books: never sent to, and never made active.
    changeInBooks("10", { Active: false, SyncToken: "3" });
    await readAgain();
    expect(await press(now)).toEqual({ ok: false, errors: [INACTIVE_THERE] });
    changeInBooks("10", { Active: true, SyncToken: "4" });
    await readAgain();
    // QuickBooks not connected: a send needs a live connection to the roster's company.
    await db.delete(qboConnection);
    expect(await press(now)).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ name: "Rivera Family" });
  });

  it("a name only a change on its way to QuickBooks holds: said as that, not as a customer QuickBooks has, no press, and refused with nothing sent", async () => {
    changeInBooks("12", { DisplayName: "Leo M. Rivera", SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    // Mei Chen's rename to the portal's name for Leo, waiting to reach QuickBooks: QuickBooks has no customer of it yet.
    await seedQueued({ op: "rename", role: "parent", qboId: "21", syncToken: "0", name: "Leo Rivera", was: "Mei Chen" }, { state: "waiting" });
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.sends.filter((s) => s.field === "name")).toEqual([]);
    expect(row.sendNotes).toContainEqual({ at: row.differences.findIndex((d) => d.kind === "name"), words: sendNameQueuedNote("Leo Rivera") });
    expect(row.sendNotes.map((n) => n.words).join(" ")).not.toContain("QuickBooks has another customer named");
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: false, errors: [sendNameQueuedWords("Leo Rivera")] });
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect((await items()).map((q) => q.request.op)).toEqual(["rename"]);
  });

  it("a lost answer: waiting on the queue as maybe sent, said in words, left on Reconciliation", async () => {
    // Renamed in the books with the version the link holds, so the portal's request is taken there, and its answer lost.
    changeInBooks("12", { DisplayName: "Leo M. Rivera" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    stub.loseUpdateAnswer = true;
    stub.calls.length = 0;
    const r = await press(offer);
    stub.loseUpdateAnswer = false;
    expect(r).toEqual({ ok: true, status: "waiting", message: expect.stringContaining("The portal can't tell yet whether QuickBooks took the name “Leo Rivera”: its answer didn't arrive.") });
    expect(posts().at(-1)).toMatchObject({ Id: "12", SyncToken: "0", DisplayName: "Leo Rivera" });
    const [item, ...more] = await items();
    expect(more).toEqual([]);
    expect(item).toMatchObject({ state: "waiting", sent: true, studentId: leo, request: { op: "rename", qboId: "12", name: "Leo Rivera", was: "Leo M. Rivera" } });
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ field: "name", queueId: item!.id }) })]);
    expect(await studentRow(leo)).toMatchObject({ name: "Leo Rivera" });
  });
});

describe("a name in flat books: the member", () => {
  it("sent as the member's name", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    rivera = await recordOfCustomer("10", "family");
    changeInBooks("10", { DisplayName: "The Riveras" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    expect(offer.words).toEqual(["Sends “Rivera Family” to the books as this member's name, in place of “The Riveras” there. The books' name is replaced."]);
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Sent the portal's name “Rivera Family” to QuickBooks, in place of “The Riveras”." });
    expect(posts()).toEqual([expect.objectContaining({ Id: "10", SyncToken: "0", DisplayName: "Rivera Family" })]);
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "family", targetId: String(rivera), after: expect.objectContaining({ field: "name", kind: "family" }) })]);
  });
});

describe("the family a student is under, sent to the books", () => {
  beforeEach(layered);

  /** Leo's form waiting to be signed, a place on a shift still to come, and a per-student buy-out with an unpaid invoice, all in the Rivera family. */
  async function leosThings() {
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Join" }] });
    const req = await seedFormRequirement({ stepId: season.stepIds.Join!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplsend" }) });
    const open = await seedRequest({ requirementId: req, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_sendopen" });
    const { shifts: [soon] } = await seedEvent({ name: "Fall fair", inDays: 20 });
    const place = await seedSignup({ shiftId: soon!.id, familyQboId: "10", signedUpBy: ana.id, student: { qboId: "12", name: "Leo Rivera" } });
    const perStudent = await seedBuyoutRequirement({ appliesTo: "student" });
    await seedBuyout({ requirementId: perStudent, familyQboId: "10", subjectQboId: "12", chosenBy: ana.id, invoiceQboId: "5001" });
    return { open, place };
  }

  it("a student the books moved under another family: moved back, the same send from either row, nothing of theirs moved in the portal", async () => {
    const { open, place } = await leosThings();
    changeInBooks("12", { ...under("20"), SyncToken: "1" });
    await readAgain();
    const fromRivera = await sendOf("Rivera Family", "place");
    const fromChen = await sendOf("Chen Family", "place");
    expect(fromRivera).toMatchObject({ kind: "student", recordId: String(leo), about: "Leo Rivera's family",
      words: ["Sends Leo Rivera's family to the books: QuickBooks will have them under Rivera Family's customer, where it has them under “Chen Family” now. The books' place is replaced. "
        + "Once QuickBooks has them there, Rivera Family sees their invoices in the portal, and no family sees them through “Chen Family” any more. "
        + "Nothing else of theirs in the portal moves: their forms, volunteer places and buy-outs stay as they are."] });
    expect(fromChen).toMatchObject({ recordId: String(leo), stamp: fromRivera.stamp, words: fromRivera.words });
    stub.calls.length = 0;
    expect(await press(fromChen)).toEqual({ ok: true, message: "Sent Leo Rivera's family to QuickBooks: QuickBooks has them under Rivera Family now, as the portal has them. "
      + "Nothing of theirs in the portal moved: their forms, volunteer places and buy-outs stay as they are. Rivera Family sees their invoices in the portal now." });
    expect(posts().at(-1)).toMatchObject({ Id: "12", SyncToken: "1", ParentRef: { value: "10" } });
    expect(stub.customers.find((c) => c.Id === "12")).toMatchObject({ ParentRef: { value: "10" } });
    // One item, the move, done: filed under the family the books had them under; no follow-up of a portal move.
    const [item, ...others] = await items();
    expect(others).toEqual([]);
    expect(item).toMatchObject({ state: "done", familyId: chen, studentId: leo,
      request: { op: "move", qboId: "12", fromFamilyQboId: "20", toFamilyQboId: "10", fromFamilyId: chen, toFamilyId: rivera } });
    expect(await auditsOf("roster.student.move.followed")).toEqual([]);
    expect(await auditsOf("roster.record.moved")).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera, active: true });
    // His form still waiting in Rivera, his place to come kept, nobody told by email, and no buy-out invoice voided or queued.
    expect(await requestNow(open)).toMatchObject({ state: "waiting", envelopeId: "envelope_sendopen", familyId: rivera });
    expect((await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, place.id)))[0]!.cancelledAt).toBeNull();
    expect(mail.outbox).toEqual([]);
    expect(stub.apiCalls().filter((c) => /\/invoice$/.test(c.path))).toEqual([]);
    const [row, ...more] = await sends();
    expect(more).toEqual([]);
    expect(row).toMatchObject({ targetType: "student", targetId: String(leo), before: { familyQboId: "20" },
      after: { field: "place", kind: "student", studentId: String(leo), familyId: String(rivera), fromFamilyId: String(chen), customerQboId: "12", familyQboId: "10", queueId: item!.id, replaced: [] } });
    // The audit page's record filter finds the send under both families.
    for (const f of [rivera, chen]) expect((await auditPage(parseAuditFilters({ record: `family:${f}` }), {}, 500)).rows.map((r) => r.id)).toContain(row!.id);
    const after = await loadAccountingLinks();
    expect(after.rows.flatMap((r) => r.differences).filter((d) => d.kind === "place" || d.kind === "student_elsewhere")).toEqual([]);
  });

  it("a student the books put at the top of the tree: sent under the family, the before-value the top", async () => {
    changeInBooks("12", { ParentRef: undefined, Job: false, SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "place");
    expect(offer.words[0]).toContain("QuickBooks will have them under Rivera Family's customer, where it has them at the top of its list, under no customer now.");
    stub.calls.length = 0;
    expect(await press(offer)).toMatchObject({ ok: true });
    expect(posts().at(-1)).toMatchObject({ Id: "12", SyncToken: "1", ParentRef: { value: "10" } });
    const [item] = await items();
    expect(item).toMatchObject({ state: "done", familyId: rivera, request: { op: "move", fromFamilyQboId: "top", toFamilyQboId: "10", toFamilyId: rivera } });
    expect(item!.request).not.toHaveProperty("fromFamilyId");
    expect(await sends()).toEqual([expect.objectContaining({ before: { familyQboId: null }, after: expect.not.objectContaining({ fromFamilyId: expect.anything() }) })]);
  });

  it("refused on a stale stamp (moved again in the books), and held by the field when QuickBooks moves them again as the send arrives", async () => {
    changeInBooks("12", { ...under("20"), SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "place");
    stub.calls.length = 0;
    changeInBooks("12", { ParentRef: undefined, Job: false, SyncToken: "2" });
    await readAgain();
    expect(await press(offer)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    // Under Chen again, read; then moved to the top in QuickBooks as the request arrives.
    changeInBooks("12", { ...under("20"), SyncToken: "3" });
    await readAgain();
    const again = await sendOf("Rivera Family", "place");
    stub.beforeUpdate = (c) => { delete c.ParentRef; c.Job = false; c.SyncToken = "4"; stub.beforeUpdate = null; };
    const r = await press(again);
    expect(r).toMatchObject({ ok: true, status: "attention" });
    expect((r as { message: string }).message).toContain("Leo Rivera's move to Rivera Family wasn't sent to QuickBooks. The portal held it back: QuickBooks moved them again since this page was drawn, so the portal's family wasn't sent over it.");
    expect(posts()).toHaveLength(1);
    expect(stub.customers.find((c) => c.Id === "12")).not.toHaveProperty("ParentRef");
    expect((await items()).map((q) => [q.request.op, q.state, q.lastCode])).toEqual([["move", "refused", "fault_5010"]]);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
  });

  it("a kept move of the student is closed as replaced, said beside the press", async () => {
    changeInBooks("12", { ...under("20"), SyncToken: "1" });
    await readAgain();
    // The portal's earlier move of Leo back to Rivera, which QuickBooks refused, kept on Reconciliation.
    const kept = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "1", fromFamilyQboId: "20", toFamilyQboId: "10", fromFamilyId: chen, toFamilyId: rivera },
      { state: "refused", code: "fault_6000" });
    const offer = await sendOf("Rivera Family", "place");
    expect(offer.words.slice(1)).toEqual(["The move kept on the Reconciliation page is closed, as this takes its place."]);
    stub.calls.length = 0;
    expect(await press(offer)).toMatchObject({ ok: true });
    expect(posts().at(-1)).toMatchObject({ Id: "12", ParentRef: { value: "10" } });
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "given_up" });
    expect((await items()).filter((q) => q.id !== kept.id).map((q) => [q.request.op, q.state])).toEqual([["move", "done"]]);
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ field: "place", replaced: [kept.id] }) })]);
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
  });

  it("refused while the family the books have them under is being changed (its \"being sent\" lock held, as askFamilyInactive() holds it for its whole run)", async () => {
    changeInBooks("12", { ...under("20"), SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "place");
    stub.calls.length = 0;
    // Chen being made inactive with everyone under it: Leo's customer is among them, so he isn't moved under Rivera meanwhile.
    expect(await holding(SENDING_LOCK, String(chen), () => press(offer))).toEqual({ ok: false, errors: [FAMILY_BUSY] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    // Once it is done, the same press goes through.
    expect(await press(offer)).toMatchObject({ ok: true });
  });

  it("a change waiting for the family's customer: no press, the queue's sentence in its place on either row and on the page, and the press refused", async () => {
    changeInBooks("12", { ...under("20"), SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "place");
    await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" }, { state: "waiting" });
    const view = await loadAccountingLinks();
    for (const [name, kind] of [["Rivera Family", "place"], ["Chen Family", "student_elsewhere"]] as const) {
      const row = rowOf(view, name);
      const at = row.differences.findIndex((d) => d.kind === kind);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(row.sends.filter((x) => x.field === "place"), name).toEqual([]);
      expect(row.sendNotes, name).toContainEqual({ at, words: QUEUE_IN_THE_WAY_OF_SEND });
    }
    asStaff(sender);
    expect((await renderPage(AccountingLinksPage)).replaceAll("&#x27;", "'")).toContain(QUEUE_IN_THE_WAY_OF_SEND);
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    expect(posts()).toEqual([]);
    expect((await items()).map((q) => q.request.op)).toEqual(["rename"]);
    expect(await sends()).toEqual([]);
  });

  it("refused, sending and saving nothing: the family's customer inactive in the books, the student's inactive there, not connected (then no press, its sentence in place)", async () => {
    changeInBooks("12", { ...under("20"), SyncToken: "1" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "place");
    stub.calls.length = 0;
    // Rivera's customer made inactive in the books after the page was drawn: nowhere to send Leo to, and the row says so.
    changeInBooks("10", { Active: false, SyncToken: "1" });
    await readAgain();
    expect(await press(offer)).toEqual({ ok: false, errors: [SEND_FAMILY_NOT_LINKED] });
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.sends.filter((x) => x.field === "place")).toEqual([]);
    expect(row.sendNotes).toContainEqual({ at: row.differences.findIndex((d) => d.kind === "place"), words: "QuickBooks has this family's customer inactive, so no student is sent to it." });
    // Leo's own customer inactive in the books: the portal sends nothing to a customer inactive there.
    changeInBooks("10", { Active: true, SyncToken: "2" });
    changeInBooks("12", { Active: false, SyncToken: "2" });
    await readAgain();
    expect(await press(offer)).toEqual({ ok: false, errors: [INACTIVE_THERE] });
    // QuickBooks disconnected: the press refuses, and the screen draws none, with one sentence in its place.
    changeInBooks("12", { Active: true, SyncToken: "3" });
    await readAgain();
    await db.delete(qboConnection);
    expect(await press(offer)).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    const disconnected = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(disconnected.sends).toEqual([]);
    expect(disconnected.sendNotes).toContainEqual({ at: disconnected.differences.findIndex((d) => d.kind === "place"), words: SEND_NOT_CONNECTED });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera, active: true });
  });

  it("a lost answer: the move waits on the queue as maybe sent, said in words", async () => {
    // Moved in the books with the version the link holds, so the portal's request is taken there, and its answer lost.
    changeInBooks("12", under("20"));
    await readAgain();
    const offer = await sendOf("Rivera Family", "place");
    stub.loseUpdateAnswer = true;
    stub.calls.length = 0;
    const r = await press(offer);
    stub.loseUpdateAnswer = false;
    expect(r).toMatchObject({ ok: true, status: "waiting", message: expect.stringContaining("The portal can't tell yet whether QuickBooks took Leo Rivera's move to Rivera Family: its answer didn't arrive.") });
    expect(posts().at(-1)).toMatchObject({ Id: "12", SyncToken: "0", ParentRef: { value: "10" } });
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: true, studentId: leo, request: expect.objectContaining({ op: "move", fromFamilyQboId: "20", toFamilyQboId: "10" }) })]);
    expect(await sends()).toHaveLength(1);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
  });
});

describe("a student or member inactive in the portal, made inactive in the books", () => {
  beforeEach(layered);
  /** Leo made inactive in the portal (the test's own write: nothing imports after it), his customer active in the books. */
  const leoInactiveHere = () => db.update(student).set({ active: false }).where(eq(student.id, leo));

  it("a student with no balance: one make-inactive, the balance read first, the link aligned, the record as it was", async () => {
    await leoInactiveHere();
    const offer = await sendOf("Rivera Family", "inactive");
    expect(offer).toMatchObject({ kind: "student", recordId: String(leo), about: "Leo Rivera's active status",
      words: ["Makes Leo Rivera inactive in the books, as the portal has them, in place of active there. QuickBooks is asked what is owed first, and any balance, owed or a credit, stops it with nothing sent."] });
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: true, message: "Made Leo Rivera inactive in QuickBooks, as the portal has them: QuickBooks showed no balance on the account first." });
    // The balance read live, then one request, with the link's own version and Active false.
    expect(stub.apiCalls().map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(posts()).toEqual([expect.objectContaining({ Id: "12", SyncToken: "0", Active: false })]);
    expect(stub.customers.find((c) => c.Id === "12")).toMatchObject({ Active: false });
    // applyWritten()'s follow-ups: the cache takes the answer and the link its version; the record was inactive already.
    expect(await studentLinkVersion("12")).toBe("1");
    expect(await studentRow(leo)).toMatchObject({ active: false, familyId: rivera });
    expect(await auditsOf("roster.customer.deactivate")).toEqual([expect.objectContaining({ after: expect.objectContaining({ sentFrom: "accounting.difference.send", linkVersion: "1" }) })]);
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo), before: { active: true },
      after: { field: "inactive", kind: "student", familyId: String(rivera), studentId: String(leo), customerQboId: "12", active: false, outcome: "sent", replaced: [] } })]);
    expect(await items()).toEqual([]);
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").differences).toEqual([]);
  });

  for (const [what, amount, words] of [
    ["an amount owed", 25, "Leo Rivera has an open balance in QuickBooks. They weren't made inactive."],
    ["a credit", -10, "Leo Rivera has a credit in QuickBooks. They weren't made inactive."],
  ] as const) {
    it(`a student with ${what}: stopped, nothing sent, said in words, never queued`, async () => {
      await leoInactiveHere();
      stub.invoices.push(balance("9001", "12", amount));
      const offer = await sendOf("Rivera Family", "inactive");
      stub.calls.length = 0;
      expect(await press(offer)).toEqual({ ok: false, errors: [`${words} ${WRITE_COPY.balanceFix}`] });
      expect(posts()).toEqual([]);
      expect(await items()).toEqual([]);
      expect(await auditsOf("roster.write.refused")).toEqual([expect.objectContaining({ after: expect.objectContaining({ op: "deactivate", code: amount > 0 ? "open_balance" : "credit_balance" }) })]);
      expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped", code: amount > 0 ? "open_balance" : "credit_balance" }) })]);
      expect(stub.customers.find((c) => c.Id === "12")).toMatchObject({ Active: true });
    });
  }

  it("a balance that can't be read stops it; a customer QuickBooks has inactive already, read live, is sent nothing", async () => {
    await leoInactiveHere();
    const offer = await sendOf("Rivera Family", "inactive");
    stub.quirks.balances = false;
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect(posts()).toEqual([]);
    stub.quirks.balances = true;
    // Inactive in QuickBooks, which the cache doesn't show yet: the live read finds it so, and nothing is sent.
    changeInBooks("12", { Active: false, SyncToken: "1" });
    expect(await press(offer)).toEqual({ ok: true, message: "QuickBooks has Leo Rivera inactive already, so nothing was sent." });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect((await sends()).map((a) => (a.after as { outcome: string }).outcome).sort()).toEqual(["inactive_there", "stopped"]);
    expect(await studentRow(leo)).toMatchObject({ active: false });
  });

  it("a make-inactive of the customer kept on Reconciliation: left kept while a balance stops the send, closed as replaced once QuickBooks has it inactive", async () => {
    await leoInactiveHere();
    const kept = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "refused", code: "fault_6000" });
    stub.invoices.push(balance("9001", "12", 25));
    const offer = await sendOf("Rivera Family", "inactive");
    expect(offer.words.slice(1)).toEqual(["The make-inactive kept on the Reconciliation page is closed once QuickBooks has the customer inactive, as this takes its place."]);
    stub.calls.length = 0;
    expect(await press(offer)).toMatchObject({ ok: false });
    expect(posts()).toEqual([]);
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "refused" });
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped", replaced: [] }) })]);
    // The balance paid: sent, and the kept one closed.
    stub.invoices = [];
    expect(await press(offer)).toMatchObject({ ok: true });
    expect(posts()).toEqual([expect.objectContaining({ Id: "12", Active: false })]);
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "given_up" });
    expect((await sends()).find((a) => (a.after as { outcome: string }).outcome === "sent")).toMatchObject({ after: expect.objectContaining({ replaced: [kept.id] }) });
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
  });

  it("stale twice and a refusal are refused in words with nothing queued; a lost answer is queued as maybe sent, its send row `queued`", async () => {
    await leoInactiveHere();
    const offer = await sendOf("Rivera Family", "inactive");
    // Someone changing it in QuickBooks as each request arrives: stale, read live, stale again.
    stub.beforeUpdate = (c) => { if (c.Id === "12") c.SyncToken = String(Number(c.SyncToken) + 1); };
    stub.calls.length = 0;
    expect(await press(offer)).toEqual({ ok: false, errors: [STALE_TWICE] });
    stub.beforeUpdate = null;
    expect(posts().map((b) => b.SyncToken)).toEqual(["0", "1"]);
    expect(await items()).toEqual([]);
    // QuickBooks refusing it (a validation fault): refused, nothing queued.
    stub.updateFault = "6000";
    expect(await press(offer)).toMatchObject({ ok: false });
    stub.updateFault = null;
    expect(await items()).toEqual([]);
    // The answer lost after QuickBooks took it: queued as maybe sent, found by the queue after a roster read.
    stub.loseUpdateAnswer = true;
    expect(await press(offer)).toEqual({ ok: true, queued: true, status: "waiting", message: WRITE_COPY.queued });
    stub.loseUpdateAnswer = false;
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: true, targetQboId: "12", studentId: leo, request: expect.objectContaining({ op: "deactivate", qboId: "12" }) })]);
    expect((await sends()).map((a) => (a.after as { outcome: string }).outcome).sort()).toEqual(["queued", "refused", "stale_again"]);
    expect(await studentRow(leo)).toMatchObject({ active: false });
  });

  it("a lost answer as the club changes company goes on the queue given up, its send row `refused`, and the staff member is told it won't be tried again", async () => {
    await leoInactiveHere();
    const offer = await sendOf("Rivera Family", "inactive");
    // The change of company's clear runs as the make-inactive reaches QuickBooks (stage 4's slice M7a2), and its answer never comes back.
    stub.onApiRequest = async (c) => {
      if (c.method !== "POST") return;
      stub.onApiRequest = null;
      expect(await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: null, label: "admin@club.org" }, ip: null })).toBe(true);
      stub.loseUpdateAnswer = true;
    };
    expect(await press(offer)).toEqual({ ok: false, errors: [WRITE_COPY.givenUpForCompany] });
    stub.loseUpdateAnswer = false;
    expect(await items()).toEqual([expect.objectContaining({ state: "given_up", sent: true, targetQboId: "12", nextTryAt: null })]);
    expect((await sends()).map((a) => a.after)).toEqual([expect.objectContaining({ outcome: "refused", queue: "given_up" })]);
  });

  it("a balance is said with its amount only to a reader who may see balances, through the press", async () => {
    await leoInactiveHere();
    stub.invoices.push(balance("9001", "12", 25));
    const offer = await sendOf("Rivera Family", "inactive");
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite", "Finance.Balance.Read"]);
    asStaff(sender);
    expect(await sendDifferenceAction("inactive", "student", offer.recordId, tag, offer.stamp))
      .toEqual({ ok: false, errors: [`Leo Rivera has an open balance in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    asStaff(treasurer);
    expect(await sendDifferenceAction("inactive", "student", offer.recordId, tag, offer.stamp))
      .toEqual({ ok: false, errors: [`Leo Rivera owes $25.00 in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
  });

  it("not offered, and refused, for a record active in the portal (that would make a customer active in the books) and for a layered family with a student active in the portal", async () => {
    changeInBooks("12", { Active: false, SyncToken: "1" });
    await readAgain();
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    const at = row.differences.findIndex((d) => d.kind === "active" && d.of === "student");
    expect(row.sends).toEqual([]);
    expect(row.sendNotes).toEqual([{ at, words: "The portal never makes a customer active in the books, so this can only be taken from them." }]);
    stub.calls.length = 0;
    expect(await pressWith("inactive", "student", String(leo), sendStamp("inactive", String(leo), "12", ["12"]))).toEqual({ ok: false, errors: [SEND_CHANGED] });
    // Rivera inactive in the portal, its customer active in the books, but Leo active in the portal (slice M5b): QuickBooks
    // would make him inactive with the family, so no press, and the press refused, in words.
    changeInBooks("12", { Active: true, SyncToken: "2" });
    await readAgain();
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    const inactive = (await loadAccountingLinks()).inactive.find((r) => r.name === "Rivera Family")!;
    const leoActive = familySendStudentsWords(["Leo Rivera"], []);
    expect(inactive).toMatchObject({ send: null, sendNote: leoActive });
    expect(await pressWith("inactive", "family", String(rivera), sendStamp("inactive", String(rivera), "10", ["10", "11", "12"]))).toMatchObject({ ok: false, errors: [leoActive] });
    // A stamp of the family alone, as M5a's member's was: whom it covers isn't whom the page drew.
    expect(await pressWith("inactive", "family", String(rivera), sendStamp("inactive", String(rivera), "10", ["10"]))).toMatchObject({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await familyRow(rivera)).toMatchObject({ active: false });
  });
});

describe("a member inactive in the portal, made inactive in flat books", () => {
  it("one make-inactive by the balance rule, the member's link aligned, the record as it was", async () => {
    // Flat books whose Rivera Family has nobody under it in QuickBooks.
    const company = fznCompany();
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] }, company: { ...company, customers: company.customers.filter((c) => c.Id !== "11" && c.Id !== "12") } });
    rivera = await recordOfCustomer("10", "family");
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    const row = (await loadAccountingLinks()).inactive.find((r) => r.name === "Rivera Family")!;
    expect(row.send).toMatchObject({ field: "inactive", kind: "family", recordId: String(rivera), about: "Rivera Family's active status",
      words: ["Makes Rivera Family inactive in the books, as the portal has it, in place of active there. QuickBooks is asked what is owed first, and any balance, owed or a credit, stops it with nothing sent."] });
    stub.calls.length = 0;
    expect(await press(row.send!)).toEqual({ ok: true, message: "Made Rivera Family inactive in QuickBooks, as the portal has it: QuickBooks showed no balance on the account first." });
    expect(posts()).toEqual([expect.objectContaining({ Id: "10", SyncToken: "0", Active: false })]);
    expect(await familyLinkVersion("10")).toBe("1");
    expect(await familyRow(rivera)).toMatchObject({ active: false });
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "family", targetId: String(rivera), after: expect.objectContaining({ field: "inactive", kind: "family", outcome: "sent" }) })]);
    expect((await loadAccountingLinks()).inactive).toEqual([]);
  });
});

describe("who may press it", () => {
  beforeEach(layered);

  it("the linking permission with Roster.Read and Roster.Family.ReadWrite: any one missing is refused as the guard refuses, and every argument is checked", async () => {
    changeInBooks("10", { DisplayName: "Rivera Household" });
    await readAgain();
    const offer = await sendOf("Rivera Family", "name");
    const noChange = await staffWith("linkonly@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    const noLink = await staffWith("changeonly@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    const noRead = await staffWith("noread@club.org", ["Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
    stub.calls.length = 0;
    for (const who of [noChange, noLink, noRead]) {
      asStaff(who);
      await expect(sendDifferenceAction("name", "family", offer.recordId, tag, offer.stamp)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === noChange.id).map((a) => a.permission)).toEqual(["Roster.Family.ReadWrite"]);
    expect(refusals.filter((a) => a.actorId === noLink.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    expect(refusals.filter((a) => a.actorId === noRead.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    asStaff(sender);
    const NOT_FROM_PAGE = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const args of [
      ["active", "family", offer.recordId, tag, offer.stamp], ["title", "family", offer.recordId, tag, offer.stamp], ["name", "parent", offer.recordId, tag, offer.stamp],
      ["place", "family", offer.recordId, tag, offer.stamp], [7, "family", offer.recordId, tag, offer.stamp], ["name", "family", "x".repeat(65), tag, offer.stamp],
      ["name", "family", "", tag, offer.stamp], ["name", "family", offer.recordId, null, offer.stamp], ["name", "family", offer.recordId, "t".repeat(65), offer.stamp],
      ["name", "family", offer.recordId, tag, "s".repeat(65)], ["name", "family", offer.recordId, tag, { stamp: offer.stamp }],
    ] as unknown[][]) {
      expect(await (sendDifferenceAction as unknown as (...a: unknown[]) => Promise<unknown>)(...args), JSON.stringify(args)).toEqual(NOT_FROM_PAGE);
    }
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await sendDifferenceAction("name", "family", offer.recordId, tag, offer.stamp)).toEqual({ ok: true, message: "Sent the portal's name “Rivera Family” to QuickBooks, in place of “Rivera Household”." });
    expect(await sends()).toEqual([expect.objectContaining({ actorId: sender.id })]);
  });
});

describe("the page", () => {
  beforeEach(layered);

  it("draws Send beside Take for a reader who may change families, none for one who may not, and none for what it can't or won't send", async () => {
    // Imported before anything is changed in the portal: Zoe (13) and Max (14) under Rivera, Oak Family (80), and a
    // school named Rivera Family (90).
    await readAgain(qc("13", "Zoe Rivera", "3", under("10")), qc("14", "Max Rivera", "3", under("10")), qc("80", "Oak Family", "1"), qc("90", "Rivera Family", "4"));
    await syncAppRecords();
    // In the portal: Zoe inactive, Oak inactive. In the books: Rivera renamed, Leo renamed and under Chen, Max not a
    // student customer now, Chen inactive.
    await db.update(student).set({ active: false }).where(eq(student.id, await recordOfCustomer("13", "student")));
    await db.update(family).set({ active: false }).where(eq(family.id, await recordOfCustomer("80", "family")));
    changeInBooks("10", { DisplayName: "Rivera Household" });
    changeInBooks("12", { DisplayName: "Leo M. Rivera", ...under("20") });
    changeInBooks("14", { CustomerTypeRef: { value: "4" } });
    changeInBooks("20", { Active: false });
    // And Kim Rivera (15), a student customer under Rivera read after the import, with no record: a link, not a value.
    await readAgain(qc("15", "Kim Rivera", "3", under("10")));
    const view = await loadAccountingLinks();
    const kinds = (name: string) => rowOf(view, name).differences.map((d) => d.kind);
    expect(kinds("Rivera Family")).toEqual(expect.arrayContaining(["name", "place", "active", "student_customer"]));
    expect(kinds("Chen Family")).toEqual(expect.arrayContaining(["active", "student_elsewhere", "parent_customers"]));
    const listOf = (whole: string) => { const at = whole.indexOf('id="links-list-h"'); return whole.slice(at, whole.indexOf("</section>", at)).replaceAll("&#x27;", "'").replaceAll("<!-- -->", ""); };
    const partOf = (whole: string) => { const at = whole.indexOf('id="links-inactive-h"'); return at < 0 ? "" : whole.slice(at, whole.indexOf("</section>", at)).replaceAll("&#x27;", "'"); };
    const pressed = (part: string, label: string) => [...part.matchAll(new RegExp(`${label}<span class="visually-hidden">: ([^<]*)</span>`, "g"))].map((m) => m[1]).sort();
    const HELD_ELSEWHERE = "QuickBooks has another customer named “Rivera Family”, and every name there must be different, so the portal's name can't be sent: rename the record on its page instead.";
    const NEVER_ACTIVE = "The portal never makes a customer active in the books, so this can only be taken from them.";

    asStaff(sender);
    const whole = await renderPage(AccountingLinksPage);
    const list = listOf(whole);
    expect(pressed(list, "Send the app's to QuickBooks")).toEqual(["Leo Rivera's family", "Leo Rivera's family", "Leo Rivera's name", "Zoe Rivera's active status"]);
    // Beside the Take it pairs with, in the same row-actions.
    expect(list).toContain(`Take QuickBooks' into the app<span class="visually-hidden">: Leo Rivera's name</span></button><button type="button" class="btn btn-line">Send the app's to QuickBooks<span class="visually-hidden">: Leo Rivera's name</span></button></div>`);
    expect(list).toContain("Sends “Leo Rivera” to the books as Leo Rivera's name, in place of “Leo M. Rivera” there. The books' name is replaced.");
    // The family's name another customer holds, Chen inactive in the books, and nothing for Max (not a student customer
    // now), Mei Chen's Parent customer or the Chens' own active status.
    expect(list).toContain(HELD_ELSEWHERE);
    expect(list).toContain(NEVER_ACTIVE);
    expect(list).not.toMatch(/Send the app's to QuickBooks<span class="visually-hidden">: (Rivera Family's name|Max Rivera's family|Chen Family's active status|Kim Rivera)/);
    expect(rowOf(view, "Rivera Family").sends.map((x) => x.at)).not.toContain(rowOf(view, "Rivera Family").differences.findIndex((d) => d.kind === "student_customer"));
    // Oak, inactive here and active in the books, a layered family with nobody under it in the books: its Take, and
    // since slice M5b its Send, beside it.
    const part = partOf(whole);
    const OAK_SENT = "Makes “Oak Family” inactive in the books, as the portal has it, in place of active there.";
    expect(pressed(part, "Take QuickBooks' into the app")).toEqual(["Oak Family's active status"]);
    expect(pressed(part, "Send the app's to QuickBooks")).toEqual(["Oak Family's active status"]);
    expect(part).toContain(OAK_SENT);
    // The props are only words and bound actions: no stamp is drawn into the page.
    for (const s of [...view.rows.flatMap((r) => [...r.sends, ...r.takes]), ...view.inactive.flatMap((r) => (r.take ? [r.take] : []))]) expect(whole).not.toContain(s.stamp);
    for (const s of view.inactive.flatMap((r) => (r.send ? [r.send] : []))) expect(whole).not.toContain(s.stamp);

    // A reader without Roster.Family.ReadWrite: the Takes as before, no Send and none of its sentences.
    const linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    asStaff(linker);
    const theirs = await renderPage(AccountingLinksPage);
    expect(pressed(listOf(theirs), "Send the app's to QuickBooks")).toEqual([]);
    expect(pressed(listOf(theirs), "Take QuickBooks' into the app")).toEqual(pressed(list, "Take QuickBooks' into the app"));
    expect(listOf(theirs)).not.toContain(HELD_ELSEWHERE);
    expect(listOf(theirs)).not.toContain(NEVER_ACTIVE);
    expect(partOf(theirs)).not.toContain(OAK_SENT);
    expect(pressed(partOf(theirs), "Send the app's to QuickBooks")).toEqual([]);
    expect(listOf(theirs)).not.toContain(QUEUE_IN_THE_WAY_OF_SEND);
    // Drawing the page sends and queues nothing.
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect((await db.select().from(writeQueue).where(sql`${writeQueue.request}->>'op' = 'move'`))).toEqual([]);
  });
});

describe("a layered family inactive in the portal, made inactive in the books with everyone under it (slice M5b)", () => {
  let zoe: AppStudentId;
  beforeEach(async () => {
    await layered();
    // Zoe Rivera (13), a second student under Rivera, imported before anything is changed in the portal.
    await readAgain(qc("13", "Zoe Rivera", "3", under("10")));
    await syncAppRecords();
    zoe = await recordOfCustomer("13", "student");
    // In the portal: the family and both its students inactive. In the books: all of them, and Ana's Parent customer, active.
    await db.update(student).set({ active: false }).where(eq(student.familyId, rivera));
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
  });
  const offerNow = async () => (await loadAccountingLinks()).inactive.find((r) => r.name === "Rivera Family")!;
  const familyRuns = () => auditsOf("roster.family.deactivate");
  const COVER = "Makes Rivera Family's customer inactive in the books, as the portal has it, in place of active there, and with it everyone active under it, as QuickBooks asks: “Ana Rivera”, “Leo Rivera”, “Zoe Rivera” and “Rivera Family”, one at a time in that order, deepest first and the family last.";
  const AGAIN = "Rivera Family is still active in QuickBooks. Press “Send the app's to QuickBooks” on its row on Accounting links again to carry on with whoever is still active.";

  it("offered with whom it covers in words, and sent: one make-inactive each, deepest first and the family last, one family row and one send row, the records as they were", async () => {
    // A make-inactive of Leo's customer kept on Reconciliation: closed once QuickBooks has it inactive.
    const kept = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { state: "refused", code: "fault_6000" });
    const row = await offerNow();
    expect(row.sendNote).toBeNull();
    expect(row.send).toMatchObject({ field: "inactive", kind: "family", recordId: String(rivera), about: "Rivera Family's active status",
      words: [COVER, "QuickBooks is asked what each of them owes first, and any balance on any of them, owed or a credit, or one that can't be read, stops it with nothing sent.",
        "If QuickBooks stops it part way, whoever was made inactive before then stays inactive in the books, and the answer says who.", "The portal's records don't change.",
        "A make-inactive kept on the Reconciliation page for any of them is closed once QuickBooks has that customer inactive, as this takes its place."] });
    expect(row.send!.stamp).toBe(sendStamp("inactive", String(rivera), "10", ["10", "11", "12", "13"]));
    stub.calls.length = 0;
    const r = await press(row.send!);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.ok && r.message.startsWith("Made inactive in QuickBooks: Ana Rivera, Leo Rivera and Zoe Rivera, then Rivera Family.")).toBe(true);
    // Each read first (its balance), then each made inactive, the family last.
    const sent = posts();
    expect(sent.map((b) => b.Id)).toEqual(["11", "12", "13", "10"]);
    for (const b of sent) expect(b).toMatchObject({ Active: false });
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toHaveLength(4);
    expect(stub.customers.filter((c) => ["10", "11", "12", "13"].includes(String(c.Id))).every((c) => c.Active === false)).toBe(true);
    expect(await familyRuns()).toEqual([expect.objectContaining({ targetId: "10", after: expect.objectContaining({ outcome: "done", made: ["11", "12", "13", "10"], notMade: [] }) })]);
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "family", targetId: String(rivera), before: { active: true },
      after: { field: "inactive", kind: "family", familyId: String(rivera), customerQboId: "10", covered: ["11", "12", "13", "10"], active: false, outcome: "sent", replaced: [kept.id] } })]);
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "given_up" });
    expect(await items()).toHaveLength(1);
    // The portal's records as they were: nothing made active, nothing else changed.
    expect(await familyRow(rivera)).toMatchObject({ active: false });
    expect(await studentRow(leo)).toMatchObject({ active: false, familyId: rivera });
    expect(await studentRow(zoe)).toMatchObject({ active: false, familyId: rivera });
    expect((await loadAccountingLinks()).inactive).toEqual([]);
  });

  it("a balance owed on one and a credit on another: stopped with nothing sent, said in words, the amount only for a reader who may see balances", async () => {
    stub.invoices.push(balance("9001", "12", 25), balance("9002", "13", -10));
    const row = await offerNow();
    stub.calls.length = 0;
    const r = await press(row.send!);
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain("Leo Rivera");
    expect(errors[1]).toContain("Zoe Rivera");
    expect(errors[2]).toBe(`Nobody was made inactive. ${WRITE_COPY.balanceFix}`);
    expect(errors.join(" ")).not.toContain("$");
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await familyRuns()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "refused", made: [] }) })]);
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped", code: "open_balance" }) })]);
    // Through the press: the amount said only to a holder of Finance.Balance.Read.
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite", "Finance.Balance.Read"]);
    asStaff(treasurer);
    const told = await sendDifferenceAction("inactive", "family", row.send!.recordId, tag, row.send!.stamp);
    expect(told.ok).toBe(false);
    expect(told.ok ? "" : told.errors.join(" ")).toContain("$25.00");
    expect(told).not.toHaveProperty("changed");
    expect(posts()).toEqual([]);
    // Nothing changed anywhere: only the links page is drawn again, not the layout.
    expect(revalidatedPaths()).not.toContain("/");
  });

  it("an answer lost part way, through the press: stopped, the lost step held on the queue, the send row `queued`, and the pages drawn again on `changed`", async () => {
    const row = await offerNow();
    // Leo's make-inactive reaches QuickBooks, which makes him inactive, and its answer never comes back.
    stub.onApiRequest = (c) => { stub.loseUpdateAnswer = c.method === "POST" && /"Id":"12"/.test(c.body); };
    stub.calls.length = 0;
    asStaff(sender);
    const told = await sendDifferenceAction("inactive", "family", row.send!.recordId, tag, row.send!.stamp);
    stub.onApiRequest = null; stub.loseUpdateAnswer = false;
    expect(told.ok).toBe(false);
    expect(told.ok ? [] : told.errors[0]).toBe("Made inactive in QuickBooks: Ana Rivera.");
    expect(told).not.toHaveProperty("changed");
    expect(posts().map((b) => b.Id)).toEqual(["11", "12"]);
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: true, targetQboId: "12" })]);
    expect(await familyRuns()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped", made: ["11"], maybe: ["12"] }) })]);
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "queued", code: "unreachable" }) })]);
    // Ana was made inactive in the books: the layout is drawn again (`changed`), though the press didn't go through.
    expect(revalidatedPaths()).toContain("/");
  });

  it("a balance that can't be read stops it, with nothing sent", async () => {
    const row = await offerNow();
    stub.quirks.balances = false;
    stub.calls.length = 0;
    expect(await press(row.send!)).toMatchObject({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped" }) })]);
  });

  it("the second step refused by QuickBooks: stopped part way, the words naming who was made inactive and who wasn't", async () => {
    const row = await offerNow();
    stub.onApiRequest = (c) => { if (c.method === "POST" && c.body.includes(`"Id":"12"`)) stub.updateFault = "6000"; };
    stub.calls.length = 0;
    const r = await press(row.send!);
    stub.onApiRequest = null; stub.updateFault = null;
    expect(r).toMatchObject({ ok: false, changed: true });
    const errors = r.ok ? [] : r.errors;
    expect(errors[0]).toBe("Made inactive in QuickBooks: Ana Rivera.");
    expect(errors).toContain("Not made inactive yet: Zoe Rivera.");
    expect(errors.at(-1)).toBe(AGAIN);
    expect(posts().map((b) => b.Id)).toEqual(["11", "12"]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: false });
    expect(stub.customers.find((c) => c.Id === "10")).toMatchObject({ Active: true });
    expect(await familyRuns()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped", made: ["11"] }) })]);
    expect(await sends()).toEqual([expect.objectContaining({ after: expect.objectContaining({ outcome: "stopped", covered: ["11", "12", "13", "10"] }) })]);
  });

  it("someone added under the family in the books after the page: the cover changed, nothing sent", async () => {
    const row = await offerNow();
    await readAgain(qc("16", "Ivy Rivera", "3", under("10")));
    stub.calls.length = 0;
    expect(await press(row.send!)).toMatchObject({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await familyRuns()).toEqual([]);
  });

  it("a student of the family active in the portal, or a customer under it linked to an active student of another family: not offered, and refused, nothing sent", async () => {
    const stamp = sendStamp("inactive", String(rivera), "10", ["10", "11", "12", "13"]);
    await db.update(student).set({ active: true }).where(eq(student.id, leo));
    const leoActive = familySendStudentsWords(["Leo Rivera"], []);
    expect(await offerNow()).toMatchObject({ send: null, sendNote: leoActive });
    stub.calls.length = 0;
    expect(await pressWith("inactive", "family", String(rivera), stamp)).toMatchObject({ ok: false, errors: [leoActive] });
    // Leo inactive again; Zoe moved to the Chens in the portal and active there, while the books keep her under Rivera.
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    await db.update(student).set({ active: true, familyId: chen }).where(eq(student.id, zoe));
    const zoeElsewhere = familySendStudentsWords([], ["Zoe Rivera"]);
    expect(await offerNow()).toMatchObject({ send: null, sendNote: zoeElsewhere });
    expect(await pressWith("inactive", "family", String(rivera), stamp)).toMatchObject({ ok: false, errors: [zoeElsewhere] });
    // The words for a student of the family never send staff to a press the family's page refuses while it is inactive.
    expect(leoActive).not.toContain("first, or take");
    expect(leoActive).toContain("take the books' value instead");
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await familyRuns()).toEqual([]);
  });

  it("the family's lock held (a family-page press under way): refused as being changed; the family record active again: refused as changed", async () => {
    const row = await offerNow();
    stub.calls.length = 0;
    expect(await holding(SENDING_LOCK, String(rivera), () => press(row.send!))).toMatchObject({ ok: false, errors: [FAMILY_BEING_CHANGED] });
    // The record active again: refused by sendInactive()'s own first check, before the family action is reached
    // (prepareFamily()'s check of the record is for a record made active between the two transactions).
    await db.update(family).set({ active: true }).where(eq(family.id, rivera));
    expect(await press(row.send!)).toMatchObject({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("the family's customer made inactive in the books since the page, the record still inactive: refused as changed by the family action's own check, nothing read or sent", async () => {
    const row = await offerNow();
    changeInBooks("10", { Active: false, SyncToken: "1" });
    await readAgain();
    stub.calls.length = 0;
    // sendInactive() hands a layered family on before it looks at the customer, so this is prepareFamily()'s refusal:
    // without it the action would read every balance and answer that the family is inactive in QuickBooks already.
    expect(await press(row.send!)).toMatchObject({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await familyRuns()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("not offered, and refused, while a change waits for the family's customer or a move out of the family is kept", async () => {
    const row = await offerNow();
    const waiting = await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Household", was: "Rivera Family" }, { state: "waiting" });
    expect(await offerNow()).toMatchObject({ send: null, sendNote: QUEUE_IN_THE_WAY_OF_SEND });
    stub.calls.length = 0;
    expect(await press(row.send!)).toMatchObject({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen },
      { state: "refused", code: "fault_6240" });
    expect(await offerNow()).toMatchObject({ send: null, sendNote: QUEUE_IN_THE_WAY_OF_SEND });
    expect(await press(row.send!)).toMatchObject({ ok: false, errors: [MOVE_PENDING] });
    expect(posts()).toEqual([]);
    expect(await familyRuns()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("not offered while a change waits for anyone it covers, or while QuickBooks isn't connected", async () => {
    await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana R. Rivera", was: "Ana Rivera" });
    expect(await offerNow()).toMatchObject({ send: null, sendNote: QUEUE_IN_THE_WAY_OF_SEND });
    await db.delete(writeQueue);
    await db.delete(qboConnection);
    expect(await offerNow()).toMatchObject({ send: null, sendNote: SEND_NOT_CONNECTED });
  });
});
