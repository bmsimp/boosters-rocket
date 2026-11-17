import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
// Mail goes to an outbox. `atSend` runs as each message goes, on its own connection: it sees only what is committed.
type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], atSend: null as null | (() => Promise<unknown>), seen: [] as unknown[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password",
  buildSender: async () => async (m: Msg) => { if (mail.atSend) mail.seen.push(await mail.atSend()); mail.outbox.push(m); } }));

import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, buyout, formWithdrawal, jobRun, parent, qboCustomer, setting, signatureConsent, signedFormEvidence, volunteerCredit, volunteerSignup, writeQueue } from "@/lib/db/schema";
import * as volunteerMoved from "@/lib/volunteer/moved-student";
import { refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";
import { applyWritten, askRosterWrite, REFRESH_ASK_KEY } from "@/lib/roster/writes";
import { runWriteQueue } from "@/lib/roster/queue";
import { setRosterSource } from "@/lib/roster/source";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { checkBuyoutInvoices } from "@/lib/buyouts/daily-check";
import { MONEY_JOB } from "@/lib/money/run-keys";
import FormsPage from "@/app/(parent)/forms/page";
import FormPage from "@/app/(parent)/forms/[id]/page";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { formSetting, requestNow, seedConsent, seedEvidence, seedFormRequirement, seedRequest } from "../helpers/forms";
import { identityNow, seedParentIn } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { seedCheckIn, seedEvent, seedSignup } from "../helpers/volunteer";
import { seedBuyout, seedBuyoutRequirement, queueOf } from "../helpers/buyouts";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";

/**
 * A student moved to another family in QuickBooks, and read by a roster refresh, is followed up as a move staff make in
 * the portal is (afterStudentMoved(), src/lib/roster/writes.ts): their forms and volunteer places, in the refresh's own
 * savepoint, once; the guardians told after the commit. Buy-outs are the daily check's (src/lib/buyouts/daily-check.ts).
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
afterEach(() => { vi.restoreAllMocks(); mail.atSend = null; });
vi.setConfig({ testTimeout: 60_000 });

const LEO = "12", RIVERA = "10", CHEN = "20";
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
/** Moves a customer to another parent in QuickBooks, as a change made there: a new version of the record. */
const moveInQuickBooks = (id: string, toQboId: string | null, o: { active?: boolean } = {}) => {
  const c = inStub(id);
  if (toQboId === null) { delete c.ParentRef; delete c.Job; } else Object.assign(c, { ParentRef: { value: toQboId }, Job: true });
  if (o.active !== undefined) c.Active = o.active;
  c.SyncToken = String(Number(c.SyncToken) + 1);
};
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0];
const followed = () => auditsOf("roster.student.move.followed");
const lastRun = async () => (await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1))[0]!;
const signup = async (id: string) => (await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, id)))[0]!;
const anaId = async () => (await db.select().from(parent).where(eq(parent.email, "ana@example.com")))[0]!.id;

/** Leo, under the Rivera family, with an open form, a signed one with its evidence, a place still to come, and one done and checked in. */
async function seedLeo() {
  const ana = await anaId();
  const season = await seedSeason({ name: "Moving season", steps: [{ name: "Join" }] });
  const stepId = season.stepIds["Join"]!;
  const openReq = await seedFormRequirement({ stepId, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplmedical" }) });
  const signedReq = await seedFormRequirement({ stepId, title: "Photo consent", appliesTo: "student", form: formSetting({ id: "envelope_tmplphoto" }), position: 60 });
  const open = await seedRequest({ requirementId: openReq, familyQboId: RIVERA, subjectQboId: LEO, state: "waiting", envelopeId: "envelope_qbmovedopen",
    signers: [{ parentId: ana, recipientId: 1, name: "Ana Rivera", email: "ana@example.com", signedAt: null }] });
  await seedConsent(open, { parentId: ana, name: "Ana Rivera", email: "ana@example.com" });
  const signed = await seedRequest({ requirementId: signedReq, familyQboId: RIVERA, subjectQboId: LEO, state: "complete", envelopeId: "envelope_qbmovedsigned",
    signers: [{ parentId: ana, recipientId: 1, name: "Ana Rivera", email: "ana@example.com", signedAt: "2026-11-10T14:00:00.000Z" }] });
  const evidence = await seedEvidence(signed, { tag: "qbmoved" });
  const { shifts: [soon] } = await seedEvent({ name: "Fall fair", inDays: 20 });
  const { shifts: [past] } = await seedEvent({ name: "Summer fair", inDays: -20 });
  const coming = await seedSignup({ shiftId: soon!.id, familyQboId: RIVERA, signedUpBy: ana, student: { qboId: LEO, name: "Leo Rivera" } });
  const done = await seedSignup({ shiftId: past!.id, familyQboId: RIVERA, signedUpBy: ana, student: { qboId: LEO, name: "Leo Rivera" } });
  const credit = await seedCheckIn({ signupId: done.id, familyQboId: RIVERA, by: ana });
  return { ana, open, signed, evidence, coming, done, credit, openReq, signedReq };
}

beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = []; mail.seen = [];
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
});

