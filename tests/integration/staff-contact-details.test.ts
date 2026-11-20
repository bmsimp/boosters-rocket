import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, qboCustomer, writeQueue, type RosterWrite } from "@/lib/db/schema";
import { AccessDenied, type ParentCtx } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import type { ContactValues } from "@/lib/parents/contact-fields";
import { CONTACT_COPY, loadMyContact, saveDetails, saveMyContact } from "@/lib/parents/contact-edits";
import { CONTACT_REPLACED_NOTE } from "@/lib/parents/contact-queue";
import { contactSavedWords, CONTACT_DIFFERS, keptContactWords, RosterBusyAtTry, SAVED_LEASE_MS, SENDING_LOCK, sendContactSaved, STAFF_DETAILS_COPY, trySavedItem } from "@/lib/roster/writes";
import { giveUp, runWriteQueue } from "@/lib/roster/queue";
import type { MembershipShape } from "@/lib/roster/shape";
import { savePersonDetailsAction } from "@/app/staff/(app)/parents/actions";
import { saveFamilyDetailsAction } from "@/app/staff/(app)/roster/write-actions";
import PersonPage from "@/app/staff/(app)/parents/[id]/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { NO_DETAILS, familyDetails, inQuickBooks, personDetails, setFamilyDetails, setPersonDetails, takeInDone, takeInNotRun } from "../helpers/contact";
import { resetDb, seedGuardian, seedParent, untilALockIsAwaited } from "../helpers/db";
import { FZN_SHAPE, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { auditsOf, connectRoster, queueItem, seedAnaRivera, staffWith } from "../helpers/roster-writes";
import { storeShape } from "../helpers/roster-cache";
import { holdTheRosterLock } from "../helpers/reconcile";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Stage 3's slice 11c: staff see and change a guardian's phone and mailing address, on the person's page (books with a
 * parent type) or the family's page (books with none, flat books included), through the parent's own save
 * (saveDetails()), and each change is tried at once after the save's commit (sendContactSaved()), through the one try
 * every change saved first takes. The company is FZN-shaped (fznCompany(), tests/helpers/qbo-stub.ts): Ana Rivera's own
 * record is customer 11, under the Rivera Family, 10, with the phone 555-0101. Every request is the stub's: `posts()`
 * proves what was sent.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const NEW_PHONE = "512-555-0222";
const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
const items = () => db.select().from(writeQueue);
/** The form as the staff form sends it: the seven fields, and the version it was drawn at. */
const form = (v: Partial<ContactValues>, version: string) => ({ ...NO_DETAILS, ...v, version });
const asSaved = (v: Partial<ContactValues>, version: string) => ({ values: { ...NO_DETAILS, ...v }, version });
const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"");
/** The worker's wake once a staff member's items are past their lease. */
const wakeAfterLease = () => runWriteQueue(new Date(Date.now() + SAVED_LEASE_MS + 2 * MIN));
const SAVED = STAFF_DETAILS_COPY.savedPerson;
const SAVED_FAMILY = STAFF_DETAILS_COPY.savedFamily;
const inQb = (family: string) => `QuickBooks has them on their record under ${family} now.`;
const NO_PARENT_TYPE: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null };
const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["1"] };

let rivera: AppFamilyId, chen: AppFamilyId;
let registrar: Awaited<ReturnType<typeof staffWith>>;
beforeEach(async () => {
  await resetDb(); stub.reset();
  await connectRoster(stub);
  await takeInDone();
  registrar = await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]);
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
  stub.calls.length = 0;
});

