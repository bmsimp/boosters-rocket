import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, parent, qboCustomer, writeQueue } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { AppFamilyId } from "@/lib/families/ids";
import { EMAIL_COPY, confirmMyEmailChange } from "@/lib/parents/email-change";
import { EMAIL_ASKED_BY, queueEmailChange } from "@/lib/parents/contact-queue";
import { removeGuardian } from "@/lib/parents/guardians";
import { blockPerson, renamePerson } from "@/lib/parents/people";
import { addStudentToLinked, askFamilyInactive, coverStamp, EMAIL_ALREADY_THERE, EMAIL_DIFFERS, EMAIL_NOT_OFFERED, EMAIL_SUPERSEDED_AT_PRESS, EMAIL_TOO_LONG, emailShown, emailShownUnder,
  familyCover, INACTIVE_THERE_CODE, keptEmailWords, keptWordsFor, moveStudent, portalValueStamp, renameLinked, SENDING_LOCK, sendPortalValue, whoStopped } from "@/lib/roster/writes";
import { compareEmail, giveUp, loadOpenWrites, runWriteQueue } from "@/lib/roster/queue";
import { env } from "@/env";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { inQuickBooks } from "../helpers/contact";
import { resetDb, seedGuardian, seedParent, seedParentSession, untilALockIsAwaited } from "../helpers/db";
import { seedEmailChange } from "../helpers/email-change";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, queueItem, seedAnaRivera, staffWith } from "../helpers/roster-writes";
import { seedParentSettings, SIGNINS_ON, storeShape } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Stage 3's slice S11e: a parent's confirmed change of sign-in email, the portal's own since slice 11d, is queued in the
 * confirm's own transaction for each record of theirs in QuickBooks, and sent on by the write queue's worker: the own
 * Parent customer of each of their open memberships, or, in books with no parent type, each membership's family's own
 * linked customer. The field sent is made from the field read live: only the address the portal knew there is
 * replaced, and nothing is sent over a field that holds something else. The company is FZN-shaped (fznCompany(),
 * tests/helpers/qbo-stub.ts): Ana Rivera's own record is customer 11, under the Rivera Family, 10, its email field
 * " Ana@Example.com ", and she signs in with ana@example.com. Every request is the stub's: `posts()` proves what was sent.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const MIN = 60_000;
const OLD = "ana@example.com";
const NEW = "ana.new@example.com";
const NEWER = "ana.newer@example.com";
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const bodies = () => posts().map((c) => JSON.parse(c.body) as Record<string, unknown>);
/** The email fields sent, in order. */
const sentFields = () => bodies().flatMap((b) => { const a = (b.PrimaryEmailAddr as { Address?: string } | undefined)?.Address; return a === undefined ? [] : [a]; });
const gets = (id: string) => stub.apiCalls().filter((c) => c.method === "GET" && c.path.endsWith(`/customer/${id}`));
const items = () => db.select().from(writeQueue);
const emailItems = async () => (await items()).filter((i) => i.request.op === "email");
const openItems = async () => (await items()).filter((i) => i.state === "waiting" || i.state === "stuck" || i.state === "refused");
const linkOfRow = async (guardianId: string) => (await db.select().from(accountingLink).where(and(eq(accountingLink.guardianId, guardianId), isNotNull(accountingLink.guardianId))))[0];
/** The worker's next wake, a little later, when the items queued now are due. */
const wake = (afterMs = 2 * MIN) => runWriteQueue(new Date(Date.now() + afterMs));
const DONE = (email: string) => ({ ok: true, message: EMAIL_COPY.done(email), signedOut: true });
/** QuickBooks' email field for a customer changed there, its version raised, as an edit in QuickBooks leaves it. */
const fieldInQuickBooks = (id: string, field: string) => {
  const c = inQuickBooks(stub, id);
  Object.assign(c, { PrimaryEmailAddr: { Address: field }, SyncToken: String(Number(c.SyncToken ?? 0) + 1) });
};
const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&quot;", "\"");
/** The part of the Reconciliation page about the changes waiting to reach QuickBooks: from its heading to the next section. */
const writesSection = (html: string) => { const at = html.indexOf("id=\"writes-h\""); return html.slice(at, html.indexOf("<section", at)); };

type Who = { parentId: string; authUserId: string; guardianId: string; familyId: AppFamilyId; name: string };
/** A confirmed change of sign-in email, as the link's page confirms it: a session of the person's own, their request, then the press. */
async function confirm(who: Who, to: string) {
  const [me] = await db.select({ email: parent.email }).from(parent).where(eq(parent.id, who.parentId));
  const session = await seedParentSession(who.authUserId, { familyId: who.familyId });
  const { token } = await seedEmailChange({ parentId: who.parentId, guardianId: who.guardianId, familyId: who.familyId, recordQboId: null, newEmail: to });
  const ctx: ParentCtx = { door: "parent", parentId: who.parentId, sessionId: session.id, guardianId: who.guardianId, familyId: who.familyId, name: who.name, email: me!.email,
    families: [], ip: null };
  return confirmMyEmailChange(ctx, token);
}

let tag: string;
let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId, chen: AppFamilyId;
beforeEach(async () => {
  await resetDb(); stub.reset();
  tag = await connectRoster(stub);
  await seedParentSettings(SIGNINS_ON);
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
  stub.calls.length = 0;
});