describe("a student QuickBooks moved to another family, read by a refresh", () => {
  beforeEach(async () => { await connectRoster(stub); });

  it("is followed as a move made in the portal: the forms and the place still to come follow, the place done stays, once", async () => {
    const leo = await seedLeo();
    moveInQuickBooks(LEO, CHEN);
    // Each guardian is told only once the refresh is committed: at that moment its run is recorded as done.
    mail.atSend = async () => (await lastRun()).outcome;

    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    const run = await lastRun();
    expect(await cached(LEO)).toMatchObject({ parentQboId: CHEN });

    // The open form starts again under the new family, the old family's consent goes, and its document waits for the worker to withdraw it.
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: CHEN, state: "not_opened", envelopeId: null, signers: [] });
    expect(await db.select().from(signatureConsent).where(eq(signatureConsent.requestId, leo.open))).toEqual([]);
    expect(await db.select().from(formWithdrawal)).toEqual([expect.objectContaining({ envelopeId: "envelope_qbmovedopen", anySigned: false })]);
    // The signed form moves with its evidence: it still counts for Leo.
    expect(await requestNow(leo.signed)).toMatchObject({ familyQboId: CHEN, state: "complete", envelopeId: "envelope_qbmovedsigned" });
    expect((await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.id, leo.evidence.id)))[0]).toMatchObject({ requestId: leo.signed, familyQboId: CHEN });
    // The place still to come is given up; the one done keeps its credit with the family it was earned for.
    expect((await signup(leo.coming.id)).cancelledAt).not.toBeNull();
    expect((await signup(leo.done.id)).cancelledAt).toBeNull();
    expect((await db.select().from(volunteerCredit).where(eq(volunteerCredit.id, leo.credit.id)))[0]).toMatchObject({ familyQboId: RIVERA, removedAt: null });

    const [row] = await followed();
    expect(await followed()).toHaveLength(1);
    expect(row).toMatchObject({ door: "system", actorLabel: "roster", targetType: "qbo_customer", targetId: LEO,
      after: { fromFamilyQboId: RIVERA, toFamilyQboId: CHEN, cause: `roster.refresh#${run.id}`, formsMoved: 1, formsReset: 1, formsToWithdraw: 1, placesGivenUp: 1, buyouts: "daily_check" } });
    expect(await auditsOf("forms.request.moved")).toHaveLength(2);
    expect(await auditsOf("volunteer.signup.moved")).toEqual([expect.objectContaining({ targetId: LEO, after: expect.objectContaining({ cancelled: 1, guardiansTold: 1 }) })]);
    // Ana, who took the place, is told once, after the commit, about her own sign-up, and never where Leo went.
    expect(mail.outbox.map((m) => [m.to, m.subject])).toEqual([["ana@example.com", "Your place has been freed: Fall fair"]]);
    expect(mail.seen).toEqual(["ok"]);
    expect(mail.outbox[0]!.text).not.toContain("Chen");
    // The follow-ups send QuickBooks nothing.
    expect(stub.apiCalls().filter((c) => c.method !== "GET")).toEqual([]);

    // A later refresh that still sees Leo under the Chen family runs nothing.
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await followed()).toHaveLength(1);
    expect(await db.select().from(formWithdrawal)).toHaveLength(1);
    expect(await auditsOf("forms.request.moved")).toHaveLength(2);
    expect(mail.outbox).toHaveLength(1);
  });

  it("a student made inactive in QuickBooks is followed by nothing, moved or not", async () => {
    const leo = await seedLeo();
    moveInQuickBooks(LEO, CHEN, { active: false });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await cached(LEO)).toMatchObject({ parentQboId: CHEN, active: false });
    expect(await followed()).toEqual([]);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: RIVERA, state: "waiting" });
    expect((await signup(leo.coming.id)).cancelledAt).toBeNull();
    expect(mail.outbox).toEqual([]);
  });

  it("a student moved to something that isn't a family is followed by nothing: a school, a parent, no one", async () => {
    const leo = await seedLeo();
    for (const to of ["30", "21", null]) {
      moveInQuickBooks(LEO, to);
      expect(await refreshRoster(WORKER), String(to)).toMatchObject({ ok: true });
      expect((await cached(LEO))!.parentQboId).toBe(to);
    }
    expect(await followed()).toEqual([]);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: RIVERA, state: "waiting" });
    expect((await signup(leo.coming.id)).cancelledAt).toBeNull();
  });

  it("a move staff made in the portal is followed once, by the move: the refresh after it finds the student where the move put them", async () => {
    const leo = await seedLeo();
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await askRosterWrite({ op: "move", qboId: LEO, syncToken: "0", toFamilyQboId: CHEN }, await currentRosterTag(), op)).toMatchObject({ ok: true });
    expect(await followed()).toEqual([expect.objectContaining({ after: expect.objectContaining({ cause: `roster.student.move#${LEO}`, formsReset: 1, placesGivenUp: 1 }) })]);
    const told = mail.outbox.length;
    expect(told).toBe(1);

    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await followed()).toHaveLength(1);
    expect(await db.select().from(formWithdrawal)).toHaveLength(1);
    expect(await auditsOf("forms.request.moved")).toHaveLength(2);
    expect(await auditsOf("volunteer.signup.moved")).toHaveLength(1);
    expect(mail.outbox).toHaveLength(told);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: CHEN, state: "not_opened" });
  });

  // The gap the review of step 5 left: a move whose answer named another record asks for a refresh and runs nothing.
  it("a move whose answer named another record is followed by the refresh it asks for", async () => {
    const leo = await seedLeo();
    moveInQuickBooks(LEO, CHEN);
    await applyWritten({ op: "move", role: "student", qboId: LEO, syncToken: "0", fromFamilyQboId: RIVERA, toFamilyQboId: CHEN },
      { Id: "13", DisplayName: "Someone Else", SyncToken: "1", ParentRef: { value: CHEN } }, { realmId: REALM, actor: WORKER.actor, ip: null });
    expect(await followed()).toEqual([]);
    expect((await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY)))).toHaveLength(1);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: RIVERA });

    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await followed()).toEqual([expect.objectContaining({ targetId: LEO, after: expect.objectContaining({ cause: `roster.refresh#${(await lastRun()).id}`, formsReset: 1, formsMoved: 1, placesGivenUp: 1 }) })]);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: CHEN, state: "not_opened" });
  });

  it("a queued move QuickBooks made already: the refresh that finds it follows it, and marking it done takes nothing more from the families", async () => {
    const leo = await seedLeo();
    moveInQuickBooks(LEO, CHEN);
    // Sent after the last read, its answer lost: the queue reads the roster again before it looks for it.
    const item = await seedQueued({ op: "move", role: "student", qboId: LEO, syncToken: "0", fromFamilyQboId: RIVERA, toFamilyQboId: CHEN }, { sent: true, lastTriedAt: new Date() });

    expect(await runWriteQueue()).toMatchObject({ ran: true, ok: true });
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: CHEN, state: "not_opened" });
    // The refresh followed the move; the queue's own look at it found nothing left to move, cancel or tell.
    const rows = await followed();
    expect(rows.map((r) => (r.after as { cause: string }).cause).sort()).toEqual([`roster.refresh#${(await lastRun()).id}`, `roster.write.found#${LEO}`].sort());
    expect(rows.find((r) => (r.after as { cause: string }).cause.startsWith("roster.write.found"))!.after).toMatchObject({ formsMoved: 0, formsReset: 0, placesGivenUp: 0 });
    expect(await db.select().from(formWithdrawal)).toHaveLength(1);
    expect(await auditsOf("forms.request.moved")).toHaveLength(2);
    expect(mail.outbox).toHaveLength(1);
    expect(stub.apiCalls().filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a follow-up that fails leaves the old roster and everything of the student as it was, and records the run as failed; the next refresh follows the move", async () => {
    const leo = await seedLeo();
    const before = { customers: await db.select().from(qboCustomer), signups: await db.select().from(volunteerSignup), audits: (await db.select().from(auditLog)).length };
    moveInQuickBooks(LEO, CHEN);
    // The forms are moved first; the volunteer places then fail, so the forms' changes must be undone with the rest.
    vi.spyOn(volunteerMoved, "volunteerForMovedStudent").mockRejectedValueOnce(new Error("boom: ana@example.com"));

    expect(await refreshRoster(WORKER)).toEqual({ ok: false, reason: "failed",
      error: "The forms and volunteer places of a student who moved to another family couldn't be brought up to date, so the roster was left as it was. (follow_up_failed)" });
    expect(await db.select().from(qboCustomer)).toEqual(before.customers);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: RIVERA, state: "waiting", envelopeId: "envelope_qbmovedopen" });
    expect(await requestNow(leo.signed)).toMatchObject({ familyQboId: RIVERA });
    expect(await db.select().from(formWithdrawal)).toEqual([]);
    expect(await db.select().from(signatureConsent).where(eq(signatureConsent.requestId, leo.open))).toHaveLength(1);
    expect(await db.select().from(volunteerSignup)).toEqual(before.signups);
    expect(await lastRun()).toMatchObject({ outcome: "failed" });
    const after = await db.select().from(auditLog).orderBy(asc(auditLog.id));
    expect(after.slice(before.audits).map((r) => [r.action, r.after])).toEqual([["roster.refresh.failed", { code: "follow_up_failed" }]]);
    expect(JSON.stringify(after)).not.toContain("boom");
    expect(mail.outbox).toEqual([]);

    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await followed()).toHaveLength(1);
    expect(await requestNow(leo.open)).toMatchObject({ familyQboId: CHEN, state: "not_opened" });
    expect((await signup(leo.coming.id)).cancelledAt).not.toBeNull();
    expect(mail.outbox).toHaveLength(1);
  });

  it("a club that moves dozens of students at once in QuickBooks: the refresh finishes, each move followed once", async () => {
    const ana = await anaId();
    const season = await seedSeason({ name: "Reorganized", steps: [{ name: "Join" }] });
    const req = await seedFormRequirement({ stepId: season.stepIds["Join"]!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplmedical" }) });
    const { shifts: [shift] } = await seedEvent({ name: "Big fair", inDays: 10, shifts: [{ places: 100 }] });
    const ids = Array.from({ length: 48 }, (_, i) => String(1000 + i));
    for (const id of ids) {
      stub.customers.push({ Id: id, DisplayName: `Student ${id}`, Active: true, SyncToken: "0", CustomerTypeRef: { value: "3" }, ParentRef: { value: RIVERA }, Job: true });
    }
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    for (const id of ids) {
      await seedRequest({ requirementId: req, familyQboId: RIVERA, subjectQboId: id, state: "waiting", envelopeId: `envelope_many${id}` });
      await seedSignup({ shiftId: shift!.id, familyQboId: RIVERA, signedUpBy: ana, student: { qboId: id, name: `Student ${id}` } });
    }
    for (const id of ids) moveInQuickBooks(id, CHEN);

    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    const rows = await followed();
    expect(rows).toHaveLength(48);
    expect(new Set(rows.map((r) => r.targetId))).toEqual(new Set(ids));
    expect(rows.every((r) => (r.after as { formsReset: number; placesGivenUp: number }).formsReset === 1 && (r.after as { placesGivenUp: number }).placesGivenUp === 1)).toBe(true);
    expect(await db.select().from(formWithdrawal)).toHaveLength(48);
    expect((await db.select().from(volunteerSignup)).every((s) => s.cancelledAt !== null)).toBe(true);
    expect(mail.outbox).toHaveLength(48);

    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await followed()).toHaveLength(48);
  });
});