/** Ana Rivera, a guardian of the Rivera family, with the phone the take-in copied from her own record (version 1). */
async function ana() {
  const seeded = await seedAnaRivera({ status: "active" });
  await setPersonDetails(seeded.ana.id, { phone: "555-0101" }, 1);
  const ctx: ParentCtx = { door: "parent", parentId: seeded.ana.id, sessionId: "a-session", guardianId: seeded.row.id, familyId: rivera, name: "Ana Rivera",
    email: "ana@example.com", families: [], ip: null };
  return { ...seeded, ctx };
}
const staffOp = () => ({ actor: { door: "staff" as const, id: registrar.id, label: registrar.email }, ip: null, permission: "Parents.ReadWrite", staffUserId: registrar.id });
const queueAs = () => ({ askedBy: registrar.id, nextTryAt: new Date(Date.now() + SAVED_LEASE_MS) });
/** Reconciliation's "Give up", as the registrar. */
const reconciler = () => ({ actor: staffOp().actor, ip: null, permission: "Roster.Family.ReadWrite" });
/** A queue item's row held FOR UPDATE in a transaction of its own, so a write to it waits until it is released. */
async function holdTheRow(id: string): Promise<{ release: () => Promise<void> }> {
  let release!: () => void, taken!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const isTaken = new Promise<void>((r) => { taken = r; });
  const held = db.transaction(async (tx) => { await tx.execute(sql`select id from write_queue where id = ${id} for update`); taken(); await released; });
  await isTaken;
  return { release: async () => { release(); await held; } };
}
/** Until the queue item's row reads as `ready` says: the thing itself, read again, never a guessed sleep. */
async function untilTheItem(id: string, ready: (r: NonNullable<Awaited<ReturnType<typeof queueItem>>>) => boolean, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await queueItem(id);
    if (r && ready(r)) return;
    if (Date.now() > until) throw new Error(`The item didn't come to the state asked for within ${timeoutMs} ms.`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe("staff change a person's details on their page: saved, audited, and tried at once (items 1, 3 and 4)", () => {
  it("saved, `parent.details.save` naming the staff member and the permission, and their own Parent customer in QuickBooks at once", async () => {
    const a = await ana();
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1")))
      .toEqual({ ok: true, message: `${SAVED} ${inQb("Rivera Family")}`, current: asSaved({ phone: NEW_PHONE }, "p:2"), compare: [] });
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: NEW_PHONE } });
    const [item] = await items();
    expect(item).toMatchObject({ state: "done", askedBy: registrar.id, askedByLabel: registrar.email, familyId: rivera, targetQboId: "11" });
    const [save] = await auditsOf("parent.details.save");
    expect(save).toMatchObject({ actorId: registrar.id, permission: "Parents.ReadWrite", targetType: "parent", targetId: a.ana.id,
      before: { phone: "555-0101" }, after: { phone: NEW_PHONE, queueIds: [item!.id] } });
    expect(await personDetails(a.ana.id)).toEqual({ values: { ...NO_DETAILS, phone: NEW_PHONE }, version: 2 });
  });

  it("a person in two families: two items, both tried at once, and the answer names both families", async () => {
    const a = await ana();
    await seedGuardian({ parentId: a.ana.id, familyQboId: "20", sourceQboId: "21", status: "active" });
    await syncAppRecords();
    // Her record under the Chen family holds the phone the portal knows for her, as her records agreed at the take-in.
    inQuickBooks(stub, "21").PrimaryPhone = { FreeFormNumber: "555-0101" };
    await db.update(qboCustomer).set({ phone: "555-0101" }).where(eq(qboCustomer.qboId, "21"));
    asStaff(registrar);
    const r = await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"));
    expect(r).toMatchObject({ ok: true, compare: [] });
    expect(r).not.toHaveProperty("status");
    // One sentence per family, in the order of her rows.
    const said = (r as { message: string }).message;
    expect(said.startsWith(`${SAVED} `)).toBe(true);
    expect([...said.slice(SAVED.length + 1).split(/(?<=now\.) /)].sort()).toEqual([inQb("Chen Family"), inQb("Rivera Family")]);
    expect(bodies().map((b) => b.Id).sort()).toEqual(["11", "21"]);
    expect((await items()).map((i) => i.state)).toEqual(["done", "done"]);
  });

  it("a person with no Parent customer of their own: saved, and nothing sent for their membership", async () => {
    const kit = await seedParent({ name: "Kit Rivera", email: "kit@example.com" });
    await seedGuardian({ parentId: kit.id, familyQboId: "10", status: "active" });
    await syncAppRecords();
    asStaff(registrar);
    expect(await savePersonDetailsAction(kit.id, form({ phone: NEW_PHONE }, "p:0"))).toEqual({ ok: true,
      message: `${SAVED} Nothing was sent to QuickBooks for their membership of Rivera Family: the “In QuickBooks” column says where QuickBooks stands for it.`,
      current: asSaved({ phone: NEW_PHONE }, "p:1"), compare: [] });
    expect(await items()).toEqual([]);
    expect(posts()).toEqual([]);
    // And one who is nobody's guardian: saved, with nothing more to say.
    const lone = await seedParent({ name: "Lone Person", email: "lone@example.com" });
    expect(await savePersonDetailsAction(lone.id, form({ phone: NEW_PHONE }, "p:0"))).toEqual({ ok: true, message: SAVED, current: asSaved({ phone: NEW_PHONE }, "p:1"), compare: [] });
  });

  it("the same details again: nothing changed, nothing queued", async () => {
    const a = await ana();
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: "555-0101" }, "p:1"))).toEqual({ ok: true, message: STAFF_DETAILS_COPY.unchanged, current: asSaved({ phone: "555-0101" }, "p:1"), compare: [] });
    expect(await items()).toEqual([]);
    expect(await auditsOf("parent.details.save")).toEqual([]);
  });

  it("a field that can't be saved: refused with its sentence, nothing saved", async () => {
    const a = await ana();
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: "5".repeat(31) }, "p:1"))).toEqual({ ok: false, errors: ["Phone can be up to 30 characters. Please shorten it."] });
    expect(await personDetails(a.ana.id)).toMatchObject({ version: 1, values: { phone: "555-0101" } });
  });
});

describe("a family's details, in books with no parent type and in flat books (items 2 and 3)", () => {
  for (const shape of [NO_PARENT_TYPE, FLAT]) {
    it(`${shape.kind === "flat" ? "flat books" : "layered books with no parent type"}: saved on the family record, its own customer in QuickBooks at once`, async () => {
      await storeShape(shape);
      asStaff(registrar);
      expect(await saveFamilyDetailsAction(String(rivera), form({ phone: NEW_PHONE }, "f:0")))
        .toEqual({ ok: true, message: `${SAVED_FAMILY} QuickBooks has them on Rivera Family's record now.`, current: asSaved({ phone: NEW_PHONE }, "f:1"), compare: [] });
      expect(bodies()).toEqual([{ Id: "10", SyncToken: "0", sparse: true, PrimaryPhone: { FreeFormNumber: NEW_PHONE } }]);
      expect(await familyDetails(rivera)).toEqual({ values: { ...NO_DETAILS, phone: NEW_PHONE }, version: 1 });
      const [item] = await items();
      expect(item).toMatchObject({ state: "done", askedBy: registrar.id, request: { op: "contact", role: shape.kind === "flat" ? "member" : "family", qboId: "10" } });
      expect((await auditsOf("parent.details.save"))[0]).toMatchObject({ actorId: registrar.id, permission: "Roster.Family.ReadWrite", targetType: "family", targetId: String(rivera),
        before: { phone: "" }, after: { phone: NEW_PHONE, queueIds: [item!.id] } });
    });
  }
});

