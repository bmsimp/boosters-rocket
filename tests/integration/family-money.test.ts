import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMoney, qboConnection, qboCustomer, setting } from "@/lib/db/schema";
import { loadFamilyMoney, MAX_LIVE_READS, RETRY_AFTER_FAILURE_MS } from "@/lib/money/family-money";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { resetDb } from "../helpers/db";
import { ageMoney, connectCompany, invoiceQueries, moneyRow, setFreshSeconds, stubInvoice as inv } from "../helpers/money";
import { FAMILY_A, MONEY_REALM, seedFamilyMoney } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, fam, par, seedShape, stu } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const SYSTEM = { actor: { door: "system", id: null, label: "test" }, ip: null } as const;
const MINUTE = 60_000;
/** A family (10) with a parent (11) and a student (12), and a second family (20) with a student (22). */
async function twoFamilies() {
  await seedShape();
  await addToCache([
    fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"),
    fam("20", "Chen Family"), stu("22", "Mei Chen", "20"),
  ]);
  stub.customers = [{ Id: "10", DisplayName: "Rivera Family", BalanceWithJobs: 0 }, { Id: "20", DisplayName: "Chen Family", BalanceWithJobs: 0 }];
}
const balanceWithJobs = (amount: number) => { stub.customers.find((c) => c.Id === "10")!.BalanceWithJobs = amount; };
const audits = async (action = "money.balance_mismatch") => (await db.select().from(auditLog)).filter((r) => r.action === action);
const numbers = (invoices: { number: string | null }[]) => invoices.map((i) => i.number);

describe("whose invoices are a family's (v1 spec §8.2)", () => {
  it("layered: the family customer and its active students and parents, and nobody else", async () => {
    await twoFamilies();
    await addToCache([
      stu("13", "Old Student", "10", { active: false }),
      fam("14", "A Family Under A Family", { parentQboId: "10" }), // a sub-customer of the family type is another family
      { qboId: "15", displayName: "A Sponsor", typeQboId: "M", parentQboId: "10" },
      stu("16", "Grandchild", "12"),                                              // not directly under the family
    ]);
    await connectCompany(stub);
    stub.invoices = [
      inv("1", "10"), inv("2", "11", { Balance: 20 }), inv("3", "12", { Balance: 30.5 }),
      inv("4", "13"), inv("5", "14"), inv("6", "15"), inv("7", "16"), inv("8", "20"), inv("9", "22"),
    ];
    balanceWithJobs(135.5);
    const money = await loadFamilyMoney("10");
    expect(invoiceQueries(stub)).toEqual(["select * from Invoice where CustomerRef in ('10','11','12') orderby Id startposition 1 maxresults 1000"]);
    expect(money.familyName).toBe("Rivera Family");
    expect(money.figures).toMatchObject({ current: true, totalCents: 13550, currency: "USD", credit: false, paid: [] });
    expect(money.figures!.open.map((i) => [i.number, i.forName, i.balanceCents])).toEqual([["INV-1", null, 8500], ["INV-2", "Ana Rivera", 2000], ["INV-3", "Leo Rivera", 3050]]);
    expect(await audits()).toHaveLength(0);
  });

  it("layered with no student or parent type: the family customer alone", async () => {
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: null, parentTypeId: null });
    await addToCache([fam("10", "Rivera Family"), stu("12", "Leo Rivera", "10")]);
    await connectCompany(stub);
    stub.invoices = [inv("1", "10"), inv("3", "12")];
    expect(numbers((await loadFamilyMoney("10")).figures!.open)).toEqual(["INV-1"]);
    expect(invoiceQueries(stub)).toEqual(["select * from Invoice where CustomerRef = '10' orderby Id startposition 1 maxresults 1000"]);
  });

  it("flat: the member's own customer only, whatever sits under it", async () => {
    await seedShape({ kind: "flat", memberTypeIds: ["M"] });
    await addToCache([{ qboId: "30", displayName: "Okafor Household", typeQboId: "M" }, { qboId: "31", displayName: "A Job", typeQboId: "M", parentQboId: "30" },
      { qboId: "40", displayName: "Lee Household", typeQboId: "M" }]);
    await connectCompany(stub);
    stub.customers = [{ Id: "30", BalanceWithJobs: 170 }];
    stub.invoices = [inv("1", "30"), inv("2", "31"), inv("3", "40")];
    const money = await loadFamilyMoney("30");
    expect(money.familyName).toBe("Okafor Household");
    expect(numbers(money.figures!.open)).toEqual(["INV-1"]);
    expect(money.figures!.totalCents).toBe(8500);
    expect(invoiceQueries(stub)).toEqual(["select * from Invoice where CustomerRef = '30' orderby Id startposition 1 maxresults 1000"]);
  });

  it.each([
    ["a customer the shape doesn't call a family", "12"],
    ["a customer of a type outside the shape", "15"],
    ["an id that isn't in the cache", "999"],
  ])("shows nothing, and asks QuickBooks nothing, for %s", async (_what, id) => {
    await twoFamilies();
    await addToCache([{ qboId: "15", displayName: "A Sponsor", typeQboId: "M" }]);
    await connectCompany(stub);
    stub.invoices = [inv("1", "12"), inv("2", "15"), inv("3", "999")];
    expect((await loadFamilyMoney(id)).figures).toBeNull();
    expect(stub.calls).toHaveLength(0);
    expect((await moneyRow(id))?.failedCode).toBe("not_a_family");
  });

  it("never sends an id that isn't digits to QuickBooks: such a family only ever shows what is stored", async () => {
    await seedShape();
    await addToCache([fam(FAMILY_A.family.qboId, FAMILY_A.family.name), fam("50", "Digits Family"), stu("5O", "Letter O Student", "50")]);
    await connectCompany(stub);
    expect((await loadFamilyMoney(FAMILY_A.family.qboId)).figures).toBeNull();
    expect((await loadFamilyMoney("50")).figures).toBeNull(); // one bad id among the family's customers refuses the whole read
    expect(stub.calls).toHaveLength(0);
    expect((await moneyRow("50"))?.failedCode).toBe("bad_id");
  });
});

