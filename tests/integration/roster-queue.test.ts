import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
// A switch to make the portal's side of a write fail after QuickBooks took it: reading QuickBooks' answer into a cache
// row (customerRow(), which applyWritten() calls first in its transaction) throws while it is on. The roster refresh
// reads its rows through its own reference, so a refresh still works.
const cacheFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/roster/refresh", async (original) => {
  const m = await original<typeof import("@/lib/roster/refresh")>();
  return { ...m, customerRow: (...args: Parameters<typeof m.customerRow>) => { if (cacheFails.on) throw new Error("deadlock detected"); return m.customerRow(...args); } };
});

// A switch to make a move's volunteer follow-up throw (after its forms follow-up has run), `times` times over.
const followFails = vi.hoisted(() => ({ times: 0 }));
vi.mock("@/lib/volunteer/moved-student", async (original) => {
  const m = await original<typeof import("@/lib/volunteer/moved-student")>();
  return { ...m, volunteerForMovedStudent: async (...args: Parameters<typeof m.volunteerForMovedStudent>) => {
    if (followFails.times > 0) { followFails.times--; throw new Error("a follow-up failed"); }
    return m.volunteerForMovedStudent(...args);
  } };
});

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, formWithdrawal, jobRun, qboCustomer, setting, student, writeQueue } from "@/lib/db/schema";
import { giveUp, loadOpenWrites, queueCounts, runWriteQueue, tryAgainNow, WRITE_QUEUE_JOB } from "@/lib/roster/queue";
import { applyWritten, askRosterWrite, REFRESH_ASK_KEY } from "@/lib/roster/writes";
import { clearRosterOfOtherCompany, ROSTER_JOB } from "@/lib/roster/source";
import { runDueJobs } from "@/lib/jobs/runner";
import { resetDb } from "../helpers/db";
import { requestByCustomer, seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason } from "../helpers/season";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0];
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const refreshes = async () => (await db.select().from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok")))).length;
const MIN = 60_000, HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const RENAME = { op: "rename" as const, role: "student" as const, qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" };

let op: ReturnType<typeof asOp>;
beforeEach(async () => {
  await resetDb(); stub.reset(); cacheFails.on = false; followFails.times = 0;
  await connectRoster(stub);
  stub.calls.length = 0;
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
});

describe("a write that QuickBooks didn't act on is sent again when its time comes", () => {
  it("is sent, the cache follows the answer, and the item is done, audited", async () => {
    const item = await seedQueued(RENAME, { sent: false, createdAt: ago(2 * MIN), familyQboId: "10" });
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    expect(posts().map((c) => JSON.parse(c.body))).toEqual([{ Id: "12", SyncToken: "0", sparse: true, DisplayName: "Leon Rivera" }]);
    expect(await cached("12")).toMatchObject({ displayName: "Leon Rivera", syncToken: "1" });
    expect(await queueItem(item.id)).toMatchObject({ state: "done", tries: 2, resultQboId: "12", nextTryAt: null });
    expect((await auditsOf("roster.write.done"))[0]).toMatchObject({ door: "system", targetId: item.id, after: { state: "done", how: "sent", tries: 2 } });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ door: "system", actorLabel: "worker", after: { name: "Leon Rivera", queueId: item.id } });
    expect(await refreshes()).toBe(1); // nothing it sent could have been made already: no roster read was needed
  });

  it("is not tried before its time", async () => {
    await seedQueued(RENAME, { nextTryAt: new Date(Date.now() + 5 * MIN) });
    expect(await runWriteQueue()).toEqual({ ran: false, ok: true });
    expect(posts()).toEqual([]);
  });

  it("backs off after another failure: 5 minutes after the second try, and goes on waiting", async () => {
    const item = await seedQueued(RENAME, { sent: false });
    stub.rateLimitNext = 1;
    await runWriteQueue();
    const after = (await queueItem(item.id))!;
    expect(after).toMatchObject({ state: "waiting", tries: 2, lastCode: "http_429", sent: false });
    expect(Math.round((after.nextTryAt!.getTime() - after.lastTriedAt.getTime()) / MIN)).toBe(5);
    expect((await auditsOf("roster.write.retry"))[0]!.after).toMatchObject({ state: "waiting", tries: 2, code: "http_429" });
    expect(await runWriteQueue(new Date(Date.now() + 4 * MIN))).toEqual({ ran: false, ok: true });
    expect(posts()).toHaveLength(1);
  });

  it("is stuck after its eighth try, or once it is a day old", async () => {
    const tired = await seedQueued(RENAME, { sent: false, tries: 7 });
    const old = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { sent: false, tries: 2, createdAt: ago(25 * HOUR) });
    stub.rateLimitNext = 2;
    await runWriteQueue();
    expect(await queueItem(tired.id)).toMatchObject({ state: "stuck", tries: 8, nextTryAt: null });
    expect(await queueItem(old.id)).toMatchObject({ state: "stuck", tries: 3 });
    expect(await auditsOf("roster.write.stuck")).toHaveLength(2);
    expect(await queueCounts()).toEqual({ waiting: 0, stuck: 2 });
  });

  it("is stuck when QuickBooks now refuses it outright, with nothing changed", async () => {
    const item = await seedQueued(RENAME, { sent: false });
    stub.updateFault = "6000";
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: "fault_6000" });
    expect(await cached("12")).toMatchObject({ displayName: "Leo Rivera" });
  });
});