describe("the gate, a parent's change on the queue, and the version (items 3 to 5)", () => {
  it("before the portal has read QuickBooks' details: saved, nothing sent, said so; left with no try counted, and the worker sends it once it may", async () => {
    const a = await ana();
    await takeInNotRun();
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"))).toEqual({ ok: true, status: "waiting", current: asSaved({ phone: NEW_PHONE }, "p:2"), compare: [],
      message: `${SAVED} Nothing was sent to their record under Rivera Family yet: the portal is still waiting for its read of the phones and mailing addresses QuickBooks holds (the first since this version was installed, or since the membership shape was last saved). They are sent once that read is done, usually within a few minutes, and you'll find them on the Reconciliation page until then.` });
    expect(posts()).toEqual([]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, tries: 0 });
    expect(item!.nextTryAt!.getTime()).toBeGreaterThan(Date.now());
    await takeInDone();
    // A wake within the lease leaves it: it is held for the at-once try, as a change saved first is.
    await runWriteQueue();
    expect(posts()).toEqual([]);
    await wakeAfterLease();
    expect(bodies()).toEqual([expect.objectContaining({ Id: "11", PrimaryPhone: { FreeFormNumber: NEW_PHONE } })]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
  });

  it("a parent's change waiting, never sent: staff's takes its place, and is sent at once", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    const [theirs] = await items();
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: "512-555-0333" }, "p:2"))).toMatchObject({ ok: true, message: `${SAVED} ${inQb("Rivera Family")}` });
    expect(await queueItem(theirs!.id)).toMatchObject({ state: "given_up", note: CONTACT_REPLACED_NOTE });
    expect(bodies()).toEqual([expect.objectContaining({ Id: "11", PrimaryPhone: { FreeFormNumber: "512-555-0333" } })]);
  });

  it("a parent's change that may have been sent: staff's carries it as `orWas`, is never refused, and lands last", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    stub.loseUpdateAnswer = true;
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    stub.loseUpdateAnswer = false;
    const [theirs] = await items();
    expect(theirs).toMatchObject({ state: "waiting", sent: true });
    asStaff(registrar);
    const r = await savePersonDetailsAction(a.ana.id, form({ phone: "512-555-0333" }, "p:2"));
    expect(r).toMatchObject({ ok: true });
    const mine = (await items()).find((i) => i.id !== theirs!.id)!;
    expect(mine.request).toMatchObject({ change: { phone: "512-555-0333" }, was: { phone: "555-0101" }, orWas: [{ phone: NEW_PHONE }] });
    expect(mine.state).not.toBe("refused");
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "512-555-0333" } });
    expect((await items()).filter((i) => i.state === "refused")).toEqual([]);
  });

  it("a stale form: a parent saved meanwhile, and nothing of theirs is overwritten", async () => {
    const a = await ana();
    await saveMyContact(a.ctx, form({ phone: NEW_PHONE }, "p:1"));
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: "512-555-0333" }, "p:1")))
      .toEqual({ ok: false, errors: [STAFF_DETAILS_COPY.changed], current: asSaved({ phone: NEW_PHONE }, "p:2") });
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: NEW_PHONE }, version: 2 });
    expect((await auditsOf("parent.details.save")).filter((r) => r.actorId === registrar.id)).toEqual([]);
  });

  it("a parent's form drawn before a staff save: refused as changed, shown staff's values, nothing overwritten, nothing queued for it", async () => {
    const a = await ana();
    // The parent opens their details page: the form is drawn at version p:1.
    const drawn = await loadMyContact(a.ctx);
    expect(drawn).toMatchObject({ state: "ok", form: asSaved({ phone: "555-0101" }, "p:1") });
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE, line1: "12 Heron Lane", city: "Austin" }, "p:1"))).toMatchObject({ ok: true });
    const staffItems = await items();
    expect(staffItems).toEqual([expect.objectContaining({ askedBy: registrar.id })]);
    const sentBefore = posts().length;
    // The parent submits the form drawn before it.
    expect(await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "p:1")))
      .toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: asSaved({ phone: NEW_PHONE, line1: "12 Heron Lane", city: "Austin" }, "p:2") });
    expect(await personDetails(a.ana.id)).toEqual({ values: { ...NO_DETAILS, phone: NEW_PHONE, line1: "12 Heron Lane", city: "Austin" }, version: 2 });
    expect((await auditsOf("parent.details.save.failed")).map((r) => [r.door, r.targetType, r.targetId, r.after]))
      .toEqual([["parent", "parent", a.ana.id, { code: "stale" }]]);
    // No second item for the refused submit, and nothing more sent.
    expect((await items()).map((i) => i.id).sort()).toEqual(staffItems.map((i) => i.id).sort());
    expect(posts().length).toBe(sentBefore);
  });

  it("in books with no parent type, a parent's form drawn before staff saved the family's details: refused as changed, shown staff's values", async () => {
    const a = await ana();
    await storeShape(NO_PARENT_TYPE);
    expect(await loadMyContact(a.ctx)).toMatchObject({ state: "ok", form: { version: "f:0" } });
    asStaff(registrar);
    expect(await saveFamilyDetailsAction(String(rivera), form({ phone: NEW_PHONE }, "f:0"))).toMatchObject({ ok: true });
    const staffItems = await items();
    expect(await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "f:0"))).toEqual({ ok: false, errors: [CONTACT_COPY.changed], current: asSaved({ phone: NEW_PHONE }, "f:1") });
    expect(await familyDetails(rivera)).toEqual({ values: { ...NO_DETAILS, phone: NEW_PHONE }, version: 1 });
    expect((await items()).map((i) => i.id).sort()).toEqual(staffItems.map((i) => i.id).sort());
  });

  it("two staff at once from one version: one wins, the other is told it changed, nothing overwritten", async () => {
    const a = await ana();
    const other = await staffWith("treasurer@club.org", ["Roster.Read", "Parents.ReadWrite"]);
    asStaff(registrar);
    const first = savePersonDetailsAction(a.ana.id, form({ phone: "512-555-0333" }, "p:1"));
    asStaff(other);
    const second = savePersonDetailsAction(a.ana.id, form({ phone: "512-555-0444" }, "p:1"));
    const answers = await Promise.all([first, second]);
    const won = answers.filter((r) => r.ok), lost = answers.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toEqual([expect.objectContaining({ ok: false, errors: [STAFF_DETAILS_COPY.changed] })]);
    const kept = (won[0] as { current: { values: ContactValues } }).current.values.phone;
    expect(await personDetails(a.ana.id)).toMatchObject({ values: { phone: kept }, version: 2 });
    expect(await auditsOf("parent.details.save")).toHaveLength(1);
  });

  it("a form drawn for the person's details after a shape save made them the family's: answered as changed, neither row saved", async () => {
    const a = await ana();
    await storeShape(NO_PARENT_TYPE);
    asStaff(registrar);
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"))).toEqual({ ok: false, errors: [STAFF_DETAILS_COPY.whoseChanged] });
    // And the other way round: the family's form, after a shape with a parent type again.
    await storeShape(FZN_SHAPE);
    expect(await saveFamilyDetailsAction(String(rivera), form({ phone: NEW_PHONE }, "f:0"))).toEqual({ ok: false, errors: [STAFF_DETAILS_COPY.whoseChanged] });
    // A family's version on the person's form is the other row's: answered as changed, with the person's as they stand.
    expect(await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "f:1"))).toEqual({ ok: false, errors: [STAFF_DETAILS_COPY.changed], current: asSaved({ phone: "555-0101" }, "p:1") });
    expect(await personDetails(a.ana.id)).toMatchObject({ version: 1, values: { phone: "555-0101" } });
    expect(await familyDetails(rivera)).toMatchObject({ version: 0, values: NO_DETAILS });
    expect(await items()).toEqual([]);
  });
});

