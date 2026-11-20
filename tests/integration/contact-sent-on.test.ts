import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, qboCustomer, writeQueue, type RosterWrite } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import type { ContactValues } from "@/lib/parents/contact-fields";
import { CONTACT_COPY, saveDetails, saveMyContact } from "@/lib/parents/contact-edits";
import { addGuardian, removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { addStudentToLinked, askFamilyInactive, CONTACT_AWAITS_READ, CONTACT_DIFFERS, CONTACT_NOT_OFFERED, CONTACT_SUPERSEDED_AT_PRESS, contactShown, contactShownUnder, contactStopNow, contactStopsNow, coverStamp, familyCover, keptWordsFor, moveStudent, portalValueStamp,
  renameLinked, SENDING_LOCK, sendPortalValue, whoStopped } from "@/lib/roster/writes";
import { compareContact, giveUp, loadOpenWrites, runWriteQueue, tryAgainNow } from "@/lib/roster/queue";
import { env } from "@/env";
import { ROSTER_LOCK, saveShape, type MembershipShape } from "@/lib/roster/shape";
import { refreshRoster } from "@/lib/roster/refresh";
import { takeInContactDetails } from "@/lib/parents/contact-take-in";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { NO_DETAILS, inQuickBooks, personDetails, setPersonDetails, takeInDone, takeInNotRun } from "../helpers/contact";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { FZN_SHAPE, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { moveInQuickBooksOnly, storeShape } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Stage 3's slice 11b: a parent's change of their phone and mailing address, saved in the portal (slice 11a), is queued
 * in the save's own transaction for each record it goes to, and sent on by the write queue's worker: the own Parent
 * customer of each of the person's open memberships, or, in books with no parent type, the family's own linked
 * customer. Nothing QuickBooks holds that the portal never knew of is overwritten. The company is FZN-shaped
 * (fznCompany(), tests/helpers/qbo-stub.ts): Ana Rivera's own record is customer 11, under the Rivera Family, 10, with
 * the phone 555-0101 and no address. Every request is the stub's: `posts()` proves what was sent.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const NEW_PHONE = "512-555-0222";
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const items = () => db.select().from(writeQueue);
const openItems = async () => (await items()).filter((i) => i.state === "waiting" || i.state === "stuck" || i.state === "refused");
const linkOfRow = async (guardianId: string) => (await db.select().from(accountingLink).where(and(eq(accountingLink.guardianId, guardianId), isNotNull(accountingLink.guardianId))))[0];
/** The worker's next wake, a little later, when the items saved now are due. */
const wake = (afterMs = 2 * MIN) => runWriteQueue(new Date(Date.now() + afterMs));
/** The form as a browser sends it back: every field, and the version it was drawn at. */
const form = (v: Partial<ContactValues>, version: string) => ({ ...NO_DETAILS, ...v, version });
const asSaved = (v: Partial<ContactValues>, version: string) => ({ values: { ...NO_DETAILS, ...v }, version });
const parentActor = (id: string, email: string) => ({ door: "parent" as const, id, label: email });

let tag: string;
let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId, chen: AppFamilyId;
beforeEach(async () => {
  await resetDb(); stub.reset();
  tag = await connectRoster(stub);
  // The take-in has run after a read under this shape, so a parent's change is sent on (item 1's gate, contactSendsMayGo()).
  await takeInDone();
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
  stub.calls.length = 0;
});

/** Ana Rivera, signed in to the Rivera family, with the phone the take-in copied from her own record (version 1). */
async function ana(o: { phone?: string; version?: number } = {}) {
  const seeded = await seedAnaRivera({ status: "active" });
  await setPersonDetails(seeded.ana.id, { phone: o.phone ?? "555-0101" }, o.version ?? 1);
  const ctx: ParentCtx = { door: "parent", parentId: seeded.ana.id, sessionId: "a-session", guardianId: seeded.row.id, familyId: rivera, name: "Ana Rivera",
    email: "ana@example.com", families: [], ip: null };
  return { ...seeded, ctx };
}

describe("a parent's save queues the change for each record it goes to (items 1 to 3)", () => {
  it("one item for their own Parent customer, nothing sent at the save, and the answer in today's words", async () => {
    const a = await ana();
    expect(await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"))).toEqual({ ok: true, message: CONTACT_COPY.saved, current: asSaved({ phone: NEW_PHONE }, "p:2") });
    expect(posts()).toEqual([]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, tries: 0, familyId: rivera, studentId: null, targetQboId: "11", askedBy: null,
      request: { op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: NEW_PHONE }, was: { phone: "555-0101" }, guardianId: a.row.id } });
    expect((item!.request as { orWas?: unknown }).orWas).toBeUndefined();
    expect((await auditsOf("parent.details.save"))[0]!.after).toEqual({ phone: NEW_PHONE, queueIds: [item!.id] });
  });

  it("the worker sends it at its next wake, with the link's own version and today's body, and aligns the link", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE, line1: "7 Kestrel Way", city: "Round Rock", region: "TX" }, "p:1"));
    await wake();
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE },
      BillAddr: { Line1: "7 Kestrel Way", Line2: "", Line3: "", Line4: "", Line5: "", City: "Round Rock", CountrySubDivisionCode: "TX", PostalCode: "", Country: "" } }]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: NEW_PHONE }, SyncToken: "1" });
    expect((await items())[0]).toMatchObject({ state: "done" });
    expect(await linkOfRow(a.row.id)).toMatchObject({ customerId: "11", syncedToken: "1" });
    expect((await auditsOf("roster.customer.contact"))).toHaveLength(1);
    // The cache takes QuickBooks' answer; the portal's details are as the parent saved them.
    expect((await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, "11")))[0]).toMatchObject({ phone: NEW_PHONE, addressLine1: "7 Kestrel Way" });
    expect(await personDetails(a.ana.id)).toMatchObject({ version: 2 });
  });

  it("nothing is queued where there is no record of their own: no Parent customer, one two open rows share, a closed row, a customer id that isn't digits", async () => {
    // A guardian staff added with no Parent customer of their own.
    const kit = await seedParent({ name: "Kit Rivera", email: "kit@example.com" });
    await seedGuardian({ parentId: kit.id, familyQboId: "10", status: "active" });
    await syncAppRecords();
    expect(await saveDetails({ kind: "person", parentId: kit.id }, asSaved({ phone: NEW_PHONE }, "p:0"), { actor: parentActor(kit.id, "kit@example.com"), ip: null })).toMatchObject({ is: "saved", queued: 0 });
    // Ana's Parent customer shared with a second open row: nobody's own.
    const a = await ana();
    const ben = await seedParent({ name: "Ben Rivera", email: "ben@example.com" });
    const benRow = await seedGuardian({ parentId: ben.id, familyQboId: "10", sourceQboId: "11", status: "active" });
    await syncAppRecords();
    expect(await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"))).toMatchObject({ ok: true, message: CONTACT_COPY.saved });
    // Ben's row closed: Ana's own again. Her own row closed: nothing.
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, benRow.id));
    expect(await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: "512-555-0333" }, "p:2"), { actor: parentActor(a.ana.id, "ana@example.com"), ip: null })).toMatchObject({ is: "saved", queued: 1 });
    await db.delete(writeQueue);
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, a.row.id));
    expect(await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: "512-555-0444" }, "p:3"), { actor: parentActor(a.ana.id, "ana@example.com"), ip: null })).toMatchObject({ is: "saved", queued: 0 });
    // Open again, linked to a customer whose id isn't one QuickBooks uses: never queued.
    await db.update(guardian).set({ status: "active", disabledReason: null }).where(eq(guardian.id, a.row.id));
    await db.update(accountingLink).set({ customerId: "E2E-P1" }).where(eq(accountingLink.guardianId, a.row.id));
    expect(await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: "512-555-0555" }, "p:4"), { actor: parentActor(a.ana.id, "ana@example.com"), ip: null })).toMatchObject({ is: "saved", queued: 0 });
    expect(await items()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("nothing is queued for a customer the roster's copy holds inactive, save after save (as nothing is sent to one)", async () => {
    const a = await ana();
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "11"));
    for (const [phone, version] of [[NEW_PHONE, "p:1"], ["512-555-0333", "p:2"]] as const) {
      expect(await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone }, version), { actor: parentActor(a.ana.id, "ana@example.com"), ip: null }))
        .toMatchObject({ is: "saved", queued: 0 });
    }
    expect(await items()).toEqual([]);
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: "512-555-0333" } });
    await wake();
    expect(posts()).toEqual([]);
  });

  it("a person in two families: two items, sent to two records; a family made inactive gets none", async () => {
    const a = await ana();
    // Ana's own record in the Chen family too: Mei Chen's customer, 21, stands for it here.
    await seedGuardian({ parentId: a.ana.id, familyQboId: "20", sourceQboId: "21", status: "active" });
    await syncAppRecords();
    // That record holds the phone the portal knows for her, as her records agreed at the take-in: an empty one there
    // would be a difference the portal never knew of, and kept (AGENTS.md's rough edge for the mapping screen).
    inQuickBooks(stub, "21").PrimaryPhone = { FreeFormNumber: "555-0101" };
    await db.update(qboCustomer).set({ phone: "555-0101" }).where(eq(qboCustomer.qboId, "21"));
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    expect((await items()).map((i) => [i.targetQboId, String(i.familyId)]).sort()).toEqual([["11", String(rivera)], ["21", String(chen)]].sort());
    await wake();
    expect(bodies().map((b) => b.Id).sort()).toEqual(["11", "21"]);
    for (const id of ["11", "21"]) expect(inQuickBooks(stub, id)).toMatchObject({ PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    expect(await openItems()).toEqual([]);
    await db.update(family).set({ active: false }).where(eq(family.id, chen));
    await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "p:2"));
    expect((await openItems()).map((i) => i.targetQboId)).toEqual(["11"]);
  });

  it("the save takes neither the roster lock nor any \"being sent\" lock, and waits for none", async () => {
    const a = await ana();
    // Another connection holds the roster lock exclusively, and Ana's row's and her family's "being sent" locks.
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${a.row.id}::text))`);
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${String(rivera)}::text))`);
      return saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    });
    expect(result).toMatchObject({ ok: true, message: CONTACT_COPY.saved });
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "11" })]);
    // Nor does it take one by trying: the modules a parent's save runs name no advisory lock and none of the roster's.
    for (const file of ["src/lib/parents/contact-edits.ts", "src/lib/parents/contact-queue.ts"]) {
      const source = readFileSync(file, "utf8");
      for (const lock of ["advisory", "ROSTER_LOCK", "SENDING_LOCK", "lockRosterAs", "whileSending", "whileMaking"]) expect(source, `${file} ${lock}`).not.toContain(lock);
    }
  });
});

