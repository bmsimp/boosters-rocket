import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, guardian, parent, parentAuthUser, qboConnection, setting, student, writeQueue } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { sendStamp } from "@/lib/accounting/stamp";
import { loadAccountingLinks, QUEUE_IN_THE_WAY_OF_SEND, SEND_GUARDIAN_FAMILY_INACTIVE, SEND_NOT_CONNECTED, sendGuardianNameTakenNote, type GuardianSendOffer, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { LINK_COPY, sendAllDifferences } from "@/lib/accounting/link-writes";
import { guardianDifferenceNext } from "@/lib/accounting/differences";
import { AccessDenied } from "@/lib/guards";
import { sendDifferenceAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { removeGuardian } from "@/lib/parents/guardians";
import { renamePerson } from "@/lib/parents/people";
import { ROSTER_ASK_KEY, rosterRefreshAsked } from "@/lib/parents/refresh-ask";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { refreshRoster } from "@/lib/roster/refresh";
import { GUARDIAN_BEING_CHANGED, SEND_CHANGED, SEND_GUARDIAN_ROSTER_BUSY, SENDING_LOCK, sendGuardianNameQueuedWords, sendGuardianNameTakenWords, sendToBooks, STALE_TWICE, WRITE_COPY } from "@/lib/roster/writes";
import { resetDb, seedParent } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * Send the app's to QuickBooks for a guardian's difference (stage 4's slice M3c4 of the app-owned families spec,
 * section 5, "Differences"; section 6; open questions 11 and 12; sendToBooks()'s sendGuardianName() and
 * sendGuardianInactive() in src/lib/roster/writes.ts): a guardian's own Parent customer named otherwise than the person
 * is sent the person's name, as a rename saved first over the books' name the row showed; a removed guardian's own
 * Parent customer still active in the books is made inactive by the balance rule. Nothing is taken from the books and
 * nothing is made active. The company is fznCompany()'s (tests/helpers/qbo-stub.ts): the Rivera Family 10 with Ana
 * Rivera 11 (Parent) and Leo Rivera 12 (Student), the Chen Family 20 with Mei Chen 21 (Parent). Ana's row is linked to
 * 11 (seedAnaRivera()). The books change after seeding only through the stub (changeInBooks(), readAgain()), and no
 * helper that runs the whole import is called after a record changed.
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };
/** An open invoice (a positive amount) or a credit (a negative one) on a customer: its own Balance, as the stub reads it with `quirks.balances`. */
const balance = (Id: string, customer: string, amount: number) => ({ Id, SyncToken: "0", CustomerRef: { value: customer }, TotalAmt: amount, Balance: amount });
/** Runs the press while another session holds this lock, as a send under way (whileSending(), whileGuardiansHeld()) holds it. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

let tag: string;
let sender: Awaited<ReturnType<typeof staffWith>>;
const sendOp = (showAmounts = false) => ({ actor: { door: "staff" as const, id: sender.id, label: sender.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite",
  staffUserId: sender.id, showAmounts });
const pressName = (guardianId: string, stamp: string) => sendToBooks({ field: "guardian_name", guardianId, stamp }, tag, sendOp());
const pressInactive = (guardianId: string, stamp: string, showAmounts = false) => sendToBooks({ field: "guardian_inactive", guardianId, stamp }, tag, sendOp(showAmounts));
const nameStamp = (guardianId: string, customer: string, books: string, person: string) => sendStamp("guardian_name", guardianId, customer, [books, person]);
const inactiveStamp = (guardianId: string, customer: string) => sendStamp("guardian_inactive", guardianId, customer, [customer]);
const sends = () => auditsOf("accounting.difference.send");
/** Every write sent to the books since the calls were last cleared, as its body: found by method and path, never by position. */
const posts = () => stub.apiCalls().filter((c) => c.method === "POST" && /\/customer$/.test(c.path)).map((c) => JSON.parse(c.body) as Record<string, unknown>);
const items = () => db.select().from(writeQueue);
const personNow = async (id: string) => (await db.select({ name: parent.name }).from(parent).where(eq(parent.id, id)))[0]!.name;
const signInNameNow = async (id: string) => (await db.select({ name: parentAuthUser.name }).from(parentAuthUser).where(eq(parentAuthUser.parentId, id)))[0]!.name;
const rowNow = async (id: string) => (await db.select().from(guardian).where(eq(guardian.id, id)))[0]!;
const linkVersion = async (guardianId: string) => (await db.select({ v: accountingLink.syncedToken }).from(accountingLink).where(eq(accountingLink.guardianId, guardianId)))[0]?.v;

/** A guardian row of a new person in a family, written directly with nothing queued. */
async function rowIn(familyId: AppFamilyId, name: string, email: string, how: "open" | "removed" = "open") {
  const p = await seedParent({ name, email });
  const [row] = await db.insert(guardian).values({ parentId: p.id, familyId, status: how === "open" ? "active" : "disabled",
    disabledReason: how === "open" ? null : "removed", statusBeforeDisable: how === "open" ? null : "active" }).returning({ id: guardian.id });
  return row!.id;
}
const linkRowTo = (guardianId: string, customerId: string) =>
  db.insert(accountingLink).values({ system: QUICKBOOKS, realmId: REALM, customerId, guardianId, origin: "confirmed", syncedToken: "0", syncedAt: new Date() });
/** A row closed as removed, written directly (nothing queued, nothing sent), as a removal whose make-inactive was given up leaves it. */
const removedHere = (guardianId: string) => db.update(guardian).set({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" }).where(eq(guardian.id, guardianId));

let op: ReturnType<typeof asOp>;
let rivera: AppFamilyId, chen: AppFamilyId;
let ana: Awaited<ReturnType<typeof seedAnaRivera>>["ana"], row: Awaited<ReturnType<typeof seedAnaRivera>>["row"];

beforeEach(async () => {
  await resetDb(); stub.reset();
  // A customer read by id carries its own Balance, as QuickBooks' does: the portal reads it before making anyone inactive.
  stub.quirks.balances = true;
  tag = await connectRoster(stub);
  sender = await staffWith("sender@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
  op = asOp(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"]));
  rivera = await recordOfCustomer("10", "family"); chen = await recordOfCustomer("20", "family");
  ({ ana, row } = await seedAnaRivera({ status: "active" }));
});

describe("a guardian's name sent to their own Parent customer", () => {
  beforeEach(async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
  });

  it("one rename with the person's name, the item done, a kept rename closed, one send row on the guardian, and the person and every record as they were", async () => {
    // A rename of the row's Parent customer QuickBooks refused, kept on Reconciliation: the send takes its place.
    const kept = await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana Rivera", was: "Ana Old", guardianId: row.id }, { state: "refused", code: "fault_6000" });
    stub.calls.length = 0;
    expect(await pressName(row.id, nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera"))).toEqual({ ok: true,
      message: "Sent the name “Ana Rivera” to their Parent customer in QuickBooks, in place of “Ana R. Lopez”. Their name in the portal and on their sign-in is as it was." });
    expect(posts()).toEqual([expect.objectContaining({ Id: "11", SyncToken: "0", DisplayName: "Ana Rivera" })]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ DisplayName: "Ana Rivera" });
    const queued = (await items()).filter((q) => q.id !== kept.id);
    expect(queued.map((q) => [q.request.op, q.state, q.familyId, q.studentId])).toEqual([["rename", "done", rivera, null]]);
    expect(queued[0]!.request).toEqual({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana Rivera", was: "Ana R. Lopez", guardianId: row.id });
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "given_up" });
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept.id]);
    const [sent, ...more] = await sends();
    expect(more).toEqual([]);
    expect(sent).toMatchObject({ targetType: "guardian", targetId: row.id, permission: "Accounting.Link.ReadWrite", before: { name: "Ana R. Lopez" },
      after: { field: "guardian_name", guardianId: row.id, familyId: String(rivera), customerQboId: "11", name: "Ana Rivera", queueId: queued[0]!.id, replaced: [kept.id] } });
    // The audit page's record filter finds it by its target, as a guardian's rows are found.
    expect((await auditPage(parseAuditFilters({ record: `guardian:${row.id}` }), {}, 500)).rows.map((r) => r.id)).toContain(sent!.id);
    // The person, their sign-in and their row as they were; only the row's link took QuickBooks' new version.
    expect(await personNow(ana.id)).toBe("Ana Rivera");
    expect(await signInNameNow(ana.id)).toBe("Ana Rivera");
    expect(await rowNow(row.id)).toMatchObject({ status: "active", familyId: rivera, parentId: ana.id });
    expect(await linkVersion(row.id)).toBe("1");
    expect(await auditsOf("parent.name.changed")).toEqual([]);
  });

  it("QuickBooks renaming it again between the page and the send: held by the field, kept, nothing sent over it", async () => {
    stub.beforeUpdate = (c) => { c.DisplayName = "Ana Lopez-Rivera"; c.SyncToken = "1"; stub.beforeUpdate = null; };
    stub.calls.length = 0;
    expect(await pressName(row.id, nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera"))).toEqual({ ok: true, status: "attention", message: "The name “Ana Rivera” wasn't sent to their Parent customer in QuickBooks. "
      + "The portal held it back: QuickBooks' name changed again since this page was drawn (it has “Ana Lopez-Rivera” now), so the person's name wasn't sent over it. "
      + "The change is kept on the Reconciliation page, where you can send it again or give it up." });
    expect(posts()).toHaveLength(1);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ DisplayName: "Ana Lopez-Rivera" });
    expect((await items()).map((q) => [q.request.op, q.state, q.lastCode])).toEqual([["rename", "refused", "fault_5010"]]);
    expect(await sends()).toHaveLength(1);
    expect(await personNow(ana.id)).toBe("Ana Rivera");
  });

  it("refused, sending and saving nothing: the name another customer holds, or only a change on its way holds", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    await readAgain(qc("90", "Ana Rivera", "4"));
    stub.calls.length = 0;
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [sendGuardianNameTakenWords("Ana Rivera")] });
    stub.customers = stub.customers.filter((c) => c.Id !== "90");
    await readAgain();
    // Mei Chen's rename to Ana's name, waiting to reach QuickBooks.
    await seedQueued({ op: "rename", role: "parent", qboId: "21", syncToken: "0", name: "Ana Rivera", was: "Mei Chen" }, { state: "waiting" });
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [sendGuardianNameQueuedWords("Ana Rivera")] });
    expect(posts()).toEqual([]);
    expect((await items()).map((q) => q.request.op)).toEqual(["rename"]);
    expect(await sends()).toEqual([]);
    // Neither sentence names another family.
    for (const words of [sendGuardianNameTakenWords("Ana Rivera"), sendGuardianNameQueuedWords("Ana Rivera")]) expect(words).not.toMatch(/Chen|Rivera Family/);
  });

  it("refused as changed: a stale stamp, the person renamed since, the row removed since", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    changeInBooks("11", { DisplayName: "Ana R. L." });
    await readAgain();
    stub.calls.length = 0;
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    // The person renamed in the portal since the page (their record, written directly: nothing is queued for it here).
    const now = nameStamp(row.id, "11", "Ana R. L.", "Ana Rivera");
    await db.update(parent).set({ name: "Ana Lopez" }).where(eq(parent.id, ana.id));
    expect(await pressName(row.id, now)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    await db.update(parent).set({ name: "Ana Rivera" }).where(eq(parent.id, ana.id));
    // The row removed since: no name of theirs is sent for a family they no longer belong to.
    await removedHere(row.id);
    expect(await pressName(row.id, now)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("refused while the row's \"being sent\" lock is held (a rename of the person under way), and while a change waits for the row or its customer", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    stub.calls.length = 0;
    expect(await holding(SENDING_LOCK, row.id, () => pressName(row.id, stamp))).toEqual({ ok: false, errors: [GUARDIAN_BEING_CHANGED] });
    // A create of the row's waiting on the queue, and a change waiting for its customer.
    const create = await seedQueued({ op: "create", role: "parent", name: "Ana Rivera", typeQboId: "2", familyQboId: "10", email: "ana@example.com", guardianId: row.id }, { state: "waiting" });
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, create.id));
    const waiting = await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana R.", was: "Ana R. Lopez" }, { state: "stuck" });
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [WRITE_COPY.waiting] });
    await db.delete(writeQueue).where(eq(writeQueue.id, waiting.id));
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    // Free again, the same press goes through.
    expect(await pressName(row.id, stamp)).toMatchObject({ ok: true });
  });

  it("a person in two families whose other family's Parent customer has their name: refused as changed, nothing sent (one person, one name)", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    await readAgain(qc("25", "Ana Rivera", "2", under("20")));
    const [inChen] = await db.insert(guardian).values({ parentId: ana.id, familyId: chen, status: "active" }).returning({ id: guardian.id });
    await linkRowTo(inChen!.id, "25");
    stub.calls.length = 0;
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
  });

  it("an id that isn't a guardian row's, or another family's guardian's with this row's stamp: refused, nothing sent", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    const mei = await rowIn(chen, "Mei Lin", "mei@example.com");
    await linkRowTo(mei, "21");
    stub.calls.length = 0;
    expect(await pressName("not-a-uuid", stamp)).toEqual({ ok: false, errors: [WRITE_COPY.gone] });
    expect(await pressName(crypto.randomUUID(), stamp)).toEqual({ ok: false, errors: [WRITE_COPY.gone] });
    expect(await pressName(mei, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(stub.customers.find((c) => c.Id === "21")).toMatchObject({ DisplayName: "Mei Chen" });
  });
});