describe("ids no page sends, and who may (items 1 to 3)", () => {
  it("another person's id at a version not theirs, a student's, a family's, a non-uuid, odd fields: refused, nothing of anyone changed or queued", async () => {
    const a = await ana();
    await setPersonDetails(a.ana.id, {}, 3);
    const kit = await seedParent({ name: "Kit Rivera", email: "kit@example.com" });
    const leo = String(await recordOfCustomer("12", "student"));
    asStaff(registrar);
    // Ana's form (version 3) sent with Kit's id: the version is checked against Kit's own row, which isn't at it, so
    // nothing is saved on it. (At Kit's own version it would be: the next test.)
    expect(await savePersonDetailsAction(kit.id, form({ phone: NEW_PHONE }, "p:3"))).toMatchObject({ ok: false, errors: [STAFF_DETAILS_COPY.changed] });
    for (const id of [leo, String(rivera), "not-a-uuid", "11", 11 as unknown as string]) expect(await savePersonDetailsAction(id, form({ phone: NEW_PHONE }, "p:3")), String(id)).toEqual(NOT_FROM_PAGE);
    for (const sent of [{ ...form({}, "p:3"), phone: 7 }, { phone: NEW_PHONE }, "phone=1", null, form({ phone: NEW_PHONE }, "3")]) {
      expect(await savePersonDetailsAction(a.ana.id, sent)).toEqual(NOT_FROM_PAGE);
    }
    // The family's form: a student's id, a person's, a non-uuid; an inactive family is refused in words.
    await storeShape(NO_PARENT_TYPE);
    for (const id of [leo, a.ana.id, "10", "not-a-uuid"]) expect(await saveFamilyDetailsAction(id, form({ phone: NEW_PHONE }, "f:0")), id).toEqual(NOT_FROM_PAGE);
    await db.update(family).set({ active: false }).where(eq(family.id, chen));
    expect(await saveFamilyDetailsAction(String(chen), form({ phone: NEW_PHONE }, "f:0")))
      .toEqual({ ok: false, errors: ["This family is inactive in the portal, so its details can't be changed. Nothing was saved."] });
    expect(await personDetails(a.ana.id)).toMatchObject({ version: 3, values: { phone: "555-0101" } });
    expect(await personDetails(kit.id)).toMatchObject({ version: 0, values: NO_DETAILS });
    for (const f of [rivera, chen]) expect(await familyDetails(f)).toMatchObject({ version: 0, values: NO_DETAILS });
    expect(await items()).toEqual([]);
    expect(await auditsOf("parent.details.save")).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("what the version check is: another record's id at that record's own version is saved on that record, as its own page would save it", async () => {
    // The id is checked as a record the portal holds and the version as that record's own; nothing else tells one
    // record's form from another's, and both actions' permissions already cover every such record. So a form sent with
    // another person's (or another active family's) id at that one's own version changes that one, audited as theirs,
    // and the record the form was drawn for is left as it was.
    const a = await ana();
    const kit = await seedParent({ name: "Kit Rivera", email: "kit@example.com" });
    asStaff(registrar);
    expect(await savePersonDetailsAction(kit.id, form({ phone: NEW_PHONE }, "p:0"))).toMatchObject({ ok: true, current: asSaved({ phone: NEW_PHONE }, "p:1") });
    expect(await personDetails(kit.id)).toEqual({ values: { ...NO_DETAILS, phone: NEW_PHONE }, version: 1 });
    expect(await personDetails(a.ana.id)).toMatchObject({ version: 1, values: { phone: "555-0101" } });
    expect((await auditsOf("parent.details.save")).map((r) => r.targetId)).toEqual([kit.id]);
    // A family record that isn't the page's: Rivera's form at f:0 sent with Chen's id, both at version 0.
    await storeShape(NO_PARENT_TYPE);
    expect(await saveFamilyDetailsAction(String(chen), form({ phone: NEW_PHONE }, "f:0"))).toMatchObject({ ok: true, current: asSaved({ phone: NEW_PHONE }, "f:1") });
    expect(await familyDetails(chen)).toEqual({ values: { ...NO_DETAILS, phone: NEW_PHONE }, version: 1 });
    expect(await familyDetails(rivera)).toMatchObject({ version: 0, values: NO_DETAILS });
    expect((await auditsOf("parent.details.save")).map((r) => r.targetId).sort()).toEqual([String(chen), kit.id].sort());
  });

  it("a holder of Roster.Read alone is refused by both actions, and the family's page shows them no details and no form", async () => {
    await ana();
    await storeShape(NO_PARENT_TYPE);
    await setFamilyDetails(rivera, { phone: "555-0177", line1: "9 Plover Row" }, 1);
    const page = async () => decode(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    const reader = await staffWith("reader@club.org", ["Roster.Read"]);
    asStaff(reader);
    await expect(savePersonDetailsAction((await seedParent({ name: "Kit", email: "kit@example.com" })).id, form({ phone: NEW_PHONE }, "p:0"))).rejects.toBeInstanceOf(AccessDenied);
    await expect(saveFamilyDetailsAction(String(rivera), form({ phone: NEW_PHONE }, "f:1"))).rejects.toBeInstanceOf(AccessDenied);
    let html = await page();
    for (const shown of ["555-0177", "9 Plover Row", "Phone and mailing address", "Save details"]) expect(html, shown).not.toContain(shown);
    // Parents.ReadWrite sees them, with no form; Roster.Family.ReadWrite gets the form.
    asStaff(await staffWith("parents@club.org", ["Roster.Read", "Parents.ReadWrite"]));
    html = await page();
    expect(html).toContain("555-0177");
    expect(html).toContain("9 Plover Row");
    expect(html).not.toContain("Save details");
    asStaff(await staffWith("writer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    html = await page();
    expect(html).toContain("Save details");
    expect(html).toContain("value=\"555-0177\"");
    expect(await familyDetails(rivera)).toMatchObject({ version: 1 });
  });
});

describe("the at-once try, whatever stands in its way (item 4)", () => {
  it("the item's lock held: nothing sent, not marked as sent, left for the worker, which sends it once its lease has run out", async () => {
    const a = await ana();
    asStaff(registrar);
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${a.row.id}::text))`);
      return savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"));
    });
    expect(r).toEqual({ ok: true, status: "waiting", current: asSaved({ phone: NEW_PHONE }, "p:2"), compare: [],
      message: `${SAVED} Nothing was sent to their record under Rivera Family just now: another change to this record is under way at this moment. The portal tries them shortly, and you'll find them on the Reconciliation page until then.` });
    expect(posts()).toEqual([]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, tries: 0 });
    await runWriteQueue();
    expect(posts()).toEqual([]);
    await wakeAfterLease();
    expect(bodies()).toEqual([expect.objectContaining({ Id: "11", PrimaryPhone: { FreeFormNumber: NEW_PHONE } })]);
  });

  it("the roster lock held longer than the wait: nothing sent, never marked as sent, left for the worker", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    const lock = await holdTheRosterLock();
    let sent: Awaited<ReturnType<typeof sendContactSaved>>;
    try {
      const sending = sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp(), { rosterWaitMs: 1_000 });
      // It waits for the roster lock (the proof that it asked for it), then gives up waiting.
      await untilALockIsAwaited();
      sent = await sending;
    } finally {
      await lock.release();
    }
    expect(sent.map((s) => s.got)).toEqual([{ is: "roster" }]);
    expect(contactSavedWords(sent, "person", { mayCompare: true, whoCompares: "" })).toEqual({ status: "waiting", compare: [],
      sentences: ["Nothing was sent to their record under Rivera Family just now: the roster is busy at this moment. The portal tries them shortly, and you'll find them on the Reconciliation page until then."] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: false, tries: 0 })]);
  });

  it("QuickBooks unreachable: waiting, in the words of what the try came to", async () => {
    const a = await ana();
    stub.dropApi = true;
    asStaff(registrar);
    const r = await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"));
    stub.dropApi = false;
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", tries: 1 });
    const words = item!.sent
      ? "The portal can't tell yet whether QuickBooks took them for their record under Rivera Family: its answer didn't arrive. The portal finishes it after its next read of QuickBooks, and you'll find it on the Reconciliation page until then."
      : "Sending them to their record under Rivera Family is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.";
    expect(r).toEqual({ ok: true, status: "waiting", message: `${SAVED} ${words}`, current: asSaved({ phone: NEW_PHONE }, "p:2"), compare: [] });
  });

  it("QuickBooks holds other details: kept as contact_differs, said so, and linked to the compare view for a reader who may open it", async () => {
    const a = await ana();
    inQuickBooks(stub, "11").PrimaryPhone = { FreeFormNumber: "555-9999" };
    await db.update(qboCustomer).set({ phone: "555-9999" }).where(eq(qboCustomer.qboId, "11"));
    asStaff(registrar);
    const r = await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"));
    const [item] = await items();
    expect(item).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    const held = keptContactWords(CONTACT_DIFFERS, item!.request as Extract<RosterWrite, { op: "contact" }>);
    expect(held).toBe("The portal held it back: QuickBooks didn't hold the phone the portal last knew for this record when it was tried, so the portal's phone wasn't sent over it.");
    expect(r).toEqual({ ok: true, status: "attention", current: asSaved({ phone: NEW_PHONE }, "p:2"), compare: [item!.id],
      message: `${SAVED} They didn't reach their record under Rivera Family in QuickBooks. ${held} It is kept on the Reconciliation page: compare the two there, from the link below.` });
    expect(posts()).toEqual([]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryPhone: { FreeFormNumber: "555-9999" } });
    // A reader who may not open Reconciliation is told who can, and given no link.
    asStaff(await staffWith("parents@club.org", ["Parents.ReadWrite"]));
    const again = await savePersonDetailsAction(a.ana.id, form({ phone: "512-555-0444" }, "p:2"));
    const newer = (await items()).find((i) => i.state === "refused" && i.id !== item!.id)!;
    expect(again).toEqual({ ok: true, status: "attention", current: asSaved({ phone: "512-555-0444" }, "p:3"), compare: [],
      message: `${SAVED} They didn't reach their record under Rivera Family in QuickBooks. ${keptContactWords(CONTACT_DIFFERS, newer.request as Extract<RosterWrite, { op: "contact" }>)} It is kept on the Reconciliation page: someone who may see the Reconciliation page can compare the two there.` });
  });

  it("a parent saves again between the commit and the try: given up with nothing sent, and the newer change carries it", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    await saveMyContact(a.ctx, form({ phone: "512-555-0333" }, "p:2"));
    const sent = await sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp());
    expect(sent.map((s) => s.got)).toEqual([{ is: "replaced" }]);
    expect(contactSavedWords(sent, "person", { mayCompare: true, whoCompares: "" })).toEqual({ status: "waiting", compare: [],
      sentences: ["Nothing was sent to their record under Rivera Family from this save: a newer change to these details, saved meanwhile, has taken its place and carries them. The portal sends that one on, and the Reconciliation page lists it if it doesn't go through."] });
    expect(await queueItem(saved.queueIds[0]!)).toMatchObject({ state: "given_up", note: CONTACT_REPLACED_NOTE });
    expect(posts()).toEqual([]);
    await runWriteQueue(new Date(Date.now() + 2 * MIN));
    expect(bodies()).toEqual([expect.objectContaining({ Id: "11", PrimaryPhone: { FreeFormNumber: "512-555-0333" } })]);
  });

  it("the record is no longer the one it is for when it is tried: given up with nothing sent, in its own words", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    // The family is made inactive in the portal between the save and the try.
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    const sent = await sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp());
    expect(sent).toEqual([expect.objectContaining({ familyName: "Rivera Family", got: { is: "stopped", note: "The guardian was removed in the portal, or their family made inactive, before it was sent." } })]);
    expect(contactSavedWords(sent, "person", { mayCompare: true, whoCompares: "" })).toEqual({ status: "attention", compare: [],
      sentences: ["Nothing was sent to their record under Rivera Family: the guardian was removed in the portal, or their family made inactive, before it was sent."] });
    expect(posts()).toEqual([]);
  });

  it("an item tried by someone else between the first read and its lock: read again, left to the worker untouched, never sent again", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    const lock = await holdTheRosterLock();
    let sent: Awaited<ReturnType<typeof sendContactSaved>>;
    try {
      // The at-once try has read the item and holds its lock, waiting for the roster lock; meanwhile the item is tried
      // elsewhere and its answer lost (as the worker leaves one once its lease has run out).
      const sending = sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp(), { rosterWaitMs: 15_000 });
      await untilALockIsAwaited();
      await db.update(writeQueue).set({ sent: true, tries: 1, lastCode: "unreachable", lastTriedAt: new Date() }).where(eq(writeQueue.id, saved.queueIds[0]!));
      await lock.release();
      sent = await sending;
    } finally {
      await lock.release();
    }
    expect(sent.map((s) => s.got)).toEqual([{ is: "waiting", sent: true }]);
    expect(posts()).toEqual([]);
    expect(await queueItem(saved.queueIds[0]!)).toMatchObject({ state: "waiting", sent: true, tries: 1, lastCode: "unreachable" });
  });

  it("the roster lock held at the try's own look: nothing sent, the item as it was, and never waited on past the wait", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    const item = (await queueItem(saved.queueIds[0]!))!;
    if (item.request.op !== "contact") throw new Error("not a contact item");
    const lock = await holdTheRosterLock();
    try {
      // Its first look under the roster lock (the gate) gives up after the wait: the rejection is the proof.
      await expect(trySavedItem(item, item.request, { by: "at_once", linkedBy: registrar.id, actor: staffOp().actor, ip: null, permission: "Parents.ReadWrite", rosterWaitMs: 1_000 }))
        .rejects.toBeInstanceOf(RosterBusyAtTry);
    } finally {
      await lock.release();
    }
    expect(posts()).toEqual([]);
    expect(await queueItem(item.id)).toMatchObject({ state: "waiting", sent: false, tries: 0 });
  });

  it("the roster lock taken after the try marked its item, before its record's check: the mark taken back, nothing sent, no try counted", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    const id = saved.queueIds[0]!;
    const first = (await queueItem(id))!;
    if (first.request.op !== "contact") throw new Error("not a contact item");
    // The item's row held, so the try's mark waits for it once its first look (the gate) has gone through.
    const row = await holdTheRow(id);
    let lock: Awaited<ReturnType<typeof holdTheRosterLock>> | null = null;
    try {
      const trying = trySavedItem(first, first.request, { by: "at_once", linkedBy: registrar.id, actor: staffOp().actor, ip: null, permission: "Parents.ReadWrite", rosterWaitMs: 3_000 })
        .then(() => null, (e: unknown) => e);
      await untilALockIsAwaited();
      lock = await holdTheRosterLock();
      await row.release();
      // Marked as maybe sent (the proof the mark was made), then its record's check gives up waiting for the roster lock.
      await untilTheItem(id, (r) => r.sent);
      expect(await trying).toBeInstanceOf(RosterBusyAtTry);
    } finally {
      await row.release();
      await lock?.release();
    }
    expect(posts()).toEqual([]);
    expect(await queueItem(id)).toMatchObject({ state: "waiting", sent: false, tries: 0, lastTriedAt: first.lastTriedAt, request: first.request, nextTryAt: first.nextTryAt });
  });

  it("given up on Reconciliation while the at-once try waits for the roster lock: said from what the item holds, never promised to the worker", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    const lock = await holdTheRosterLock();
    let sent: Awaited<ReturnType<typeof sendContactSaved>>;
    try {
      const sending = sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp(), { rosterWaitMs: 3_000 });
      // It waits for the roster lock before its try (rosterFreeWithin()); meanwhile staff give the item up.
      await untilALockIsAwaited();
      expect(await giveUp(saved.queueIds[0]!, "Not needed now.", reconciler())).toMatchObject({ ok: true });
      sent = await sending;
    } finally {
      await lock.release();
    }
    expect(sent.map((s) => s.got)).toEqual([{ is: "abandoned", sent: false }]);
    expect(contactSavedWords(sent, "person", { mayCompare: true, whoCompares: "" }).sentences)
      .toEqual(["Nothing was sent to their record under Rivera Family: the change was given up on the Reconciliation page meanwhile. The portal keeps the details."]);
    expect(posts()).toEqual([]);
    expect(await queueItem(saved.queueIds[0]!)).toMatchObject({ state: "given_up", sent: false, tries: 0 });
  });

  it("given up while the try, its item marked, waits for the roster lock at its record's check: the mark taken back, and said from what the item holds", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    const id = saved.queueIds[0]!;
    const first = (await queueItem(id))!;
    // The item's row held, so the try's mark waits for it: the try's first look (the gate) has gone through by then.
    const row = await holdTheRow(id);
    let lock: Awaited<ReturnType<typeof holdTheRosterLock>> | null = null;
    let sent: Awaited<ReturnType<typeof sendContactSaved>>;
    try {
      const sending = sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp(), { rosterWaitMs: 3_000 });
      await untilALockIsAwaited();
      // The roster lock taken before the record's check (contactStops()) asks for it, then the mark let through.
      lock = await holdTheRosterLock();
      await row.release();
      await untilTheItem(id, (r) => r.sent);
      await untilALockIsAwaited();
      expect(await giveUp(id, "Not needed now.", reconciler())).toMatchObject({ ok: true });
      sent = await sending;
    } finally {
      await row.release();
      await lock?.release();
    }
    expect(sent.map((s) => s.got)).toEqual([{ is: "abandoned", sent: false }]);
    expect(posts()).toEqual([]);
    // Given up as staff asked, with no mark of a send that never went.
    expect(await queueItem(id)).toMatchObject({ state: "given_up", sent: false, tries: 0, lastTriedAt: first.lastTriedAt, request: first.request });
  });

  it("given up on Reconciliation between the commit and the try: said so, from what the item holds, and nothing sent", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    await db.update(writeQueue).set({ state: "given_up", finishedAt: new Date() }).where(eq(writeQueue.id, saved.queueIds[0]!));
    const sent = await sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp());
    expect(sent.map((s) => s.got)).toEqual([{ is: "abandoned", sent: false }]);
    expect(contactSavedWords(sent, "person", { mayCompare: true, whoCompares: "" })).toEqual({ status: "attention", compare: [],
      sentences: ["Nothing was sent to their record under Rivera Family: the change was given up on the Reconciliation page meanwhile. The portal keeps the details."] });
    // One that may have been sent before it was given up is never said not to have gone through.
    expect(contactSavedWords([{ ...sent[0]!, got: { is: "abandoned", sent: true } }], "person", { mayCompare: true, whoCompares: "" }).sentences)
      .toEqual(["The change for their record under Rivera Family was given up on the Reconciliation page while it was being sent, so QuickBooks has the details only if that try got through. The portal keeps them."]);
    expect(posts()).toEqual([]);
  });

  it("the details changed again with no newer change queued for the record: given up, and never said to be carried by one", async () => {
    const a = await ana();
    const saved = await saveDetails({ kind: "person", parentId: a.ana.id }, asSaved({ phone: NEW_PHONE }, "p:1"), { ...staffOp(), queueAs: queueAs() });
    if (saved.is !== "saved") throw new Error("not saved");
    // The portal's details change with nothing queued for her record (as a save does once QuickBooks' copy has it inactive).
    await setPersonDetails(a.ana.id, { phone: "512-555-0333" }, 3);
    const sent = await sendContactSaved({ kind: "person", parentId: a.ana.id }, saved.queueIds, staffOp());
    expect(sent.map((s) => s.got)).toEqual([{ is: "outdated" }]);
    expect(contactSavedWords(sent, "person", { mayCompare: true, whoCompares: "" })).toEqual({ status: "attention", compare: [],
      sentences: ["Nothing was sent to their record under Rivera Family from this save: the portal's details changed again after it, and no newer change of them was queued for this record, so nothing goes to QuickBooks for it. This page shows the details the portal holds now."] });
    expect(await queueItem(saved.queueIds[0]!)).toMatchObject({ state: "given_up" });
    expect(posts()).toEqual([]);
  });
});