describe("a write QuickBooks may already have made is never simply sent again (v1 spec §4)", () => {
  it("a rename that went through: a roster read since its last try finds it, and it is done without sending anything", async () => {
    inStub("12").DisplayName = "Leon Rivera"; inStub("12").SyncToken = "1"; // the lost answer's change, in QuickBooks
    const item = await seedQueued(RENAME, { sent: true, code: "timeout" });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await refreshes()).toBe(2);
    expect(await queueItem(item.id)).toMatchObject({ state: "done", resultQboId: "12" });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found" });
  });

  it("a create that went through: found by its name, family and type", async () => {
    const w = { op: "create" as const, role: "student" as const, name: "Rosa Rivera", typeQboId: "3", familyQboId: "10", email: null };
    stub.customers.push({ Id: "77", DisplayName: "Rosa Rivera", Active: true, SyncToken: "0", ParentRef: { value: "10" }, Job: true, CustomerTypeRef: { value: "3" } });
    const item = await seedQueued(w, { sent: true, code: "unreachable" });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "done", resultQboId: "77" });
  });

  it("an update whose record moved on since is stuck: nothing is overwritten", async () => {
    inStub("12").DisplayName = "Leo R. Rivera"; inStub("12").SyncToken = "2";   // someone else's change in QuickBooks
    const item = await seedQueued(RENAME, { sent: true, code: "http_500" });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(inStub("12").DisplayName).toBe("Leo R. Rivera");
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: "moved_on" });
  });

  it("one that didn't go through is sent again once a roster read shows it isn't there", async () => {
    const item = await seedQueued(RENAME, { sent: true, code: "timeout" });
    await runWriteQueue();
    expect(await refreshes()).toBe(2);
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
  });

  it("stays one that may have been made when a resend after it sends nothing: the next try looks again after a later roster read", async () => {
    const item = await seedQueued(RENAME, { sent: true, code: "timeout", createdAt: ago(10 * MIN), nextTryAt: ago(5 * MIN) });
    // The roster read shows it isn't there; the resend is throttled before QuickBooks acts on it.
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.rateLimitNext = 1; };
    await runWriteQueue();
    stub.onApiRequest = null;
    expect(posts()).toHaveLength(1);
    expect(inStub("12").DisplayName).toBe("Leo Rivera");
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", sent: true, lastCode: "http_429" });
    expect((await auditsOf("roster.write.retry"))[0]!.after).toMatchObject({ code: "http_429", sent: true });
    // Its next try reads the roster again first, as for any write that may have been made.
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) }).where(eq(writeQueue.id, item.id));
    const before = await refreshes();
    await runWriteQueue();
    expect(await refreshes()).toBe(before + 1);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
  });

  it("stays one that may have been made when QuickBooks refuses its resend outright", async () => {
    const item = await seedQueued(RENAME, { sent: true, code: "timeout" });
    stub.updateFault = "6000";
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", sent: true, lastCode: "fault_6000" });
  });

  it("waits for a roster read that works: while QuickBooks can't be read, nothing is sent", async () => {
    const item = await seedQueued(RENAME, { sent: true, code: "timeout" });
    stub.failQueryFrom = 1;
    expect(await runWriteQueue()).toEqual({ ran: true, ok: false });
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", tries: 1 });
  });

  it("records the time of the send itself, so a resend whose answer is lost again is looked for after a later roster read, never sent a third time", async () => {
    const item = await seedQueued(RENAME, { sent: true, code: "timeout", createdAt: ago(10 * MIN), nextTryAt: ago(5 * MIN) });
    // The wake started a second before its roster read; the resend goes through in QuickBooks and its answer is lost.
    stub.loseUpdateAnswer = true;
    await runWriteQueue(ago(1000));
    stub.loseUpdateAnswer = false;
    expect(posts()).toHaveLength(1);
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
    const waiting = (await queueItem(item.id))!;
    expect(waiting).toMatchObject({ state: "waiting", sent: true });
    expect(waiting.lastTriedAt.getTime()).toBeGreaterThan(Date.now() - 1000);
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) }).where(eq(writeQueue.id, item.id));
    await runWriteQueue();
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found" });
  });

  it("a move found made already runs its follow-ups once, and moves the student's record: the open form is reset under the new family", async () => {
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null });
    const requestId = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_leowaiting" });
    inStub("12").ParentRef = { value: "20" }; inStub("12").SyncToken = "1"; // the lost answer's move, in QuickBooks
    const item = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" }, { sent: true, code: "timeout" });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "20", state: "not_opened", envelopeId: null });
    expect((await db.select().from(formWithdrawal)).map((w) => w.envelopeId)).toEqual(["envelope_leowaiting"]);
    // The roster read the queue ran first followed nothing (stage 3's slice 9c): the queue's own follow-up did it all,
    // once, and the student's record is in the new family's, said on the item's done row.
    const followed = (await auditsOf("roster.student.move.followed")).map((r) => r.after as { cause: string; formsReset: number });
    expect(followed.map((f) => [f.cause.split("#")[0], f.formsReset])).toEqual([["roster.write.found", 1]]);
    expect(followed[0]).toMatchObject({ fromFamilyQboId: "10", toFamilyQboId: "20" });
    const [leo] = await db.select().from(student).where(eq(student.id, await recordOfCustomer("12", "student")));
    expect(leo).toMatchObject({ familyId: await recordOfCustomer("20", "family"), active: true });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found",
      appRecord: { kind: "student", studentId: String(leo!.id), set: { familyId: String(await recordOfCustomer("20", "family")) } } });
  });

  it("a change QuickBooks took whose cache update fails is audited, asks for a roster read, and is looked for after it, never simply sent again", async () => {
    const item = await seedQueued(RENAME, { sent: false });
    cacheFails.on = true;
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    cacheFails.on = false;
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", sent: true, lastCode: "cache_failed", tries: 2 });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ targetId: "12", after: { name: "Leon Rivera", queueId: item.id, refreshAsked: true, code: "cache_failed" } });
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) }).where(eq(writeQueue.id, item.id));
    await runWriteQueue();
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await cached("12")).toMatchObject({ displayName: "Leon Rivera" });
    // Found made, its record follows as a sent one's does: nothing else would bring it (stage 3's slice 9c).
    expect((await db.select().from(student).where(eq(student.id, await recordOfCustomer("12", "student"))))[0]).toMatchObject({ name: "Leon Rivera" });

    // The staff action says the change is made, and that the roster here will show it after its next read; the change
    // goes on the queue as one QuickBooks may have made, so the worker finishes it.
    cacheFails.on = true;
    const tag = await (await import("@/lib/seasons/roster-lock")).currentRosterTag();
    expect(await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Mei L. Chen" }, tag, op)).toEqual({ ok: true, message: expect.stringContaining("Done in QuickBooks. The roster here will show it") });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ targetId: "21", after: { code: "cache_failed" } });
    expect((await db.select().from(writeQueue).where(eq(writeQueue.targetQboId, "21")))[0]).toMatchObject({ state: "waiting", sent: true, lastCode: "cache_failed",
      familyId: await recordOfCustomer("20", "family"), studentId: null, askedBy: op.staffUserId });
  });

  it("a family staff made that the portal couldn't take in is queued as made, and the worker makes its record and link once a read shows it", async () => {
    cacheFails.on = true;
    const tag = await (await import("@/lib/seasons/roster-lock")).currentRosterTag();
    expect(await askRosterWrite({ op: "create", role: "family", name: "Okafor Family", familyQboId: null, email: null, typeQboId: null }, tag, op))
      .toEqual({ ok: true, message: expect.stringContaining("Done in QuickBooks") });
    cacheFails.on = false;
    const made = stub.customers.find((c) => c.DisplayName === "Okafor Family")!;
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, lastCode: "cache_failed", familyId: null, askedBy: op.staffUserId });
    expect((await auditsOf("roster.write.queued"))[0]).toMatchObject({ targetId: item!.id, after: { op: "create", role: "family", code: "cache_failed", sent: true } });
    // Nothing in the portal yet: the cache missed it, and no read makes a record.
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, made.Id as string))).toEqual([]);
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) });
    await runWriteQueue();
    expect(posts()).toHaveLength(1); // the create itself, never sent again
    expect(await queueItem(item!.id)).toMatchObject({ state: "done", resultQboId: made.Id });
    const [link] = await db.select().from(accountingLink).where(eq(accountingLink.customerId, made.Id as string));
    expect(link).toMatchObject({ origin: "created", linkedBy: op.staffUserId, realmId: REALM, studentId: null, guardianId: null });
    expect((await db.select().from(family).where(eq(family.id, link!.familyId!)))[0]).toMatchObject({ name: "Okafor Family", active: true });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found", appRecord: { kind: "family", familyId: String(link!.familyId), made: true, linkId: link!.id } });
  });

  it("a move staff made that the portal couldn't take in is queued as made, and the worker runs its follow-ups and moves the record once a read shows it", async () => {
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null });
    const requestId = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_leoheld" });
    cacheFails.on = true;
    const tag = await (await import("@/lib/seasons/roster-lock")).currentRosterTag();
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toMatchObject({ ok: true });
    cacheFails.on = false;
    // Nothing of the move's transaction was kept: no follow-up, and the record still in the Rivera family.
    expect(await auditsOf("roster.student.move.followed")).toEqual([]);
    expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "10", state: "waiting" });
    const leo = await recordOfCustomer("12", "student");
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ familyId: await recordOfCustomer("10", "family") });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, lastCode: "cache_failed", familyId: await recordOfCustomer("10", "family"), studentId: leo });
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) });
    await runWriteQueue();
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "20", state: "not_opened" });
    expect((await auditsOf("roster.student.move.followed")).map((r) => (r.after as { cause: string }).cause.split("#")[0])).toEqual(["roster.write.found"]);
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ familyId: await recordOfCustomer("20", "family") });
  });

  it("a move whose follow-up fails part way keeps nothing of the move's transaction, is held as made, and is followed once by the queue", async () => {
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null });
    const requestId = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_leopart" });
    const leo = await recordOfCustomer("12", "student");
    // The forms follow-up runs and resets the request, then the volunteer one throws: all of it is rolled back together.
    followFails.times = 1;
    const tag = await (await import("@/lib/seasons/roster-lock")).currentRosterTag();
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toEqual({ ok: true, message: expect.stringContaining("Done in QuickBooks") });
    expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "10", state: "waiting", envelopeId: "envelope_leopart" });
    expect(await db.select().from(formWithdrawal)).toEqual([]);
    expect(await auditsOf("roster.student.move.followed")).toEqual([]);
    expect(await auditsOf("forms.request.moved")).toEqual([]);
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ familyId: await recordOfCustomer("10", "family") });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, lastCode: "cache_failed", studentId: leo });
    // The queue finds the move made and follows it, once.
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) });
    await runWriteQueue();
    expect(posts()).toHaveLength(1); // the move itself, never sent again
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect((await auditsOf("roster.student.move.followed")).map((r) => (r.after as { cause: string; formsReset: number })))
      .toEqual([expect.objectContaining({ cause: "roster.write.found#12", formsReset: 1 })]);
    expect(await requestByCustomer(requestId)).toMatchObject({ familyQboId: "20", state: "not_opened" });
    expect((await db.select().from(formWithdrawal)).map((w) => w.envelopeId)).toEqual(["envelope_leopart"]);
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ familyId: await recordOfCustomer("20", "family") });
  });

  it("a change found made whose finishing keeps failing counts its tries, then is stuck: never left waiting for good", async () => {
    const leo = await recordOfCustomer("12", "student");
    inStub("12").ParentRef = { value: "20" }; inStub("12").SyncToken = "1"; // the lost answer's move, in QuickBooks
    const item = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" }, { sent: true, code: "timeout" });
    followFails.times = 1000;
    expect(await runWriteQueue()).toMatchObject({ ran: true });
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", sent: true, lastCode: "finish_failed", tries: 2 });
    expect((await auditsOf("roster.write.retry"))[0]!.after).toMatchObject({ code: "finish_failed", tries: 2 });
    // At the queue's last try it is stuck, for staff to look at on Reconciliation; nothing was sent at any try.
    await db.update(writeQueue).set({ tries: 7, nextTryAt: ago(MIN) }).where(eq(writeQueue.id, item.id));
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: "finish_failed", tries: 8 });
    expect(posts()).toEqual([]);
    expect((await db.select().from(student).where(eq(student.id, leo)))[0]).toMatchObject({ familyId: await recordOfCustomer("10", "family") });
    expect(await auditsOf("roster.student.move.followed")).toEqual([]);
  });

  it("a create QuickBooks answered with another customer is held with that customer, and is never sent again when the read doesn't show it as sent", async () => {
    const w = { op: "create" as const, role: "family" as const, name: "Okafor Family", typeQboId: "1", familyQboId: null, email: null };
    await applyWritten(w, { Id: "88", DisplayName: "Someone Else", SyncToken: "0" }, { realmId: REALM, actor: WORKER.actor, ip: null, linkedBy: op.staffUserId });
    const [item] = await db.select().from(writeQueue);
    expect(item).toMatchObject({ state: "waiting", sent: true, lastCode: "answer_other", resultQboId: "88", askedBy: op.staffUserId });
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "stuck", lastCode: "made_unmatched", sent: true });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "88"))).toEqual([]);
    // "Try again now" looks again, and still sends nothing.
    await tryAgainNow(item!.id, op);
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "stuck", lastCode: "made_unmatched" });
  });

  it("from the staff action to done: a lost answer is queued, then found by the worker", async () => {
    stub.loseUpdateAnswer = true;
    const tag = (await import("@/lib/seasons/roster-lock")).currentRosterTag();
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera" }, await tag, op)).toMatchObject({ queued: true });
    stub.loseUpdateAnswer = false;
    const [item] = await db.select().from(writeQueue);
    await db.update(writeQueue).set({ nextTryAt: new Date() });
    await runWriteQueue();
    expect(posts()).toHaveLength(1); // the first try only
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(await cached("12")).toMatchObject({ displayName: "Leon Rivera" });
  });
});