describe("reading and keeping (v1 spec §8.2: live, with a short cache)", () => {
  it("keeps one row per family: the invoices as shown, the total, QuickBooks' own balance, the currency, the company and the time", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [
      inv("1", "10", { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", "12", { InvoiceLink: "javascript:alert(1)" }),
      inv("3", "10", { Balance: 0, TxnDate: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) }),
    ];
    balanceWithJobs(170);
    const before = Date.now();
    await loadFamilyMoney("10");
    const row = (await moneyRow("10"))!;
    expect(row).toMatchObject({ realmId: MONEY_REALM, totalCents: 17000, balanceWithJobsCents: 17000, currency: "USD", failedAt: null, failedCode: null, mismatchAuditedAt: null });
    expect(row.readAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.invoices!.map((i) => [i.number, i.balanceCents, i.payLink])).toEqual([["INV-1", 8500, "https://connect.intuit.com/t/one"], ["INV-2", 8500, null], ["INV-3", 0, null]]);
    expect(await db.select().from(familyMoney)).toHaveLength(1);
    // The requests: the invoices with their pay links, then the family customer for the cross-check.
    expect(stub.apiCalls().map((c) => [c.method, c.path, c.query.get("include")])).toEqual([
      ["GET", `/v3/company/${MONEY_REALM}/query`, "invoiceLink"], ["GET", `/v3/company/${MONEY_REALM}/customer/10`, null]]);
  });

  it("shows a fresh row at once, without asking QuickBooks", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    const first = await loadFamilyMoney("10");
    const asked = stub.calls.length;
    stub.invoices = [inv("1", "10"), inv("2", "10")];
    await ageMoney("10", 4 * MINUTE); // inside the default five minutes
    const second = await loadFamilyMoney("10");
    expect(stub.calls).toHaveLength(asked);
    expect(second.figures).toMatchObject({ current: true, totalCents: 8500 });
    expect(Date.parse(second.figures!.asOf)).toBe(Date.parse(first.figures!.asOf) - 4 * MINUTE);
  });

  it("asks again once the row is older than the freshness window, and replaces it", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    stub.invoices = [inv("1", "10", { Balance: 0 }), inv("2", "10", { Balance: 12.34 })];
    await ageMoney("10", 6 * MINUTE);
    const money = await loadFamilyMoney("10");
    expect(money.figures).toMatchObject({ current: true, totalCents: 1234 });
    expect(numbers(money.figures!.open)).toEqual(["INV-2"]);
    expect(Date.now() - Date.parse(money.figures!.asOf)).toBeLessThan(10_000);
    expect(await db.select().from(familyMoney)).toHaveLength(1);
  });

  it("goes by the stored freshness window: a long one keeps a row fresh, none at all asks every time", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await setFreshSeconds(7 * 86_400);
    await loadFamilyMoney("10");
    await ageMoney("10", 6 * 86_400_000);
    const asked = stub.calls.length;
    expect((await loadFamilyMoney("10")).figures!.current).toBe(true);
    expect(stub.calls).toHaveLength(asked);
    await setFreshSeconds(0);
    expect((await loadFamilyMoney("10")).figures!.current).toBe(true);
    expect((await loadFamilyMoney("10")).figures!.current).toBe(true);
    expect(invoiceQueries(stub)).toHaveLength(3);
  });

  it("when QuickBooks can't be reached, keeps the old row, records the failed try, and says the figures are not current", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    const first = await loadFamilyMoney("10");
    await ageMoney("10", 6 * MINUTE);
    stub.invoices = [inv("1", "10", { Balance: 1 })];
    stub.failNext = 2; // the try and its one retry
    const money = await loadFamilyMoney("10");
    expect(money.figures).toMatchObject({ current: false, totalCents: 8500 });
    expect(Date.parse(money.figures!.asOf)).toBe(Date.parse(first.figures!.asOf) - 6 * MINUTE);
    const row = (await moneyRow("10"))!;
    expect(row).toMatchObject({ totalCents: 8500, failedCode: "http_500" });
    expect(Date.now() - row.failedAt!.getTime()).toBeLessThan(10_000);
    expect(JSON.stringify(row)).not.toContain("a message the portal must never store");
    expect(stub.apiCalls()).toHaveLength(4); // read, cross-check, failed try, failed retry
  });

  it("after a failed try, shows what is stored without asking again for a while, then asks", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    await ageMoney("10", 6 * MINUTE);
    stub.failNext = 2;
    await loadFamilyMoney("10");
    const asked = stub.calls.length;
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: false, totalCents: 8500 }); // QuickBooks is back, but it is too soon
    expect(stub.calls).toHaveLength(asked);
    await ageMoney("10", RETRY_AFTER_FAILURE_MS + 1000);
    stub.invoices = [inv("1", "10", { Balance: 60 })];
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 6000 });
    // The failed try stays on the row as the last one that failed; it is older than the read, so nothing waits on it.
    expect((await moneyRow("10"))!.failedCode).toBe("http_500");
    stub.invoices = [];
    await ageMoney("10", 6 * MINUTE);
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 0 });
  });

  it("with nothing stored and QuickBooks down, shows nothing and records the failed try", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.failNext = 2;
    expect(await loadFamilyMoney("10")).toEqual({ familyName: "Rivera Family", figures: null });
    expect(await moneyRow("10")).toMatchObject({ readAt: null, invoices: null, totalCents: null, realmId: null, failedCode: "http_500" });
    stub.reset();
    expect((await loadFamilyMoney("10")).figures).toBeNull(); // too soon to ask again
    expect(stub.calls).toHaveLength(0);
  });

  it("gives up on a slow QuickBooks after a short time and keeps what it had", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    await ageMoney("10", 6 * MINUTE);
    stub.apiDelayMs = 4000;
    const started = Date.now();
    const money = await loadFamilyMoney("10", { timeoutMs: 200 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(money.figures).toMatchObject({ current: false, totalCents: 8500 });
    expect((await moneyRow("10"))!.failedCode).toBe("timeout");
  });

  it("refuses an answer it can't trust, and shows nothing of it", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10"), inv("2", "12", { Balance: "lots" })];
    expect((await loadFamilyMoney("10")).figures).toBeNull();
    expect(await moneyRow("10")).toMatchObject({ readAt: null, failedCode: "bad_answer" });
    stub.nullQueryBody = true;
    await ageMoney("10", RETRY_AFTER_FAILURE_MS + 1000);
    expect((await loadFamilyMoney("10")).figures).toBeNull();
    expect((await moneyRow("10"))!.failedCode).toBe("bad_answer");
  });

  // QuickBooks answers "no invoices" with 200 and an empty QueryResponse. Any other 200 without invoices in it is not
  // that answer, and must never be shown as $0.00 owed.
  const FAULT = { Fault: { Error: [{ Message: "a message the portal must never store", code: "4000" }], type: "ValidationFault" } };
  it.each([
    ["a Fault", FAULT, "fault"],
    ["a Fault beside an empty QueryResponse", { QueryResponse: {}, ...FAULT }, "fault"],
    ["an empty object", {}, "bad_answer"],
    ["a list", [], "bad_answer"],
    ["a QueryResponse that is a list", { QueryResponse: [] }, "bad_answer"],
    ["invoices that aren't a list", { QueryResponse: { Invoice: { Id: "1" } } }, "bad_answer"],
    ["rows of something else", { QueryResponse: { Customer: [{ Id: "10" }], startPosition: 1, maxResults: 1 } }, "bad_answer"],
  ])("never takes a 200 that is %s for a family that owes nothing", async (_what, body, code) => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "12")]; // the family owes $85.00
    balanceWithJobs(85);
    stub.oddInvoiceAnswer = { body };
    // Nothing stored: nothing is shown, and the try is recorded as failed.
    expect((await loadFamilyMoney("10")).figures).toBeNull();
    const failed = (await moneyRow("10"))!;
    expect(failed).toMatchObject({ readAt: null, invoices: null, totalCents: null, failedCode: code });
    expect(JSON.stringify(failed)).not.toContain("a message the portal must never store");
    // Figures stored: they stay, marked as not current, and are not replaced by a zero.
    stub.oddInvoiceAnswer = null;
    await ageMoney("10", RETRY_AFTER_FAILURE_MS + 1000);
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 8500 });
    await ageMoney("10", 6 * MINUTE);
    stub.oddInvoiceAnswer = { body };
    const money = await loadFamilyMoney("10");
    expect(money.figures).toMatchObject({ current: false, totalCents: 8500 });
    expect(numbers(money.figures!.open)).toEqual(["INV-1"]);
    expect(await moneyRow("10")).toMatchObject({ totalCents: 8500, failedCode: code });
  });

  it("an empty QueryResponse is the one answer that means no invoices", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.oddInvoiceAnswer = { body: { QueryResponse: {}, time: "2026-11-15T10:00:00.000-08:00" } };
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 0, open: [], paid: [] });
    stub.oddInvoiceAnswer = { body: { QueryResponse: { Invoice: [], startPosition: 1, maxResults: 0 } } };
    await ageMoney("10", 6 * MINUTE);
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 0 });
    expect((await moneyRow("10"))!.failedAt).toBeNull();
  });

  it("still shows the invoices when the cross-check can't be read", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.customers = []; // the customer read answers 400
    stub.invoices = [inv("1", "10")];
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 8500, credit: false });
    expect(await moneyRow("10")).toMatchObject({ balanceWithJobsCents: null, failedAt: null });
    expect(await audits()).toHaveLength(0);
  });
});