describe("a family's details kept as a difference, and a family with no link (items 2 and 4)", () => {
  it("kept: said so, the compare view linked in the answer and on the family's page only for a reader holding Parents.ReadWrite", async () => {
    await storeShape(NO_PARENT_TYPE);
    inQuickBooks(stub, "10").PrimaryPhone = { FreeFormNumber: "555-9999" };
    await db.update(qboCustomer).set({ phone: "555-9999" }).where(eq(qboCustomer.qboId, "10"));
    asStaff(registrar);
    const r = await saveFamilyDetailsAction(String(rivera), form({ phone: NEW_PHONE }, "f:0"));
    const [item] = await items();
    expect(item).toMatchObject({ state: "refused", lastCode: CONTACT_DIFFERS });
    const held = keptContactWords(CONTACT_DIFFERS, item!.request as Extract<RosterWrite, { op: "contact" }>);
    expect(r).toEqual({ ok: true, status: "attention", current: asSaved({ phone: NEW_PHONE }, "f:1"), compare: [item!.id],
      message: `${SAVED_FAMILY} They didn't reach Rivera Family's record in QuickBooks. ${held} It is kept on the Reconciliation page: compare the two there, from the link below.` });
    expect(posts()).toEqual([]);
    const page = async () => decode(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }));
    expect(await page()).toContain(`/staff/reconciliation?compare=${item!.id}#writes-h`);
    // A reader who may change families but not see parents' details: told who can, and given no link anywhere.
    asStaff(await staffWith("writer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const again = await saveFamilyDetailsAction(String(rivera), form({ phone: "512-555-0444" }, "f:1"));
    const newer = (await items()).find((i) => i.state === "refused" && i.id !== item!.id)!;
    expect(again).toEqual({ ok: true, status: "attention", current: asSaved({ phone: "512-555-0444" }, "f:2"), compare: [],
      message: `${SAVED_FAMILY} They didn't reach Rivera Family's record in QuickBooks. ${keptContactWords(CONTACT_DIFFERS, newer.request as Extract<RosterWrite, { op: "contact" }>)} It is kept on the Reconciliation page: someone who may see parents' details can compare the two there.` });
    expect(await page()).not.toContain("?compare=");
  });

  it("a family with no link: saved, and nothing sent to QuickBooks for it", async () => {
    await storeShape(NO_PARENT_TYPE);
    const [hand] = await db.insert(family).values({ name: "Hand Family", active: true }).returning({ id: family.id });
    asStaff(registrar);
    expect(await saveFamilyDetailsAction(String(hand!.id), form({ phone: NEW_PHONE }, "f:0")))
      .toEqual({ ok: true, message: `${SAVED_FAMILY} Nothing was sent to QuickBooks for Hand Family.`, current: asSaved({ phone: NEW_PHONE }, "f:1"), compare: [] });
    expect(await items()).toEqual([]);
    expect(posts()).toEqual([]);
  });
});