describe("a removed guardian's Parent customer made inactive in the books", () => {
  beforeEach(() => removedHere(row.id));

  it("no balance: one make-inactive, the balance read first, the guardian still removed, one send row", async () => {
    stub.calls.length = 0;
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: true,
      message: "Made Ana Rivera's Parent customer “Ana Rivera” inactive in QuickBooks: QuickBooks showed no balance on the account first. Ana Rivera stays removed from this family in the portal." });
    expect(stub.apiCalls().filter((c) => c.method === "GET" && /\/customer\/11$/.test(c.path))).toHaveLength(1);
    expect(posts()).toEqual([expect.objectContaining({ Id: "11", SyncToken: "0", Active: false })]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: false });
    expect(await rowNow(row.id)).toMatchObject({ status: "disabled", disabledReason: "removed" });
    expect(await linkVersion(row.id)).toBe("1");
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "guardian", targetId: row.id, before: { active: true },
      after: { field: "guardian_inactive", guardianId: row.id, familyId: String(rivera), customerQboId: "11", active: false, outcome: "sent", replaced: [] } })]);
    expect(await auditsOf("roster.customer.deactivate")).toEqual([expect.objectContaining({ after: expect.objectContaining({ sentFrom: "accounting.difference.send" }) })]);
    expect(await auditsOf("parent.access.granted")).toEqual([]);
  });

  for (const [what, amount, words] of [
    ["an amount owed", 25, "Ana Rivera has an open balance in QuickBooks. They weren't made inactive."],
    ["a credit", -10, "Ana Rivera has a credit in QuickBooks. They weren't made inactive."],
  ] as const) {
    it(`${what}: stopped, nothing sent, said in words, never queued, the amount only for a reader who may see balances`, async () => {
      stub.invoices.push(balance("9001", "11", amount));
      stub.calls.length = 0;
      expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: false, errors: [`${words} ${WRITE_COPY.balanceFix}`] });
      const told = await pressInactive(row.id, inactiveStamp(row.id, "11"), true);
      expect(told.ok ? "" : told.errors.join(" ")).toMatch(amount > 0 ? /\$25\.00/ : /\$10\.00/);
      expect(posts()).toEqual([]);
      expect(await items()).toEqual([]);
      expect((await sends()).map((a) => a.after)).toEqual([expect.objectContaining({ outcome: "stopped", code: amount > 0 ? "open_balance" : "credit_balance" }),
        expect.objectContaining({ outcome: "stopped" })]);
      expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: true });
    });
  }

  it("a balance that can't be read stops it; one QuickBooks has inactive already, read live, is sent nothing", async () => {
    stub.quirks.balances = false;
    stub.calls.length = 0;
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: false, errors: [WRITE_COPY.balanceUnknown] });
    expect(posts()).toEqual([]);
    stub.quirks.balances = true;
    changeInBooks("11", { Active: false, SyncToken: "1" });
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: true,
      message: "QuickBooks has Ana Rivera's Parent customer “Ana Rivera” inactive already, so nothing was sent. Ana Rivera stays removed from this family in the portal." });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect((await sends()).map((a) => (a.after as { outcome: string }).outcome).sort()).toEqual(["inactive_there", "stopped"]);
  });

  it("stale twice is refused in words with nothing queued; a lost answer is queued as maybe sent, filed under the family", async () => {
    stub.beforeUpdate = (c) => { if (c.Id === "11") c.SyncToken = String(Number(c.SyncToken) + 1); };
    stub.calls.length = 0;
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: false, errors: [STALE_TWICE] });
    stub.beforeUpdate = null;
    expect(await items()).toEqual([]);
    stub.loseUpdateAnswer = true;
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: true, queued: true, status: "waiting", message: WRITE_COPY.queued });
    stub.loseUpdateAnswer = false;
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: true, targetQboId: "11", familyId: rivera, studentId: null,
      request: expect.objectContaining({ op: "deactivate", role: "parent", qboId: "11", guardianId: row.id }) })]);
    expect((await sends()).map((a) => (a.after as { outcome: string }).outcome).sort()).toEqual(["queued", "stale_again"]);
    expect(await rowNow(row.id)).toMatchObject({ status: "disabled" });
  });

  it("a make-inactive kept for a balance: left kept while a balance stops the send, closed as replaced once QuickBooks has it inactive", async () => {
    // A real removal, its make-inactive kept for a balance (stage 3's slice 9h).
    await db.update(guardian).set({ status: "active", disabledReason: null, statusBeforeDisable: null }).where(eq(guardian.id, row.id));
    stub.invoices = [balance("909", "11", 5)];
    expect(await removeGuardian(row.id, "Moved away.", op)).toMatchObject({ ok: true });
    const [kept] = await items();
    expect(kept).toMatchObject({ state: "refused", lastCode: "open_balance", request: expect.objectContaining({ op: "deactivate", guardianId: row.id }) });
    stub.calls.length = 0;
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toMatchObject({ ok: false });
    expect((await items()).find((q) => q.id === kept!.id)).toMatchObject({ state: "refused" });
    stub.invoices = [];
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toMatchObject({ ok: true });
    expect(posts()).toEqual([expect.objectContaining({ Id: "11", Active: false })]);
    expect((await items()).find((q) => q.id === kept!.id)).toMatchObject({ state: "given_up" });
    expect((await sends()).find((a) => (a.after as { outcome: string }).outcome === "sent")).toMatchObject({ after: expect.objectContaining({ replaced: [kept!.id] }) });
    expect((await auditsOf("roster.write.replaced")).map((a) => a.targetId)).toEqual([kept!.id]);
  });

  it("refused as changed: an open row linked to that customer since, the row reinstated since, the customer inactive in the books already; and while its lock is held", async () => {
    const stamp = inactiveStamp(row.id, "11");
    stub.calls.length = 0;
    expect(await holding(SENDING_LOCK, row.id, () => pressInactive(row.id, stamp))).toEqual({ ok: false, errors: [GUARDIAN_BEING_CHANGED] });
    const raul = await rowIn(rivera, "Raul Rivera", "raul@example.com");
    await linkRowTo(raul, "11");
    expect(await pressInactive(row.id, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    await db.delete(accountingLink).where(and(eq(accountingLink.guardianId, raul)));
    await db.update(guardian).set({ status: "active", disabledReason: null }).where(eq(guardian.id, row.id));
    expect(await pressInactive(row.id, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    await removedHere(row.id);
    changeInBooks("11", { Active: false, SyncToken: "1" });
    await readAgain();
    expect(await pressInactive(row.id, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("never for an open row: an open guardian whose Parent customer the books have inactive is sent nothing, and never made active", async () => {
    await db.update(guardian).set({ status: "active", disabledReason: null }).where(eq(guardian.id, row.id));
    changeInBooks("11", { Active: false, SyncToken: "1" });
    await readAgain();
    stub.calls.length = 0;
    for (const stamp of [inactiveStamp(row.id, "11"), sendStamp("guardian_active", row.id, "11", ["11"])]) expect(await pressInactive(row.id, stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: false });
  });
});

const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
/** The row's guardian send of this field, as the page draws it now (for a reader who may change families). */
const guardianSendOf = async (name: string, field: GuardianSendOffer["field"]): Promise<GuardianSendOffer> => {
  const s = rowOf(await loadAccountingLinks(), name).guardianSends.find((x) => x.field === field);
  if (!s) throw new Error(`the row ${name} offers no send of ${field}`);
  return s;
};
const atOf = (row: LinkRow, kind: "guardian_name" | "guardian_active") => row.differences.findIndex((d) => d.kind === kind);
/** The list's own section, its apostrophes as text, and the presses of one label it draws, by their hidden words. */
const listOf = (whole: string) => { const at = whole.indexOf('id="links-list-h"'); return whole.slice(at, whole.indexOf("</section>", at)).replaceAll("&#x27;", "'").replaceAll("<!-- -->", ""); };
const pressed = (part: string, label: string) => [...part.matchAll(new RegExp(`${label}<span class="visually-hidden">: ([^<]*)</span>`, "g"))].map((m) => m[1]).sort();

describe("the offers on Accounting links", () => {
  it("a name and a removed guardian's Parent customer: offered with their words and stamps, drawn for a reader who may change families, and pressed through the action", async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain(qc("14", "Bea Rivera", "2", under("10")));
    const bea = await rowIn(rivera, "Bea Rivera", "bea@example.com", "removed");
    await linkRowTo(bea, "14");
    const r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.differences.map((d) => d.kind)).toEqual(["guardian_name", "guardian_active"]);
    expect(r.guardianSends).toEqual([
      { at: 0, field: "guardian_name", kind: "guardian", recordId: row.id, about: "Ana Rivera's name on their Parent customer",
        words: ["Sends “Ana Rivera” to the books as the name on Ana Rivera's Parent customer, in place of “Ana R. Lopez” there. The books' name is replaced. Their name in the portal and on their sign-in doesn't change."],
        stamp: nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera"), seal: { customerId: "11", value: ["Ana R. Lopez", "Ana Rivera"] } },
      { at: 1, field: "guardian_inactive", kind: "guardian", recordId: bea, about: "Bea Rivera's Parent customer's active status",
        words: ["Makes Bea Rivera's Parent customer “Bea Rivera” inactive in the books, in place of active there. QuickBooks is asked what is owed first, and any balance, owed or a credit, or one that can't be read, stops it with nothing sent. Bea Rivera stays removed from this family in the portal."],
        stamp: inactiveStamp(bea, "14"), seal: { customerId: "14", value: ["14"] } }]);
    // No take, nor a record's send, nor any sentence in their place.
    expect([...r.takes, ...r.takeNotes, ...r.sends, ...r.sendNotes]).toEqual([]);

    // Drawn for a holder of the three permissions, each beside its words; none for a reader who may not change families.
    asStaff(sender);
    const list = listOf(await renderPage(AccountingLinksPage));
    expect(pressed(list, "Send the app's to QuickBooks")).toEqual(["Ana Rivera's name on their Parent customer", "Bea Rivera's Parent customer's active status"]);
    expect(pressed(list, "Take QuickBooks' into the app")).toEqual([]);
    expect(list).toContain(r.guardianSends[0]!.words[0]);
    expect(list).toContain(guardianDifferenceNext(r.differences[0]!)!);
    for (const s of r.guardianSends) expect(list).not.toContain(s.stamp);
    const linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    asStaff(linker);
    const theirs = listOf(await renderPage(AccountingLinksPage));
    expect(pressed(theirs, "Send the app's to QuickBooks")).toEqual([]);
    expect(theirs).not.toContain(r.guardianSends[0]!.words[0]);
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);

    // Pressed through the action, as the page binds it.
    asStaff(sender);
    const [name, inactive] = r.guardianSends;
    expect(await sendDifferenceAction(name!.field, name!.kind, name!.recordId, tag, name!.stamp)).toMatchObject({ ok: true, message: expect.stringContaining("Sent the name “Ana Rivera” to their Parent customer in QuickBooks") });
    expect(await sendDifferenceAction(inactive!.field, inactive!.kind, inactive!.recordId, tag, inactive!.stamp)).toMatchObject({ ok: true, message: expect.stringContaining("Made Bea Rivera's Parent customer “Bea Rivera” inactive in QuickBooks") });
    expect(posts()).toEqual([expect.objectContaining({ Id: "11", DisplayName: "Ana Rivera" }), expect.objectContaining({ Id: "14", Active: false })]);
    expect((await sends()).map((a) => [a.targetType, a.targetId, (a.after as { field: string }).field]).sort()).toEqual([["guardian", bea, "guardian_inactive"], ["guardian", row.id, "guardian_name"]].sort());
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").differences).toEqual([]);
  });

  it("a kept rename of the row: said closed beside the press", async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
    await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana Rivera", was: "Ana Old", guardianId: row.id }, { state: "refused", code: "fault_6000" });
    expect((await guardianSendOf("Rivera Family", "guardian_name")).words.slice(1)).toEqual(["The rename kept on the Reconciliation page is closed, as this takes its place."]);
  });

  it("in place of a press, one sentence: the name another customer holds, a change waiting for the row, QuickBooks not connected", async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain(qc("90", "Ana Rivera", "4"));
    let r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.guardianSends).toEqual([]);
    expect(r.sendNotes).toEqual([{ at: atOf(r, "guardian_name"), words: sendGuardianNameTakenNote("Ana Rivera") }]);
    stub.customers = stub.customers.filter((c) => c.Id !== "90");
    await readAgain();
    // A create of the row's waiting on the queue: not the difference's own note, so the queue's sentence stands in for the press.
    const create = await seedQueued({ op: "create", role: "parent", name: "Ana Rivera Elsewhere", typeQboId: "2", familyQboId: "10", email: "ana@example.com", guardianId: row.id }, { state: "waiting" });
    r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.guardianSends).toEqual([]);
    expect(r.sendNotes).toEqual([{ at: atOf(r, "guardian_name"), words: QUEUE_IN_THE_WAY_OF_SEND }]);
    await db.delete(writeQueue).where(eq(writeQueue.id, create.id));
    // A rename of its customer waiting: the difference's own queue note says it, and no press or sentence is added.
    await seedQueued({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana Rivera", was: "Ana R. Lopez", guardianId: row.id }, { state: "waiting" });
    r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.differences[atOf(r, "guardian_name")]).toMatchObject({ queue: { state: "waiting" } });
    expect([...r.guardianSends, ...r.sendNotes]).toEqual([]);
    await db.delete(writeQueue);
    await db.delete(qboConnection);
    r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.guardianSends).toEqual([]);
    expect(r.sendNotes).toEqual([{ at: atOf(r, "guardian_name"), words: SEND_NOT_CONNECTED }]);
  });

  it("a removed guardian's Parent customer an open row is linked to since: no difference, no offer, and the press refused", async () => {
    await removedHere(row.id);
    const offer = await guardianSendOf("Rivera Family", "guardian_inactive");
    await linkRowTo(await rowIn(rivera, "Raul Rivera", "raul@example.com"), "11");
    const r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.differences.filter((d) => d.kind === "guardian_active")).toEqual([]);
    // Raul's own now: his name may be sent to it, but nothing makes it inactive.
    expect(r.guardianSends.map((x) => [x.field, x.recordId])).not.toContainEqual(["guardian_inactive", row.id]);
    stub.calls.length = 0;
    asStaff(sender);
    expect(await sendDifferenceAction(offer.field, offer.kind, offer.recordId, tag, offer.stamp)).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
  });

  it("an open guardian whose Parent customer the books have inactive: no press, no take, no sentence of a send, only what staff can do", async () => {
    changeInBooks("11", { Active: false });
    await readAgain();
    const r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.differences).toEqual([{ kind: "guardian_active", guardianId: row.id, who: "Ana Rivera", portalOpen: true, queue: null }]);
    expect([...r.guardianSends, ...r.sends, ...r.sendNotes, ...r.takes, ...r.takeNotes]).toEqual([]);
    asStaff(sender);
    const list = listOf(await renderPage(AccountingLinksPage));
    expect(pressed(list, "Send the app's to QuickBooks")).toEqual([]);
    expect(list).toContain(guardianDifferenceNext(r.differences[0]!)!);
  });
});

