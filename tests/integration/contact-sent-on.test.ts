import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { readFileSync } from "node:fs";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, qboCustomer, writeQueue } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import type { ContactValues } from "@/lib/parents/contact-fields";
import { CONTACT_COPY, saveDetails, saveMyContact } from "@/lib/parents/contact-edits";
import { addGuardian, removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { askFamilyInactive, CONTACT_DIFFERS, CONTACT_NOT_OFFERED, coverStamp, familyCover, keptContactWords, portalValueStamp, SENDING_LOCK, sendPortalValue, whoStopped, WRITE_COPY } from "@/lib/roster/writes";
import { giveUp, loadOpenWrites, runWriteQueue } from "@/lib/roster/queue";
import { ROSTER_LOCK, type MembershipShape } from "@/lib/roster/shape";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { NO_DETAILS, inQuickBooks, personDetails, setPersonDetails } from "../helpers/contact";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedAnaRivera, staffWith } from "../helpers/roster-writes";
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

  it("a person in two families: two items, sent to two records; a family made inactive gets none", async () => {
    const a = await ana();
    // Ana's own record in the Chen family too: Mei Chen's customer, 21, stands for it here.
    await seedGuardian({ parentId: a.ana.id, familyQboId: "20", sourceQboId: "21", status: "active" });
    await syncAppRecords();
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
    it(`${version === 0 ? "a person who saved before the take-in" : "a person whose records disagreed at the take-in"}: read live, kept and listed, and the parent is told nothing`, async () => {
      const a = await ana({ phone: "", version });
      expect(await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, `p:${version}`))).toMatchObject({ ok: true, message: CONTACT_COPY.saved });
      await wake();
      // The cache showed a phone the portal never knew of: read live, nothing sent over it.
      expect(posts()).toEqual([]);
      expect(stub.apiCalls().filter((c) => c.method === "GET" && c.path.endsWith("/customer/11"))).toHaveLength(1);
      expect((await items())[0]).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
      const [row] = await loadOpenWrites({ showDetails: true });
      expect(row).toMatchObject({ state: "refused", words: "Send Ana Rivera's phone to their record under Rivera Family", familyId: rivera, mayResend: true,
        details: { quickbooks: "phone 555-0101", portal: `phone ${NEW_PHONE}` } });
      expect((await loadOpenWrites())[0]!.details).toBeNull();
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

  it("a waiting change holds back the person's rename and the family action, in true words; a kept one blocks nothing", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    expect(await renamePerson(a.ana.id, "Ana M. Rivera", op)).toEqual({ ok: false, reason: "qbo_pending" });
    const c = (await familyCover("10"))!;
    const stamp = coverStamp(String(rivera), [c.family.qboId, ...c.under.map((u) => u.qboId)]);
    expect((await askFamilyInactive(String(rivera), stamp, tag, op)).result).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.update(writeQueue).set({ state: "refused", lastCode: CONTACT_DIFFERS });
    expect(await renamePerson(a.ana.id, "Ana M. Rivera", op)).toMatchObject({ ok: true, changed: true });
  });
});

describe("Reconciliation and a family's page (item 7)", () => {
  /** A change kept because QuickBooks holds a phone the portal never knew of. */
  async function kept() {
    const a = await ana({ phone: "" });
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    await wake();
    stub.calls.length = 0;
    return a;
  }

  it("lists it in words, with what QuickBooks and the portal hold only for staff who may see a person's details", async () => {
    await kept();
    const decode = (html: string) => html.replaceAll("&#x27;", "'");
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    let html = decode(await renderPage(ReconciliationPage));
    expect(html).toContain("Send Ana Rivera's phone to their record under Rivera Family");
    expect(html).toContain(keptContactWords(CONTACT_DIFFERS));
    expect(html).toContain("Send the portal's value");
    expect(html).not.toContain("555-0101");
    expect(html).not.toContain(NEW_PHONE);
    asStaff(await staffWith("parents@club.org", ["Roster.Read", "Parents.ReadWrite"]));
    html = decode(await renderPage(ReconciliationPage));
    expect(html).toContain("QuickBooks has: phone 555-0101.");
    expect(html).toContain(`The portal has: phone ${NEW_PHONE}.`);
    expect(html).not.toContain("Send the portal's value"); // no Roster.Family.ReadWrite
    // The family's page lists it in words, with no buttons.
    const page = decode(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    expect(page).toContain(keptContactWords(CONTACT_DIFFERS));
  });

  it("\"Send the portal's value\" sends the portal's details as they are now, over what the row showed, with the live version", async () => {
    const a = await kept();
    const [row] = await loadOpenWrites();
    // A stamp of anything but what the row showed sends nothing.
    expect(await sendPortalValue(row!.id, "something else", portalValueStamp(row!.id, "something else"), op)).toMatchObject({ ok: false });
    expect(posts()).toEqual([]);
    expect(await sendPortalValue(row!.id, row!.shown, portalValueStamp(row!.id, row!.shown), op)).toEqual({ ok: true, message: "Sent: QuickBooks has the portal's details now." });
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
    expect(await queueItem(row!.id)).toMatchObject({ state: "done" });
    expect((await auditsOf("roster.write.sent_again"))).toHaveLength(1);
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE } });
  });

  it("one whose Parent customer QuickBooks has moved since: not offered, in words that say QuickBooks' record changed, and the press refused so", async () => {
    await kept();
    await moveInQuickBooksOnly(["11"], "20");
    const [row] = await loadOpenWrites();
    expect(row).toMatchObject({ mayResend: false, notOffered: "not_own" });
    expect(await sendPortalValue(row!.id, row!.shown, portalValueStamp(row!.id, row!.shown), op)).toEqual({ ok: false, errors: [CONTACT_NOT_OFFERED.not_own] });
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
