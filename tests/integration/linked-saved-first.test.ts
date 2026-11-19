import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, qboCustomer, student, writeQueue } from "@/lib/db/schema";
import { addStudentToLinked, askRosterWrite, BEING_SENT, changeInPortal, createInQuickBooksAndLink, FAMILY_SENDING, MAKING_LOCK, NAME_DIFFERS, portalValueStamp, renameLinked,
  sendPortalValue, SENDING_LOCK, TAKEN_NAME_KEPT, WRITE_COPY } from "@/lib/roster/writes";
import { giveUp, loadOpenWrites, queueCounts, REFUSED_NOT_AGAIN, runWriteQueue, tryAgainNow } from "@/lib/roster/queue";
import { refreshRoster } from "@/lib/roster/refresh";
import { cleanUp } from "@/lib/jobs/cleanup";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { saveShape } from "@/lib/roster/shape";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Stage 3's slice 9e: a rename of a linked family, member or student, and a student added to a linked family, are saved
 * in the portal first and then sent, a rename with its link's own version (`accounting_link.synced_token`). A stale
 * answer is settled by the field, never by the version alone; what QuickBooks refuses is kept as a `refused` item that
 * blocks nothing, with its ways out. Every request is the stub's: `bodies()` proves what was sent each time.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const inStub = (id: string) => stub.customers.find((c) => c.Id === id)!;
const cached = async (qboId: string) => (await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, qboId)))[0];
const linkOf = async (customer: string, kind: "family" | "student") => (await db.select().from(accountingLink)
  .where(and(eq(accountingLink.customerId, customer), kind === "family" ? isNotNull(accountingLink.familyId) : isNotNull(accountingLink.studentId))))[0];