describe("staff try a change again, or give it up", () => {
  it("Try again now puts a stuck item back for the worker's next wake, audited; one more failure makes it stuck again", async () => {
    const item = await seedQueued(RENAME, { state: "stuck", tries: 8, nextTryAt: null });
    expect(await tryAgainNow(item.id, op)).toEqual({ ok: true, message: expect.stringContaining("within a minute") });
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", tries: 8 });
    expect((await auditsOf("roster.write.again"))[0]).toMatchObject({ door: "staff", actorLabel: "registrar@club.org", before: { state: "stuck" }, after: { state: "waiting" } });
    stub.rateLimitNext = 1;
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", tries: 9 });
    await tryAgainNow(item.id, op);
    await runWriteQueue();
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
  });

  it("Give up needs a note, is audited with it, and the item is never tried again", async () => {
    const item = await seedQueued(RENAME);
    expect(await giveUp(item.id, "  ", op)).toEqual({ ok: false, errors: [expect.stringContaining("Say why")] });
    expect(await giveUp(item.id, "Made it in QuickBooks myself.", op)).toMatchObject({ ok: true });
    expect(await queueItem(item.id)).toMatchObject({ state: "given_up", note: "Made it in QuickBooks myself." });
    expect((await auditsOf("roster.write.given_up"))[0]!.after).toEqual({ state: "given_up", note: "Made it in QuickBooks myself." });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await giveUp(item.id, "again", op)).toMatchObject({ ok: false });
    expect(await tryAgainNow(item.id, op)).toMatchObject({ ok: false });
    expect(await loadOpenWrites()).toEqual([]);
  });

  it("lists waiting and stuck items in words, for the club and for one family", async () => {
    await seedQueued(RENAME, { familyQboId: "10" });
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" }, { state: "stuck", familyQboId: "10" });
    await seedQueued({ op: "create", role: "family", name: "Patel Family", typeQboId: "1", familyQboId: null, email: null });
    const all = await loadOpenWrites();
    expect(all.map((i) => i.words).sort()).toEqual(["Make the family “Patel Family”", "Move the student Leo Rivera from Rivera Family to Chen Family", "Rename the student “Leo Rivera” to “Leon Rivera”"]);
    const rivera = await recordOfCustomer("10", "family"), chen = await recordOfCustomer("20", "family"), leo = await recordOfCustomer("12", "student");
    expect((await loadOpenWrites({ familyId: chen })).map((i) => i.write.op)).toEqual(["move"]);   // the family it moves to
    expect((await loadOpenWrites({ familyId: rivera })).map((i) => i.write.op).sort()).toEqual(["move", "rename"]);
    // Each is filed under the app's family record, which its link addresses; a new family is filed under none.
    expect(all.map((i) => [i.write.op, i.familyId]).sort()).toEqual([["create", null], ["move", rivera], ["rename", rivera]]);
    const filed = await db.select({ op: sql<string>`${writeQueue.request}->>'op'`, familyId: writeQueue.familyId, studentId: writeQueue.studentId }).from(writeQueue);
    expect(filed.sort((a, b) => (a.op < b.op ? -1 : 1))).toEqual([{ op: "create", familyId: null, studentId: null }, { op: "move", familyId: rivera, studentId: leo }, { op: "rename", familyId: rivera, studentId: leo }]);
  });

  it("finds a family's items by its record, its customer as target, or a move into it, as the page did by customer", async () => {
    const rivera = await recordOfCustomer("10", "family"), chen = await recordOfCustomer("20", "family");
    // One item of each arm for Chen Family (20): filed under its record, about the family itself but filed under none (as
    // migration 0034 leaves another company's, or an item queued before its record), and a move into it filed under Rivera.
    const filed = await seedQueued({ op: "rename", role: "parent", qboId: "21", syncToken: "0", name: "Mei Chen-Li", was: "Mei Chen" }, { familyQboId: "20" });
    const target = await seedQueued({ op: "rename", role: "family", qboId: "20", syncToken: "0", name: "Chen-Li Family", was: "Chen Family" }, { familyQboId: null });
    const moveIn = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" });
    expect((await queueItem(target.id))!.familyId).toBeNull();
    expect((await loadOpenWrites({ familyId: chen })).map((i) => i.id).sort()).toEqual([filed.id, target.id, moveIn.id].sort());
    // The family it moves from finds the move by its record; the links offered are each item's own family record.
    expect((await loadOpenWrites({ familyId: rivera })).map((i) => [i.id, i.familyId])).toEqual([[moveIn.id, rivera]]);
    expect((await loadOpenWrites({ familyId: chen })).map((i) => [i.write.op, i.familyId]).sort()).toEqual([["move", rivera], ["rename", null], ["rename", chen]]); // sorted as text: "rename," first
    // A family record with no link in the roster's company finds only what is filed under it: nothing here, and no error.
    const unlinked = await recordOfCustomer("NOT-ON-THE-ROSTER", "family");
    await db.delete(accountingLink).where(eq(accountingLink.familyId, unlinked));
    expect(await loadOpenWrites({ familyId: unlinked })).toEqual([]);
  });

  it("a flat club's member finds its item by its record", async () => {
    await seedQueued({ op: "deactivate", role: "member", qboId: "30", syncToken: "0" }, { familyQboId: "30" });
    const member = await recordOfCustomer("30", "family");
    expect((await loadOpenWrites({ familyId: member })).map((i) => [i.write.op, i.familyId])).toEqual([["deactivate", member]]);
  });
});