describe("two requests for the same family never both go to QuickBooks", () => {
  it("in one process, the second waits for the first and shows what it brought", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    stub.apiDelayMs = 150;
    const [one, two, three] = await Promise.all([loadFamilyMoney("10"), loadFamilyMoney("10"), loadFamilyMoney("10")]);
    expect(invoiceQueries(stub)).toHaveLength(1);
    for (const money of [one, two, three]) expect(money.figures).toMatchObject({ current: true, totalCents: 8500 });
  });

  it("when another process holds the family's lock, shows what is there and asks nothing", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    await ageMoney("10", 6 * MINUTE);
    stub.invoices = [inv("1", "10", { Balance: 1 })];
    const asked = stub.calls.length;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // Another session takes the family's lock and keeps it, as a second copy of the portal would while it reads.
    let locked!: () => void;
    const taken = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(7461002, hashtext('10'))`); locked(); await held; });
    await taken;
    try {
      expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: false, totalCents: 8500 }); // the old row, marked as not current
      expect((await loadFamilyMoney("20")).figures).toMatchObject({ current: true, totalCents: 0 });      // another family is not held up
      expect(stub.calls.length).toBe(asked + 2); // family 20's read and cross-check only
    } finally { release(); await holder; }
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: true, totalCents: 100 });
  });

  it("many families at once take turns: no more than a few reads run together, and every one is answered", async () => {
    await seedShape();
    const ids = Array.from({ length: MAX_LIVE_READS + 2 }, (_, i) => String(100 + i));
    await addToCache(ids.map((id) => fam(id, `Family ${id}`)));
    await connectCompany(stub);
    stub.customers = ids.map((Id) => ({ Id, BalanceWithJobs: 85 }));
    stub.invoices = ids.map((id, i) => inv(String(i + 1), id));
    stub.apiDelayMs = 80;
    const all = await Promise.all(ids.map((id) => loadFamilyMoney(id)));
    expect(all.map((m) => m.figures?.totalCents)).toEqual(ids.map(() => 8500));
    expect(all.every((m) => m.figures!.current)).toBe(true);
    expect(stub.peakApi).toBeGreaterThan(1);
    expect(stub.peakApi).toBeLessThanOrEqual(MAX_LIVE_READS);
  });
});

describe("never the wrong company", () => {
  it("asks QuickBooks nothing while it is disconnected, and shows the last figures as not current", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    await ageMoney("10", 6 * MINUTE);
    await db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null, accessTokenCiphertext: null, accessTokenKeyId: null });
    const asked = stub.calls.length;
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: false, totalCents: 8500 });
    expect((await loadFamilyMoney("20")).figures).toBeNull();
    expect(stub.calls).toHaveLength(asked);
    expect((await moneyRow("10"))!.failedCode).toBe("not_connected");
  });

  it("asks nothing when there is no connection at all", async () => {
    await twoFamilies();
    expect((await loadFamilyMoney("10")).figures).toBeNull();
    expect(stub.calls).toHaveLength(0);
    expect((await moneyRow("10"))!.failedCode).toBe("not_connected");
  });

  it.each([
    ["the roster cache was read from another company than the connected one", "1111"],
    ["the roster cache doesn't say which company it was read from", null],
  ])("refuses a live read when %s", async (_what, source) => {
    await twoFamilies();
    await connectCompany(stub);
    if (source) await db.transaction((tx) => setRosterSource(tx, source));
    else await db.delete(setting).where(eq(setting.key, "roster.source"));
    stub.invoices = [inv("1", "10")];
    expect((await loadFamilyMoney("10")).figures).toBeNull();
    expect(stub.calls).toHaveLength(0);
    expect((await moneyRow("10"))!.failedCode).toBe("other_company");
  });

  it("treats a stored row from another company as absent, however fresh it is", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    // The same family id in another company: the cache now says it came from 2222, and QuickBooks is connected to 2222.
    await db.transaction((tx) => setRosterSource(tx, "2222"));
    await db.update(qboConnection).set({ realmId: "2222" });
    stub.invoices = [inv("7", "10", { Balance: 5 })];
    const money = await loadFamilyMoney("10");
    expect(money.figures).toMatchObject({ current: true, totalCents: 500 });
    expect(numbers(money.figures!.open)).toEqual(["INV-7"]);
    expect((await moneyRow("10"))!.realmId).toBe("2222");
    expect(stub.apiCalls().at(-1)!.path).toBe("/v3/company/2222/customer/10");
    // And when the new company can't be asked, the old company's figures are not shown in its place.
    await db.update(familyMoney).set({ realmId: MONEY_REALM });
    await db.update(qboConnection).set({ realmId: null });
    expect((await loadFamilyMoney("10")).figures).toBeNull();
  });

  it("does not keep figures when the company changes while QuickBooks is answering", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    stub.apiDelayMs = 300;
    const loading = loadFamilyMoney("10");
    await new Promise((r) => setTimeout(r, 100));
    await db.transaction((tx) => setRosterSource(tx, "2222"));
    expect((await loading).figures).toBeNull();
    expect(await moneyRow("10")).toMatchObject({ readAt: null, invoices: null, failedCode: "other_company" });
  });

  it("deletes every money row when a different company is connected", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10"), inv("2", "20")];
    await loadFamilyMoney("10");
    await loadFamilyMoney("20");
    await seedFamilyMoney(FAMILY_A);
    expect(await db.select().from(familyMoney)).toHaveLength(3);
    expect(await clearRosterOfOtherCompany(MONEY_REALM, SYSTEM)).toBe(false); // the same company keeps them
    expect(await db.select().from(familyMoney)).toHaveLength(3);
    expect(await clearRosterOfOtherCompany("2222", SYSTEM)).toBe(true);
    expect(await db.select().from(familyMoney)).toHaveLength(0);
    expect(await db.select().from(qboCustomer)).toHaveLength(0);
  });

  it("refuses at once when only an Admin can fix the connection, and shows the last figures", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10")];
    await loadFamilyMoney("10");
    await ageMoney("10", 6 * MINUTE);
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)", lastErrorAt: new Date(), accessExpiresAt: new Date(Date.now() - 1000) });
    const asked = stub.calls.length;
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ current: false, totalCents: 8500 });
    expect(stub.calls).toHaveLength(asked); // no token refresh was tried
    expect((await moneyRow("10"))!.failedCode).toBe("needs_admin");
  });
});

describe("the cross-check against QuickBooks' own balance (v1 spec §8.3)", () => {
  it("shows the sum of the invoices whatever QuickBooks' balance says, and audits a difference once per family per day", async () => {
    await twoFamilies();
    await connectCompany(stub);
    await setFreshSeconds(0);
    stub.invoices = [inv("1", "10"), inv("2", "12", { Balance: 100 }), inv("9", "20")];
    balanceWithJobs(250);
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ totalCents: 18500, credit: false }); // higher: nothing is said to the parent
    expect(await moneyRow("10")).toMatchObject({ totalCents: 18500, balanceWithJobsCents: 25000 });
    const [first] = await audits();
    expect(first).toMatchObject({ door: "system", actorId: null, targetType: "family", targetId: "10", after: { invoicesCents: 18500, balanceWithJobsCents: 25000, currency: "USD" } });
    await loadFamilyMoney("10");
    await loadFamilyMoney("10");
    expect(await audits()).toHaveLength(1);
    await loadFamilyMoney("20"); // another family's difference ($85.00 of invoices, a balance of zero) is its own row
    expect((await audits()).map((a) => a.targetId)).toEqual(["10", "20"]);
    await ageMoney("10", 25 * 60 * MINUTE); // the next day
    await loadFamilyMoney("10");
    expect((await audits()).map((a) => a.targetId)).toEqual(["10", "20", "10"]);
  });

  it("says the club may be holding a credit when QuickBooks' balance is lower than the invoices add up to", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10"), inv("2", "12", { Balance: 100 })];
    balanceWithJobs(135);
    const money = await loadFamilyMoney("10");
    expect(money.figures).toMatchObject({ totalCents: 18500, credit: true }); // the figure stays the sum
    expect(await audits()).toHaveLength(1);
  });

  it("audits nothing when the two agree", async () => {
    await twoFamilies();
    await connectCompany(stub);
    stub.invoices = [inv("1", "10"), inv("2", "12", { Balance: 100 })];
    balanceWithJobs(185);
    expect((await loadFamilyMoney("10")).figures).toMatchObject({ totalCents: 18500, credit: false });
    expect(await audits()).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0); // a parent's own read is not audited either
  });
});