describe("nothing is sent until the portal knows the details QuickBooks holds (the second read's item 1)", () => {
  const getsOf = (id: string) => stub.apiCalls().filter((c) => c.method === "GET" && c.path.endsWith(`/customer/${id}`));

  it("a save before the take-in has run is queued and left as it is across two wakes, no try counted; after a read and the take-in it is sent", async () => {
    const a = await ana();
    await takeInNotRun();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    await wake();
    await wake(10 * MIN);
    expect(posts()).toEqual([]);
    expect(getsOf("11")).toEqual([]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, tries: 0, lastCode: null });
    // Never stuck by its age for this: a day later it is still waiting, untried.
    await runWriteQueue(new Date(Date.now() + 25 * 60 * MIN));
    expect(await queueItem(item!.id)).toMatchObject({ state: "waiting", sent: false, tries: 0 });
    expect(posts()).toEqual([]);
    // The row says why, and "Try again now" says so too, changing nothing.
    const [row] = await loadOpenWrites();
    expect(row).toMatchObject({ state: "waiting", awaitsRead: true });
    expect(await tryAgainNow(item!.id, op)).toEqual({ ok: false, errors: [CONTACT_AWAITS_READ] });
    // A read under the shape, then the take-in (which leaves Ana's own saved details as they are): sent at the next wake.
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await takeInContactDetails()).toMatchObject({ ran: true });
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE } });
    expect((await loadOpenWrites())[0]).toMatchObject({ awaitsRead: false });
    await wake(30 * 60 * MIN);
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
  });

  it("a change that waited more than a day for the read gets the queue's usual tries once it may go, counted from then, not stuck at its first failure", async () => {
    const a = await ana();
    await takeInNotRun();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    const [item] = await items();
    // Saved two days ago, and left alone since by every wake, as the take-in hadn't run.
    await db.update(writeQueue).set({ createdAt: new Date(Date.now() - 48 * 60 * MIN) }).where(eq(writeQueue.id, item!.id));
    await wake();
    expect(await queueItem(item!.id)).toMatchObject({ state: "waiting", tries: 0, sent: false });
    // The read and the take-in now: the gate opens, and the first send meets a 500.
    await takeInDone();
    stub.failNext = 1;
    await wake();
    expect(posts()).toHaveLength(1);
    const after = await queueItem(item!.id);
    // Waiting for the queue's next gap, as any item's first failure leaves it, though it was made two days ago.
    expect(after).toMatchObject({ state: "waiting", tries: 1, sent: true });
    expect(after!.lastCode).toMatch(/^http_500/);
    expect(after!.nextTryAt).not.toBeNull();
  });

  it("a save while a shape save has withdrawn the read's mark waits until the next read, and then goes", async () => {
    const a = await ana();
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    await wake();
    expect(posts()).toEqual([]);
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: false, tries: 0 });
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    await wake(10 * MIN);
    expect(bodies()).toEqual([expect.objectContaining({ Id: "11", PrimaryPhone: { FreeFormNumber: NEW_PHONE } })]);
    expect((await items())[0]).toMatchObject({ state: "done" });
  });

  it("\"Send the portal's value\" while the mark is withdrawn sends nothing, in words, and keeps the change as it was", async () => {
    const a = await ana({ phone: "" });
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    await wake();
    const kept = (await items())[0]!;
    expect(kept).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    await saveShape(FZN_SHAPE, { actor: WORKER.actor, ip: null });
    stub.calls.length = 0;
    expect((await loadOpenWrites())[0]).toMatchObject({ mayResend: false, notOffered: "awaits_read", awaitsRead: true });
    expect(await sendPortalValue(kept.id, "anything", portalValueStamp(kept.id, "anything"), op)).toEqual({ ok: false, errors: [CONTACT_AWAITS_READ] });
    expect(stub.apiCalls()).toEqual([]);
    expect(await queueItem(kept.id)).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS, tries: kept.tries });
  });

  it("over a cache row that holds no details, with nothing known before: QuickBooks is read first, and a phone found there is kept as a difference", async () => {
    const a = await ana({ phone: "" });
    // The portal's copy holds nothing for Ana's own record (as a row no read has filled), while QuickBooks holds her phone.
    await db.update(qboCustomer).set({ phone: null }).where(eq(qboCustomer.qboId, "11"));
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    expect((await items())[0]!.request).toMatchObject({ was: { phone: "" } });
    await wake();
    expect(posts()).toEqual([]);
    expect(getsOf("11")).toHaveLength(1);
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-0101" } });
  });
});

