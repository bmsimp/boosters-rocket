import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));
// What the page hands each LinkPress, the client component: every prop is sent to the browser, so each is recorded here
// and drawn by the real component.
const pressProps = vi.hoisted(() => ({ seen: [] as Record<string, unknown>[] }));
vi.mock("@/app/staff/(app)/links/link-press", async (original) => {
  const m = await original<typeof import("@/app/staff/(app)/links/link-press")>();
  const { createElement } = await import("react");
  return { ...m, LinkPress: (p: Parameters<typeof m.LinkPress>[0]) => { pressProps.seen.push({ ...p }); return createElement(m.LinkPress, p); } };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { loadAccountingLinks, SEND_ALL_MAX, type SendAllOffer } from "@/lib/accounting/mapping";
import { LINK_COPY, SEND_ALL_COPY, sendAllDifferences, sentAllWords } from "@/lib/accounting/link-writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { runWriteQueue } from "@/lib/roster/queue";
import { SAVED_LEASE_MS, SENDING_LOCK } from "@/lib/roster/writes";
import { sendAllAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { fznCompany, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { auditsOf, connectRoster, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Send the app's for all (stage 4's slice M5b of the app-owned families spec; section 5, "there is a bulk Send the app's
 * for all"; sendAllDifferences() in src/lib/accounting/link-writes.ts, the press sendAllAction()): every name and
 * student's family the accounting links screen's list shows, queued as changes saved first in one transaction under the
 * roster lock, nothing sent at the press, the queue's worker sending each once its lease is out. The company is
 * fznCompany()'s with, imported before anything is changed in the portal, Zoe Rivera 13 (Student, under Rivera Family 10),
 * Sam Chen 23 (Student, under Chen Family 20), Park Family 70 with Ivy Park 71, and Oak Family 80 with Max Oak 81. The
 * books change only through the stub (changeInBooks(), with a roster read, readAgain()).
 */
vi.setConfig({ testTimeout: 90_000 });

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
/** Runs the press while another session holds this lock, as a send under way (whileSending()) holds it. */
const holding = <T>(key: number, id: string, run: () => Promise<T>) => db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(key))}, hashtext(${id}::text))`);
  return run();
});

let tag: string;
let sender: Awaited<ReturnType<typeof staffWith>>;
const op = () => ({ actor: { door: "staff" as const, id: sender.id, label: sender.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: sender.id });
const EVERY = { status: null, q: "" } as const;
/** The press as the page binds it for this filter. */
const offerFor = async (filter: { status: null; q: string } = EVERY): Promise<SendAllOffer> => {
  const o = (await loadAccountingLinks()).sendAll(filter);
  if (o === null) throw new Error("the view offers no Send the app's for all");
  return o;
};
const pressWith = (o: { count: unknown; stamp: unknown }, filter: { status: unknown; q: unknown } = { status: "", q: "" }, t = tag) =>
  sendAllDifferences({ status: filter.status, q: filter.q, count: o.count, stamp: o.stamp }, t, op());
const sends = () => auditsOf("accounting.difference.send");
const items = () => db.select().from(writeQueue);
/** Every write sent to the books since the calls were last cleared, as its method and path. */
const writes = () => stub.apiCalls().filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
const cust = (id: string) => stub.customers.find((c) => c.Id === id)!;
const listOf = (whole: string) => { const at = whole.indexOf('id="links-list-h"'); return whole.slice(at, whole.indexOf("</section>", at)).replaceAll("&#x27;", "'").replaceAll("<!-- -->", ""); };

let rivera: AppFamilyId, chen: AppFamilyId, park: AppFamilyId, oak: AppFamilyId, zoe: AppStudentId, sam: AppStudentId, max: AppStudentId;
beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox = []; pressProps.seen.length = 0;
  await seedParentSettings(SIGNINS_ON);
  await seedWorkingMail();
  stub.quirks.balances = true;
  sender = await staffWith("sender@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
  tag = await connectRoster(stub);
  await readAgain(qc("13", "Zoe Rivera", "3", under("10")), qc("23", "Sam Chen", "3", under("20")), qc("70", "Park Family", "1"), qc("71", "Ivy Park", "3", under("70")),
    qc("80", "Oak Family", "1"), qc("81", "Max Oak", "3", under("80")));
  await syncAppRecords();
  [rivera, chen, park, oak] = [await recordOfCustomer("10", "family"), await recordOfCustomer("20", "family"), await recordOfCustomer("70", "family"), await recordOfCustomer("80", "family")];
  [zoe, sam, max] = [await recordOfCustomer("13", "student"), await recordOfCustomer("23", "student"), await recordOfCustomer("81", "student")];
});

/**
 * Four differences, each reading customers of its own: Oak's name (80) and Zoe's (13) renamed in the books; Sam (23,
 * a Chen) put under Park (70) in the books; Leo (12, a Rivera) put at the top of the tree. And two it passes over: Max
 * (81) inactive in the portal, active in the books (a make-inactive), and Ivy (71) active in the portal, inactive in the
 * books.
 */
async function fourAndTwo() {
  changeInBooks("80", { DisplayName: "Oak Household", SyncToken: "1" });
  changeInBooks("13", { DisplayName: "Zoe M. Rivera", SyncToken: "1" });
  changeInBooks("23", { ...under("70"), SyncToken: "1" });
  changeInBooks("12", { ParentRef: undefined, Job: false, SyncToken: "1" });
  changeInBooks("71", { Active: false, SyncToken: "1" });
  await readAgain();
  await db.update(student).set({ active: false }).where(eq(student.id, max));
}

describe("Send the app's for all", () => {
  it("queues every name and student's family the list shows in one press, sends nothing at the press, and the worker sends each once its lease is out", async () => {
    // A rename of Oak's kept on Reconciliation: the send takes its place.
    const kept = await seedQueued({ op: "rename", role: "family", qboId: "80", syncToken: "0", name: "Oak Family", was: "Oak Old" }, { state: "refused", code: "fault_6240" });
    await fourAndTwo();
    const offer = await offerFor();
    expect(offer).toMatchObject({ count: 4, later: 0, passedOver: { inactive: 1, booksInactive: 1 } });
    stub.calls.length = 0;
    const before = Date.now();
    const r = await pressWith(offer);
    expect(r).toEqual({ ok: true, message: sentAllWords({ names: 2, places: 2, later: 0, passedOver: { inactive: 1, booksInactive: 1 }, inactiveListed: false }) });
    // No inactive family is listed, so none is spoken of.
    expect(r.ok && r.message).not.toContain("inactive families");
    expect(r.ok && r.message).toContain("Queued for QuickBooks: 2 names and 2 students' families.");
    expect(r.ok && r.message).toContain("Passed over: 1 make-inactive");
    // Nothing went to QuickBooks at the press: no write request at all.
    expect(writes()).toEqual([]);
    const queued = (await items()).filter((q) => q.state === "waiting");
    expect(queued).toHaveLength(4);
    for (const q of queued) expect(q.nextTryAt!.getTime()).toBeGreaterThanOrEqual(before + SAVED_LEASE_MS - 1000);
    expect(queued.map((q) => `${q.request.op} ${q.targetQboId}`).sort()).toEqual(["move 12", "move 23", "rename 13", "rename 80"]);
    expect((await items()).find((q) => q.id === kept.id)).toMatchObject({ state: "given_up" });
    // One send row each, with the bulk's id and its item; one bulk row with the counts.
    const [bulk] = await auditsOf("accounting.difference.send_all");
    expect(await auditsOf("accounting.difference.send_all")).toHaveLength(1);
    expect(bulk).toMatchObject({ targetType: "accounting_difference", actorId: sender.id,
      after: { count: 4, names: 2, places: 2, passedOver: { inactive: 1, booksInactive: 1 }, later: 0, status: null, searched: false } });
    const pressId = (bulk!.after as { pressId: string }).pressId;
    expect(bulk!.targetId).toBe(pressId);
    const rows = await sends();
    expect(rows).toHaveLength(4);
    for (const a of rows) expect(a.after).toMatchObject({ bulk: pressId, queueId: expect.any(String) });
    expect(rows.map((a) => (a.after as { queueId: string }).queueId).sort()).toEqual(queued.map((q) => q.id).sort());
    expect(rows.find((a) => a.targetId === String(oak))!.after).toMatchObject({ field: "name", replaced: [kept.id] });
    expect(rows.find((a) => a.targetId === String(sam))!.after).toMatchObject({ field: "place", familyId: String(chen), fromFamilyId: String(park) });
    // Nothing passed over is queued: no make-inactive, nothing for Ivy.
    expect(queued.some((q) => q.request.op === "deactivate" || q.targetQboId === "71" || q.targetQboId === "81")).toBe(false);
    // The worker, before the lease is out, takes nothing; after it, sends each as any saved change.
    await runWriteQueue(new Date());
    expect(writes()).toEqual([]);
    await runWriteQueue(new Date(Date.now() + SAVED_LEASE_MS + 60_000));
    expect(cust("80")).toMatchObject({ DisplayName: "Oak Family" });
    expect(cust("13")).toMatchObject({ DisplayName: "Zoe Rivera" });
    expect(cust("23")).toMatchObject({ ParentRef: { value: "20" } });
    expect(cust("12")).toMatchObject({ ParentRef: { value: "10" } });
    expect(cust("71")).toMatchObject({ Active: false });
    expect(cust("81")).toMatchObject({ Active: true });
    expect((await items()).filter((q) => queued.some((x) => x.id === q.id)).map((q) => q.state)).toEqual(["done", "done", "done", "done"]);
    // The portal's records were never changed: they had these values already.
    expect((await db.select().from(student).where(eq(student.id, sam)))[0]).toMatchObject({ familyId: chen, active: true });
    expect((await db.select().from(student).where(eq(student.id, max)))[0]).toMatchObject({ active: false });
  });

  it("QuickBooks changing one again between the page and the worker: that one held and kept, the others done", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    expect(await pressWith(offer)).toMatchObject({ ok: true });
    // Someone renames Zoe again in QuickBooks before the worker gets to it.
    changeInBooks("13", { DisplayName: "Zoe Q. Rivera", SyncToken: "2" });
    await runWriteQueue(new Date(Date.now() + SAVED_LEASE_MS + 60_000));
    expect(cust("13")).toMatchObject({ DisplayName: "Zoe Q. Rivera" });
    const all = await items();
    expect(all.find((q) => q.targetQboId === "13")).toMatchObject({ state: "refused" });
    expect(all.filter((q) => q.targetQboId !== "13").map((q) => q.state)).toEqual(["done", "done", "done"]);
    expect(cust("80")).toMatchObject({ DisplayName: "Oak Family" });
  });

  it("refused with nothing queued: a stale stamp, a count other than the page's, and the list changed since the page", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    stub.calls.length = 0;
    expect(await pressWith({ count: offer.count, stamp: "x".repeat(22) })).toEqual({ ok: false, errors: [SEND_ALL_COPY.changed] });
    expect(await pressWith({ count: offer.count - 1, stamp: offer.stamp })).toEqual({ ok: false, errors: [SEND_ALL_COPY.changed] });
    // The filter isn't the page's: another list.
    expect(await pressWith(offer, { status: "", q: "oak" })).toEqual({ ok: false, errors: [SEND_ALL_COPY.changed] });
    // Oak renamed back in the books since the page: one send fewer.
    changeInBooks("80", { DisplayName: "Oak Family", SyncToken: "2" });
    await readAgain();
    expect(await pressWith(offer)).toEqual({ ok: false, errors: [SEND_ALL_COPY.changed] });
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await auditsOf("accounting.difference.send_all")).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it("the stamp seals which sends the list showed and its filter: as many sends, but others, or another filter showing the same ones, are refused", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    // Another filter showing the same four: its own stamp, so the page's doesn't hold for it.
    const withDifferences = (await loadAccountingLinks()).sendAll({ status: "with_differences", q: "" })!;
    expect(withDifferences.count).toBe(offer.count);
    expect(withDifferences.stamp).not.toBe(offer.stamp);
    expect(await pressWith(offer, { status: "with_differences", q: "" })).toEqual({ ok: false, errors: [SEND_ALL_COPY.changed] });
    // Oak renamed back in the books and Park renamed there since the page: one send gone and another come, still four.
    changeInBooks("80", { DisplayName: "Oak Family", SyncToken: "2" });
    changeInBooks("70", { DisplayName: "Park Household", SyncToken: "1" });
    await readAgain();
    expect((await offerFor()).count).toBe(offer.count);
    expect(await pressWith(offer)).toEqual({ ok: false, errors: [SEND_ALL_COPY.changed] });
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
    expect(await auditsOf("accounting.difference.send_all")).toEqual([]);
  });

  it("a family a student's move goes out of being changed at this moment (its lock held): refused, nothing queued, said as busy", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    // Park's "being sent" lock held, as a make-inactive of Park on its page holds it: Sam's move out of Park can't be queued.
    expect(await holding(SENDING_LOCK, String(park), () => pressWith(offer))).toEqual({ ok: false, errors: [SEND_ALL_COPY.familyBusy("Sam Chen's family")] });
    // Chen's, the family it goes into, likewise.
    expect(await holding(SENDING_LOCK, String(chen), () => pressWith(offer))).toEqual({ ok: false, errors: [SEND_ALL_COPY.familyBusy("Sam Chen's family")] });
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("two students sent into one family go in one press, and the worker sends both", async () => {
    // Leo and Zoe, both Riveras, put at the top of the tree in the books.
    changeInBooks("12", { ParentRef: undefined, Job: false, SyncToken: "1" });
    changeInBooks("13", { ParentRef: undefined, Job: false, SyncToken: "1" });
    await readAgain();
    const offer = await offerFor();
    expect(offer).toMatchObject({ count: 2, later: 0 });
    const r = await pressWith(offer);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toContain("Queued for QuickBooks: 2 students' families.");
    expect(r.ok && r.message).not.toContain("more difference");
    expect((await items()).map((q) => `${q.request.op} ${q.targetQboId}`).sort()).toEqual(["move 12", "move 13"]);
    await runWriteQueue(new Date(Date.now() + SAVED_LEASE_MS + 60_000));
    expect(cust("12")).toMatchObject({ ParentRef: { value: "10" } });
    expect(cust("13")).toMatchObject({ ParentRef: { value: "10" } });
    expect((await items()).map((q) => q.state)).toEqual(["done", "done"]);
  });

  it("one record's lock held (a send of it under way): refused, nothing queued, said in words", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    expect(await holding(SENDING_LOCK, String(zoe), () => pressWith(offer))).toEqual({ ok: false, errors: [SEND_ALL_COPY.busy("Zoe Rivera's name")] });
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("two sends giving one name: refused, nothing queued, said in words", async () => {
    changeInBooks("13", { DisplayName: "Zoe M. Rivera", SyncToken: "1" });
    await readAgain();
    // Sam's record renamed in the portal to the name Zoe's sends: both differ from the books, and neither name is held there.
    await db.update(student).set({ name: "Zoe Rivera" }).where(eq(student.id, sam));
    const offer = await offerFor();
    expect(offer.count).toBe(2);
    expect(await pressWith(offer)).toEqual({ ok: false, errors: [SEND_ALL_COPY.sameName("Zoe Rivera")] });
    expect(await items()).toEqual([]);
    expect(await sends()).toEqual([]);
  });

  it("a send that reads a customer an earlier one queues for is left for a later press, and said", async () => {
    // Park's name and Sam's move under Park's... the other way: Sam (a Chen) put under Park in the books, and Chen renamed there.
    changeInBooks("20", { DisplayName: "Chen Household", SyncToken: "1" });
    changeInBooks("23", { ...under("70"), SyncToken: "1" });
    await readAgain();
    const offer = await offerFor();
    expect(offer).toMatchObject({ count: 1, later: 1 });
    const r = await pressWith(offer);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.message).toContain("One more difference waits for a change queued now to reach QuickBooks first");
    expect((await items()).map((q) => q.request.op)).toEqual(["rename"]);
  });

  it(`more than ${SEND_ALL_MAX}: no press on the page, a notice to narrow the list, and the press refused`, async () => {
    // A hundred and one students under Rivera, imported, then each renamed in the books.
    const many = Array.from({ length: SEND_ALL_MAX + 1 }, (_, i) => qc(String(1000 + i), `Kid ${i} Rivera`, "3", under("10")));
    await readAgain(...many);
    await syncAppRecords();
    for (const c of many) changeInBooks(c.Id, { DisplayName: `${c.DisplayName} Jr`, SyncToken: "1" });
    await readAgain();
    const offer = await offerFor();
    expect(offer).toMatchObject({ count: SEND_ALL_MAX + 1, stamp: null });
    asStaff(sender);
    const list = listOf(await renderPage(AccountingLinksPage));
    expect(list).not.toContain("Send the app's for all (");
    expect(list).toContain(`This list shows ${SEND_ALL_MAX + 1} names and students' families to send. Up to ${SEND_ALL_MAX} can be sent at once, so narrow the list with the search or a status first.`);
    expect(await pressWith({ count: SEND_ALL_MAX + 1, stamp: "s".repeat(22) })).toEqual({ ok: false, errors: [SEND_ALL_COPY.overCap] });
    expect(await sendAllAction("", "", SEND_ALL_MAX + 1, tag, "s".repeat(22))).toEqual({ ok: false, errors: [SEND_ALL_COPY.overCap] });
    expect(await items()).toEqual([]);
    // One of them renamed back in the books: exactly SEND_ALL_MAX, the press drawn with its count and taken.
    changeInBooks(many[0]!.Id, { DisplayName: many[0]!.DisplayName, SyncToken: "2" });
    await readAgain();
    const atCap = await offerFor();
    expect(atCap.count).toBe(SEND_ALL_MAX);
    expect(atCap.stamp).not.toBeNull();
    expect(listOf(await renderPage(AccountingLinksPage))).toContain(`Send the app's for all (${SEND_ALL_MAX})`);
    expect(await pressWith(atCap)).toMatchObject({ ok: true });
    expect((await items()).filter((q) => q.state === "waiting")).toHaveLength(SEND_ALL_MAX);
    expect(writes()).toEqual([]);
  });
});