describe("Send the app's for all", () => {
  it("never queues a guardian's send nor counts it as passed over, and says a guardian's is sent from its own row", async () => {
    // First with no guardian's send: a student the portal has inactive (a make-inactive, passed over) draws the notice,
    // and it says nothing of guardians.
    const leo = await recordOfCustomer("12", "student");
    await db.update(student).set({ active: false }).where(eq(student.id, leo));
    expect((await loadAccountingLinks()).sendAll({ status: null, q: "" })).toMatchObject({ passedOver: { inactive: 1 }, guardians: 0 });
    asStaff(sender);
    const without = listOf(await renderPage(AccountingLinksPage));
    expect(without).toContain("It passes over 1 make-inactive this list shows");
    expect(without).not.toContain("A guardian's Parent customer is sent from its own row.");
    await db.update(student).set({ active: true }).where(eq(student.id, leo));
    changeInBooks("10", { DisplayName: "Rivera Household" });
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
    await removedHere(row.id);
    // Ana's row removed and her Parent customer active: a guardian's make-inactive; the family's name: a record's.
    const view = await loadAccountingLinks();
    const r = rowOf(view, "Rivera Family");
    expect(r.guardianSends.map((s) => s.field)).toEqual(["guardian_inactive"]);
    const all = view.sendAll({ status: null, q: "" })!;
    expect(all).toMatchObject({ count: 1, later: 0, passedOver: { inactive: 0, booksInactive: 0 }, guardians: 1 });
    asStaff(sender);
    expect((await renderPage(AccountingLinksPage)).replaceAll("&#x27;", "'")).toContain("A guardian's Parent customer is sent from its own row.");
    expect(await sendAllDifferences({ status: "", q: "", count: all.count, stamp: all.stamp }, tag, sendOp())).toMatchObject({ ok: true });
    expect((await items()).map((q) => [q.request.op, "role" in q.request ? q.request.role : null, q.familyId])).toEqual([["rename", "family", rivera]]);
    expect((await items()).filter((q) => "guardianId" in q.request)).toEqual([]);
    expect((await sends()).map((a) => a.targetType)).toEqual(["family"]);
    expect(posts()).toEqual([]);
    // Without a guardian's send the words don't say it.
    const plain = rowOf(await loadAccountingLinks(), "Chen Family");
    expect(plain.guardianSends).toEqual([]);
    expect((await loadAccountingLinks()).sendAll({ status: null, q: "Chen" })).toMatchObject({ guardians: 0 });
  });
});