describe("each send compares QuickBooks' details first, and never overwrites one the portal didn't know of (items 4 and 5)", () => {
  it("a stale answer with QuickBooks still holding what the portal knew: sent once more with the version just read", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    inQuickBooks(stub, "11").SyncToken = "3"; // changed in QuickBooks meanwhile, not the phone
    await wake();
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "3"]);
    expect((await items())[0]).toMatchObject({ state: "done" });
    expect(await linkOfRow(a.row.id)).toMatchObject({ syncedToken: "4" });
    expect((await auditsOf("roster.customer.contact"))[0]!.after).toMatchObject({ resent: "stale", fieldAsHeld: true });
  });

  it("a stale answer with the change made already: done, nothing sent again", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    Object.assign(inQuickBooks(stub, "11"), { SyncToken: "3", PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    await wake();
    expect(bodies()).toHaveLength(1);
    expect((await items())[0]).toMatchObject({ state: "done" });
  });

  it("a stale answer with something else there: nothing more is sent, the change is kept, and the portal keeps its details", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    Object.assign(inQuickBooks(stub, "11"), { SyncToken: "3", PrimaryPhone: { FreeFormNumber: "555-9999" } });
    await wake();
    expect(bodies()).toHaveLength(1);
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-9999" } });
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE }, version: 2 });
    expect(await auditsOf("roster.write.kept_refused")).toHaveLength(1);
  });

  it("a stale answer with the field cleared in QuickBooks meanwhile: kept, never sent over the clearing", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    const there = inQuickBooks(stub, "11");
    delete there.PrimaryPhone;
    there.SyncToken = "3";
    await wake();
    expect(bodies().filter((b) => b.SyncToken !== "0")).toEqual([]);
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    expect(inQuickBooks(stub, "11").PrimaryPhone).toBeUndefined();
  });

  it("a field cleared in QuickBooks stays cleared, even once a send of the other field has moved the link's version on", async () => {
    const a = await ana();
    await setPersonDetails(a.ana.id, { line1: "12 Heron Lane", city: "Austin" });
    await db.update(qboCustomer).set({ addressLine1: "12 Heron Lane", addressCity: "Austin" }).where(eq(qboCustomer.qboId, "11"));
    const there = inQuickBooks(stub, "11");
    there.BillAddr = { Line1: "12 Heron Lane", City: "Austin" };
    // The treasurer clears the phone in QuickBooks; the portal's copy of QuickBooks hasn't been read since.
    delete there.PrimaryPhone;
    there.SyncToken = "1";
    // The parent changes only the address: QuickBooks holds the address the portal knew, so it is sent, once more
    // after the stale answer, and the link is aligned with QuickBooks' answer.
    await saveMyContact(a.ctx, form({ phone: "555-0101", line1: "14 Heron Lane", city: "Austin" }, "p:1"));
    await wake();
    expect((await items())[0]).toMatchObject({ state: "done" });
    const aligned = (await linkOfRow(a.row.id))!.syncedToken;
    expect(aligned).toBe(inQuickBooks(stub, "11").SyncToken);
    // Then the phone: the item carries the link's version, the very one QuickBooks holds, and the phone is empty there.
    // The portal never knew it empty, so it is kept as a difference and nothing is sent over the clearing.
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE, line1: "14 Heron Lane", city: "Austin" }, "p:2"));
    const phoneItem = (await items()).find((i) => i.state === "waiting")!;
    expect(phoneItem.request).toMatchObject({ change: { phone: NEW_PHONE }, was: { phone: "555-0101" }, syncToken: aligned });
    await wake();
    expect(await queueItem(phoneItem.id)).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    expect(bodies().filter((b) => "PrimaryPhone" in b)).toEqual([]);
    expect(inQuickBooks(stub, "11").PrimaryPhone).toBeUndefined();
  });

  it("QuickBooks' own refusal: kept, in words that say QuickBooks refused it", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    stub.updateFault = "6000";
    await wake();
    const [item] = await items();
    expect(item).toMatchObject({ state: "refused" });
    expect(whoStopped(item!.lastCode)).toBe("quickbooks");
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE } });
  });

  it("stale twice in a row: waits as never sent, for a later try", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    stub.beforeUpdate = (c) => { c.SyncToken = String(Number(c.SyncToken ?? 0) + 1); }; // someone saves in QuickBooks at every send
    await wake();
    expect(bodies()).toHaveLength(2);
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: false, lastCode: "fault_5010" });
  });

  it("the first send after the take-in: QuickBooks holds what the take-in copied, but for letter case and spacing, and it is sent", async () => {
    const a = await ana();
    await setPersonDetails(a.ana.id, { line1: "12 Heron Lane", city: "Austin" });
    await db.update(qboCustomer).set({ addressLine1: "12  HERON LANE", addressCity: "AUSTIN" }).where(eq(qboCustomer.qboId, "11"));
    inQuickBooks(stub, "11").BillAddr = { Line1: "12  HERON LANE", City: "AUSTIN" };
    await saveMyContact(a.ctx, form({ phone: "555-0101", line1: "14 Heron Lane", city: "Austin" }, "p:1"));
    await wake();
    expect(bodies()).toEqual([expect.objectContaining({ SyncToken: "0", BillAddr: expect.objectContaining({ Line1: "14 Heron Lane", City: "Austin" }) })]);
    expect(bodies()[0]).not.toHaveProperty("PrimaryPhone"); // the phone wasn't changed, so it isn't sent
    expect((await items())[0]).toMatchObject({ state: "done" });
  });

  it("a guardian whose Parent customer slice 9h made, with no phone or address there: sent", async () => {
    const r = await addGuardian(rivera, { name: "Luis Rivera", email: "luis@example.com" }, op);
    if (!r.ok) throw new Error("not added");
    const made = stub.customers.find((c) => c.DisplayName === "Luis Rivera")!;
    stub.calls.length = 0;
    expect(await saveDetails({ kind: "person", parentId: r.parentId }, asSaved({ phone: NEW_PHONE }, "p:0"), { actor: parentActor(r.parentId, "luis@example.com"), ip: null }))
      .toMatchObject({ is: "saved", queued: 1 });
    await wake();
    expect(bodies()).toEqual([{ Id: made.Id, SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
  });

  for (const version of [0, 1]) {
    it(`${version === 0 ? "a person the take-in gave no phone" : "a person whose records disagreed at the take-in"}: read live, kept and listed, and the parent is told nothing`, async () => {
      const a = await ana({ phone: "", version });
      expect(await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, `p:${version}`))).toMatchObject({ ok: true, message: CONTACT_COPY.saved });
      await wake();
      // The cache showed a phone the portal never knew of: read live, nothing sent over it.
      expect(posts()).toEqual([]);
      expect(stub.apiCalls().filter((c) => c.method === "GET" && c.path.endsWith("/customer/11"))).toHaveLength(1);
      expect((await items())[0]).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
      const [row] = await loadOpenWrites();
      expect(row).toMatchObject({ state: "refused", words: "Send Ana Rivera's phone to their record under Rivera Family", familyId: rivera, mayResend: true,
        differs: [{ field: "phone", portalKnew: false, quickbooksHolds: true }] });
    });
  }
});