describe("Send the app's for all in flat books", () => {
  it("queues a member's name", async () => {
    await resetDb(); stub.reset();
    sender = await staffWith("sender@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
    const company = fznCompany();
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] }, company: { ...company, customers: company.customers.filter((c) => c.Id !== "11" && c.Id !== "12") } });
    const member = await recordOfCustomer("10", "family");
    changeInBooks("10", { DisplayName: "Rivera Household", SyncToken: "1" });
    await readAgain();
    const offer = await offerFor();
    expect(offer.count).toBe(1);
    expect(await pressWith(offer)).toMatchObject({ ok: true });
    expect(await items()).toEqual([expect.objectContaining({ state: "waiting", targetQboId: "10", request: expect.objectContaining({ op: "rename", role: "member", name: "Rivera Family", was: "Rivera Household" }) })]);
    expect(await sends()).toEqual([expect.objectContaining({ targetType: "family", targetId: String(member) })]);
  });
});

describe("who may press it, and the page", () => {
  it("the linking permission with Roster.Read and Roster.Family.ReadWrite: any one missing is refused as the guard refuses, and every argument is checked", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    const noChange = await staffWith("linkonly@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    const noLink = await staffWith("changeonly@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
    const noRead = await staffWith("noread@club.org", ["Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
    for (const who of [noChange, noLink, noRead]) {
      asStaff(who);
      await expect(sendAllAction("", "", offer.count, tag, offer.stamp!)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === noChange.id).map((a) => a.permission)).toEqual(["Roster.Family.ReadWrite"]);
    expect(refusals.filter((a) => a.actorId === noLink.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    expect(refusals.filter((a) => a.actorId === noRead.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    asStaff(sender);
    const NOT_FROM_PAGE = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const args of [
      ["nope", "", offer.count, tag, offer.stamp], [7, "", offer.count, tag, offer.stamp], ["", 7, offer.count, tag, offer.stamp], ["", "q".repeat(201), offer.count, tag, offer.stamp],
      ["", "", "4", tag, offer.stamp], ["", "", 0, tag, offer.stamp], ["", "", 1.5, tag, offer.stamp], ["", "", offer.count, null, offer.stamp],
      ["", "", offer.count, "t".repeat(65), offer.stamp], ["", "", offer.count, tag, "s".repeat(65)], ["", "", offer.count, tag, { stamp: offer.stamp }],
    ] as unknown[][]) {
      expect(await (sendAllAction as unknown as (...a: unknown[]) => Promise<unknown>)(...args), JSON.stringify(args)).toEqual(NOT_FROM_PAGE);
    }
    expect(await items()).toEqual([]);
    expect(await sendAllAction("", "", offer.count, tag, offer.stamp!)).toMatchObject({ ok: true });
    expect(await auditsOf("accounting.difference.send_all")).toEqual([expect.objectContaining({ actorId: sender.id })]);
    expect(writes()).toEqual([]);
  });

  it("draws the press with its count for a reader holding all three, none for one without Roster.Family.ReadWrite, and only words and bound actions", async () => {
    await fourAndTwo();
    const offer = await offerFor();
    asStaff(sender);
    const whole = await renderPage(AccountingLinksPage);
    const list = listOf(whole);
    expect(list).toContain(`Send the app's for all (4)<span class="visually-hidden">: Send the app's for all</span>`);
    expect(list).toContain("It skips 1 make-inactive: each reads a balance first, so send it on its row.");
    expect(list).toContain("It passes over 1 difference whose customer QuickBooks has inactive: the portal sends nothing there, and never makes a customer active.");
    // No inactive family is listed, so none is spoken of.
    expect(list).not.toContain("The inactive families listed after the families");
    expect(whole).not.toContain(offer.stamp!);
    // Every prop each press is handed is words or its bound action: no stamp, offer, seal or id goes to the browser as a prop.
    expect(pressProps.seen.length).toBeGreaterThan(0);
    for (const p of pressProps.seen) {
      expect(Object.keys(p).sort()).toEqual(["about", "act", "busy", "label"]);
      for (const k of ["about", "busy", "label"] as const) expect(typeof p[k]).toBe("string");
      expect(typeof p.act).toBe("function");
    }
    expect(pressProps.seen.some((p) => p.label === "Send the app's for all (4)")).toBe(true);
    expect(whole).toContain("Only three things here send anything to the books: Send the app&#x27;s to QuickBooks, Send the app&#x27;s for all, and a student&#x27;s move taken from the books");
    // A search narrows it, by the list's own rule.
    expect(listOf(await renderPage(AccountingLinksPage, { searchParams: { q: "oak" } }))).toContain("Send the app's for all (1)");
    const linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    asStaff(linker);
    const theirs = listOf(await renderPage(AccountingLinksPage));
    // Neither the press nor its notice.
    expect(theirs).not.toContain("Send the app's for all (");
    expect(theirs).not.toContain("Send the app's for all sends only");
    // Oak made inactive in the portal, its customer active in the books: listed after the families, and so spoken of.
    await db.update(student).set({ active: false }).where(eq(student.familyId, oak));
    await db.update(family).set({ active: false }).where(eq(family.id, oak));
    asStaff(sender);
    const now = await offerFor();
    expect(now.inactiveListed).toBe(true);
    expect(listOf(await renderPage(AccountingLinksPage))).toContain("The inactive families listed after the families aren't part of it.");
    // Drawing the page queues nothing.
    expect(await items()).toEqual([]);
    expect(writes()).toEqual([]);
    expect(await db.select().from(family).where(eq(family.id, rivera))).toHaveLength(1);
  });
});