const familyRow = async (id: AppFamilyId) => (await db.select().from(family).where(eq(family.id, id)))[0]!;
const studentNamed = async (name: string) => db.select().from(student).where(eq(student.name, name));
const items = () => db.select().from(writeQueue);
const later = () => new Date(Date.now() + 2 * MIN);
/** Holds one of the advisory locks a send holds, for as long as `run` takes, on another connection. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

let tag: string;
let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId;
let leo: string, leoId: AppStudentId;
beforeEach(async () => {
  await resetDb(); stub.reset();
  tag = await connectRoster(stub);
  stub.calls.length = 0;
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
  rivera = await recordOfCustomer("10", "family");
  leoId = await recordOfCustomer("12", "student");
  leo = String(leoId);
});

describe("each link starts aligned, and only an answer to what the portal sent moves its version", () => {
  it("a family's rename is saved first, sent with its link's version, and the link takes the answer's", async () => {
    expect((await linkOf("10", "family"))!.syncedToken).toBe("0");
    expect(await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Household" }, tag, op)).toEqual({ ok: true, message: "Renamed Rivera Household in the portal and in QuickBooks." });
    expect(bodies()).toEqual([{ Id: "10", SyncToken: "0", sparse: true, DisplayName: "Rivera Household" }]);
    expect((await familyRow(rivera)).name).toBe("Rivera Household");
    expect((await linkOf("10", "family"))!.syncedToken).toBe("1");
    expect((await auditsOf("roster.record.renamed"))[0]).toMatchObject({ targetType: "family", targetId: String(rivera),
      before: { name: "Rivera Family" }, after: { name: "Rivera Household", quickbooks: "sending", customerQboId: "10" } });
    expect((await auditsOf("roster.customer.rename"))[0]!.after).toMatchObject({ name: "Rivera Household", linkVersion: "1" });
    expect(await items()).toEqual([]);
  });

  it("a treasurer's rename read by a roster read leaves the link's version; the next rename is read live, kept refused, and nothing is overwritten", async () => {
    inStub("12").DisplayName = "Leonardo Rivera"; inStub("12").SyncToken = "1";
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    expect((await linkOf("12", "student"))!.syncedToken).toBe("0");
    stub.calls.length = 0;
    const r = await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("QuickBooks has “Leonardo Rivera” now.") });
    expect(posts()).toEqual([]);
    expect(inStub("12").DisplayName).toBe("Leonardo Rivera");
    expect((await studentNamed("Leon Rivera"))).toHaveLength(1);
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: NAME_DIFFERS, sent: false, targetQboId: "12", studentId: leo, request: { op: "rename", name: "Leon Rivera", was: "Leo Rivera", syncToken: "0" } });
    expect((await linkOf("12", "student"))!.syncedToken).toBe("0");
    expect((await auditsOf("roster.write.kept_refused"))[0]).toMatchObject({ targetId: kept!.id, after: { state: "refused", code: NAME_DIFFERS } });
  });

  it("a treasurer's rename the cache hasn't read yet: the send is stale, the live read finds the name changed, it is kept refused and the cache shows QuickBooks' name", async () => {
    inStub("12").DisplayName = "Leonardo Rivera"; inStub("12").SyncToken = "1";
    await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op);
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, DisplayName: "Leon Rivera" }]);
    expect(inStub("12").DisplayName).toBe("Leonardo Rivera");
    expect(await cached("12")).toMatchObject({ displayName: "Leonardo Rivera", syncToken: "1" });
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: "fault_5010" });
    expect((await loadOpenWrites())[0]).toMatchObject({ state: "refused", holds: "Leonardo Rivera" });
  });

  it("stale with the name as the portal held it (the version raised another way): sent once more with the version just read, and the link takes that answer's", async () => {
    inStub("12").SyncToken = "3";
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true, message: "Renamed Leon Rivera in the portal and in QuickBooks." });
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "3"]);
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
    expect((await linkOf("12", "student"))!.syncedToken).toBe("4");
    expect((await auditsOf("roster.customer.rename"))[0]!.after).toMatchObject({ resent: "stale", fieldAsHeld: true, linkVersion: "4" });
  });

  it("a family renamed right after a student was added under it (QuickBooks raising the family's version) goes through", async () => {
    stub.quirks.parentVersionFollows = true;
    expect(await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op)).toMatchObject({ ok: true });
    expect(inStub("10").SyncToken).toBe("1");
    expect(await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Household" }, tag, op)).toMatchObject({ ok: true, message: "Renamed Rivera Household in the portal and in QuickBooks." });
    expect(bodies().slice(-2).map((b) => [b.Id, b.SyncToken])).toEqual([["10", "0"], ["10", "1"]]);
    expect((await linkOf("10", "family"))!.syncedToken).toBe("2");
  });

  it("a link with no version is read live first and sent with the version read, when the name is as the portal held it", async () => {
    await db.update(accountingLink).set({ syncedToken: null }).where(eq(accountingLink.customerId, "12"));
    inStub("12").SyncToken = "5";
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true });
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "5", sparse: true, DisplayName: "Leon Rivera" }]);
    expect((await auditsOf("roster.customer.rename"))[0]!.after).toMatchObject({ resent: "no_version", fieldAsHeld: true });
    expect((await linkOf("12", "student"))!.syncedToken).toBe("6");
  });

  it("a second stale answer right after the live read waits as never sent, and the worker's try follows the same rule: one resend", async () => {
    stub.beforeUpdate = (c) => { c.SyncToken = String(Number(c.SyncToken ?? 0) + 1); }; // a change in QuickBooks at the moment of every send
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true, queued: true });
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "1"]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, lastCode: "fault_5010", studentId: leo, request: { syncToken: "0", was: "Leo Rivera" } });
    stub.beforeUpdate = null;
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "2"]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
  });

  it("a queued rename's later try sends the version it was queued with", async () => {
    stub.rateLimitNext = 1;
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true, queued: true });
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: false, request: { syncToken: "0" } });
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "0", sparse: true, DisplayName: "Leon Rivera" }]);
    expect((await linkOf("12", "student"))!.syncedToken).toBe("1");
  });

  it("a move sent with a page version newer than the link's leaves the link's version", async () => {
    inStub("12").SyncToken = "2";
    await refreshRoster(WORKER);
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "2", toFamilyQboId: "20" }, tag, op)).toMatchObject({ ok: true });
    expect((await linkOf("12", "student"))!.syncedToken).toBe("0");
  });

  it("a lost answer is queued as possibly made, and found after a roster read rather than sent again", async () => {
    stub.loseUpdateAnswer = true;
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true, queued: true });
    stub.loseUpdateAnswer = false;
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: true });
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(posts()).toEqual([]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect((await auditsOf("roster.write.done"))[0]!.after).toMatchObject({ how: "found" });
  });
});

describe("a rename saved first: what is refused before anything is saved, and what is kept refused after", () => {
  it("a standing difference left by an earlier given-up rename is never sent over", async () => {
    stub.updateFault = "6000";
    await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Household" }, tag, op);
    stub.updateFault = null;
    const [first] = await items();
    expect(await giveUp(first!.id, "Leave it.", op)).toMatchObject({ ok: true, message: expect.stringContaining("The portal keeps its own name") });
    stub.calls.length = 0;
    const r = await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Home" }, tag, op);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("QuickBooks has “Rivera Family” now.") });
    // Nobody renamed it in QuickBooks: the words say the portal can't tell that from an earlier change of its own.
    expect(r).toMatchObject({ message: expect.stringContaining("an earlier change from the portal never reached it") });
    expect(r).not.toMatchObject({ message: expect.stringContaining("Someone changed the name") });
    expect(posts()).toEqual([]);
    expect(inStub("10").DisplayName).toBe("Rivera Family");
    expect((await familyRow(rivera)).name).toBe("Rivera Home");
  });

  it("a name QuickBooks takes as another's (6240) is kept refused with a free one offered; one the cache shows is refused before anything is saved", async () => {
    stub.otherNames = ["Leon Rivera"];
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true, message: expect.stringContaining("“Leon Rivera (2)”") });
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: "fault_6240" });
    const before = await items();
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Ana Rivera" }, tag, op)).toMatchObject({ ok: false, offer: "Ana Rivera (2)" });
    expect(await items()).toEqual(before);
    expect(await studentNamed("Leon Rivera")).toHaveLength(1);
  });

  it("another fault is kept refused, and the portal's name stays", async () => {
    stub.updateFault = "6000";
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: true, message: expect.stringContaining("QuickBooks wouldn't take it.") });
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: "fault_6000", studentId: leo });
    expect(await studentNamed("Leon Rivera")).toHaveLength(1);
  });

  it("the cache holding the name already: saved, and nothing is sent", async () => {
    await db.update(student).set({ name: "Leo R." }).where(eq(student.id, leoId));
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leo Rivera" }, tag, op)).toEqual({ ok: true, message: "Renamed Leo Rivera in the portal. QuickBooks has that name already, so nothing was sent." });
    expect(posts()).toEqual([]);
    expect((await auditsOf("roster.record.renamed"))[0]!.after).toMatchObject({ quickbooks: "has_it" });
  });

  it("a rename while another change to the record is being sent is refused in words, and nothing is saved or sent", async () => {
    const r = await holding(SENDING_LOCK, leo, () => renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op));
    expect(r).toEqual({ ok: false, errors: [BEING_SENT] });
    expect(posts()).toEqual([]);
    expect(await studentNamed("Leon Rivera")).toEqual([]);
  });

  it("an inactive record is refused; an unlinked one is changed in the portal only, as before", async () => {
    await db.update(student).set({ active: false }).where(eq(student.id, leoId));
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: false });
    await db.update(student).set({ active: true }).where(eq(student.id, leoId));
    await db.delete(accountingLink).where(and(eq(accountingLink.customerId, "12"), isNotNull(accountingLink.studentId)));
    expect(await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op)).toMatchObject({ ok: false, errors: [expect.stringContaining("saved in the portal only")] });
    expect(await changeInPortal({ op: "rename_student", studentId: leo, name: "Leon Rivera" }, tag, op)).toEqual({ ok: true, message: "Renamed Leon Rivera in the portal." });
    expect(posts()).toEqual([]);
  });

  it("a Parent customer's rename keeps today's path: QuickBooks first, with its page's version", async () => {
    expect(await askRosterWrite({ op: "rename", qboId: "21", syncToken: "0", name: "Mei L. Chen", parentOnly: true }, tag, op)).toEqual({ ok: true, message: "Renamed in QuickBooks." });
    expect(bodies()).toEqual([{ Id: "21", SyncToken: "0", sparse: true, DisplayName: "Mei L. Chen" }]);
    // The parent's action renames a parent only.
    expect(await askRosterWrite({ op: "rename", qboId: "12", syncToken: "0", name: "Leon Rivera", parentOnly: true }, tag, op)).toEqual({ ok: false, errors: [WRITE_COPY.notOffered] });
  });
});

describe("a student added to a linked family is saved first", () => {
  it("taken: the saved record is linked, with the answer's version, and no second student is made", async () => {
    expect(await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op)).toEqual({ ok: true, message: "Rosa Rivera is added to Rivera Family in the portal, made in QuickBooks and linked." });
    const [rosa] = await studentNamed("Rosa Rivera");
    expect(rosa).toMatchObject({ familyId: rivera, active: true });
    const made = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!;
    expect((await linkOf(String(made.Id), "student"))).toMatchObject({ studentId: rosa!.id, origin: "created", syncedToken: "0" });
    expect((await auditsOf("roster.student.added"))[0]!.after).toMatchObject({ quickbooks: "sending", familyId: String(rivera) });
    expect(bodies()).toEqual([expect.objectContaining({ DisplayName: "Rosa Rivera", ParentRef: { value: "10" }, BillWithParent: true })]);
  });

  it("unreachable: it waits on the queue filed under the family and the student, and the found-done path links the existing record", async () => {
    stub.loseUpdateAnswer = true;
    expect(await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op)).toMatchObject({ ok: true, queued: true });
    stub.loseUpdateAnswer = false;
    const [rosa] = await studentNamed("Rosa Rivera");
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: true, familyId: rivera, studentId: rosa!.id });
    await runWriteQueue(later());
    expect(await studentNamed("Rosa Rivera")).toHaveLength(1);
    const made = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!;
    expect(await linkOf(String(made.Id), "student")).toMatchObject({ studentId: rosa!.id, syncedToken: "0" });
  });

  it("refused: the student stays, active and unlinked, and the refused item says why; then “Create in QuickBooks and link” makes them and closes it", async () => {
    stub.updateFault = "6000";
    expect(await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op)).toMatchObject({ ok: true, unlinked: true, message: expect.stringContaining("They stay in the portal, unlinked") });
    stub.updateFault = null;
    const [rosa] = await studentNamed("Rosa Rivera");
    expect(rosa).toMatchObject({ active: true });
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: "fault_6000", studentId: rosa!.id });
    expect((await createInQuickBooksAndLink(String(rivera), null, tag, op)).result).toMatchObject({ ok: true });
    expect(await queueItem(kept!.id)).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.replaced"))[0]).toMatchObject({ targetId: kept!.id, after: { state: "given_up" } });
    expect(await db.select().from(accountingLink).where(eq(accountingLink.studentId, rosa!.id))).toHaveLength(1);
  });

  it("is refused, saving nothing, while a send holds the family's lock, and “Create in QuickBooks and link” is refused while the add holds it", async () => {
    expect(await holding(MAKING_LOCK, String(rivera), () => addStudentToLinked(String(rivera), "Rosa Rivera", tag, op))).toEqual({ ok: false, errors: [FAMILY_SENDING] });
    expect((await holding(MAKING_LOCK, String(rivera), () => createInQuickBooksAndLink(String(rivera), null, tag, op))).result).toEqual({ ok: false, errors: [FAMILY_SENDING] });
    expect(await studentNamed("Rosa Rivera")).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("is refused, saving nothing, for a family with no link (one whose create is waiting included), and where the books have no student type", async () => {
    const [own] = await db.insert(family).values({ name: "Oak Family", active: true }).returning();
    await seedQueued({ op: "create", role: "family", name: "Oak Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: own!.id });
    expect(await addStudentToLinked(String(own!.id), "Ivy Oak", tag, op)).toMatchObject({ ok: false });
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" }, { actor: WORKER.actor, ip: null });
    expect(await addStudentToLinked(String(await recordOfCustomer("10", "family")), "Rosa Rivera", tag, op)).toMatchObject({ ok: false });
    expect(await studentNamed("Ivy Oak")).toEqual([]);
    expect(await studentNamed("Rosa Rivera")).toEqual([]);
  });
});

describe("a refused change blocks nothing, and leaves only by the ways it may", () => {
  async function refusedRename() {
    stub.updateFault = "6000";
    await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Household" }, tag, op);
    stub.updateFault = null;
    stub.calls.length = 0;
    return (await items())[0]!;
  }

  it("the family still takes a student, a move and another rename, which takes its place; the worker never tries it; Try again now refuses it", async () => {
    const kept = await refusedRename();
    expect(await queueCounts()).toEqual({ waiting: 0, stuck: 0, refused: 1 });
    await runWriteQueue(later());
    expect(posts()).toEqual([]);
    expect(await tryAgainNow(kept.id, op)).toEqual({ ok: false, errors: [REFUSED_NOT_AGAIN] });
    expect(await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op)).toMatchObject({ ok: true });
    expect(await askRosterWrite({ op: "move", qboId: "12", syncToken: "0", toFamilyQboId: "20" }, tag, op)).toMatchObject({ ok: true });
    // The later rename takes the refused one's place. The portal's name before it ("Rivera Household") isn't what
    // QuickBooks holds, so it is read live first and kept refused in its turn: a standing difference is never sent over.
    expect(await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Home" }, tag, op)).toMatchObject({ ok: true, message: expect.stringContaining("QuickBooks refused the rename") });
    expect(inStub("10").DisplayName).toBe("Rivera Family");
    expect(await queueItem(kept.id)).toMatchObject({ state: "given_up" });
    expect((await items()).filter((i) => i.state === "refused")).toEqual([expect.objectContaining({ lastCode: NAME_DIFFERS, request: expect.objectContaining({ name: "Rivera Home", was: "Rivera Household" }) })]);
    expect((await auditsOf("roster.write.replaced"))[0]!.after).toMatchObject({ replacedBy: { op: "rename", name: "Rivera Home" } });
  });

  it("the daily clean-up keeps it, however old", async () => {
    const kept = await refusedRename();
    const old = new Date(Date.now() - 90 * 24 * 3_600_000);
    await db.update(writeQueue).set({ createdAt: old, updatedAt: old, lastTriedAt: old }).where(eq(writeQueue.id, kept.id));
    await db.transaction((tx) => cleanUp(tx));
    expect(await queueItem(kept.id)).toMatchObject({ state: "refused" });
  });

  it("Send the portal's value: sent with the live version while the name reads as the row showed; nothing sent when it changed again; a value not as shown is refused", async () => {
    inStub("12").DisplayName = "Leonardo Rivera"; inStub("12").SyncToken = "1";
    await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op);
    const [kept] = await items();
    stub.calls.length = 0;
    // A value the row didn't show is not trusted.
    expect(await sendPortalValue(kept!.id, "Something else", portalValueStamp(kept!.id, "Leonardo Rivera"), op)).toMatchObject({ ok: false });
    // QuickBooks changed again since the row was drawn: nothing is sent, and the cache shows the newer name.
    inStub("12").DisplayName = "Leo the Lion"; inStub("12").SyncToken = "2";
    expect(await sendPortalValue(kept!.id, "Leonardo Rivera", portalValueStamp(kept!.id, "Leonardo Rivera"), op)).toMatchObject({ ok: false, errors: [expect.stringContaining("“Leo the Lion”")] });
    expect(posts()).toEqual([]);
    expect(await cached("12")).toMatchObject({ displayName: "Leo the Lion" });
    // Only the version moved since the row was drawn: sent with the live version, on purpose.
    inStub("12").SyncToken = "7";
    expect(await sendPortalValue(kept!.id, "Leo the Lion", portalValueStamp(kept!.id, "Leo the Lion"), op)).toMatchObject({ ok: true });
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "7", sparse: true, DisplayName: "Leon Rivera" }]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "done" });
    expect((await auditsOf("roster.write.sent_again"))[0]).toMatchObject({ targetId: kept!.id, after: { syncToken: "7", name: "Leon Rivera" } });
    expect((await linkOf("12", "student"))!.syncedToken).toBe("8");
  });

  it("Send the portal's value for a student's refused create makes them and links the saved record", async () => {
    stub.updateFault = "6000";
    await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op);
    stub.updateFault = null;
    const [kept] = await items();
    expect(await sendPortalValue(kept!.id, "", portalValueStamp(kept!.id, ""), op)).toMatchObject({ ok: true });
    expect(await queueItem(kept!.id)).toMatchObject({ state: "done" });
    const [rosa] = await studentNamed("Rosa Rivera");
    expect(await db.select().from(accountingLink).where(eq(accountingLink.studentId, rosa!.id))).toHaveLength(1);
  });

  it("Send the portal's value given up while it is on its way: QuickBooks makes the student, but nothing is linked and the item stays given up", async () => {
    stub.updateFault = "6000";
    await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op);
    stub.updateFault = null;
    const [kept] = await items();
    // Staff give it up at the moment the create reaches QuickBooks.
    stub.onApiRequest = async (call) => { if (call.method === "POST") { stub.onApiRequest = null; expect(await giveUp(kept!.id, "Not wanted.", op)).toMatchObject({ ok: true }); } };
    expect(await sendPortalValue(kept!.id, "", portalValueStamp(kept!.id, ""), op)).toMatchObject({ ok: true, message: expect.stringContaining("given up") });
    const made = stub.customers.find((c) => c.DisplayName === "Rosa Rivera")!;
    const [rosa] = await studentNamed("Rosa Rivera");
    expect(await db.select().from(accountingLink).where(eq(accountingLink.studentId, rosa!.id))).toEqual([]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "given_up", resultQboId: String(made.Id) });
    expect(await items()).toHaveLength(1);
  });

  it("Send the portal's value with a lost answer: the item itself waits, sent, and the worker sends it against the name the row showed", async () => {
    inStub("12").DisplayName = "Leonardo Rivera"; inStub("12").SyncToken = "1";
    await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op);
    const [kept] = await items();
    stub.updateServerFault = { status: 500, code: "10000" };
    expect(await sendPortalValue(kept!.id, "Leonardo Rivera", portalValueStamp(kept!.id, "Leonardo Rivera"), op)).toMatchObject({ ok: true, queued: true });
    stub.updateServerFault = null;
    expect(await items()).toHaveLength(1);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "waiting", sent: true, request: { syncToken: "1", checked: true, was: "Leonardo Rivera", name: "Leon Rivera" } });
    stub.calls.length = 0;
    await runWriteQueue(later());
    // QuickBooks didn't make it: sent again, with the version the press read, as the name still reads as staff were shown.
    expect(bodies()).toEqual([{ Id: "12", SyncToken: "1", sparse: true, DisplayName: "Leon Rivera" }]);
    expect(await queueItem(kept!.id)).toMatchObject({ state: "done" });
    expect(inStub("12").DisplayName).toBe("Leon Rivera");
  });

  it("Send the portal's value refused again: refused, as it was asked, with the new code; and a taken name isn't sent again", async () => {
    inStub("12").DisplayName = "Leonardo Rivera"; inStub("12").SyncToken = "1";
    await renameLinked({ kind: "student", recordId: leo, name: "Leon Rivera" }, tag, op);
    const [kept] = await items();
    stub.updateFault = "6000";
    expect(await sendPortalValue(kept!.id, "Leonardo Rivera", portalValueStamp(kept!.id, "Leonardo Rivera"), op)).toMatchObject({ ok: false });
    stub.updateFault = null;
    expect(await queueItem(kept!.id)).toMatchObject({ state: "refused", lastCode: "fault_6000", sent: false, request: { syncToken: "0", was: "Leo Rivera" } });
    expect((await loadOpenWrites())[0]).toMatchObject({ state: "refused", mayResend: true });

    await db.update(writeQueue).set({ lastCode: "fault_6240" }).where(eq(writeQueue.id, kept!.id));
    stub.calls.length = 0;
    expect(await sendPortalValue(kept!.id, "Leonardo Rivera", portalValueStamp(kept!.id, "Leonardo Rivera"), op)).toEqual({ ok: false, errors: [TAKEN_NAME_KEPT] });
    expect(posts()).toEqual([]);
    expect((await loadOpenWrites())[0]).toMatchObject({ state: "refused", mayResend: false });
  });

  it("“Create in QuickBooks and link” that QuickBooks refuses again leaves the refused create kept", async () => {
    stub.updateFault = "6000";
    await addStudentToLinked(String(rivera), "Rosa Rivera", tag, op);
    const [kept] = await items();
    expect((await createInQuickBooksAndLink(String(rivera), null, tag, op)).result).toMatchObject({ ok: false });
    stub.updateFault = null;
    expect(await queueItem(kept!.id)).toMatchObject({ state: "refused" });
    expect(await auditsOf("roster.write.replaced")).toEqual([]);
  });

  it("a make-inactive the worker finds QuickBooks has already, without sending it, leaves the link's version", async () => {
    await seedQueued({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" });
    inStub("12").Active = false; inStub("12").SyncToken = "5";
    expect((await refreshRoster(WORKER)).ok).toBe(true);
    stub.calls.length = 0;
    await runWriteQueue(later());
    expect(posts()).toEqual([]);
    expect((await items())[0]).toMatchObject({ state: "done" });
    expect((await linkOf("12", "student"))!.syncedToken).toBe("0");
  });
});