describe("one family's row, one family's guardians", () => {
  it("family A's row never offers a send of family B's guardian, and B's guardian's id pressed with A's stamp is refused, nothing sent", async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain(qc("23", "Old Chen", "2", under("20")));
    const mei = await rowIn(chen, "Mei Lin", "mei@example.com"); await linkRowTo(mei, "21");
    const old = await rowIn(chen, "Old Chen", "old@example.com", "removed"); await linkRowTo(old, "23");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "Rivera Family").guardianSends.map((s) => s.recordId)).toEqual([row.id]);
    expect(rowOf(view, "Chen Family").guardianSends.map((s) => [s.field, s.recordId])).toEqual([["guardian_name", mei], ["guardian_inactive", old]]);
    const ana = rowOf(view, "Rivera Family").guardianSends[0]!;
    asStaff(sender);
    stub.calls.length = 0;
    for (const [field, id] of [["guardian_name", mei], ["guardian_inactive", old], ["guardian_inactive", mei]] as const) {
      expect(await sendDifferenceAction(field, "guardian", id, tag, ana.stamp), `${field} ${id}`).toEqual({ ok: false, errors: [SEND_CHANGED] });
    }
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(stub.customers.filter((c) => c.Id === "21" || c.Id === "23").map((c) => [c.DisplayName, c.Active])).toEqual([["Mei Chen", true], ["Old Chen", true]]);
  });
});

