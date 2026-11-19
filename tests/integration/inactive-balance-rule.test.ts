import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, student, writeQueue } from "@/lib/db/schema";
import { askFamilyInactive, CREDIT_BALANCE, deactivateLinked, FAMILY_BEING_CHANGED, renameLinked, SENDING_LOCK, STALE_TWICE, STUDENT_BEING_CHANGED, WRITE_COPY } from "@/lib/roster/writes";
import { runWriteQueue } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import type { AppStudentId } from "@/lib/families/ids";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Stage 3's slice 9g: making a linked student or member inactive stays QuickBooks first, by the record (deactivateLinked(),
 * no version and no QuickBooks id from the page), under one balance rule: any balance, owed or a credit, and a balance
 * that can't be read, stop it before anything is sent, at a press and at the worker's try. It carries the link's own
 * version, and a stale answer is settled by the Active flag. `bodies()` proves every write sent, and that none was sent
 * with a balance standing.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const studentLink = async (customer: string) => (await db.select().from(accountingLink).where(and(eq(accountingLink.customerId, customer), isNotNull(accountingLink.studentId))))[0]!;
const studentRow = async (id: AppStudentId) => (await db.select().from(student).where(eq(student.id, id)))[0]!;
const items = () => db.select().from(writeQueue);
const later = () => new Date(Date.now() + 2 * MIN);
/** An open invoice (a positive amount) or a credit (a negative one) on a customer: the customer's own Balance as the stub reads it. */
const balance = (Id: string, customer: string, amount: number) => ({ Id, SyncToken: "0", CustomerRef: { value: customer }, TotalAmt: amount, Balance: amount });
/** Holds one of the advisory locks a send holds, for as long as `run` takes, on another connection. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

let tag: string;
let op: ReturnType<typeof asOp>;
let leo: AppStudentId;
const offLeo = (o = op) => deactivateLinked({ kind: "student", recordId: String(leo) }, tag, o);
beforeEach(async () => {
  await resetDb(); stub.reset();
  // A customer read by id carries its own Balance, as QuickBooks' does: the portal reads it before making anyone inactive.
  stub.quirks.balances = true;
  tag = await connectRoster(stub);
  stub.calls.length = 0;
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
  leo = await recordOfCustomer("12", "student");
});

describe("a linked student made inactive by the record, with the link's own version", () => {
  it("is sent with the link's version, made inactive from QuickBooks' answer, and the link takes the answer's", async () => {
    expect((await studentLink("12")).syncedToken).toBe("0");
    expect(await offLeo()).toEqual({ ok: true, message: "Made inactive in QuickBooks." });
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, Active: false }]);
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect((await studentLink("12")).syncedToken).toBe("1");
    expect((await auditsOf("roster.customer.deactivate"))[0]!.after).toMatchObject({ appRecord: { kind: "student", studentId: String(leo), set: { active: false } }, linkVersion: "1" });
    expect(await items()).toEqual([]);
  });

  it("a link with no version is sent with the one the balance read just showed, and aligned by the answer", async () => {
    await db.update(accountingLink).set({ syncedToken: null, syncedAt: null }).where(and(eq(accountingLink.customerId, "12"), isNotNull(accountingLink.studentId)));
    inStub("12").SyncToken = "6";
    expect(await offLeo()).toMatchObject({ ok: true });
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "6", sparse: true, Active: false }]);
    expect((await studentLink("12")).syncedToken).toBe("7");
  });

  it("stale, then the live read shows them still active with no balance: sent once more with the version just read, and the link aligned", async () => {
    inStub("12").SyncToken = "3"; // changed in QuickBooks since the portal last aligned with it
    expect(await offLeo()).toEqual({ ok: true, message: "Made inactive in QuickBooks." });
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "3"]);
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect((await studentLink("12")).syncedToken).toBe("4");
    expect((await auditsOf("roster.customer.deactivate"))[0]!.after).toMatchObject({ resent: "stale" });
  });

  it("stale, then the live read shows them inactive there: found made, nothing more sent, the record follows and the link is left", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12") { c.Active = false; c.SyncToken = "2"; } }; // made inactive in QuickBooks at that moment
    expect(await offLeo()).toEqual({ ok: true, message: WRITE_COPY.inactiveMeanwhile }); // a request went, so never "nothing was sent"
    expect(bodies()).toHaveLength(1);
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect((await studentLink("12")).syncedToken).toBe("0");
    expect((await auditsOf("roster.record.follows"))[0]!.after).toMatchObject({ op: "deactivate", code: "already_inactive" });
  });

  it("stale twice: refused in words, nothing queued, nothing changed", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12") c.SyncToken = String(Number(c.SyncToken) + 1); };
    expect(await offLeo()).toEqual({ ok: false, errors: [STALE_TWICE] });
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "1"]);
    expect(await studentRow(leo)).toMatchObject({ active: true });
    expect(await items()).toEqual([]);
    expect((await auditsOf("roster.write.refused"))[0]!.after).toMatchObject({ op: "deactivate", code: "fault_5010" });
  });

  it("a balance that appears with the stale answer: the read after it stops it, and it is never sent again", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12" && c.SyncToken === "0") { c.SyncToken = "1"; stub.invoices = [balance("901", "12", -5)]; } };
    expect(await offLeo()).toEqual({ ok: false, errors: [`Leo Rivera has a credit in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(bodies()).toHaveLength(1);
    expect(await items()).toEqual([]);
  });

  it("a lost answer is queued as maybe sent, filed under the record, and found after a roster read without being sent again", async () => {
    stub.loseUpdateAnswer = true;
    expect(await offLeo()).toEqual({ ok: true, queued: true, message: WRITE_COPY.queued });
    stub.loseUpdateAnswer = false;
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: true, targetQboId: "12", studentId: leo, familyId: await recordOfCustomer("10", "family"),
      request: { op: "deactivate", role: "student", qboId: "12", syncToken: "0" } });
    expect(await studentRow(leo)).toMatchObject({ active: true }); // never guessed
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(posts()).toEqual([]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(await studentRow(leo)).toMatchObject({ active: false });
  });

  it("a live read that shows no version: nothing sent, and the words say the answer couldn't be read, not what is owed", async () => {
    await db.update(accountingLink).set({ syncedToken: null, syncedAt: null }).where(and(eq(accountingLink.customerId, "12"), isNotNull(accountingLink.studentId)));
    delete inStub("12").SyncToken;
    expect(await offLeo()).toEqual({ ok: false, errors: ["QuickBooks' answer about Leo Rivera couldn't be read (it didn't say which version it holds), so nothing was changed. Try again in a few minutes."] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("an unlinked student, or a student with a move QuickBooks refused that the portal kept, is refused with nothing read or sent", async () => {
    const [nia] = await db.insert(student).values({ familyId: await recordOfCustomer("10", "family"), name: "Nia Rivera", active: true }).returning({ id: student.id });
    expect(await deactivateLinked({ kind: "student", recordId: String(nia!.id) }, tag, op))
      .toEqual({ ok: false, errors: [expect.stringMatching(/^That isn't linked to QuickBooks, so it is made inactive in the portal only/)] });
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20" }, { state: "refused", code: "fault_6000" });
    expect(await offLeo()).toEqual({ ok: false, errors: [expect.stringMatching(/^A move of this student hasn't reached QuickBooks yet/)] });
    expect(stub.apiCalls()).toEqual([]);
    expect(await studentRow(leo)).toMatchObject({ active: true });
  });

  it("the family action refuses a family with no link: that is made inactive in the portal only", async () => {
    const [okafor] = await db.insert(family).values({ name: "Okafor Family", active: true }).returning({ id: family.id });
    expect(await askFamilyInactive(String(okafor!.id), "not-a-stamp", tag, op))
      .toEqual({ changed: false, result: { ok: false, errors: [expect.stringMatching(/^That isn't linked to QuickBooks, so it is made inactive in the portal only/)] } });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("a member (flat books) the same way, by their own family record", async () => {
    await resetDb(); stub.reset(); stub.quirks.balances = true;
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["2", "3"] } });
    op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const ana = await recordOfCustomer("11", "family");
    stub.invoices = [balance("902", "11", -12)];
    stub.calls.length = 0;
    expect(await deactivateLinked({ kind: "family", recordId: String(ana) }, tag, { ...op, showAmounts: true }))
      .toEqual({ ok: false, errors: [`Ana Rivera has a credit of $12.00 in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
    stub.invoices = [];
    expect(await deactivateLinked({ kind: "family", recordId: String(ana) }, tag, op)).toMatchObject({ ok: true });
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, Active: false }]);
    expect((await db.select().from(family).where(eq(family.id, ana)))[0]).toMatchObject({ active: false });
  });
});

describe("one sender at a time: a record being sent is never made inactive meanwhile", () => {
  it("two staff pressing at once, or a press while the record's lock is held: nothing is read or sent", async () => {
    expect(await holding(SENDING_LOCK, String(leo), () => offLeo())).toEqual({ ok: false, errors: [STUDENT_BEING_CHANGED] });
    const rivera = await recordOfCustomer("10", "family");
    expect(await holding(SENDING_LOCK, String(rivera), () => deactivateLinked({ kind: "family", recordId: String(rivera) }, tag, op)))
      .toEqual({ ok: false, errors: [FAMILY_BEING_CHANGED] });
    expect(stub.apiCalls()).toEqual([]);
    const other = asOp(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const [a, b] = await Promise.all([offLeo(), offLeo(other)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(bodies()).toHaveLength(1);
  });

  it("a make-inactive racing a rename of the same record: the one that holds the record's lock goes, the other is refused", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let rename: Promise<unknown> | null = null;
    // While the make-inactive's balance read is with QuickBooks, a rename of Leo is asked for.
    stub.onApiRequest = async (c) => {
      if (c.method !== "GET" || rename) return;
      rename = renameLinked({ kind: "student", recordId: String(leo), name: "Leon Rivera" }, tag, op);
      await rename; release();
    };
    const off = offLeo();
    await held;
    expect(await rename).toEqual({ ok: false, errors: [STUDENT_BEING_CHANGED] });
    expect(await off).toMatchObject({ ok: true });
    expect(await studentRow(leo)).toMatchObject({ active: false, name: "Leo Rivera" });
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, Active: false }]);
  });

  it("the worker leaves a make-inactive filed under the student while their lock is held: nothing sent, no try counted", async () => {
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    await holding(SENDING_LOCK, String(leo), () => runWriteQueue(later()));
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", tries: 1 });
    expect(stub.apiCalls().filter((c) => c.path.includes("/customer"))).toEqual([]);
  });
});

describe("the worker reads the balance again before it sends a waiting make-inactive", () => {
  it("a balance that appears between a press's queued send and the worker's try: stuck, never sent", async () => {
    // The press's send is turned away unread (429): queued, never sent.
    stub.onApiRequest = (c) => { if (c.method === "POST") { stub.rateLimitNext = 1; stub.onApiRequest = null; } };
    expect(await offLeo()).toMatchObject({ ok: true, queued: true });
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, lastCode: "http_429" });
    stub.invoices = [balance("903", "12", 40)];
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(await queueItem(item!.id)).toMatchObject({ state: "stuck", lastCode: "open_balance", sent: false });
    expect(posts()).toEqual([]);
    // A credit the same way, with its own code.
    const credit = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: "20" });
    stub.invoices = [balance("904", "21", -7)];
    await runWriteQueue(later());
    expect(await queueItem(credit.id)).toMatchObject({ state: "stuck", lastCode: CREDIT_BALANCE });
    expect(posts()).toEqual([]);
  });

  it("a balance that can't be read: one that may be read later waits for its next try, one that won't makes it stuck", async () => {
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    stub.dropApi = true;
    await runWriteQueue(later());
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", tries: 2, lastCode: "unreachable", sent: false });
    stub.dropApi = false;
    stub.customers = stub.customers.filter((c) => c.Id !== "21"); // QuickBooks no longer answers for Mei: a refusal
    const gone = await seedQueued({ op: "deactivate", role: "parent", qboId: "21", syncToken: "0" }, { familyQboId: "20" });
    await runWriteQueue(later());
    expect((await queueItem(gone.id))!.state).toBe("stuck");
    expect(posts().filter((c) => /"Id":"21"/.test(c.body))).toEqual([]);
  });

  it("an item queued before this slice with a page's version, stale now: read, still active with no balance, sent once more with the version just read", async () => {
    inStub("12").SyncToken = "5";
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    await runWriteQueue(later());
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "5"]);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect((await studentLink("12")).syncedToken).toBe("6");
  });

  it("stale twice at the worker: left waiting with the stale code, nothing changed, never sent a third time", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12") c.SyncToken = String(Number(c.SyncToken) + 1); };
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    await runWriteQueue(later());
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "1"]);
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", lastCode: "fault_5010", tries: 2, sent: false });
    expect(await studentRow(leo)).toMatchObject({ active: true });
  });

  it("a balance on the read after a stale answer at the worker: stuck, never sent again", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12" && c.SyncToken === "0") { c.SyncToken = "1"; stub.invoices = [balance("905", "12", 30)]; } };
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    await runWriteQueue(later());
    expect(bodies()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "stuck", lastCode: "open_balance" });
    expect(await studentRow(leo)).toMatchObject({ active: true });
  });

  it("a resend whose answer is lost at the worker: kept as sent with the version it carried, then found after a roster read and the link aligned", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12" && c.SyncToken === "0") c.SyncToken = "1"; };
    let n = 0;
    stub.onApiRequest = (c) => { if (c.method === "POST" && ++n === 2) stub.loseUpdateAnswer = true; };
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    await runWriteQueue(later());
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "1"]);
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", sent: true, request: { op: "deactivate", role: "student", qboId: "12", syncToken: "1", checked: true } });
    expect(await studentRow(leo)).toMatchObject({ active: true }); // never guessed
    stub.onApiRequest = null; stub.loseUpdateAnswer = false; stub.beforeUpdate = null;
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    stub.calls.length = 0;
    await runWriteQueue(new Date(Date.now() + 10 * MIN)); // past the 5 minutes its second try waits
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await studentRow(leo)).toMatchObject({ active: false });
    expect((await studentLink("12")).syncedToken).toBe("2");
  });

  it("one whose stale answer's read shows them inactive there: found made, nothing more sent, the record follows", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "12") { c.Active = false; c.SyncToken = "2"; } };
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: false, tries: 1 });
    await runWriteQueue(later());
    expect(bodies()).toHaveLength(1);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
    expect(await studentRow(leo)).toMatchObject({ active: false });
  });

  it("a sent one is looked for after a roster read first, as before: QuickBooks has it inactive, so it is done with nothing sent", async () => {
    inStub("12").Active = false;
    const item = await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { sent: true, code: "timeout", lastTriedAt: new Date(Date.now() - MIN) });
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "done" });
  });
});
