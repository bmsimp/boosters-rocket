import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

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

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, familyMoney, qboCustomer, student, volunteerCredit, volunteerSignup, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { askFamilyInactive, BEING_SENT, changeInPortal, createInQuickBooksAndLink, FAMILY_SENDING, FAMILY_WAITING, familyCover, INACTIVE_THERE_CODE, keptMoveWords, MAKING_LOCK,
  MOVE_PENDING, moveStudent, NO_FAMILY_CUSTOMER, PLACE_DIFFERS, portalValueStamp, renameLinked, sendPortalValue, SENDING_LOCK, WRITE_COPY } from "@/lib/roster/writes";
import { giveUp, loadOpenWrites, REFUSED_NOT_AGAIN, runWriteQueue, tryAgainNow } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import { afterStudentMoved } from "@/lib/roster/writes";
import { sessionFamily } from "@/lib/families/session-family";
import { findMyForm } from "@/lib/forms/my-forms";
import { findMySignedPdf } from "@/lib/forms/my-evidence";
import { loadFamilyMoney } from "@/lib/money/family-money";
import FormsPage from "@/app/(parent)/forms/page";
import FormPage from "@/app/(parent)/forms/[id]/page";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { formSetting, requestNow, seedConsent, seedEvidence, seedFormRequirement, seedRequest } from "../helpers/forms";
import { identityNow } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { seedCheckIn, seedEvent, seedSignup } from "../helpers/volunteer";
import { seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { recordOfCustomer } from "../helpers/app-records";
import { stubInvoice } from "../helpers/money";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, auditsOf, connectRoster, queueItem, REALM, staffWith, WORKER } from "../helpers/roster-writes";