describe("a later change, a lost answer, a removal and what a waiting change holds back (items 3 and 6)", () => {
  it("two saves in a row: the second takes the place of the first, never sent, and carries its before-value", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE, line1: "7 Kestrel Way" }, "p:2"));
    const [first, second] = (await items()).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    expect(first).toMatchObject({ state: "given_up" });
    expect(second).toMatchObject({ state: "waiting", request: { change: { phone: NEW_PHONE, address: { line1: "7 Kestrel Way" } }, was: { phone: "555-0101", address: { line1: "" } } } });
    expect((await auditsOf("roster.write.replaced")).map((r) => r.targetId)).toEqual([first!.id]);
    await wake();
    expect(bodies()).toEqual([expect.objectContaining({ PrimaryPhone: { FreeFormNumber: NEW_PHONE }, BillAddr: expect.objectContaining({ Line1: "7 Kestrel Way" }) })]);
  });

  it("a save while the first may have been sent: the newer value lands last, and the older never after it", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    stub.loseUpdateAnswer = true;
    await wake();
    stub.loseUpdateAnswer = false;
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: true });
    await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "p:2"));
    const second = (await items()).find((i) => i.state === "waiting" && !i.sent)!;
    // The first is left to finish; the second accepts what it asked for as what QuickBooks may hold.
    expect(second.request).toMatchObject({ change: { phone: "512-555-0333" }, was: { phone: "555-0101" }, orWas: [{ phone: NEW_PHONE }] });
    await wake(4 * MIN);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "512-555-0333" } });
    expect(bodies().at(-1)).toMatchObject({ PrimaryPhone: { FreeFormNumber: "512-555-0333" } });
    expect(await openItems()).toEqual([]);
  });

  it("a change of the other field while the first may have been sent: the later one carries both, so neither is lost", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    // The send is cut off before QuickBooks takes it: the change waits as maybe sent.
    stub.dropApi = true;
    await wake();
    stub.dropApi = false;
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: true });
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-0101" } });
    // Only the address this time.
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE, line1: "7 Kestrel Way" }, "p:2"));
    const second = (await items()).find((i) => i.state === "waiting" && !i.sent)!;
    expect(second.request).toMatchObject({ change: { phone: NEW_PHONE, address: { line1: "7 Kestrel Way" } }, was: { phone: "555-0101", address: { line1: "" } }, orWas: [{ phone: NEW_PHONE }] });
    await wake(4 * MIN);
    // Whichever is tried first, QuickBooks ends with both, and nothing is left open or lost.
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: NEW_PHONE }, BillAddr: expect.objectContaining({ Line1: "7 Kestrel Way" }) });
    expect(await openItems()).toEqual([]);
  });

  it("a maybe-sent change never lands after a later one, even once the later one is given up", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    stub.dropApi = true;
    await wake();
    stub.dropApi = false;
    await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "p:2"));
    const later = (await items()).find((i) => i.state === "waiting" && !i.sent)!;
    expect(await giveUp(later.id, "The club will sort it out.", op)).toMatchObject({ ok: true });
    stub.calls.length = 0;
    await wake(4 * MIN);
    // The older change no longer holds the portal's details: given up, nothing sent.
    expect(posts()).toEqual([]);
    expect(await openItems()).toEqual([]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-0101" } });
    expect((await auditsOf("roster.write.given_up")).map((r) => r.after)).toContainEqual(expect.objectContaining({ why: "superseded", sentNow: false }));
  });

  it("removing the guardian gives up their change that never left, and sends none of it", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    const [item] = await items();
    expect(await removeGuardian(a.row.id, "Moved away.", op)).toMatchObject({ ok: true });
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    await wake();
    expect(bodies().filter((b) => "PrimaryPhone" in b || "BillAddr" in b)).toEqual([]);
  });

});

