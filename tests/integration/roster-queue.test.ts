import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
// A switch to make the cache's side of a write fail after QuickBooks took it: the reconcile throws while it is on.
const reconcileFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/parents/reconcile", async (original) => {
  const m = await original<typeof import("@/lib/parents/reconcile")>();
  return { ...m, reconcileAccess: async (...args: Parameters<typeof m.reconcileAccess>) => { if (reconcileFails.on) throw new Error("deadlock detected"); return m.reconcileAccess(...args); } };
});

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { formWithdrawal, jobRun, qboCustomer, setting, signatureRequest, writeQueue } from "@/lib/db/schema";
import { giveUp, loadOpenWrites, queueCounts, runWriteQueue, tryAgainNow, WRITE_QUEUE_JOB } from "@/lib/roster/queue";
import { askRosterWrite, REFRESH_ASK_KEY } from "@/lib/roster/writes";
import { clearRosterOfOtherCompany, ROSTER_JOB } from "@/lib/roster/source";
import { runDueJobs } from "@/lib/jobs/runner";
import { resetDb } from "../helpers/db";
import { seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason } from "../helpers/season";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, REALM, seedQueued, staffWith } from "../helpers/roster-writes";

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
  await resetDb(); stub.reset(); reconcileFails.on = false;
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

  it("a move found made already still runs its follow-ups: the student's open form is reset under the new family", async () => {
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: null });
    const requestId = await seedRequest({ requirementId, familyQboId: "10", subjectQboId: "12", state: "waiting", envelopeId: "envelope_leowaiting" });
    inStub("12").ParentRef = { value: "20" }; inStub("12").SyncToken = "1"; // the lost answer's move, in QuickBooks
    const item = await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" }, { sent: true, code: "timeout" });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect((await db.select().from(signatureRequest).where(eq(signatureRequest.id, requestId)))[0]).toMatchObject({ familyQboId: "20", state: "not_opened", envelopeId: null });
    expect((await db.select().from(formWithdrawal)).map((w) => w.envelopeId)).toEqual(["envelope_leowaiting"]);
    // The roster read the queue ran first found the move and followed it (src/lib/roster/refresh.ts); the queue's own
    // follow-up then found nothing left to reset.
    const followed = (await auditsOf("roster.student.move.followed")).map((r) => r.after as { cause: string; formsReset: number });
    expect(followed.map((f) => [f.cause.split("#")[0], f.formsReset])).toEqual([["roster.write.found", 0], ["roster.refresh", 1]]);
    expect(followed[1]).toMatchObject({ fromFamilyQboId: "10", toFamilyQboId: "20" });
  });

  it("a change QuickBooks took whose cache update fails is audited, asks for a roster read, and is looked for after it, never simply sent again", async () => {
    const item = await seedQueued(RENAME, { sent: false });
    reconcileFails.on = true;
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    reconcileFails.on = false;
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", sent: true, lastCode: "cache_failed", tries: 2 });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ targetId: "12", after: { name: "Leon Rivera", queueId: item.id, refreshAsked: true, code: "cache_failed" } });
    expect(await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY))).toHaveLength(1);
    await db.update(writeQueue).set({ nextTryAt: ago(MIN) }).where(eq(writeQueue.id, item.id));
    await runWriteQueue();
    expect(posts()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await cached("12")).toMatchObject({ displayName: "Leon Rivera" });

    // The staff action says the change is made, and that the roster here will show it after its next read.
    reconcileFails.on = true;
    const tag = await (await import("@/lib/seasons/roster-lock")).currentRosterTag();
    expect(await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Mei L. Chen" }, tag, op)).toEqual({ ok: true, message: expect.stringContaining("Done in QuickBooks. The roster here will show it") });
    expect((await auditsOf("roster.customer.rename"))[0]).toMatchObject({ targetId: "21", after: { code: "cache_failed" } });
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
    expect((await loadOpenWrites({ familyQboId: "20" })).map((i) => i.write.op)).toEqual(["move"]);   // the family it moves to
    expect((await loadOpenWrites({ familyQboId: "10" })).map((i) => i.write.op).sort()).toEqual(["move", "rename"]);
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