/**
 * Stage 3's slice 9f: a student's move is the portal's own change. moveStudent() saves the student record's new family,
 * runs the move's follow-ups once (the student's forms, places on shifts still to come and buy-outs) and audits it, in
 * one transaction, with the move's queue item where anything is to be sent or kept; a linked student moved into a
 * linked family is then sent with the student link's own version, and a stale answer is settled by the field (the
 * parent QuickBooks has them under, against the family moved from). Whose invoices a family sees still follows
 * QuickBooks' tree (open question 14). Every request is the stub's: `bodies()` proves what was sent each time.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
vi.setConfig({ testTimeout: 60_000 });

const LEO = "12", RIVERA = "10", CHEN = "20";
const MIN = 60_000;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const items = () => db.select().from(writeQueue).where(sql`${writeQueue.request}->>'op' = 'move'`);
const followed = () => auditsOf("roster.student.move.followed");
const studentRow = async (id: AppStudentId) => (await db.select().from(student).where(eq(student.id, id)))[0]!;
const studentLink = async () => (await db.select().from(accountingLink).where(and(eq(accountingLink.customerId, LEO), isNotNull(accountingLink.studentId))))[0]!;
/** Moves a customer to another parent in QuickBooks, as a change made there: a new version of the record. */
const moveInQuickBooks = (id: string, toQboId: string) => { const c = inStub(id); Object.assign(c, { ParentRef: { value: toQboId }, Job: true }); c.SyncToken = String(Number(c.SyncToken) + 1); };
/** Holds one of the advisory locks a send holds, for as long as `run` takes, on another connection. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});
const BODY = (token: string, to: string) => ({ Id: LEO, SyncToken: token, sparse: true, ParentRef: { value: to }, Job: true, BillWithParent: true });

let tag: string;
let op: ReturnType<typeof asOp>;
let leo: AppStudentId, rivera: AppFamilyId, chen: AppFamilyId;
const move = (to: AppFamilyId, who: AppStudentId = leo) => moveStudent(String(who), String(to), tag, op);

beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = [];
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
});

describe("a move by the app's own records", () => {
  beforeEach(async () => {
    tag = await connectRoster(stub);
    stub.calls.length = 0;
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    [leo, rivera, chen] = [await recordOfCustomer(LEO, "student"), await recordOfCustomer(RIVERA, "family"), await recordOfCustomer(CHEN, "family")];
  });

  it("a student with no link, between families with no link, gets the same follow-ups: nothing is read from or sent to QuickBooks, and there is no item", async () => {
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Join" }] });
    const req = await seedFormRequirement({ stepId: season.stepIds.Join!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplunlinked" }) });
    const open = await seedRequest({ requirementId: req, familyQboId: RIVERA, subjectQboId: LEO, state: "waiting", envelopeId: "envelope_unlinkedopen" });
    const { shifts: [soon] } = await seedEvent({ inDays: 20 });
    const place = await seedSignup({ shiftId: soon!.id, familyQboId: RIVERA, signedUpBy: ana.id, student: { qboId: LEO, name: "Leo Rivera" } });
    const perStudent = await seedBuyoutRequirement({ appliesTo: "student" });
    await seedBuyout({ requirementId: perStudent, familyQboId: RIVERA, subjectQboId: LEO, chosenBy: ana.id, invoiceQboId: "5001" });
    // The records stand alone: their links are gone, so nothing of QuickBooks can name them.
    await db.delete(accountingLink).where(sql`${accountingLink.customerId} in (${RIVERA}, ${LEO}, ${CHEN})`);
    stub.calls.length = 0;
    expect(await move(chen)).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal. Leo Rivera isn't linked to QuickBooks, so nothing was sent there." });
    expect(stub.apiCalls()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: chen });
    expect(await requestNow(open)).toMatchObject({ state: "not_opened", envelopeId: null, familyId: chen });
    expect((await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, place.id)))[0]!.cancelledAt).not.toBeNull();
    expect(await followed()).toEqual([expect.objectContaining({ targetType: "student", targetId: String(leo),
      after: expect.objectContaining({ studentId: String(leo), fromFamilyId: String(rivera), toFamilyId: String(chen), formsReset: 1, placesGivenUp: 1, buyoutsToVoid: 1 }) })]);
    expect((await auditsOf("roster.record.moved"))[0]!.after).toMatchObject({ quickbooks: "not_sent", familyId: String(chen), fromFamilyId: String(rivera) });
  });

  it("afterStudentMoved() runs the same for records with no link, called by the app's ids alone", async () => {
    await db.delete(accountingLink).where(sql`${accountingLink.customerId} in (${RIVERA}, ${LEO}, ${CHEN})`);
    const r = await db.transaction((tx) => afterStudentMoved(tx, { studentId: leo, fromFamilyId: rivera, toFamilyId: chen, cause: "test" }, { actor: WORKER.actor, ip: null }));
    expect(typeof r.tell).toBe("function");
    expect((await followed())[0]!.after).toMatchObject({ studentId: String(leo), fromFamilyId: String(rivera), toFamilyId: String(chen), formsMoved: 0, formsReset: 0, placesGivenUp: 0 });
  });

  it("a linked student into a linked family: one ParentRef update with the link's version, the item done, the follow-ups once", async () => {
    expect(await move(chen)).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal and in QuickBooks." });
    expect(bodies()).toEqual([BODY("0", CHEN)]);
    expect((await items()).map((i) => [i.state, i.familyId, i.studentId, i.request])).toEqual([["done", rivera, leo,
      expect.objectContaining({ op: "move", qboId: LEO, fromFamilyQboId: RIVERA, toFamilyQboId: CHEN, fromFamilyId: String(rivera), toFamilyId: String(chen) })]]);
    expect(await followed()).toHaveLength(1);
    expect((await studentLink()).syncedToken).toBe("1");
  });

  it("a linked student into a family with no link: saved, nothing sent, kept refused in words; Send the portal's value says to create the family first, and sends once it has its customer", async () => {
    const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
    const r = await move(okafor!.id);
    expect(r).toMatchObject({ ok: true, status: "attention" });
    expect((r as { message: string }).message).toContain("Okafor Family has no customer in QuickBooks yet");
    expect(posts()).toEqual([]);
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", sent: false, tries: 0, lastCode: NO_FAMILY_CUSTOMER, familyId: rivera, studentId: leo,
      request: expect.objectContaining({ fromFamilyQboId: RIVERA, toFamilyQboId: "", toFamilyId: String(okafor!.id) }) });
    expect((await auditsOf("roster.write.kept_refused"))[0]).toMatchObject({ targetId: kept!.id });
    expect((await auditsOf("roster.record.moved"))[0]!.after).toMatchObject({ quickbooks: "kept", queueId: kept!.id });
    // Listed with what QuickBooks has now, and the words for it; both families' pages find it.
    const [shown] = (await loadOpenWrites()).filter((w) => w.write.op === "move");
    expect(shown).toMatchObject({ state: "refused", holds: "Rivera Family", shown: RIVERA, mayResend: true,
      moneyNote: "Until QuickBooks has the move, Rivera Family still sees Leo Rivera's invoices, and Okafor Family doesn't." });
    expect(keptMoveWords(shown!.lastCode, shown!.holds)).toContain("Create the family in QuickBooks first");
    expect((await loadOpenWrites({ familyId: okafor!.id })).map((w) => w.id)).toEqual([kept!.id]);
    expect((await loadOpenWrites({ familyId: rivera })).map((w) => w.id)).toEqual([kept!.id]);
    // Never tried by the worker, nor by "Try again now".
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(posts()).toEqual([]);
    expect(await tryAgainNow(kept!.id, op)).toEqual({ ok: false, errors: [REFUSED_NOT_AGAIN] });
    // Neither family is made inactive while it waits (QuickBooks is never asked to make Leo inactive under Rivera).
    expect(await changeInPortal({ op: "deactivate_family", familyId: String(okafor!.id) }, tag, op)).toEqual({ ok: false, errors: [MOVE_PENDING] });
    const c = (await familyCover(RIVERA))!;
    expect((await askFamilyInactive(RIVERA, [[c.family.qboId, c.family.syncToken], ...c.under.map((u): [string, string] => [u.qboId, u.syncToken])], tag, op)).result)
      .toEqual({ ok: false, errors: [MOVE_PENDING] });
    // Send the portal's value: refused in words while the family has no customer.
    expect(await sendPortalValue(kept!.id, RIVERA, portalValueStamp(kept!.id, RIVERA), op)).toEqual({ ok: false, errors: [expect.stringContaining("has no customer in QuickBooks yet")] });
    expect(posts()).toEqual([]);
    // Once "Create in QuickBooks and link" has made it, the press sends the move, with the version read live.
    expect((await createInQuickBooksAndLink(String(okafor!.id), null, tag, op)).result.ok).toBe(true);
    const okaforCustomer = stub.customers.find((x) => x.DisplayName === "Okafor Family")!.Id as string;
    stub.calls.length = 0;
    expect(await sendPortalValue(kept!.id, RIVERA, portalValueStamp(kept!.id, RIVERA), op)).toMatchObject({ ok: true });
    expect(bodies()).toEqual([BODY("0", okaforCustomer)]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "done" });
    expect(await followed()).toHaveLength(1); // the save's, never the press's
  });

  it("to the family QuickBooks has the student under already: nothing sent, no item", async () => {
    moveInQuickBooks(LEO, CHEN);
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    stub.calls.length = 0;
    expect(await move(chen)).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal. QuickBooks has them in that family already, so nothing was sent." });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect((await auditsOf("roster.record.moved"))[0]!.after).toMatchObject({ quickbooks: "has_it" });
  });

  describe("a stale version is settled by the field", () => {
    it("stale with QuickBooks still under the family moved from: sent once more with the version just read, the link aligned from that answer", async () => {
      inStub(LEO).SyncToken = "4"; // an edit made in QuickBooks that moved nothing
      expect(await move(chen)).toMatchObject({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal and in QuickBooks." });
      expect(bodies()).toEqual([BODY("0", CHEN), BODY("4", CHEN)]);
      expect((await studentLink()).syncedToken).toBe("5");
      expect((await auditsOf("roster.student.move"))[0]!.after).toMatchObject({ resent: "stale", fieldAsHeld: true });
    });

    it("stale with the student moved in QuickBooks at that moment: kept refused, nothing sent over it, the words naming where QuickBooks has them", async () => {
      stub.beforeUpdate = (c) => { if (c.Id === LEO && (c.ParentRef as { value?: string } | undefined)?.value === RIVERA) { c.ParentRef = { value: "40" }; c.SyncToken = "1"; } };
      const r = await move(chen);
      expect(r).toMatchObject({ ok: true, status: "attention" });
      expect((r as { message: string }).message).toContain("QuickBooks has the student under “Old Family” now.");
      expect(bodies()).toEqual([BODY("0", CHEN)]);
      expect(inStub(LEO)).toMatchObject({ ParentRef: { value: "40" } });
      expect((await items()).map((i) => [i.state, i.lastCode])).toEqual([["refused", "fault_5010"]]);
      expect(await studentRow(leo)).toMatchObject({ familyId: chen }); // the portal's move is never undone
    });

    it("a link with no version: read live first, and sent with the version read when QuickBooks has the student where the portal moved them from", async () => {
      await db.update(accountingLink).set({ syncedToken: null }).where(and(eq(accountingLink.customerId, LEO), isNotNull(accountingLink.studentId)));
      expect(await move(chen)).toMatchObject({ ok: true });
      expect(bodies()).toEqual([BODY("0", CHEN)]);
      expect(stub.apiCalls().filter((c) => c.method === "GET").length).toBeGreaterThan(0);
      expect((await studentLink()).syncedToken).toBe("1");
    });

    it("the cache showing another parent than the family moved from: read live before anything is sent, and held", async () => {
      moveInQuickBooks(LEO, "40");
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      stub.calls.length = 0;
      expect(await move(chen)).toMatchObject({ ok: true, status: "attention" });
      expect(posts()).toEqual([]);
      expect((await items()).map((i) => [i.state, i.lastCode])).toEqual([["refused", PLACE_DIFFERS]]);
    });

    it("QuickBooks already under the family joined: found, nothing more sent, no second follow-up, the link not aligned", async () => {
      Object.assign(inStub(LEO), { ParentRef: { value: CHEN }, SyncToken: "1" }); // moved there in QuickBooks, unread
      expect(await move(chen)).toEqual({ ok: true, message: "Moved Leo Rivera to Chen Family in the portal. QuickBooks has them in that family already, so nothing was sent." });
      expect(bodies()).toEqual([BODY("0", CHEN)]); // the one that met the stale answer
      expect((await items())[0]).toMatchObject({ state: "done" });
      expect(await followed()).toHaveLength(1);
      expect((await studentLink()).syncedToken).toBe("0");
    });

    it("inactive in QuickBooks: held, nothing sent over it", async () => {
      Object.assign(inStub(LEO), { Active: false, SyncToken: "1" });
      expect(await move(chen)).toMatchObject({ ok: true, status: "attention" });
      expect(bodies()).toEqual([BODY("0", CHEN)]);
      expect((await items()).map((i) => i.lastCode)).toEqual([INACTIVE_THERE_CODE]);
    });

    it("a second stale answer waits as never sent; the worker's try follows the same rule", async () => {
      stub.beforeUpdate = (c) => { if (c.Id === LEO) c.SyncToken = String(Number(c.SyncToken) + 1); };
      expect(await move(chen)).toMatchObject({ ok: true, status: "waiting" });
      expect(bodies()).toHaveLength(2); // never more than one resend in a try
      expect((await items())[0]).toMatchObject({ state: "waiting", sent: false, lastCode: "fault_5010" });
      stub.beforeUpdate = null;
      stub.calls.length = 0;
      await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - MIN) });
      await runWriteQueue();
      expect((await items())[0]).toMatchObject({ state: "done" });
      expect(bodies().map((b) => b.ParentRef)).toEqual(expect.arrayContaining([{ value: CHEN }]));
      expect(await followed()).toHaveLength(1);
    });

    it("the queue's look at a move whose version moved on is settled by the field, never stuck for the version alone", async () => {
      stub.dropApi = true;
      expect(await move(chen)).toMatchObject({ ok: true, status: "waiting" });
      stub.dropApi = false;
      expect((await items())[0]).toMatchObject({ state: "waiting", sent: true });
      inStub(LEO).SyncToken = "5"; // edited in QuickBooks since, still under the Rivera family
      stub.calls.length = 0;
      await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - MIN) });
      await runWriteQueue();
      expect((await items())[0]).toMatchObject({ state: "done" });
      expect(bodies()).toEqual([BODY("5", CHEN)]);
      expect(await followed()).toHaveLength(1);
    });

    it("a move that takes the place of a refused one inherits its before-value, and its press sends from the place the row showed", async () => {
      moveInQuickBooks(LEO, "40");
      expect((await refreshRoster(WORKER)).ok).toBe(true);
      expect(await move(chen)).toMatchObject({ status: "attention" });
      const [first] = await items();
      expect(await move(rivera)).toMatchObject({ status: "attention" });
      expect(await queueItem(first!.id)).toMatchObject({ state: "given_up" });
      expect((await auditsOf("roster.write.replaced"))[0]).toMatchObject({ targetId: first!.id });
      const second = (await items()).find((i) => i.state === "refused")!;
      expect(second.request).toMatchObject({ fromFamilyQboId: RIVERA, toFamilyQboId: RIVERA });
      expect((await auditsOf("roster.record.moved")).at(-1)!.after).toMatchObject({ comparedWith: RIVERA, replaced: [first!.id] });
      // A value that isn't what the row showed is refused before anything is read.
      expect(await sendPortalValue(second.id, CHEN, portalValueStamp(second.id, "40"), op)).toEqual({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
      // QuickBooks moved again since the row was drawn: nothing sent, the newer place said.
      moveInQuickBooks(LEO, CHEN);
      stub.calls.length = 0;
      expect(await sendPortalValue(second.id, "40", portalValueStamp(second.id, "40"), op)).toEqual({ ok: false, errors: [expect.stringContaining("QuickBooks moved the student again since this page was shown: it has them under “Chen Family” now.")] });
      expect(posts()).toEqual([]);
      // As the row now shows it: sent, with the live version, from that place.
      expect(await sendPortalValue(second.id, CHEN, portalValueStamp(second.id, CHEN), op)).toMatchObject({ ok: true });
      expect(bodies()).toEqual([BODY("2", RIVERA)]);
      expect(await queueItem(second.id)).toMatchObject({ state: "done" });
      expect(await followed()).toHaveLength(2); // one per move saved, none for the press
    });
  });

  it("given up, a kept move leaves the portal's record where it moved it, in words", async () => {
    const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
    await move(okafor!.id);
    const [kept] = await items();
    const r = await giveUp(kept!.id, "Done by hand.", op);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("The portal keeps the student in the family it moved them to") });
    expect(await studentRow(leo)).toMatchObject({ familyId: okafor!.id });
    // No longer held back by the move: what stops it now is the linked student it holds, made inactive in QuickBooks first.
    expect(await changeInPortal({ op: "deactivate_family", familyId: String(okafor!.id) }, tag, op)).toEqual({ ok: false, errors: [expect.stringContaining("is linked to QuickBooks")] });
  });

  it("refused before anything is saved: a family's create waiting or being sent on either side, the student's own create waiting, a change being sent for the student", async () => {
    const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
    await db.insert(writeQueue).values({ realmId: REALM, request: { op: "create", role: "family", name: "Okafor Family", typeQboId: "1", familyQboId: null, email: null },
      familyId: okafor!.id, state: "waiting", sent: false, nextTryAt: new Date(Date.now() + MIN) });
    expect(await move(okafor!.id)).toEqual({ ok: false, errors: [FAMILY_WAITING] });
    expect(await holding(MAKING_LOCK, String(chen), () => move(chen))).toEqual({ ok: false, errors: [FAMILY_SENDING] });
    expect(await holding(MAKING_LOCK, String(rivera), () => move(chen))).toEqual({ ok: false, errors: [FAMILY_SENDING] });
    const [rosa] = await db.insert(student).values({ familyId: rivera, name: "Rosa Rivera", active: true }).returning({ id: student.id });
    await db.insert(writeQueue).values({ realmId: REALM, request: { op: "create", role: "student", name: "Rosa Rivera", typeQboId: "3", familyQboId: RIVERA, email: null },
      familyId: rivera, studentId: rosa!.id, state: "stuck", sent: false });
    expect(await move(chen, rosa!.id)).toEqual({ ok: false, errors: ["Making this student in QuickBooks is still waiting on the queue, so nothing else can be changed for them for now. Once it has gone through, or been given up on the Reconciliation page, try again."] });
    // Two changes to one student at once: whichever comes second is refused in words.
    expect(await holding(SENDING_LOCK, String(leo), () => move(chen))).toEqual({ ok: false, errors: [BEING_SENT] });
    expect(await holding(SENDING_LOCK, String(leo), () => renameLinked({ kind: "student", recordId: String(leo), name: "Leon Rivera" }, tag, op))).toEqual({ ok: false, errors: [BEING_SENT] });
    expect(posts()).toEqual([]);
    expect(await auditsOf("roster.record.moved")).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ familyId: rivera });
  });

  it("a move of the same student while one is still waiting is refused: one change waits for a record at a time", async () => {
    stub.rateLimitNext = 1;
    expect(await move(chen)).toMatchObject({ ok: true, status: "waiting" });
    expect(await move(rivera)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
  });
});

describe("what each family sees while a move hasn't reached QuickBooks, and after (open question 14)", () => {
  /** A guardian seeded before the roster is read, so the import gives their row its family record. */
  async function guardianBeforeTheRead(o: { familyQboId: string; name: string; email: string; sourceQboId: string }) {
    const person = await seedParent({ name: o.name, email: o.email, welcomedAt: new Date() });
    await seedGuardian({ parentId: person.id, familyQboId: o.familyQboId, status: "active", isPrimary: true, sourceQboId: o.sourceQboId });
    return { authUserId: person.authUserId, familyQboId: o.familyQboId, parentId: person.id };
  }
  const ctxOf = async (g: { authUserId: string; familyQboId: string }) => ({ ...(await identityNow((await seedParentSession(g.authUserId, { familyQboId: g.familyQboId })).id)), ip: null });
  const studentsOf = async (f: AppFamilyId) => (await sessionFamily(f))!.students.map((s) => s.name);
  const invoicesOf = async (f: AppFamilyId) => ((await loadFamilyMoney(f)).figures?.open ?? []).map((i) => i.qboId);

  let ana: Awaited<ReturnType<typeof guardianBeforeTheRead>>, mei: Awaited<ReturnType<typeof guardianBeforeTheRead>>;
  let forms: { open: string; signed: string };
  beforeEach(async () => {
    const company = fznCompany();
    Object.assign(company.customers.find((c) => c.Id === "21")!, { PrimaryEmailAddr: { Address: "mei@example.com" } });
    ana = await guardianBeforeTheRead({ familyQboId: RIVERA, name: "Ana Rivera", email: "ana@example.com", sourceQboId: "11" });
    mei = await guardianBeforeTheRead({ familyQboId: CHEN, name: "Mei Chen", email: "mei@example.com", sourceQboId: "21" });
    tag = await connectRoster(stub, { company });
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    [leo, rivera, chen] = [await recordOfCustomer(LEO, "student"), await recordOfCustomer(RIVERA, "family"), await recordOfCustomer(CHEN, "family")];
    // A per-student form open and one signed, a place to come and one done and checked in, an invoiced per-student buy-out, and an invoice of Leo's own.
    const season = await seedSeason({ name: "Moving season", steps: [{ name: "Join" }] });
    const openReq = await seedFormRequirement({ stepId: season.stepIds.Join!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplmedical" }) });
    const signedReq = await seedFormRequirement({ stepId: season.stepIds.Join!, title: "Photo consent", appliesTo: "student", form: formSetting({ id: "envelope_tmplphoto" }), position: 60 });
    const open = await seedRequest({ requirementId: openReq, familyQboId: RIVERA, subjectQboId: LEO, state: "waiting", envelopeId: "envelope_seenopen",
      signers: [{ parentId: ana.parentId, recipientId: 1, name: "Ana Rivera", email: "ana@example.com", signedAt: null }] });
    await seedConsent(open, { parentId: ana.parentId, name: "Ana Rivera", email: "ana@example.com" });
    const signed = await seedRequest({ requirementId: signedReq, familyQboId: RIVERA, subjectQboId: LEO, state: "complete", envelopeId: "envelope_seensigned",
      signers: [{ parentId: ana.parentId, recipientId: 1, name: "Ana Rivera", email: "ana@example.com", signedAt: "2026-11-10T14:00:00.000Z" }] });
    await seedEvidence(signed, { tag: "seen" });
    forms = { open, signed };
    const { shifts: [soon] } = await seedEvent({ name: "Fall fair", inDays: 20 });
    const { shifts: [past] } = await seedEvent({ name: "Summer fair", inDays: -20 });
    await seedSignup({ shiftId: soon!.id, familyQboId: RIVERA, signedUpBy: ana.parentId, student: { qboId: LEO, name: "Leo Rivera" } });
    const done = await seedSignup({ shiftId: past!.id, familyQboId: RIVERA, signedUpBy: ana.parentId, student: { qboId: LEO, name: "Leo Rivera" } });
    await seedCheckIn({ signupId: done.id, familyQboId: RIVERA, by: ana.parentId });
    await seedBuyout({ requirementId: await seedBuyoutRequirement({ appliesTo: "student" }), familyQboId: RIVERA, subjectQboId: LEO, chosenBy: ana.parentId, invoiceQboId: "5001" });
    stub.invoices.push(stubInvoice("9001", LEO));
    stub.calls.length = 0;
  });

  /** What the family left and the family joined see while QuickBooks still has Leo under the Rivera family. */
  async function inBetween() {
    const [anaCtx, meiCtx] = [await ctxOf(ana), await ctxOf(mei)];
    expect(await studentsOf(rivera)).not.toContain("Leo Rivera");
    expect(await studentsOf(chen)).toContain("Leo Rivera");
    // Forms: the signed form is Chen's now, read as "Signed" with no PDF; the open one starts again there, not opened.
    expect(await findMyForm(anaCtx, forms.signed)).toBeNull();
    expect((await findMyForm(meiCtx, forms.open))?.row).toMatchObject({ state: "not_opened" });
    expect(await findMySignedPdf(meiCtx, forms.signed)).toBeNull();
    asParent(meiCtx);
    const theirs = await renderPage(FormPage, { params: { id: forms.signed } });
    expect(theirs).toContain("Signed");
    expect(theirs).not.toContain("Ana Rivera");
    asParent(anaCtx);
    expect(await renderPage(FormsPage)).not.toContain("Leo Rivera");
    // Volunteering: the place to come is given up; the credit earned stays with the Rivera family.
    expect((await db.select().from(volunteerSignup)).filter((s) => s.cancelledAt === null).map((s) => s.familyId)).toEqual([rivera]);
    expect((await db.select().from(volunteerCredit)).map((c) => c.familyId)).toEqual([rivera]);
    // Money follows QuickBooks' tree: the Rivera family still sees Leo's invoice, the Chen family doesn't.
    expect(await invoicesOf(rivera)).toContain("9001");
    expect(await invoicesOf(chen)).not.toContain("9001");
    // The buy-out's void is queued, so the Chen family is never billed for the Rivera family's choice.
    expect((await db.select().from(writeQueue)).filter((i) => i.request.op === "invoice_void")).toHaveLength(1);
  }

  it("waiting to reach QuickBooks, then taken: both families' figures are read again, and the invoice follows the student", async () => {
    stub.rateLimitNext = 1;
    expect(await move(chen)).toMatchObject({ ok: true, status: "waiting" });
    await inBetween();
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - MIN) }).where(sql`${writeQueue.request}->>'op' = 'move'`);
    await runWriteQueue();
    expect((await items())[0]).toMatchObject({ state: "done" });
    // The cache took QuickBooks' answer: both families' rows are stale, so neither shows figures from before the move.
    for (const f of [rivera, chen]) expect((await db.select().from(familyMoney).where(eq(familyMoney.familyId, f)))[0]?.staleAt ?? "no row", String(f)).not.toBeNull();
    expect(await invoicesOf(chen)).toContain("9001");
    expect(await invoicesOf(rivera)).not.toContain("9001");
    expect(await followed()).toHaveLength(1);
  });

  it("kept refused into a family with no customer, then given up: the family left still sees the invoice throughout", async () => {
    const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
    expect(await move(okafor!.id)).toMatchObject({ ok: true, status: "attention" });
    expect(await studentsOf(okafor!.id)).toContain("Leo Rivera");
    expect(await studentsOf(rivera)).not.toContain("Leo Rivera");
    expect(await invoicesOf(rivera)).toContain("9001");
    const [kept] = await items();
    await giveUp(kept!.id, "Not making the family in QuickBooks.", op);
    expect(await invoicesOf(rivera)).toContain("9001");
    expect(await qboParentOfLeo()).toBe(RIVERA);
  });

  it("kept refused as stale (QuickBooks moved them meanwhile): nothing overwritten, and the portal's record stays in the family joined", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === LEO && (c.ParentRef as { value?: string } | undefined)?.value === RIVERA) { c.ParentRef = { value: "40" }; c.SyncToken = "1"; } };
    expect(await move(chen)).toMatchObject({ ok: true, status: "attention" });
    stub.beforeUpdate = null;
    expect(await studentsOf(chen)).toContain("Leo Rivera");
    expect(await qboParentOfLeo()).toBe("40");
    expect(await invoicesOf(chen)).not.toContain("9001");
  });
});

/** The parent the roster cache has Leo under. */
const qboParentOfLeo = async () => (await db.select({ p: qboCustomer.parentQboId }).from(qboCustomer).where(eq(qboCustomer.qboId, LEO)))[0]?.p ?? null;