describe("not followed when the cache a refresh replaces isn't this company's", () => {
  it("the first read of a company follows nothing, wherever its students are", async () => {
    // A request left from before, under the Rivera family, for a student QuickBooks has under the Chen family.
    const season = await seedSeason({ name: "Before", steps: [{ name: "Join" }] });
    const req = await seedFormRequirement({ stepId: season.stepIds["Join"]!, title: "Medical release", appliesTo: "student", form: formSetting({ id: "envelope_tmplmedical" }) });
    const open = await seedRequest({ requirementId: req, familyQboId: RIVERA, subjectQboId: LEO, state: "waiting" });
    const company = fznCompany();
    Object.assign(company.customers.find((c) => c.Id === LEO)!, { ParentRef: { value: CHEN } });
    await connectRoster(stub, { company });
    expect(await followed()).toEqual([]);
    expect(await requestNow(open)).toMatchObject({ familyQboId: RIVERA, state: "waiting" });
  });

  it("a refresh that clears another company's cache follows nothing", async () => {
    await connectRoster(stub);
    await seedLeo();
    // The cache says it came from another company: this refresh clears it, with its forms and places, and follows no move.
    await db.transaction((tx) => setRosterSource(tx, "9130000000000999"));
    moveInQuickBooks(LEO, CHEN);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await auditsOf("roster.cleared")).toHaveLength(1);
    expect(await followed()).toEqual([]);
    expect(await auditsOf("forms.request.moved")).toEqual([]);
    expect(await auditsOf("volunteer.signup.moved")).toEqual([]);
    expect(mail.outbox).toEqual([]);
  });
});