/** Ana Rivera, a guardian of the Rivera family whose own Parent customer is 11. */
async function ana() {
  const seeded = await seedAnaRivera({ status: "active" });
  const who: Who = { parentId: seeded.ana.id, authUserId: seeded.ana.authUserId, guardianId: seeded.row.id, familyId: rivera, name: "Ana Rivera" };
  return { ...seeded, who };
}

describe("the confirm queues the new address for each record of the person's (items 1 and 2)", () => {
  it("one item for her own Parent customer, nothing sent at the confirm, and the parent's answer as slice 11d gives it", async () => {
    const a = await ana();
    expect(await confirm(a.who, NEW)).toEqual(DONE(NEW));
    expect(stub.apiCalls()).toEqual([]);
    const [item] = await items();
    expect(item).toMatchObject({ state: "waiting", sent: false, tries: 0, familyId: rivera, studentId: null, targetQboId: "11", askedBy: null, askedByLabel: EMAIL_ASKED_BY,
      request: { op: "email", role: "parent", qboId: "11", syncToken: "0", from: OLD, to: NEW, guardianId: a.row.id } });
    expect((item!.request as { orFrom?: unknown }).orFrom).toBeUndefined();
    expect((await auditsOf("parent.email.save"))[0]!.after).toMatchObject({ email: NEW, queueIds: [item!.id] });
    expect((await db.select().from(parent).where(eq(parent.id, a.ana.id)))[0]!.email).toBe(NEW);
  });

  it("the worker sends it at its next wake, with the field read live, only her address replaced, and aligns the link", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    await wake();
    // The field is read first, then sent whole, as QuickBooks held it but for her address.
    expect(gets("11")).toHaveLength(1);
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryEmailAddr: { Address: ` ${NEW} ` } }]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: ` ${NEW} ` }, SyncToken: "1" });
    expect((await items())[0]).toMatchObject({ state: "done" });
    expect(await linkOfRow(a.row.id)).toMatchObject({ customerId: "11", syncedToken: "1" });
    expect(await auditsOf("roster.customer.email")).toHaveLength(1);
    expect((await db.select().from(parent).where(eq(parent.id, a.ana.id)))[0]!.email).toBe(NEW);
  });

  it("a person in two families: two items, sent to two records; a family made inactive gets none", async () => {
    const a = await ana();
    // Ana's own record in the Chen family too: Mei Chen's customer, 21, stands for it here, holding her address.
    await seedGuardian({ parentId: a.ana.id, familyQboId: "20", sourceQboId: "21", status: "active" });
    await syncAppRecords();
    fieldInQuickBooks("21", OLD);
    await confirm(a.who, NEW);
    expect((await items()).map((i) => [i.targetQboId, String(i.familyId)]).sort()).toEqual([["11", String(rivera)], ["21", String(chen)]].sort());
    await wake();
    expect(bodies().map((b) => b.Id).sort()).toEqual(["11", "21"]);
    expect(inQuickBooks(stub, "21")).toMatchObject({ PrimaryEmailAddr: { Address: NEW } });
    expect(await openItems()).toEqual([]);
    await db.update(family).set({ active: false }).where(eq(family.id, chen));
    await confirm(a.who, NEWER);
    expect((await openItems()).map((i) => i.targetQboId)).toEqual(["11"]);
  });

  it("nothing is queued with no record of their own: no Parent customer, one two open rows share, a closed row, an id that isn't digits, one the cache holds inactive", async () => {
    const q = (parentId: string, from: string, to: string) => db.transaction((tx) => queueEmailChange(tx, parentId, { from, to }, { actor: { door: "parent", id: parentId, label: from }, ip: null }));
    // A guardian staff added with no Parent customer of their own.
    const kit = await seedParent({ name: "Kit Rivera", email: "kit@example.com" });
    await seedGuardian({ parentId: kit.id, familyQboId: "10", status: "active" });
    await syncAppRecords();
    expect(await q(kit.id, "kit@example.com", "kit.new@example.com")).toEqual([]);
    // Ana's Parent customer shared with a second open row: nobody's own.
    const a = await ana();
    const ben = await seedParent({ name: "Ben Rivera", email: "ben@example.com" });
    const benRow = await seedGuardian({ parentId: ben.id, familyQboId: "10", sourceQboId: "11", status: "active" });
    await syncAppRecords();
    expect(await q(a.ana.id, OLD, NEW)).toEqual([]);
    // Ben's row closed: Ana's own again. Her own row closed: nothing.
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, benRow.id));
    expect(await q(a.ana.id, OLD, NEW)).toHaveLength(1);
    await db.delete(writeQueue);
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, a.row.id));
    expect(await q(a.ana.id, OLD, NEW)).toEqual([]);
    // Open again, linked to a customer whose id isn't one QuickBooks uses: never queued.
    await db.update(guardian).set({ status: "active", disabledReason: null }).where(eq(guardian.id, a.row.id));
    await db.update(accountingLink).set({ customerId: "E2E-P1" }).where(eq(accountingLink.guardianId, a.row.id));
    expect(await q(a.ana.id, OLD, NEW)).toEqual([]);
    // Back to 11, which the roster's copy holds inactive: never queued.
    await db.update(accountingLink).set({ customerId: "11" }).where(eq(accountingLink.guardianId, a.row.id));
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "11"));
    expect(await q(a.ana.id, OLD, NEW)).toEqual([]);
    expect(await items()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("the confirm takes neither the roster lock nor any \"being sent\" lock, and waits for none", async () => {
    const a = await ana();
    let held!: () => void, release!: () => void;
    const isHeld = new Promise<void>((y) => { held = y; });
    // Another connection holds the roster lock exclusively, and Ana's row's and her family's "being sent" locks.
    const holding = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${a.row.id}::text))`);
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${String(rivera)}::text))`);
      held();
      await new Promise<void>((y) => { release = y; });
    });
    await isHeld;
    // They are held: a reader of the roster waits for it meanwhile.
    const probe = db.transaction((tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`));
    try {
      await untilALockIsAwaited();
      expect(await confirm(a.who, NEW)).toEqual(DONE(NEW));
      expect(await items()).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "11" })]);
    } finally {
      release();
      await holding;
      await probe;
    }
  });

  it("family A's parent with family B's link: refused as any other, nothing of B queued or changed", async () => {
    const a = await ana();
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com" });
    const meiRow = await seedGuardian({ parentId: mei.id, familyQboId: "20", sourceQboId: "21", status: "active" });
    await syncAppRecords();
    const { token } = await seedEmailChange({ parentId: mei.id, guardianId: meiRow.id, familyId: chen, recordQboId: "21", newEmail: "mei.new@example.com" });
    const session = await seedParentSession(a.ana.authUserId, { familyId: rivera });
    const ctx: ParentCtx = { door: "parent", parentId: a.ana.id, sessionId: session.id, guardianId: a.row.id, familyId: rivera, name: "Ana Rivera", email: OLD, families: [], ip: null };
    expect(await confirmMyEmailChange(ctx, token)).toEqual({ ok: false, errors: [EMAIL_COPY.linkNoGood] });
    expect(await items()).toEqual([]);
    expect((await db.select().from(parent).where(eq(parent.id, mei.id)))[0]!.email).toBe("mei@example.com");
    expect((await db.select().from(parent).where(eq(parent.id, a.ana.id)))[0]!.email).toBe(OLD);
  });
});

describe("each send settles the field by what it holds, and never touches an address the portal didn't know there (item 4)", () => {
  it("a field of several addresses, hers first: only hers is replaced, the others stay as they were", async () => {
    const a = await ana();
    fieldInQuickBooks("11", "Ana@Example.com, Kids@Rivera.example");
    await confirm(a.who, NEW);
    await wake();
    expect(sentFields()).toEqual([`${NEW}, Kids@Rivera.example`]);
    expect((await items())[0]).toMatchObject({ state: "done" });
  });

  it("her address not where her record signs in by (another person's first): kept, nothing sent, the other address untouched", async () => {
    const a = await ana();
    fieldInQuickBooks("11", "someone.else@example.com, ana@example.com");
    await confirm(a.who, NEW);
    await wake();
    await stub.idle();
    expect(posts()).toEqual([]);
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: EMAIL_DIFFERS });
    expect(whoStopped(kept!.lastCode)).toBe("held");
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: "someone.else@example.com, ana@example.com" } });
    expect((await db.select().from(parent).where(eq(parent.id, a.ana.id)))[0]!.email).toBe(NEW);
  });

  it("her address not in the field at all: kept, nothing sent", async () => {
    const a = await ana();
    fieldInQuickBooks("11", "someone.else@example.com");
    await confirm(a.who, NEW);
    await wake();
    await stub.idle();
    expect(posts()).toEqual([]);
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: EMAIL_DIFFERS });
  });

  it("an address she gave up that another guardian of a shared field signs in with now is theirs: never replaced", async () => {
    // Books with no parent type: the Rivera family's own field, shared by its guardians, holds Kit's address alone.
    await storeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
    fieldInQuickBooks("10", "kit@example.com");
    const a = await ana();
    const kit = await seedParent({ name: "Kit Rivera", email: "kit@example.com" });
    await seedGuardian({ parentId: kit.id, familyQboId: "10", status: "active" });
    await syncAppRecords();
    const [kitRow] = await db.select().from(guardian).where(eq(guardian.parentId, kit.id));
    // Ana moves to a new address; her change's first try can't reach QuickBooks, so it waits, never sent.
    await confirm(a.who, NEW);
    stub.dropApi = true;
    await wake();
    stub.dropApi = false;
    const [anas] = await emailItems();
    expect(anas).toMatchObject({ state: "waiting", sent: false });
    // Kit then takes the address Ana gave up, and Kit's change lands first, putting it in the family's field.
    await confirm({ parentId: kit.id, authUserId: kit.authUserId, guardianId: kitRow!.id, familyId: rivera, name: "Kit Rivera" }, OLD);
    stub.calls.length = 0;
    await wake();
    expect(sentFields()).toEqual([OLD]);
    // Ana's next try finds her old address there, but it is Kit's sign-in now: kept, nothing sent, Kit's left as it is.
    stub.calls.length = 0;
    await wake(10 * MIN);
    await stub.idle();
    expect(posts()).toEqual([]);
    expect(await queueItem(anas!.id)).toMatchObject({ state: "refused", lastCode: EMAIL_DIFFERS });
    expect(inQuickBooks(stub, "10")).toMatchObject({ PrimaryEmailAddr: { Address: OLD } });
  });

  it("a field that would pass 100 characters: kept, nothing sent, in words of its own", async () => {
    const a = await ana();
    const long = `${"x".repeat(68)}@rivera.example`;
    fieldInQuickBooks("11", `${OLD}, ${long}`);
    expect(`${OLD}, ${long}`).toHaveLength(100);
    await confirm(a.who, NEW);
    await wake();
    await stub.idle();
    expect(posts()).toEqual([]);
    const [tooLong] = await items();
    expect(tooLong).toMatchObject({ state: "refused", lastCode: EMAIL_TOO_LONG });
    expect(keptWordsFor(tooLong!.request, tooLong!.lastCode, null)).toBe(keptEmailWords(EMAIL_TOO_LONG));
    expect(keptEmailWords(EMAIL_TOO_LONG)).toMatch(/longer than QuickBooks takes \(100 characters\)/);
  });

  it("a field holding the new address already, beside the old: kept, nothing sent", async () => {
    const a = await ana();
    fieldInQuickBooks("11", `${OLD}, ${NEW}`);
    await confirm(a.who, NEW);
    await wake();
    await stub.idle();
    expect(posts()).toEqual([]);
    const [beside] = await items();
    expect(beside).toMatchObject({ state: "refused", lastCode: EMAIL_ALREADY_THERE });
    expect(whoStopped(EMAIL_ALREADY_THERE)).toBe("held");
    expect(keptEmailWords(EMAIL_ALREADY_THERE)).toMatch(/holds the new address already, beside the one it was to replace/);
  });

  it("the roster's copy behind QuickBooks, or empty: the field is read live before anything is sent", async () => {
    const a = await ana();
    await db.update(qboCustomer).set({ email: null }).where(eq(qboCustomer.qboId, "11"));
    await confirm(a.who, NEW);
    await wake();
    const calls = stub.apiCalls();
    expect(calls.findIndex((c) => c.method === "GET" && c.path.endsWith("/customer/11"))).toBeLessThan(calls.findIndex((c) => c.method === "POST"));
    expect(sentFields()).toEqual([` ${NEW} `]);
  });

  it("the roster's copy holding the change already: done, nothing sent", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    await db.update(qboCustomer).set({ email: NEW }).where(eq(qboCustomer.qboId, "11"));
    await wake();
    expect(stub.apiCalls()).toEqual([]);
    expect((await items())[0]).toMatchObject({ state: "done" });
  });

  it("a stale answer with the field as the portal knew it: read again and sent once more with the version just read (`checked`)", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    let n = 0;
    stub.beforeUpdate = (c) => { if (n++ === 0) c.SyncToken = String(Number(c.SyncToken ?? 0) + 1); }; // a save in QuickBooks at that moment, not of the field
    await wake();
    expect(bodies().map((b) => b.SyncToken)).toEqual(["0", "1"]);
    expect((await items())[0]).toMatchObject({ state: "done" });
    expect(await linkOfRow(a.row.id)).toMatchObject({ syncedToken: "2" });
    expect((await auditsOf("roster.customer.email"))[0]!.after).toMatchObject({ resent: "stale", fieldAsHeld: true });
  });

  it("a stale answer with the field changed in QuickBooks meanwhile: kept, nothing sent over it", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    stub.beforeUpdate = (c) => { if (c.SyncToken === "0") Object.assign(c, { SyncToken: "1", PrimaryEmailAddr: { Address: "office@rivera.example" } }); };
    await wake();
    expect(bodies()).toHaveLength(1);
    expect((await items())[0]).toMatchObject({ state: "refused", lastCode: EMAIL_DIFFERS });
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: "office@rivera.example" } });
  });

  it("stale twice in a row: waits as never sent, for a later try", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    stub.beforeUpdate = (c) => { c.SyncToken = String(Number(c.SyncToken ?? 0) + 1); };
    await wake();
    expect(bodies()).toHaveLength(2);
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: false, lastCode: "fault_5010" });
  });

  it("her address changed again before the worker's try: given up unsent as superseded, never an older address after a newer", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    const [item] = await emailItems();
    await db.update(parent).set({ email: NEWER }).where(eq(parent.id, a.ana.id));
    await wake();
    await stub.idle();
    expect(posts()).toEqual([]);
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.given_up")).map((r) => (r.after as { why?: string }).why)).toEqual(["superseded"]);
  });

  it("a link with no version: the field read live first, then sent with the version just read", async () => {
    const a = await ana();
    await db.update(accountingLink).set({ syncedToken: null }).where(eq(accountingLink.guardianId, a.row.id));
    await confirm(a.who, NEW);
    expect((await emailItems())[0]!.request).toMatchObject({ syncToken: "" });
    await wake();
    expect(gets("11")).toHaveLength(1);
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "0", sparse: true, PrimaryEmailAddr: { Address: ` ${NEW} ` } }]);
    expect((await emailItems())[0]).toMatchObject({ state: "done" });
  });

  it("QuickBooks having the record inactive, though the roster's copy doesn't yet: kept, nothing sent", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    Object.assign(inQuickBooks(stub, "11"), { Active: false });
    await wake();
    await stub.idle();
    expect(posts()).toEqual([]);
    expect((await emailItems())[0]).toMatchObject({ state: "refused", lastCode: INACTIVE_THERE_CODE });
  });

  it("QuickBooks' own refusal: kept, in words that say QuickBooks refused it", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    stub.updateFault = "6000";
    await wake();
    const [item] = await items();
    expect(item).toMatchObject({ state: "refused", lastCode: "fault_6000" });
    expect(whoStopped(item!.lastCode)).toBe("quickbooks");
    expect(keptEmailWords(item!.lastCode)).toBe("QuickBooks refused it: it wouldn't take the email field with the new address in it.");
  });

  it("a lost answer waits as maybe sent, and is found made after the roster's next read, nothing sent twice", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    stub.loseUpdateAnswer = true;
    await wake();
    stub.loseUpdateAnswer = false;
    expect((await items())[0]).toMatchObject({ state: "waiting", sent: true });
    await wake(4 * MIN);
    expect(posts()).toHaveLength(1);
    expect((await items())[0]).toMatchObject({ state: "done" });
    expect(await linkOfRow(a.row.id)).toMatchObject({ syncedToken: "1" });
  });
});

describe("a later change takes the place of an earlier one, and an older address never lands after a newer (item 2)", () => {
  it("two changes in a row: the second takes the place of the first, never sent, and carries its `from`", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    await confirm(a.who, NEWER);
    const [first, second] = (await items()).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    expect(first).toMatchObject({ state: "given_up" });
    expect(second).toMatchObject({ state: "waiting", request: { from: OLD, to: NEWER } });
    expect((await auditsOf("roster.write.replaced")).map((r) => r.targetId)).toEqual([first!.id]);
    await wake();
    expect(sentFields()).toEqual([` ${NEWER} `]);
  });

  it("a change while the first may have been sent, and never landed: the first is given up unsent at its next try, the newer goes", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    // The send is cut off before QuickBooks takes it: the change waits as maybe sent.
    stub.onApiRequest = (call) => { if (call.method === "POST") stub.dropApi = true; };
    await wake();
    stub.onApiRequest = null; stub.dropApi = false;
    const [first] = await items();
    expect(first).toMatchObject({ state: "waiting", sent: true });
    await confirm(a.who, NEWER);
    const second = (await items()).find((i) => i.state === "waiting" && !i.sent)!;
    expect(second.request).toMatchObject({ from: OLD, to: NEWER, orFrom: [NEW] });
    expect(await queueItem(first!.id)).toMatchObject({ state: "waiting" });
    stub.calls.length = 0;
    await wake(4 * MIN);
    expect(sentFields()).toEqual([` ${NEWER} `]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: ` ${NEWER} ` } });
    expect(await openItems()).toEqual([]);
  });

  it("a change while the first may have been sent, and landed: the newer replaces the address the first put there", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    stub.loseUpdateAnswer = true;
    await wake();
    stub.loseUpdateAnswer = false;
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: ` ${NEW} ` } });
    await confirm(a.who, NEWER);
    stub.calls.length = 0;
    await wake(4 * MIN);
    expect(sentFields()).toEqual([` ${NEWER} `]);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: ` ${NEWER} ` } });
    expect(await openItems()).toEqual([]);
  });
});

describe("a change of sign-in email blocks nothing, and goes with the membership (item 3)", () => {
  const emailSent = () => sentFields();

  it("removing the guardian gives up the change that never left, and sends none of it", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    const [item] = await emailItems();
    expect(await removeGuardian(a.row.id, "Moved away.", op)).toMatchObject({ ok: true });
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    await wake();
    expect(emailSent()).toEqual([]);
  });

  it("blocking the person gives up nothing: the address stands, and is sent on", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    const [item] = await emailItems();
    expect(await blockPerson(a.ana.id, "Not for now.", op)).toMatchObject({ ok: true });
    expect(await queueItem(item!.id)).toMatchObject({ state: "waiting" });
    await wake();
    expect(emailSent()).toEqual([` ${NEW} `]);
  });

  it("a rename of the person goes through beside it, and both land", async () => {
    const a = await ana();
    await confirm(a.who, NEW);
    expect(await renamePerson(a.ana.id, "Ana M. Rivera", op)).toMatchObject({ ok: true, changed: true });
    await wake();
    expect(inQuickBooks(stub, "11")).toMatchObject({ DisplayName: "Ana M. Rivera", PrimaryEmailAddr: { Address: ` ${NEW} ` } });
    expect(await openItems()).toEqual([]);
  });

  it("the family action goes through while it waits; the change is then given up unsent at its next try", async () => {
    stub.quirks.balances = true;
    const a = await ana();
    await confirm(a.who, NEW);
    const [item] = await emailItems();
    const c = (await familyCover("10"))!;
    const stamp = coverStamp(String(rivera), [c.family.qboId, ...c.under.map((u) => u.qboId)]);
    expect((await askFamilyInactive(String(rivera), stamp, tag, op)).result).toMatchObject({ ok: true });
    await wake();
    expect(await queueItem(item!.id)).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.given_up")).map((r) => (r.after as { why?: string }).why)).toContain("guardian_removed");
    expect(emailSent()).toEqual([]);
  });

  it("the family's page offers every change beside a waiting one: nothing is held back there either", async () => {
    const blockedWords = ["is waiting to reach QuickBooks, so nothing else can be changed for now", "so the family can't be made inactive for now"];
    const page = async () => { asStaff(await staffWith(`page${Math.random().toString(36).slice(2, 8)}@club.org`, ["Roster.Read", "Roster.Family.ReadWrite"]));
      return decode(await renderPage(RosterEntryPage, { params: { id: String(rivera) } })); };
    // Her own Parent customer's change waiting, under the family.
    const a = await ana();
    await confirm(a.who, NEW);
    expect(await emailItems()).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "11" })]);
    let html = await page();
    for (const w of blockedWords) expect(html).not.toContain(w);
    // In books with no parent type, the family's own customer's.
    await db.delete(writeQueue);
    await storeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
    fieldInQuickBooks("10", NEW);
    await confirm(a.who, NEWER);
    expect(await emailItems()).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "10" })]);
    html = await page();
    for (const w of blockedWords) expect(html).not.toContain(w);
  });

  it("in books with no parent type: the family's field, a student moved and added and the family renamed while it waits; all of it lands", async () => {
    await storeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
    fieldInQuickBooks("10", "home@rivera.example; ana@example.com");
    const a = await ana();
    await confirm(a.who, NEW);
    const [item] = await emailItems();
    expect(item).toMatchObject({ state: "waiting", targetQboId: "10", request: { role: "family", from: OLD, to: NEW, guardianId: a.row.id } });
    expect(await renameLinked({ kind: "family", recordId: String(rivera), name: "Rivera Household" }, tag, op)).toMatchObject({ ok: true });
    expect(await addStudentToLinked(String(rivera), "Mia Rivera", tag, op)).toMatchObject({ ok: true });
    const leo = await recordOfCustomer("12", "student");
    expect(await moveStudent(String(leo), String(chen), tag, op)).toMatchObject({ ok: true });
    await wake();
    expect(await queueItem(item!.id)).toMatchObject({ state: "done" });
    // Her address replaced where it stands, later in the family's field; the other guardian's left as it was.
    expect(inQuickBooks(stub, "10")).toMatchObject({ DisplayName: "Rivera Household", PrimaryEmailAddr: { Address: `home@rivera.example; ${NEW}` } });
    expect(inQuickBooks(stub, "12")).toMatchObject({ ParentRef: { value: "20" } });
    expect(await openItems()).toEqual([]);
  });

  it("flat books: the member's own field", async () => {
    await storeShape({ kind: "flat", memberTypeIds: ["1"] });
    fieldInQuickBooks("10", "ana@example.com, home@rivera.example");
    const a = await ana();
    await confirm(a.who, NEW);
    const [item] = await emailItems();
    expect(item).toMatchObject({ targetQboId: "10", request: { role: "member" } });
    await wake();
    expect(sentFields()).toEqual([`${NEW}, home@rivera.example`]);
    const [link] = await db.select().from(accountingLink).where(eq(accountingLink.familyId, rivera));
    expect(link).toMatchObject({ customerId: "10", syncedToken: inQuickBooks(stub, "10").SyncToken });
  });
});

describe("Reconciliation: the rows, the compare view, \"Send the portal's value\" and \"Give up\" (item 5)", () => {
  /** A change kept because QuickBooks' field holds an address the portal never knew there. */
  async function kept(field = "someone.else@example.com") {
    const a = await ana();
    fieldInQuickBooks("11", field);
    await confirm(a.who, NEW);
    await wake();
    stub.calls.length = 0;
    const [row] = await loadOpenWrites();
    return { a, row: row! };
  }
  const reader = (s: { id: string; email: string }) => ({ actor: { door: "staff" as const, id: s.id, label: s.email }, ip: null });
  const compares = () => auditsOf("parent.email.compared");
  const WORDS = "Send Ana Rivera's new sign-in email to their record under Rivera Family";

  it("the list says why, in words, with no address for any reader, and offers the compare view to every reader", async () => {
    const { row } = await kept();
    expect(row).toMatchObject({ state: "refused", lastCode: EMAIL_DIFFERS, words: WORDS, shown: "", mayResend: true, notOffered: null, differs: null });
    for (const [email, patterns] of [["reader@club.org", ["Roster.Read"]], ["treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]]] as const) {
      asStaff(await staffWith(email, [...patterns]));
      const html = decode(writesSection(await renderPage(ReconciliationPage)));
      expect(html, email).toContain(WORDS);
      expect(html, email).toContain(keptEmailWords(EMAIL_DIFFERS));
      for (const address of [OLD, NEW, "someone.else@example.com"]) expect(html, `${email} ${address}`).not.toContain(address);
      expect(html, email).toContain(`?compare=${row.id}`);
      expect(html, email).not.toContain("Send the portal's value");
    }
    expect(await compares()).toEqual([]);
    // The family's page lists it in the same words, with no buttons.
    asStaff(await staffWith("registrar2@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
    expect(decode(await renderPage(RosterEntryPage, { params: { id: String(rivera) } }))).toContain(keptEmailWords(EMAIL_DIFFERS));
  });

  it("the compare view is audited before it shows the two, as text; the press is offered only to staff who may change families", async () => {
    const { a, row } = await kept();
    const only = await staffWith("reader@club.org", ["Roster.Read"]);
    asStaff(only);
    let html = decode(writesSection(await renderPage(ReconciliationPage, { searchParams: { compare: row.id } })));
    expect(html).toContain("QuickBooks has: the email field “someone.else@example.com”.");
    expect(html).toContain(`The portal has: the sign-in address ${NEW}.`);
    expect(html).not.toContain("Send the portal's value");
    expect(await compares()).toEqual([expect.objectContaining({ actorId: only.id, permission: "Roster.Read", targetType: "parent", targetId: a.ana.id, after: expect.objectContaining({ queueId: row.id }) })]);
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    html = decode(writesSection(await renderPage(ReconciliationPage, { searchParams: { compare: row.id } })));
    expect(html).toContain("Send the portal's value");
    expect(await compares()).toHaveLength(2);
  });

  it("the stamp bound into the press is keyed with the server's secret, and reads the field as the portal does", () => {
    expect(emailShownUnder("one secret", OLD)).not.toBe(emailShownUnder("another secret", OLD));
    expect(emailShown(OLD)).toBe(emailShownUnder(env.BETTER_AUTH_SECRET, OLD));
    expect(emailShown(" Ana@Example.com ")).toBe(emailShown(OLD));
  });

  it("\"Send the portal's value\": the new address put first in a Parent customer's field, sent with the live version, and nothing on a stamp it didn't show", async () => {
    const { row } = await kept();
    const view = (await compareEmail(row.id, reader(await staffWith("reader@club.org", ["Roster.Read"]))))!;
    expect(view).toMatchObject({ id: row.id, quickbooks: "the email field “someone.else@example.com”", portal: `the sign-in address ${NEW}` });
    expect(await sendPortalValue(row.id, "something else", portalValueStamp(row.id, "something else"), op)).toMatchObject({ ok: false });
    expect(await sendPortalValue(row.id, row.shown, portalValueStamp(row.id, row.shown), op)).toMatchObject({ ok: false });
    expect(posts()).toEqual([]);
    expect(await sendPortalValue(row.id, view.shown, portalValueStamp(row.id, view.shown), op)).toEqual({ ok: true, message: "Sent: QuickBooks has the person's new sign-in email now." });
    expect(bodies()).toEqual([{ Id: "11", SyncToken: "1", sparse: true, PrimaryEmailAddr: { Address: `${NEW}, someone.else@example.com` } }]);
    expect(await queueItem(row.id)).toMatchObject({ state: "done" });
    expect(await auditsOf("roster.write.sent_again")).toHaveLength(1);
  });

  it("the press over her old address where it stands, not first, its answer lost: found made after the roster's next read", async () => {
    const { row } = await kept(`someone.else@example.com, ${OLD}`);
    const view = (await compareEmail(row.id, reader(await staffWith("reader@club.org", ["Roster.Read"]))))!;
    stub.loseUpdateAnswer = true;
    expect(await sendPortalValue(row.id, view.shown, portalValueStamp(row.id, view.shown), op)).toMatchObject({ ok: true, status: "waiting" });
    stub.loseUpdateAnswer = false;
    expect(sentFields()).toEqual([`someone.else@example.com, ${NEW}`]);
    stub.calls.length = 0;
    await wake(4 * MIN);
    expect(posts()).toEqual([]);
    expect(await queueItem(row.id)).toMatchObject({ state: "done" });
  });

  it("the press over a field changed since, one holding the change already, and one that would pass 100 characters", async () => {
    const { row } = await kept();
    const view = (await compareEmail(row.id, reader(await staffWith("reader@club.org", ["Roster.Read"]))))!;
    fieldInQuickBooks("11", "office@rivera.example");
    expect(await sendPortalValue(row.id, view.shown, portalValueStamp(row.id, view.shown), op)).toMatchObject({ ok: false, errors: [expect.stringMatching(/changed this email field again since this page was shown/)] });
    // A long field there, as the roster's copy now holds it too (a read since): the compare view shows it.
    const longField = `${"x".repeat(80)}@rivera.example`;
    fieldInQuickBooks("11", longField);
    await db.update(qboCustomer).set({ email: longField, syncToken: String(inQuickBooks(stub, "11").SyncToken) }).where(eq(qboCustomer.qboId, "11"));
    const long = (await compareEmail(row.id, reader(await staffWith("reader2@club.org", ["Roster.Read"]))))!;
    expect(await sendPortalValue(row.id, long.shown, portalValueStamp(row.id, long.shown), op)).toMatchObject({ ok: false, errors: [expect.stringMatching(/longer than QuickBooks takes \(100 characters\)/)] });
    expect(posts()).toEqual([]);
    expect(await queueItem(row.id)).toMatchObject({ state: "refused" });
    fieldInQuickBooks("11", NEW);
    expect(await sendPortalValue(row.id, long.shown, portalValueStamp(row.id, long.shown), op)).toEqual({ ok: true, message: "QuickBooks has the person's new sign-in email already, so nothing was sent. The change is done." });
    expect(posts()).toEqual([]);
    expect(await queueItem(row.id)).toMatchObject({ state: "done" });
  });

  it("a person who changed their address again since: not offered, and the press gives it up, nothing sent", async () => {
    const { a, row } = await kept();
    await db.update(parent).set({ email: NEWER }).where(eq(parent.id, a.ana.id));
    const [again] = await loadOpenWrites();
    expect(again).toMatchObject({ mayResend: false, notOffered: "email_superseded" });
    const view = (await compareEmail(row.id, reader(await staffWith("reader@club.org", ["Roster.Read"]))))!;
    expect(await sendPortalValue(row.id, view.shown, portalValueStamp(row.id, view.shown), op)).toEqual({ ok: true, status: "waiting", message: EMAIL_SUPERSEDED_AT_PRESS });
    expect(posts()).toEqual([]);
    expect(await queueItem(row.id)).toMatchObject({ state: "given_up" });
  });

  it("a newer change confirmed while the press reads QuickBooks: never told done, though the field holds the older address", async () => {
    const { a, row } = await kept();
    const view = (await compareEmail(row.id, reader(await staffWith("reader@club.org", ["Roster.Read"]))))!;
    // Someone puts her address in QuickBooks, and she changes it again while the press is reading the record.
    fieldInQuickBooks("11", NEW);
    stub.onApiRequest = async (call) => {
      if (call.method !== "GET" || !call.path.endsWith("/customer/11")) return;
      stub.onApiRequest = null;
      await confirm(a.who, NEWER);
    };
    expect(await sendPortalValue(row.id, view.shown, portalValueStamp(row.id, view.shown), op)).toEqual({ ok: true, status: "waiting", message: EMAIL_SUPERSEDED_AT_PRESS });
    expect(posts()).toEqual([]);
    expect(await queueItem(row.id)).toMatchObject({ state: "given_up" });
    expect(await auditsOf("roster.write.done")).toEqual([]);
    expect((await emailItems()).filter((i) => i.state === "waiting")).toEqual([expect.objectContaining({ request: expect.objectContaining({ to: NEWER }) })]);
  });

  it("a family customer's own field (books with no parent type): compared only by staff who may see a person's details, and the press adds the address at the end", async () => {
    await storeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
    fieldInQuickBooks("10", "home@rivera.example");
    const a = await ana();
    await confirm(a.who, NEW);
    await wake();
    stub.calls.length = 0;
    const [row] = await loadOpenWrites();
    expect(row).toMatchObject({ state: "refused", lastCode: EMAIL_DIFFERS, write: expect.objectContaining({ role: "family" }) });
    // A reader of Reconciliation alone: no compare offered, none shown when asked, nothing audited.
    const only = await staffWith("reader@club.org", ["Roster.Read"]);
    asStaff(only);
    let html = decode(writesSection(await renderPage(ReconciliationPage, { searchParams: { compare: row!.id } })));
    expect(html).not.toContain(`?compare=${row!.id}`);
    expect(html).not.toContain("home@rivera.example");
    expect(await compareEmail(row!.id, reader(only))).toBeNull();
    expect(await compares()).toEqual([]);
    // Staff who may see a person's details: offered, audited under that permission, and shown.
    asStaff(await staffWith("parents@club.org", ["Roster.Read", "Parents.ReadWrite"]));
    html = decode(writesSection(await renderPage(ReconciliationPage, { searchParams: { compare: row!.id } })));
    expect(html).toContain("QuickBooks has: the email field “home@rivera.example”.");
    expect(await compares()).toEqual([expect.objectContaining({ permission: "Parents.ReadWrite", targetId: a.ana.id })]);
    const view = (await compareEmail(row!.id, { ...reader(only), mayReadFamilyField: true }))!;
    expect(await sendPortalValue(row!.id, view.shown, portalValueStamp(row!.id, view.shown), op)).toEqual({ ok: true, message: "Sent: QuickBooks has the person's new sign-in email now." });
    expect(sentFields()).toEqual([`home@rivera.example, ${NEW}`]);
  });

  it("once the record is gone (the family made inactive), neither is shown, no compare is offered, and the press is refused", async () => {
    const { row } = await kept();
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    const [gone] = await loadOpenWrites();
    expect(gone).toMatchObject({ mayResend: false, notOffered: "email_record_gone" });
    const only = await staffWith("reader@club.org", ["Roster.Read"]);
    expect(await compareEmail(row.id, reader(only))).toBeNull();
    asStaff(only);
    const html = decode(writesSection(await renderPage(ReconciliationPage, { searchParams: { compare: row.id } })));
    expect(html).not.toContain("someone.else@example.com");
    expect(html).not.toContain(`?compare=${row.id}`);
    expect(await compares()).toEqual([]);
    expect(await sendPortalValue(row.id, "", portalValueStamp(row.id, ""), op)).toEqual({ ok: false, errors: [EMAIL_NOT_OFFERED.email_record_gone] });
    expect(posts()).toEqual([]);
  });

  it("\"Give up\": the person keeps their address in the portal, QuickBooks keeps its field", async () => {
    const { a, row } = await kept();
    const r = await giveUp(row.id, "The club will sort it out.", op);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.message).toContain("The person keeps the sign-in email they changed to in the portal, and QuickBooks keeps the email field it has");
    expect(posts()).toEqual([]);
    expect((await db.select().from(parent).where(eq(parent.id, a.ana.id)))[0]!.email).toBe(NEW);
    expect(inQuickBooks(stub, "11")).toMatchObject({ PrimaryEmailAddr: { Address: "someone.else@example.com" } });
  });
});