describe("the queue and the company", () => {
  it("an item is never sent to a company other than its own", async () => {
    await seedQueued(RENAME, { realmId: "2222" });
    expect(await runWriteQueue()).toEqual({ ran: false, ok: true });
    expect(posts()).toEqual([]);
  });

  it("a different company connected deletes every item, counted in the clear's audit row", async () => {
    await seedQueued(RENAME);
    await seedQueued(RENAME, { state: "done", finishedAt: new Date() });
    expect(await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: null, label: "admin@club.org" }, ip: null })).toBe(true);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect((await auditsOf("roster.cleared"))[0]!.after).toMatchObject({ reason: "different_company", realmId: "2222", writesDeleted: 2 });
    expect(REALM).not.toBe("2222");
  });
});

describe("the worker", () => {
  it("reads the roster again when a family was made inactive, and then forgets the ask", async () => {
    // Asked after the last read, and before the read this wake makes: times set apart on purpose, since a read that
    // starts in the ask's own millisecond doesn't answer it.
    await db.update(jobRun).set({ startedAt: ago(2 * MIN) }).where(eq(jobRun.job, ROSTER_JOB));
    await db.insert(setting).values({ key: REFRESH_ASK_KEY, value: { at: ago(MIN).toISOString() } });
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    expect(await refreshes()).toBe(2);
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toEqual([]);
    expect(await runWriteQueue()).toEqual({ ran: false, ok: true });
  });

  it("runs the queue at each wake, and says so only when it did something", async () => {
    await seedQueued(RENAME);
    const wake = await runDueJobs();
    expect(wake.ran).toContainEqual({ job: WRITE_QUEUE_JOB, ok: true });
    expect((await runDueJobs()).ran.map((r) => r.job)).not.toContain(WRITE_QUEUE_JOB);
  });
});