describe("a parent's change of their details blocks nothing, in any state (the second read's item 4)", () => {
  const givenUpWhy = async () => (await auditsOf("roster.write.given_up")).map((r) => (r.after as { why?: string }).why);
  const phoneSent = () => bodies().filter((b) => "PrimaryPhone" in b);

  it("the family action goes through while it waits; the change is then given up unsent at its next try", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    const [item] = await items();
    const c = (await familyCover("10"))!;
    const stamp = coverStamp(String(rivera), [c.family.qboId, ...c.under.map((u) => u.qboId)]);
    expect((await askFamilyInactive(String(rivera), stamp, tag, op)).result).toMatchObject({ ok: true });
    expect((await db.select().from(family).where(eq(family.id, rivera)))[0]).toMatchObject({ active: false });
    await wake();
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    expect(await givenUpWhy()).toContain("guardian_removed");
    expect(phoneSent()).toEqual([]);
  });

  it("a removed guardian's change that may have been sent is given up unsent at its next try, never sent to a record no longer theirs", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    const [item] = await items();
    stub.dropApi = true;
    await wake();
    stub.dropApi = false;
    expect(await queueItem(item!.id)).toMatchObject({ state: "waiting", sent: true });
    expect(await removeGuardian(a.row.id, "Moved away.", op)).toMatchObject({ ok: true });
    // Left to finish, as one that may have been sent.
    expect(await queueItem(item!.id)).toMatchObject({ state: "waiting" });
    stub.calls.length = 0;
    await wake(4 * MIN);
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    expect(await givenUpWhy()).toContain("guardian_removed");
    expect(phoneSent()).toEqual([]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-0101" } });
  });

  it("a rename and a change of the details of one Parent customer both land, in either order", async () => {
    const a = await ana();
    // The details first, then the person's rename, which is sent at once and moves the link's version on.
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    expect(await renamePerson(a.ana.id, "Ana M. Rivera", op)).toMatchObject({ ok: true, changed: true });
    await wake();
    expect(inQuickBooks(stub, "11")).toMatchObject({ DisplayName: "Ana M. Rivera", PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    expect(await openItems()).toEqual([]);
    // The rename first, then the details.
    expect(await renamePerson(a.ana.id, "Ana Rivera", op)).toMatchObject({ ok: true, changed: true });
    await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "p:2"));
    await wake(4 * MIN);
    expect(inQuickBooks(stub, "11")).toMatchObject({ DisplayName: "Ana Rivera", PrimaryPhone: { FreeFormNumber: "512-555-0333" } });
    expect(await openItems()).toEqual([]);
  });

  it("in books with no parent type, a student is moved and added, and the family renamed, while the family's change waits; all of it lands", async () => {
    await storeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "f:0"));
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", targetQboId: "10" });
    expect(await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Household" }, tag, op)).toMatchObject({ ok: true });
    expect(await addStudentToLinked(String(rivera), "Mia Rivera", tag, op)).toMatchObject({ ok: true });
    const leo = await recordOfCustomer("12", "student");
    expect(await moveStudent(String(leo), String(chen), tag, op)).toMatchObject({ ok: true });
    await wake();
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    expect(inQuickBooks(stub, "10")).toMatchObject({ DisplayName: "Rivera Household", PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    expect(inQuickBooks(stub, "12")).toMatchObject({ ParentRef: { value: "20" } });
    expect(stub.customers.some((c) => c.DisplayName === "Mia Rivera")).toBe(true);
    expect(await openItems()).toEqual([]);
  });
});