describe("buy-outs of a student QuickBooks moved are the daily check's, and never voided twice", () => {
  beforeEach(async () => { await connectRoster(stub); });

  /** A money run that read every family, as the daily check follows it. */
  const moneyRun = () => db.insert(jobRun).values({ job: MONEY_JOB, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), outcome: "ok", startedBy: "worker" });
  const voids = async () => (await db.select().from(writeQueue)).filter((i) => i.request.op === "invoice_void");
  const state = async (id: string) => (await db.select().from(buyout).where(eq(buyout.id, id)))[0]!;
  async function leoBuyouts() {
    const ana = await anaId();
    const perStudent = await seedBuyoutRequirement({ title: "Moved shifts", appliesTo: "student" });
    const paidReq = await seedBuyoutRequirement({ title: "Paid shifts", appliesTo: "student" });
    const familyReq = await seedBuyoutRequirement({ title: "Family shifts" });
    return {
      invoiced: await seedBuyout({ requirementId: perStudent, familyQboId: RIVERA, subjectQboId: LEO, chosenBy: ana, invoiceQboId: "9905", realmId: REALM }),
      paid: await seedBuyout({ requirementId: paidReq, familyQboId: RIVERA, subjectQboId: LEO, chosenBy: ana, state: "paid", invoiceQboId: "9906", realmId: REALM }),
      family: await seedBuyout({ requirementId: familyReq, familyQboId: RIVERA, chosenBy: ana, invoiceQboId: "9907", realmId: REALM }),
    };
  }

  it("a QuickBooks move, then the daily check, then a move in the portal: one void for the unpaid one, none for the paid one or the family's", async () => {
    const b = await leoBuyouts();
    moveInQuickBooks(LEO, CHEN);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    // The refresh voids nothing itself.
    expect(await state(b.invoiced.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(await voids()).toEqual([]);

    await moneyRun();
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, voiding: 1 });
    expect(await state(b.invoiced.id)).toMatchObject({ state: "being_voided" });
    expect((await queueOf(b.invoiced.id)).map((i) => i.request)).toEqual([expect.objectContaining({ op: "invoice_void", invoiceQboId: "9905", why: "student_moved" })]);

    // Staff then move Leo back in the portal: the buy-out was the Rivera family's, already being voided, and nothing more is queued.
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const tag = await currentRosterTag();
    expect(await askRosterWrite({ op: "move", qboId: LEO, syncToken: inStub(LEO).SyncToken as string, toFamilyQboId: RIVERA }, tag, op)).toMatchObject({ ok: true });
    await moneyRun();
    await checkBuyoutInvoices();
    expect(await voids()).toHaveLength(1);
    expect(await state(b.paid.id)).toMatchObject({ state: "paid" });
    expect(await state(b.family.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(stub.apiCalls().filter((c) => c.method === "POST" && c.path.includes("/invoice"))).toEqual([]);
  });

  it("a move in the portal, then a refresh, then the daily check: the move's one void, and no other", async () => {
    const b = await leoBuyouts();
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const tag = await currentRosterTag();
    expect(await askRosterWrite({ op: "move", qboId: LEO, syncToken: "0", toFamilyQboId: CHEN }, tag, op)).toMatchObject({ ok: true });
    expect(await voids()).toHaveLength(1);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    await moneyRun();
    await checkBuyoutInvoices();
    expect(await voids()).toHaveLength(1);
    expect(await state(b.invoiced.id)).toMatchObject({ state: "being_voided" });
    expect(await state(b.paid.id)).toMatchObject({ state: "paid" });
  });

  it("a paid one is never voided, however many refreshes and checks follow", async () => {
    const b = await leoBuyouts();
    moveInQuickBooks(LEO, CHEN);
    for (let i = 0; i < 2; i++) {
      expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
      await moneyRun();
      await checkBuyoutInvoices();
    }
    expect(await voids()).toHaveLength(1);
    expect((await voids())[0]!.request).toMatchObject({ buyoutId: b.invoiced.id });
    expect(await state(b.paid.id)).toMatchObject({ state: "paid" });
  });
});

/** The Volunteer page's "Your sign-ups" box. */
const mine = (html: string) => html.slice(html.indexOf('id="mine-h"'), html.indexOf("</section>", html.indexOf('id="mine-h"')));

describe("what each family reads after a student QuickBooks moved", () => {
  it("the new family sees the signed form as signed, never the old family's guardian; the old family no longer sees the student's forms or places", async () => {
    // Both families' guardians sign in, matched to their own records in QuickBooks.
    const company = fznCompany();
    Object.assign(company.customers.find((c) => c.Id === "21")!, { PrimaryEmailAddr: { Address: "mei@example.com" } });
    const ana = await seedParentIn({ familyQboId: RIVERA, name: "Ana Rivera", email: "ana@example.com", sourceQboId: "11" });
    const mei = await seedParentIn({ familyQboId: CHEN, name: "Mei Chen", email: "mei@example.com", sourceQboId: "21" });
    await connectRoster(stub, { company });
    const leo = await seedLeo();

    asParent(await identityNow(ana.session.id));
    const beforeMove = await renderPage(FormsPage);
    expect(beforeMove).toContain("Photo consent");
    const mineBefore = mine(await renderPage(VolunteerPage));
    expect(mineBefore).toContain("Fall fair");
    expect(mineBefore).toContain("Leo Rivera");

    moveInQuickBooks(LEO, CHEN);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });

    asParent(await identityNow(mei.session.id));
    const theirs = await renderPage(FormPage, { params: { id: leo.signed } });
    expect(theirs).toContain("Photo consent");
    expect(theirs).toContain("Signed");
    expect(theirs).not.toContain("Ana Rivera");
    expect(await renderPage(FormsPage)).not.toContain("Ana Rivera");

    asParent(await identityNow(ana.session.id));
    const forms = await renderPage(FormsPage);
    for (const s of ["Photo consent", "Medical release", "Leo Rivera"]) expect(forms).not.toContain(s);
    // Leo's place still to come is gone from the family's sign-ups and from the shift's count; the check-in he earned
    // for them stays in what they have done, as credit stays with the family it was earned for.
    const volunteer = await renderPage(VolunteerPage);
    expect(mine(volunteer)).not.toContain("Fall fair");
    expect(mine(volunteer)).not.toContain("Leo Rivera");
    expect(volunteer).toContain("0 of 4 places filled");
  });
});
