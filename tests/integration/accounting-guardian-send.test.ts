import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, guardian, parent, parentAuthUser, writeQueue } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { sendStamp } from "@/lib/accounting/stamp";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { removeGuardian } from "@/lib/parents/guardians";
import { refreshRoster } from "@/lib/roster/refresh";
import { GUARDIAN_BEING_CHANGED, SEND_CHANGED, SENDING_LOCK, sendGuardianNameQueuedWords, sendGuardianNameTakenWords, sendToBooks, STALE_TWICE, WRITE_COPY } from "@/lib/roster/writes";
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