describe("who may press it", () => {
  it("the three permissions, any one missing refused as the guard refuses; every argument of the wrong type, size or pair refused", async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
    const offer = await guardianSendOf("Rivera Family", "guardian_name");
    const noChange = await staffWith("linkonly@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    const noLink = await staffWith("changeonly@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    const noRead = await staffWith("noread@club.org", ["Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
    stub.calls.length = 0;
    for (const who of [noChange, noLink, noRead]) {
      asStaff(who);
      await expect(sendDifferenceAction(offer.field, offer.kind, offer.recordId, tag, offer.stamp)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === noChange.id).map((a) => a.permission)).toEqual(["Roster.Family.ReadWrite"]);
    expect(refusals.filter((a) => a.actorId === noLink.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    expect(refusals.filter((a) => a.actorId === noRead.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    asStaff(sender);
    const NOT_FROM_PAGE = { ok: false, errors: [LINK_COPY.notFromPage] };
    const id = offer.recordId;
    for (const args of [
      ["guardian_name", "family", id, tag, offer.stamp], ["guardian_name", "student", id, tag, offer.stamp], ["guardian_inactive", "family", id, tag, offer.stamp],
      ["name", "guardian", id, tag, offer.stamp], ["inactive", "guardian", id, tag, offer.stamp], ["place", "guardian", id, tag, offer.stamp],
      ["guardian_active", "guardian", id, tag, offer.stamp], ["guardian_name", "parent", id, tag, offer.stamp], [7, "guardian", id, tag, offer.stamp], ["guardian_name", null, id, tag, offer.stamp],
      ["guardian_name", "guardian", "x".repeat(65), tag, offer.stamp], ["guardian_name", "guardian", "", tag, offer.stamp], ["guardian_name", "guardian", { id }, tag, offer.stamp],
      ["guardian_name", "guardian", id, null, offer.stamp], ["guardian_name", "guardian", id, "t".repeat(65), offer.stamp],
      ["guardian_name", "guardian", id, tag, "s".repeat(65)], ["guardian_name", "guardian", id, tag, { stamp: offer.stamp }],
    ] as unknown[][]) {
      expect(await (sendDifferenceAction as unknown as (...a: unknown[]) => Promise<unknown>)(...args), JSON.stringify(args)).toEqual(NOT_FROM_PAGE);
    }
    expect(posts()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await sendDifferenceAction(offer.field, offer.kind, offer.recordId, tag, offer.stamp)).toMatchObject({ ok: true });
    expect(await sends()).toEqual([expect.objectContaining({ actorId: sender.id, targetType: "guardian" })]);
  });

  it("a balance is said with its amount only to a reader who may see balances, through the press", async () => {
    await removedHere(row.id);
    stub.invoices.push(balance("9001", "11", 25));
    const offer = await guardianSendOf("Rivera Family", "guardian_inactive");
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite", "Finance.Balance.Read"]);
    asStaff(sender);
    expect(await sendDifferenceAction(offer.field, offer.kind, offer.recordId, tag, offer.stamp))
      .toEqual({ ok: false, errors: [`Ana Rivera has an open balance in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    asStaff(treasurer);
    expect(await sendDifferenceAction(offer.field, offer.kind, offer.recordId, tag, offer.stamp))
      .toEqual({ ok: false, errors: [`Ana Rivera owes $25.00 in QuickBooks. They weren't made inactive. ${WRITE_COPY.balanceFix}`] });
    expect(posts()).toEqual([]);
  });
});

describe("the view's reads", () => {
  it("reads as many times with guardians' sends as without: no query of its own", async () => {
    const spy = vi.spyOn(db, "select");
    try {
      const plain = await loadAccountingLinks();
      expect(rowOf(plain, "Rivera Family").guardianSends).toEqual([]);
      const none = spy.mock.calls.length;
      changeInBooks("11", { DisplayName: "Ana R. Lopez" });
      await readAgain(qc("14", "Bea Rivera", "2", under("10")));
      await linkRowTo(await rowIn(rivera, "Bea Rivera", "bea@example.com", "removed"), "14");
      await linkRowTo(await rowIn(chen, "Mei Lin", "mei@example.com"), "21");
      spy.mockClear();
      const v = await loadAccountingLinks();
      expect(rowOf(v, "Rivera Family").guardianSends.map((s) => s.field)).toEqual(["guardian_name", "guardian_inactive"]);
      expect(rowOf(v, "Chen Family").guardianSends.map((s) => s.field)).toEqual(["guardian_name"]);
      expect(spy.mock.calls.length).toBe(none);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the stops a guardian's send meets at the press (and on the screen)", () => {
  beforeEach(async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
  });

  it("the family's customer inactive in the books: the sentence in place of Send, and both presses refused as changed", async () => {
    changeInBooks("10", { Active: false, SyncToken: "1" });
    await readAgain();
    const r = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(r.guardianSends).toEqual([]);
    expect(r.sendNotes).toContainEqual({ at: atOf(r, "guardian_name"), words: SEND_GUARDIAN_FAMILY_INACTIVE });
    stub.calls.length = 0;
    expect(await pressName(row.id, nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera"))).toEqual({ ok: false, errors: [SEND_CHANGED] });
    await removedHere(row.id);
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("the roster's checks at the press: a page of another roster, QuickBooks not connected", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    stub.calls.length = 0;
    expect(await sendToBooks({ field: "guardian_name", guardianId: row.id, stamp }, "another-roster", sendOp())).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    await removedHere(row.id);
    expect(await sendToBooks({ field: "guardian_inactive", guardianId: row.id, stamp: inactiveStamp(row.id, "11") }, "another-roster", sendOp())).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    await db.update(guardian).set({ status: "active", disabledReason: null, statusBeforeDisable: null }).where(eq(guardian.id, row.id));
    await db.delete(qboConnection);
    expect(await pressName(row.id, stamp)).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    await removedHere(row.id);
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: false, errors: [WRITE_COPY.notConnected] });
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("a roster read holding the roster lock: refused within the guardian writes' wait, nothing sent, the person's row free again", async () => {
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    stub.calls.length = 0;
    const started = Date.now();
    // Held as refreshRoster() holds it across its read of every customer. Before the wait was bounded, the press waited
    // on it for as long as it was held, holding the person's row: here, for ever.
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      return pressName(row.id, stamp);
    });
    expect(r).toEqual({ ok: false, errors: [SEND_GUARDIAN_ROSTER_BUSY] });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    // Nothing of the person's is held: their row is locked again at once.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '1s'`);
      expect(await tx.select({ id: parent.id }).from(parent).where(eq(parent.id, ana.id)).for("update")).toHaveLength(1);
    });
    expect(await pressName(row.id, stamp)).toMatchObject({ ok: true });
  });

  it("a person's name the portal can't send as it is: no Send drawn, and the press refused in words", async () => {
    for (const [name, why] of [
      ["Ana: Rivera", "A name can't have a colon in it: QuickBooks uses one to join a student's or parent's name to their family's."],
      ["Ana  Rivera", "it isn't written as the portal writes names."],
    ] as const) {
      await db.update(parent).set({ name }).where(eq(parent.id, ana.id));
      const r = rowOf(await loadAccountingLinks(), "Rivera Family");
      expect(r.guardianSends, name).toEqual([]);
      stub.calls.length = 0;
      expect(await pressName(row.id, nameStamp(row.id, "11", "Ana R. Lopez", name)), name)
        .toEqual({ ok: false, errors: [`The person's name can't be sent to QuickBooks as it is: ${why} Rename them on their page under Parents instead.`] });
    }
    expect(posts()).toEqual([]);
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("a name pressed for an open row whose Parent customer the books have inactive, and a make-inactive for a row closed by a change of company: refused as changed", async () => {
    changeInBooks("11", { Active: false, SyncToken: "1" });
    await readAgain();
    stub.calls.length = 0;
    expect(await pressName(row.id, nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera"))).toEqual({ ok: false, errors: [SEND_CHANGED] });
    changeInBooks("11", { Active: true, SyncToken: "2" });
    await readAgain();
    await db.update(guardian).set({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" }).where(eq(guardian.id, row.id));
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toEqual({ ok: false, errors: [SEND_CHANGED] });
    expect(posts()).toEqual([]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: true });
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("a rename of the person tried while the row's \"being sent\" lock is held, as a send holds it: refused, nothing queued, the name as it was", async () => {
    expect(await holding(SENDING_LOCK, row.id, () => renamePerson(ana.id, "Ana Lopez", op))).toEqual({ ok: false, reason: "being_changed" });
    expect(await personNow(ana.id)).toBe("Ana Rivera");
    expect(await items()).toEqual([]);
  });
});

describe("how a guardian's send went, said in words", () => {
  it("the name: an answer lost, QuickBooks failing, QuickBooks holding it already", async () => {
    changeInBooks("11", { DisplayName: "Ana R. Lopez" });
    await readAgain();
    const stamp = nameStamp(row.id, "11", "Ana R. Lopez", "Ana Rivera");
    stub.loseUpdateAnswer = true;
    stub.calls.length = 0;
    const lost = await pressName(row.id, stamp);
    stub.loseUpdateAnswer = false;
    expect(lost).toEqual({ ok: true, status: "waiting", message: "The portal can't tell yet whether QuickBooks took the name “Ana Rivera” for their Parent customer: its answer didn't arrive. "
      + "The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice; you'll find it on the Reconciliation page until then." });
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", sent: true, familyId: rivera, studentId: null,
      request: expect.objectContaining({ op: "rename", qboId: "11", guardianId: row.id }) })]);
    expect(await sends()).toHaveLength(1);
    expect(await personNow(ana.id)).toBe("Ana Rivera");

    // QuickBooks failing every request: waiting for the worker, filed under the family.
    await db.delete(writeQueue);
    changeInBooks("11", { DisplayName: "Ana R. Lopez", SyncToken: "0" });
    await readAgain();
    stub.failNext = 50;
    const failing = await pressName(row.id, stamp);
    stub.failNext = 0;
    expect(failing).toMatchObject({ ok: true, status: "waiting", message: expect.stringContaining("“Ana Rivera” for their Parent customer") });
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", familyId: rivera, studentId: null, request: expect.objectContaining({ op: "rename", guardianId: row.id }) })]);

    // QuickBooks renamed to the person's name since the page, with a new version: found, nothing more sent.
    await db.delete(writeQueue);
    changeInBooks("11", { DisplayName: "Ana R. Lopez", SyncToken: "0" });
    await readAgain();
    changeInBooks("11", { DisplayName: "Ana Rivera", SyncToken: "1" });
    expect(await pressName(row.id, stamp)).toEqual({ ok: true,
      message: "QuickBooks has the name “Ana Rivera” on their Parent customer already, so nothing more was sent. Their name in the portal and on their sign-in is as it was." });
    expect(await items()).toEqual([expect.objectContaining({ state: "done", request: expect.objectContaining({ op: "rename", guardianId: row.id }) })]);
  });

  it("the make-inactive: a refusal QuickBooks gives is said with nothing queued; inactive there asks for a roster read; its rows found by the guardian", async () => {
    await removedHere(row.id);
    stub.updateFault = "6000";
    stub.calls.length = 0;
    const refused = await pressInactive(row.id, inactiveStamp(row.id, "11"));
    stub.updateFault = null;
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? [] : refused.errors).toHaveLength(1);
    expect(await items()).toEqual([]);
    expect((await sends()).map((a) => a.after)).toEqual([expect.objectContaining({ field: "guardian_inactive", outcome: "refused", code: expect.stringContaining("6000") })]);
    expect((await auditsOf("roster.write.refused")).map((a) => a.after)).toEqual([expect.objectContaining({ op: "deactivate", guardianId: row.id, code: expect.stringContaining("6000") })]);
    expect(stub.customers.find((c) => c.Id === "11")).toMatchObject({ Active: true });

    // Inactive in QuickBooks already, the cache behind: nothing sent, and a roster read asked for.
    await db.delete(setting).where(eq(setting.key, ROSTER_ASK_KEY));
    expect(await rosterRefreshAsked()).toBe(false);
    changeInBooks("11", { Active: false, SyncToken: "1" });
    expect(await pressInactive(row.id, inactiveStamp(row.id, "11"))).toMatchObject({ ok: true });
    expect(await rosterRefreshAsked()).toBe(true);
    const rows = await sends();
    expect(rows.map((a) => (a.after as { outcome: string }).outcome).sort()).toEqual(["inactive_there", "refused"]);
    expect(rows.every((a) => a.targetType === "guardian" && a.targetId === row.id)).toBe(true);
    // The audit page's record filter finds each by its target, as a guardian's rows are found.
    expect((await auditPage(parseAuditFilters({ record: `guardian:${row.id}` }), {}, 500)).rows.map((x) => x.id)).toEqual(expect.arrayContaining(rows.map((a) => a.id)));
  });
});