describe("Reconciliation and a family's page (item 7, and the second read's items 3 and 5)", () => {
  /** A change kept because QuickBooks holds a phone the portal never knew of. */
  async function kept() {
    const a = await ana({ phone: "" });
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    await wake();
    stub.calls.length = 0;
    return a;
  }
  const decode = (html: string) => html.replaceAll("&#x27;", "'");
  const DIDNT_KNOW = "The portal held it back: the portal didn't know this record's phone when the change was saved, and QuickBooks holds one, so the portal's phone wasn't sent over it.";
  const compares = () => auditsOf("parent.details.compared");
  const staffActor = (s: { id: string; email: string }) => ({ door: "staff" as const, id: s.id, label: s.email });

  it("the list says which details differ and whose, in true words, and holds no phone or address for any reader", async () => {
    await kept();
    const [row] = await loadOpenWrites();
    expect(row).toMatchObject({ words: "Send Ana Rivera's phone to their record under Rivera Family", differs: [{ field: "phone", portalKnew: false, quickbooksHolds: true }], shown: "" });
    expect(keptWordsFor(row!.write, row!.lastCode, row!.holds, row!.differs)).toBe(DIDNT_KNOW);
    const readers: [string, string[]][] = [["reader@club.org", ["Roster.Read"]], ["treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]],
      ["parents@club.org", ["Roster.Read", "Parents.ReadWrite"]], ["registrar2@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]]];
    for (const [email, patterns] of readers) {
      asStaff(await staffWith(email, patterns));
      const html = decode(await renderPage(ReconciliationPage));
      expect(html, email).toContain("Send Ana Rivera's phone to their record under Rivera Family");
      expect(html, email).toContain(DIDNT_KNOW);
      for (const value of ["555-0101", NEW_PHONE]) expect(html, `${email} ${value}`).not.toContain(value);
      expect(html, email).not.toContain("Send the portal's value");
      // Only a reader who may see a person's details is offered the compare view.
      expect(html.includes(`?compare=${row!.id}`), email).toBe(patterns.includes("Parents.ReadWrite"));
    }
    expect(await compares()).toEqual([]);
    // The family's page lists it in the same words, with no buttons and no values.
    const page = decode(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    expect(page).toContain(DIDNT_KNOW);
    expect(page).not.toContain(NEW_PHONE);
  });

  it("where the portal knew a phone: that QuickBooks holds a different one, or none", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    Object.assign(inQuickBooks(stub, "11"), { SyncToken: "3", PrimaryPhone: { FreeFormNumber: "555-9999" } });
    await wake();
    let [row] = await loadOpenWrites();
    expect(row).toMatchObject({ state: "refused", differs: [{ field: "phone", portalKnew: true, quickbooksHolds: true }] });
    expect(keptWordsFor(row!.write, row!.lastCode, row!.holds, row!.differs))
      .toBe("The portal held it back: QuickBooks holds a different phone for this record from the one the portal last knew, so the portal's phone wasn't sent over it.");
    // Cleared there since, as the roster's next read shows it.
    await db.update(qboCustomer).set({ phone: null }).where(eq(qboCustomer.qboId, "11"));
    [row] = await loadOpenWrites();
    expect(keptWordsFor(row!.write, row!.lastCode, row!.holds, row!.differs))
      .toBe("The portal held it back: QuickBooks holds no phone for this record, where the portal last knew one, so the portal's phone wasn't sent over it.");
  });

  it("once the portal's copy shows no difference, the words claim nothing QuickBooks no longer holds; with no copy to compare, they speak of the try", async () => {
    await kept();
    // A treasurer cleared the phone the portal never knew, and the next read stores it so: nothing differs now.
    await db.update(qboCustomer).set({ phone: null }).where(eq(qboCustomer.qboId, "11"));
    const [row] = await loadOpenWrites();
    expect(row).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS, differs: [] });
    const words = keptWordsFor(row!.write, row!.lastCode, row!.holds, row!.differs);
    expect(words).toBe("The portal held it back when it was tried: QuickBooks held other details for this record then than the ones the portal last knew, so the portal's details weren't sent over them. The portal's latest copy of QuickBooks shows no difference now.");
    expect(words).not.toContain("QuickBooks holds one");
    // A caller with no copy to compare (a press's refusal) says what the try found, in the past.
    expect(keptWordsFor(row!.write, row!.lastCode, row!.holds))
      .toBe("The portal held it back: the portal didn't know this record's phone when the change was saved, and QuickBooks held one when it was tried, so the portal's phone wasn't sent over it.");
  });

  it("the compare view: audited before it shows both values, as text, with \"Send the portal's value\" beside them", async () => {
    const a = await kept();
    const [row] = await loadOpenWrites();
    const staff = await staffWith("registrar2@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]);
    asStaff(staff);
    const html = decode(await renderPage(ReconciliationPage, { searchParams: { compare: row!.id.toUpperCase() } }));
    expect(html).toContain("QuickBooks has: phone 555-0101.");
    expect(html).toContain(`The portal has: phone ${NEW_PHONE}.`);
    expect(html).toContain("Send the portal's value");
    const [audit] = await compares();
    expect(await compares()).toHaveLength(1);
    expect(audit).toMatchObject({ actorId: staff.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: a.ana.id, after: { queueId: row!.id } });
  });

  it("a reader without Parents.ReadWrite, a made-up id, another kind of item, or a record gone: the plain list, and no audit row", async () => {
    await kept();
    const [row] = await loadOpenWrites();
    const rename = await seedQueued({ op: "rename", role: "family", qboId: "20", syncToken: "0", name: "Chen Household", was: "Chen Family" }, { state: "refused", code: "fault_6000" });
    const holder = await staffWith("parents@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]);
    const without = await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    const plain = (html: string) => {
      for (const value of ["555-0101", NEW_PHONE, "QuickBooks has: ", "The portal has: "]) expect(decode(html)).not.toContain(value);
    };
    for (const [who, compare] of [[without, row!.id], [holder, randomUUID()], [holder, "not-a-uuid"], [holder, rename.id], [holder, [row!.id, row!.id]]] as const) {
      asStaff(who);
      plain(await renderPage(ReconciliationPage, { searchParams: { compare: compare as string | string[] } }));
    }
    // The family made inactive in the portal since: the record is gone, so neither value is shown and no compare is offered.
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    asStaff(holder);
    const html = await renderPage(ReconciliationPage, { searchParams: { compare: row!.id } });
    plain(html);
    expect(html).not.toContain(`?compare=${row!.id}`);
    expect(await compareContact(row!.id, { actor: staffActor(holder), ip: null })).toBeNull();
    expect(await compares()).toEqual([]);
  });

  it("the stamp bound into the press is keyed with the server's secret, never a constant", async () => {
    const held = { phone: "555-0101", address: { line1: "", line2: "", city: "", region: "", postalCode: "", country: "" } };
    const w = { change: { phone: NEW_PHONE } };
    expect(contactShownUnder("one secret", held, w)).not.toBe(contactShownUnder("another secret", held, w));
    expect(contactShown(held, w)).toBe(contactShownUnder(env.BETTER_AUTH_SECRET, held, w));
    expect(contactShown(held, w)).not.toBe(contactShownUnder("contact-shown", held, w));
  });

  it("\"Send the portal's value\" from the compare view sends the portal's details as they are now, over what it showed, with the live version", async () => {
    const a = await kept();
    const [row] = await loadOpenWrites();
    const view = (await compareContact(row!.id, { actor: staffActor(await staffWith("registrar2@club.org", ["Parents.ReadWrite"])), ip: null }))!;
    expect(view).toMatchObject({ id: row!.id, quickbooks: "phone 555-0101", portal: `phone ${NEW_PHONE}` });
    // A stamp of anything but what the view showed sends nothing.
    expect(await sendPortalValue(row!.id, "something else", portalValueStamp(row!.id, "something else"), op)).toMatchObject({ ok: false });
    expect(await sendPortalValue(row!.id, row!.shown, portalValueStamp(row!.id, row!.shown), op)).toMatchObject({ ok: false });
    expect(posts()).toEqual([]);
    expect(await sendPortalValue(row!.id, view.shown, portalValueStamp(row!.id, view.shown), op)).toEqual({ ok: true, message: "Sent: QuickBooks has the portal's details now." });
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
    expect(await queueItem(row!.id)).toMatchObject({ state: "done" });
    expect((await auditsOf("roster.write.sent_again"))).toHaveLength(1);
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE } });
  });

  it("a parent's newer save while \"Send the portal's value\" is on its way: nothing sent from the row, and the press says the newer change took its place", async () => {
    const a = await kept();
    const [row] = await loadOpenWrites();
    const before = (await queueItem(row!.id))!;
    const view = (await compareContact(row!.id, { actor: staffActor(await staffWith("registrar2@club.org", ["Parents.ReadWrite"])), ip: null }))!;
    // The portal's details change while the press reads QuickBooks, after it chose what to send.
    stub.onApiRequest = async (call) => {
      if (call.method !== "GET" || !call.path.endsWith("/customer/11")) return;
      stub.onApiRequest = null;
      await setPersonDetails(a.ana.id, { phone: "512-555-0999" });
    };
    expect(await sendPortalValue(row!.id, view.shown, portalValueStamp(row!.id, view.shown), op)).toEqual({ ok: true, status: "waiting", message: CONTACT_SUPERSEDED_AT_PRESS });
    expect(posts()).toEqual([]);
    // Given up with nothing sent, its mark as maybe sent what it was before the press.
    expect(await queueItem(row!.id)).toMatchObject({ state: "given_up", sent: before.sent });
    expect((await auditsOf("roster.write.given_up")).map((r) => r.after)).toContainEqual(expect.objectContaining({ why: "superseded", sentNow: false }));
  });

  it("one whose Parent customer QuickBooks has moved since: not offered, in words that say QuickBooks' record changed, and the press refused so", async () => {
    await kept();
    await moveInQuickBooksOnly(["11"], "20");
    const [row] = await loadOpenWrites();
    expect(row).toMatchObject({ mayResend: false, notOffered: "not_own" });
    const view = (await compareContact(row!.id, { actor: staffActor(await staffWith("registrar2@club.org", ["Parents.ReadWrite"])), ip: null }))!;
    expect(await sendPortalValue(row!.id, view.shown, portalValueStamp(row!.id, view.shown), op)).toEqual({ ok: false, errors: [CONTACT_NOT_OFFERED.not_own] });
    expect(posts()).toEqual([]);
  });

  it("\"Give up\": the portal keeps its details, QuickBooks keeps its own", async () => {
    const a = await kept();
    const [row] = await loadOpenWrites();
    const r = await giveUp(row!.id, "The club will sort it out.", op);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.message).toContain("The portal keeps its own phone and mailing address, and QuickBooks keeps the details it has");
    expect(posts()).toEqual([]);
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE } });
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-0101" } });
  });
});

