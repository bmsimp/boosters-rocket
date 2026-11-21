import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { asParent, pageOutcome, renderPage } from "../helpers/signed-in";

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

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, formWithdrawal, jobRun, parent, qboCustomer, setting, signatureConsent, signedFormEvidence, student, volunteerCredit, volunteerSignup, writeQueue } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { applyWritten, moveStudent, REFRESH_ASK_KEY } from "@/lib/roster/writes";
import { runWriteQueue } from "@/lib/roster/queue";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { checkBuyoutInvoices } from "@/lib/buyouts/daily-check";
import { MONEY_JOB } from "@/lib/money/run-keys";
import FormsPage from "@/app/(parent)/forms/page";
import FormPage from "@/app/(parent)/forms/[id]/page";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import { findMySignedPdf } from "@/lib/forms/my-evidence";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { formSetting, requestByCustomer, seedConsent, seedEvidence, seedFormRequirement, seedRequest } from "../helpers/forms";
import { identityNow } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { seedCheckIn, seedEvent, seedSignup } from "../helpers/volunteer";
import { recordOfCustomer } from "../helpers/app-records";
import { seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";

/**
 * A move is followed only when staff make it in the portal (afterStudentMoved(), src/lib/roster/writes.ts): the
 * student's forms, volunteer places and buy-outs, once, in the transaction moveStudent() saves the move in (stage 3's
 * slice 9f), the guardians told after the commit; neither QuickBooks' answer nor the queue finding the move made runs
 * them again. Since stage 3's slice 9c a roster
 * refresh follows nothing: a student moved, renamed or made inactive in QuickBooks keeps their record, forms, places
 * and buy-outs where the app has them, and the daily buy-out check voids nothing for it (stage 4 shows such a change
 * as a difference).
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
afterEach(() => { vi.restoreAllMocks(); mail.atSend = null; });
vi.setConfig({ testTimeout: 60_000 });

const LEO = "12", RIVERA = "10", CHEN = "20";
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
/** Moves a customer to another parent in QuickBooks, as a change made there: a new version of the record. */
const moveInQuickBooks = (id: string, toQboId: string | null, o: { active?: boolean; name?: string } = {}) => {
  const c = inStub(id);
  if (toQboId === null) { delete c.ParentRef; delete c.Job; } else Object.assign(c, { ParentRef: { value: toQboId }, Job: true });
  if (o.active !== undefined) c.Active = o.active;
  if (o.name !== undefined) c.DisplayName = o.name;
  c.SyncToken = String(Number(c.SyncToken) + 1);
};
/**
 * A guardian in a family, seeded after the roster is read and the records imported from it (connectRoster()): the row
 * stands on the family's record and its own link to the parent's customer (seedGuardian()), and their session, made
 * after it (signedInNow()), names that record, which the gate lets them into while it is active.
 */
async function guardianAfterTheRead(o: { familyQboId: string; name: string; email: string; sourceQboId: string }) {
  const person = await seedParent({ name: o.name, email: o.email, welcomedAt: new Date() });
  await seedGuardian({ parentId: person.id, familyQboId: o.familyQboId, status: "active", isPrimary: true, sourceQboId: o.sourceQboId });
  return { authUserId: person.authUserId, familyQboId: o.familyQboId };
}
/** A session for a guardian, in the family record their row names. */
const signedInNow = async (g: { authUserId: string; familyQboId: string }) =>
  ({ session: await seedParentSession(g.authUserId, { familyQboId: g.familyQboId }) });
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0];
const followed = () => auditsOf("roster.student.move.followed");
/** Leo moved to the Chen family as a family's page moves him (stage 3's slice 9f): saved in the portal first, by the app's ids. */
const moveLeo = async (op: Parameters<typeof moveStudent>[3]) =>
  moveStudent(String(await recordOfCustomer(LEO, "student")), String(await recordOfCustomer(CHEN, "family")), await currentRosterTag(), op);
const signup = async (id: string) => (await db.select().from(volunteerSignup).where(eq(volunteerSignup.id, id)))[0]!;
const anaId = async () => (await db.select().from(parent).where(eq(parent.email, "ana@example.com")))[0]!.id;
/** Leo's own record as the app holds it. */
const leoRecord = async () => (await db.select().from(student).where(eq(student.id, await recordOfCustomer(LEO, "student"))))[0]!;
/**
 * Ana, the Rivera family's guardian, as the portal holds her: a roster read makes no sign-in from QuickBooks (stage 3's
 * slice 7a), so she is seeded after the read, in the Rivera family's record.
 */