describe("the person's page: the details, and where QuickBooks stands for them (items 1 and 5)", () => {
  const page = async (id: string) => decode(await renderPage(PersonPage, { params: { id } }));

  it("shows the person's details and the form; a waiting change says so in the In QuickBooks column", async () => {
    const a = await ana();
    await setPersonDetails(a.ana.id, { line1: "12 Heron Lane", city: "Austin" });
    await takeInNotRun();
    asStaff(registrar);
    await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE, line1: "12 Heron Lane", city: "Austin" }, "p:1"));
    const html = await page(a.ana.id);
    expect(html).toContain("Phone and mailing address");
    expect(html).toContain(`value="${NEW_PHONE}"`);
    expect(html).toContain("value=\"12 Heron Lane\"");
    expect(html).toContain("A change to their phone is waiting to reach QuickBooks.");
    expect(html).not.toContain("new name didn't reach QuickBooks");
    expect(html).not.toContain("?compare=");
  });

  it("a kept change: said in true words, with the compare view linked for a reader who may open it, and never what QuickBooks holds", async () => {
    const a = await ana();
    inQuickBooks(stub, "11").PrimaryPhone = { FreeFormNumber: "555-9999" };
    await db.update(qboCustomer).set({ phone: "555-9999" }).where(eq(qboCustomer.qboId, "11"));
    asStaff(registrar);
    await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"));
    const [item] = await items();
    let html = await page(a.ana.id);
    expect(html).toContain("A change to their phone didn't reach QuickBooks (kept: see the Reconciliation page).");
    expect(html).not.toContain("new name didn't reach QuickBooks");
    expect(html).toContain(`/staff/reconciliation?compare=${item!.id}#writes-h`);
    expect(html).not.toContain("555-9999");
    asStaff(await staffWith("parents@club.org", ["Parents.ReadWrite"]));
    html = await page(a.ana.id);
    expect(html).not.toContain("?compare=");
    expect(html).toContain("Someone who may see the Reconciliation page can compare the two there.");
  });

  it("in books with no parent type: no details here, each family's page linked instead", async () => {
    const a = await ana();
    await storeShape(NO_PARENT_TYPE);
    asStaff(registrar);
    const html = await page(a.ana.id);
    expect(html).toContain("a phone and mailing address are each family's, shared by its guardians");
    expect(html).toContain(`href="/staff/roster/${String(rivera)}"`);
    expect(html).not.toContain("555-0101");
    expect(html).not.toContain("Save details");
  });

  it("in books with no parent type and a broken shape: no family's page linked for the details (it would answer Not found), and why in words", async () => {
    const a = await ana();
    // The student type the shape names is one QuickBooks no longer has: the families' pages answer Not found.
    await storeShape({ ...NO_PARENT_TYPE, studentTypeId: "99" });
    asStaff(registrar);
    expect(await pageOutcome(RosterEntryPage, { params: { id: String(rivera) } })).toEqual({ notFound: true });
    const section = detailsSection(await page(a.ana.id));
    expect(section).toContain("a phone and mailing address are each family's");
    expect(section).not.toContain(`href="/staff/roster/${String(rivera)}"`);
    expect(section).toContain("A family's phone and mailing address can't be shown or changed by staff just now: the families' pages are closed until the club's customer types are set again on Settings, QuickBooks. The parent can still change them on their Family page.");
    // Set again, the link is back and the words gone.
    await storeShape(NO_PARENT_TYPE);
    const mended = detailsSection(await page(a.ana.id));
    expect(mended).toContain(`href="/staff/roster/${String(rivera)}"`);
    expect(mended).not.toContain("can't be shown or changed by staff just now");
  });

  /** The page's "Phone and mailing address" section alone. */
  const detailsSection = (html: string) => html.slice(html.indexOf("id=\"pd-h\""), html.indexOf("id=\"pn-h\""));

  it("in books with no parent type: a family they are no longer a guardian of isn't linked as the place their details are kept", async () => {
    const a = await ana();
    await storeShape(NO_PARENT_TYPE);
    await db.execute(sql`update guardian set status = 'disabled' where id = ${a.row.id}`);
    asStaff(registrar);
    const section = detailsSection(await page(a.ana.id));
    expect(section).toContain("a phone and mailing address are each family's");
    expect(section).not.toContain(`href="/staff/roster/${String(rivera)}"`);
  });

  it("a kept change whose record no longer stands (the guardian removed): no compare link, and nobody pointed at one", async () => {
    const a = await ana();
    inQuickBooks(stub, "11").PrimaryPhone = { FreeFormNumber: "555-9999" };
    await db.update(qboCustomer).set({ phone: "555-9999" }).where(eq(qboCustomer.qboId, "11"));
    asStaff(registrar);
    await savePersonDetailsAction(a.ana.id, form({ phone: NEW_PHONE }, "p:1"));
    expect((await items()).map((i) => i.state)).toEqual(["refused"]);
    await db.execute(sql`update guardian set status = 'disabled' where id = ${a.row.id}`);
    const html = await page(a.ana.id);
    expect(html).not.toContain("?compare=");
    expect(html).not.toContain("can compare the two there");
  });
});