describe("the list works out every kept change's answer at once (the second read's items 6 and 8)", () => {
  type ContactWrite = Extract<RosterWrite, { op: "contact" }>;
  it("a dozen kept rows: one transaction for all, each answer as contactStopNow() gives it for that row, and the family's own words", async () => {
    const a = await ana();
    // Mei Chen as a guardian of the Chen family, with her own Parent customer 21; and a guardian of Rivera's removed.
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com" });
    const meiRow = await seedGuardian({ parentId: mei.id, familyQboId: "20", sourceQboId: "21", status: "active" });
    const old = await seedParent({ name: "Old Rivera", email: "old@example.com" });
    const oldRow = await seedGuardian({ parentId: old.id, familyQboId: "10", status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    await syncAppRecords();
    const contact = (o: Partial<ContactWrite>): ContactWrite => ({ op: "contact", role: "parent", qboId: "11", syncToken: "0", change: { phone: NEW_PHONE }, was: { phone: "555-0101" },
      guardianId: a.row.id, ...o });
    const kinds: [ContactWrite, { familyId?: AppFamilyId }][] = [
      [contact({}), {}],
      [contact({ qboId: "21" }), { familyId: rivera }],
      [contact({ guardianId: oldRow.id }), {}],
      [{ op: "contact", role: "family", qboId: "10", syncToken: "0", change: { phone: NEW_PHONE }, was: { phone: "" } }, {}],
      [contact({ qboId: "21", guardianId: meiRow.id }), {}],
    ];
    for (let i = 0; i < 12; i++) {
      const [w, o] = kinds[i % kinds.length]!;
      await seedQueued(w, { state: "refused", code: CONTACT_DIFFERS, ...o });
    }
    // QuickBooks has the Chen family's own customer inactive: Mei's record under it is the family's matter, said so.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "20"));
    const rows = (await db.select().from(writeQueue)).map((r) => ({ id: r.id, w: r.request as ContactWrite, familyId: r.familyId }));
    expect(rows).toHaveLength(12);
    const spy = vi.spyOn(db, "transaction");
    const all = await contactStopsNow(rows);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    for (const r of rows) expect(all.get(r.id), JSON.stringify(r.w)).toEqual(await contactStopNow(r.w, r));
    expect(new Set(all.values())).toEqual(new Set([null, "not_own", "record_gone", "books_changed", "family_off"]));
    expect(CONTACT_NOT_OFFERED.family_off).toMatch(/^The guardian's family in the portal is no longer linked to a customer in QuickBooks, or QuickBooks has that family's customer inactive/);
    // The list gives those answers, in as many transactions for twelve rows as for one.
    const counted = async () => {
      const s = vi.spyOn(db, "transaction");
      const views = await loadOpenWrites();
      const n = s.mock.calls.length;
      s.mockRestore();
      return { views, n };
    };
    const twelve = await counted();
    for (const v of twelve.views) expect(v.notOffered, v.id).toBe(all.get(v.id));
    await db.delete(writeQueue).where(sql`${writeQueue.id} <> ${rows[0]!.id}`);
    const one = await counted();
    expect(one.views).toHaveLength(1);
    expect(twelve.n).toBe(one.n);
  });
});

describe("books with no parent type, and flat books: the family's details go to the family's own linked customer (item 3)", () => {
  const shapes: MembershipShape[] = [{ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, { kind: "flat", memberTypeIds: ["1"] }];
  for (const shape of shapes) {
    it(`${shape.kind === "flat" ? "flat" : "layered with no parent type"}: one item for the family's customer, sent and its link aligned`, async () => {
      await storeShape(shape);
      const a = await ana();
      expect(await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "f:0"))).toEqual({ ok: true, message: CONTACT_COPY.savedFamily, current: asSaved({ phone: NEW_PHONE }, "f:1") });
      const [item] = await items();
      expect(item).toMatchObject({ familyId: rivera, targetQboId: "10", request: { op: "contact", role: shape.kind === "flat" ? "member" : "family", qboId: "10", change: { phone: NEW_PHONE }, was: { phone: "" } } });
      expect((item!.request as { guardianId?: string }).guardianId).toBeUndefined();
      await wake();
      expect(bodies()).toEqual([{ Id: "10", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
      const [link] = await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera));
      expect(link).toMatchObject({ customerId: "10", syncedToken: "1" });
    });
  }
});