const anaAfterTheRead = () => guardianAfterTheRead({ familyQboId: RIVERA, name: "Ana Rivera", email: "ana@example.com", sourceQboId: "11" });

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
/** Everything of Leo's a move would change, as it is now. */
const leosThings = async (leo: Awaited<ReturnType<typeof seedLeo>>) => ({
  record: await leoRecord(), open: await requestByCustomer(leo.open), signed: await requestByCustomer(leo.signed),
  consents: await db.select().from(signatureConsent), withdrawals: await db.select().from(formWithdrawal), signups: await db.select().from(volunteerSignup),
  credit: await db.select().from(volunteerCredit), buyouts: await db.select().from(buyout), queue: await db.select().from(writeQueue),
});

beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = []; mail.seen = [];
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
});

describe("a student moved, renamed or made inactive in QuickBooks, read by a refresh", () => {
  beforeEach(async () => { await connectRoster(stub); await anaAfterTheRead(); });

  const CHANGES: [string, { to: string; active?: boolean; name?: string }][] = [
    ["moved to another family", { to: CHEN }],
    ["moved and made inactive", { to: CHEN, active: false }],
    ["renamed", { to: RIVERA, name: "Leonardo Rivera" }],
    ["made inactive where they are", { to: RIVERA, active: false }],
    ["moved to a school", { to: "30" }],
  ];
  it.each(CHANGES)("%s: the cache takes it, and nothing of the student's changes in the app", async (_what, change) => {
    const leo = await seedLeo();
    const before = await leosThings(leo);
    moveInQuickBooks(LEO, change.to, change);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await cached(LEO)).toMatchObject({ parentQboId: change.to, ...(change.active === false ? { active: false } : {}), ...(change.name ? { displayName: change.name } : {}) });
    expect(await leosThings(leo)).toEqual(before);
    expect(before.record).toMatchObject({ name: "Leo Rivera", active: true, familyId: await recordOfCustomer(RIVERA, "family") });
    expect(await followed()).toEqual([]);
    expect(await auditsOf("forms.request.moved")).toEqual([]);
    expect(await auditsOf("volunteer.signup.moved")).toEqual([]);
    expect(mail.outbox).toEqual([]);
    expect(stub.apiCalls().filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a move staff made in the portal is followed once, by the move: the refresh after it changes nothing", async () => {
    const leo = await seedLeo();
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    // Each guardian is told only once the move is committed.
    mail.atSend = async () => (await leoRecord()).familyId === (await recordOfCustomer(CHEN, "family"));
    expect(await moveLeo(op)).toMatchObject({ ok: true });
    const leoId = String(await recordOfCustomer(LEO, "student"));
    expect(await followed()).toEqual([expect.objectContaining({ targetId: leoId, after: expect.objectContaining({ cause: `roster.record.moved#${leoId}`, formsMoved: 1, formsReset: 1, placesGivenUp: 1 }) })]);
    // The open form starts again under the new family, its document queued for withdrawal; the signed one moves with its evidence.
    expect(await requestByCustomer(leo.open)).toMatchObject({ familyQboId: CHEN, state: "not_opened", envelopeId: null, signers: [] });
    expect(await requestByCustomer(leo.signed)).toMatchObject({ familyQboId: CHEN, state: "complete" });
    expect((await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.id, leo.evidence.id)))[0]).toMatchObject({ familyId: await recordOfCustomer(CHEN, "family"), familyQboId: RIVERA, subjectQboId: LEO });
    // The place still to come is given up; the one done keeps its credit with the family it was earned for.
    expect((await signup(leo.coming.id)).cancelledAt).not.toBeNull();
    expect((await signup(leo.done.id)).cancelledAt).toBeNull();
    expect((await db.select().from(volunteerCredit).where(eq(volunteerCredit.id, leo.credit.id)))[0]).toMatchObject({ familyId: await recordOfCustomer(RIVERA, "family"), removedAt: null });
    expect(await leoRecord()).toMatchObject({ familyId: await recordOfCustomer(CHEN, "family"), active: true });
    expect(mail.outbox.map((m) => [m.to, m.subject])).toEqual([["ana@example.com", "Your place has been freed: Fall fair"]]);
    expect(mail.seen).toEqual([true]);

    const after = await leosThings(leo);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await leosThings(leo)).toEqual(after);
    expect(await followed()).toHaveLength(1);
    expect(mail.outbox).toHaveLength(1);
  });

  it("a move whose answer named another record changes nothing at once; the queue finishes it once a read shows it, and follows nothing", async () => {
    // A move is the portal's own change (stage 3's slice 9f): its record moved and its follow-ups ran when moveStudent()
    // saved it. QuickBooks' answer, taken now or found later, moves no record and follows nothing again.
    const leo = await seedLeo();
    const before = await leosThings(leo);
    moveInQuickBooks(LEO, CHEN);
    await applyWritten({ op: "move", role: "student", qboId: LEO, syncToken: "0", fromFamilyQboId: RIVERA, toFamilyQboId: CHEN },
      { Id: "13", DisplayName: "Someone Else", SyncToken: "1", ParentRef: { value: CHEN } },
      // Filed under the records the staff action's checks found, as every real send is.
      { realmId: REALM, actor: WORKER.actor, ip: null, linkedBy: null, filed: { familyId: await recordOfCustomer(RIVERA, "family"), studentId: await recordOfCustomer(LEO, "student") } });
    expect(await followed()).toEqual([]);
    expect((await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY)))).toHaveLength(1);
    expect(await requestByCustomer(leo.open)).toMatchObject({ familyQboId: RIVERA });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, lastCode: "answer_other", targetQboId: LEO });

    // A refresh alone follows nothing; the queue, after one, finds the move made and marks it done, following nothing.
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await followed()).toEqual([]);
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 60_000) });
    expect(await runWriteQueue()).toMatchObject({ ran: true, ok: true });
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(await followed()).toEqual([]);
    const now = await leosThings(leo);
    expect({ ...now, queue: [] }).toEqual({ ...before, queue: [] });
    expect(now.record).toMatchObject({ familyId: await recordOfCustomer(RIVERA, "family") });
    expect(mail.outbox).toEqual([]);
    expect(stub.apiCalls().filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a queued move QuickBooks made already: the queue marks it done once it finds it, and neither it nor the refresh before it follows anything", async () => {
    const leo = await seedLeo();
    const before = await leosThings(leo);
    moveInQuickBooks(LEO, CHEN);
    // Sent after the last read, its answer lost: the queue reads the roster again before it looks for it.
    const item = await seedQueued({ op: "move", role: "student", qboId: LEO, syncToken: "0", fromFamilyQboId: RIVERA, toFamilyQboId: CHEN }, { sent: true, lastTriedAt: new Date() });

    expect(await runWriteQueue()).toMatchObject({ ran: true, ok: true });
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await followed()).toEqual([]);
    const now = await leosThings(leo);
    expect({ ...now, queue: [] }).toEqual({ ...before, queue: [] });
    expect(await requestByCustomer(leo.open)).toMatchObject({ familyQboId: RIVERA, state: "waiting" });
    expect(await db.select().from(formWithdrawal)).toEqual([]);
    expect(mail.outbox).toEqual([]);
    expect(stub.apiCalls().filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("buy-outs of a student QuickBooks moved are voided by nothing; a move in the portal voids once", () => {
  beforeEach(async () => { await connectRoster(stub); await anaAfterTheRead(); });

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

  it("a QuickBooks move, the refresh and the daily check void nothing; a move in the portal then voids the unpaid one, once", async () => {
    const b = await leoBuyouts();
    moveInQuickBooks(LEO, CHEN);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    await moneyRun();
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true });
    // Nothing voided for it: flagged for staff, so Reconciliation lists it.
    expect(await state(b.invoiced.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
    expect(await voids()).toEqual([]);

    // Staff then move Leo in the portal: the move's one void, for the unpaid per-student one, and none for the paid one or the family's.
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    moveInQuickBooks(LEO, RIVERA); // back where the app holds him, so the portal's move is offered
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await moveLeo(op)).toMatchObject({ ok: true });
    expect(await voids()).toHaveLength(1);
    expect((await voids())[0]!.request).toMatchObject({ buyoutId: b.invoiced.id, why: "student_moved" });
    for (let i = 0; i < 2; i++) {
      expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
      await moneyRun();
      await checkBuyoutInvoices();
    }
    expect(await voids()).toHaveLength(1);
    expect(await state(b.invoiced.id)).toMatchObject({ state: "being_voided" });
    expect(await state(b.paid.id)).toMatchObject({ state: "paid" });
    expect(await state(b.family.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(stub.apiCalls().filter((c) => c.method === "POST" && c.path.includes("/invoice"))).toEqual([]);
  });
});

/** The Volunteer page's "Your sign-ups" box. */
const mine = (html: string) => html.slice(html.indexOf('id="mine-h"'), html.indexOf("</section>", html.indexOf('id="mine-h"')));

describe("what each family reads after a student QuickBooks moved", () => {
  it("the family the app holds the student in keeps their forms and places; the family QuickBooks moved them to sees none of them", async () => {
    const company = fznCompany();
    Object.assign(company.customers.find((c) => c.Id === "21")!, { PrimaryEmailAddr: { Address: "mei@example.com" } });
    await connectRoster(stub, { company });
    const anaRow = await guardianAfterTheRead({ familyQboId: RIVERA, name: "Ana Rivera", email: "ana@example.com", sourceQboId: "11" });
    const meiRow = await guardianAfterTheRead({ familyQboId: CHEN, name: "Mei Chen", email: "mei@example.com", sourceQboId: "21" });
    const ana = await signedInNow(anaRow);
    const mei = await signedInNow(meiRow);
    const leo = await seedLeo();

    moveInQuickBooks(LEO, CHEN);
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });

    asParent(await identityNow(ana.session.id));
    const forms = await renderPage(FormsPage);
    for (const s of ["Photo consent", "Medical release"]) expect(forms).toContain(s);
    expect(mine(await renderPage(VolunteerPage))).toContain("Fall fair");

    asParent(await identityNow(mei.session.id));
    expect(await pageOutcome(FormPage, { params: { id: leo.signed } })).toEqual({ notFound: true });
    expect(await renderPage(FormsPage)).not.toContain("Photo consent");
    expect(mine(await renderPage(VolunteerPage))).not.toContain("Leo Rivera");
  });

  it("after a move staff made: the new family reads the signed form as signed, never the old family's guardian or the PDF they signed; the old family sees neither", async () => {
    const company = fznCompany();
    Object.assign(company.customers.find((c) => c.Id === "21")!, { PrimaryEmailAddr: { Address: "mei@example.com" } });
    await connectRoster(stub, { company });
    const anaRow = await guardianAfterTheRead({ familyQboId: RIVERA, name: "Ana Rivera", email: "ana@example.com", sourceQboId: "11" });
    const meiRow = await guardianAfterTheRead({ familyQboId: CHEN, name: "Mei Chen", email: "mei@example.com", sourceQboId: "21" });
    const ana = await signedInNow(anaRow);
    const mei = await signedInNow(meiRow);
    const leo = await seedLeo();
    const op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(await moveLeo(op)).toMatchObject({ ok: true });

    const meiNow = await identityNow(mei.session.id);
    asParent(meiNow);
    const theirs = await renderPage(FormPage, { params: { id: leo.signed } });
    expect(theirs).toContain("Photo consent");
    expect(theirs).toContain("Signed");
    expect(theirs).not.toContain("Ana Rivera");
    expect(await renderPage(FormsPage)).not.toContain("Ana Rivera");
    expect(await findMySignedPdf({ ...meiNow, ip: null }, leo.signed)).toBeNull();

    const anaNow = await identityNow(ana.session.id);
    asParent(anaNow);
    for (const id of [leo.signed, leo.open]) expect(await pageOutcome(FormPage, { params: { id } })).toEqual({ notFound: true });
    for (const id of [leo.signed, leo.open]) expect(await findMySignedPdf({ ...anaNow, ip: null }, id)).toBeNull();
    expect(await renderPage(FormsPage)).not.toContain("Photo consent");
    expect(mine(await renderPage(VolunteerPage))).not.toContain("Leo Rivera");
  });
});
