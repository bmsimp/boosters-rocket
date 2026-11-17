import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, qboCustomer, qboItem, setting } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { askForMoneyRun, MONEY_JOB, moneyRunView, RUN_KEY, runMoneyJob, STOPS_AT_ONE_FAMILY } from "@/lib/money/sweep";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { resetDb, seedStaff } from "../helpers/db";
import { connectCompany, invoiceQueries, moneyRow, stubInvoice as inv } from "../helpers/money";
import { MONEY_REALM } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { addToCache, fam, par, seedRosterRead, seedShape, stu } from "../helpers/roster-cache";

/**
 * The worker's read of every family's invoices (src/lib/money/sweep.ts): once a day or when staff ask, one family at
 * a time at a gentle pace, into the rows the parent pages show; a run that stops part way says how far it got and the
 * next one carries on; one audit row per run; nothing read from the wrong company or with no connection.
 */
// Each test reads several families through the stub, one request at a time: on a loaded machine that takes more than
// vitest's 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const later = (ms: number) => new Date(Date.now() + ms);
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
const runs = () => db.select().from(jobRun).where(eq(jobRun.job, MONEY_JOB)).orderBy(asc(jobRun.id));
const customer = (Id: string, Balance: number, extra: Record<string, unknown> = {}) => ({ Id, DisplayName: `Customer ${Id}`, Balance, BalanceWithJobs: Balance, ...extra });

/** Three families in a company the stub answers for: 10 (a parent 11 and a student 12), 20 (a student 22) and 30. */
async function threeFamilies() {
  await seedShape();
  await addToCache([
    fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"),
    fam("20", "Chen Family"), stu("22", "Mei Chen", "20"),
    fam("30", "Okafor Family"),
  ]);
  await connectCompany(stub);
  // Each family's own balance, and BalanceWithJobs (the family and everyone under it), agree with its invoices.
  stub.customers = [customer("10", 85, { BalanceWithJobs: 115 }), customer("11", 0), customer("12", 30), customer("20", 0, { BalanceWithJobs: 40 }), customer("22", 40), customer("30", 0)];
  stub.invoices = [inv("1", "10"), inv("2", "12", { Balance: 30 }), inv("3", "22", { Balance: 40 })];
}

describe("the worker's read of every family", () => {
  it("reads each family in turn, one request at a time at a gentle pace, into the figures the parent pages show", async () => {
    await threeFamilies();
    const at: number[] = [];
    stub.onApiRequest = () => { at.push(Date.now()); };
    expect(await runMoneyJob({ paceMs: 150 })).toEqual({ ran: true, finished: true, ok: true });
    expect(stub.peakApi).toBe(1);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    // Requests leave at least 150 ms apart; each arrives at the stub a little after it leaves, so allow for that.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(100);
    expect(at.at(-1)! - at[0]!).toBeGreaterThanOrEqual((at.length - 1) * 150 - 60);
    // One invoice query per family, then each of its customers' own balance (the cross-check).
    expect(invoiceQueries(stub)).toHaveLength(3);
    expect(stub.apiCalls().filter((c) => /\/customer\/\d+$/.test(c.path)).map((c) => c.path.split("/").pop())).toEqual(["10", "11", "12", "20", "22", "30"]);
    expect((await moneyRow("10"))!.invoices!.map((i) => i.qboId)).toEqual(["1", "2"]);
    expect((await moneyRow("20"))!).toMatchObject({ totalCents: 4000, realmId: MONEY_REALM });
    expect((await moneyRow("30"))!).toMatchObject({ totalCents: 0, invoices: [] });
    expect(await runs()).toMatchObject([{ outcome: "ok", startedBy: "worker", detail: "Read 3 families." }]);
    expect((await audits("money.read_all")).map((r) => r.after)).toEqual([{ families: 3, read: 3, couldNotRead: 0 }]);
    expect(await audits("money.read_all.failed")).toEqual([]);
  });

  it("runs once a day: not again within 24 hours of the last run that read everyone, and again after", async () => {
    await threeFamilies();
    await runMoneyJob({ paceMs: 0 });
    stub.calls.length = 0;
    expect(await runMoneyJob({ paceMs: 0, now: later(23 * HOUR) })).toEqual({ ran: false });
    expect(stub.apiCalls()).toEqual([]);
    expect(await runMoneyJob({ paceMs: 0, now: later(25 * HOUR) })).toEqual({ ran: true, finished: true, ok: true });
    expect(await runs()).toHaveLength(2);
  });

  it("runs from the worker's wake once there is a roster, after the roster's own jobs", async () => {
    await threeFamilies();
    await seedRosterRead(); // the roster was read just now: its job isn't due, so the cache above stays as it is
    const { ran } = await runDueJobs();
    expect(ran).toContainEqual({ job: MONEY_JOB, ok: true });
    expect(ran.findIndex((r) => r.job === MONEY_JOB)).toBe(ran.length - 1);
    expect((await moneyRow("10"))!.readAt).not.toBeNull();
  });

  it("stops part way when QuickBooks fails, says how far it got, and the next run carries on from there", async () => {
    await threeFamilies();
    stub.failQueryFrom = 2; // the first family's invoice query works; every one after it answers 500
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: false });
    expect((await runs())[0]).toMatchObject({ outcome: "failed",
      detail: "Read 1 family of 3, then stopped: QuickBooks couldn't be read (http_500). The next run carries on from there." });
    expect((await audits("money.read_all.failed")).map((r) => r.after)).toEqual([{ families: 3, read: 1, couldNotRead: 0, stoppedBy: "http_500" }]);
    // The family it stopped at kept no figures, and its failure is recorded as a page load's would be.
    expect(await moneyRow("20")).toMatchObject({ readAt: null, failedCode: "http_500" });
    // Not again within 15 minutes of that attempt.
    stub.failQueryFrom = null;
    expect(await runMoneyJob({ paceMs: 0, now: later(10 * MINUTE) })).toEqual({ ran: false });
    stub.calls.length = 0;
    expect(await runMoneyJob({ paceMs: 0, now: later(16 * MINUTE) })).toEqual({ ran: true, finished: true, ok: true });
    // Only the two families it hadn't read.
    expect(invoiceQueries(stub).map((q) => /'(\d+)'/.exec(q!)![1])).toEqual(["20", "30"]);
    expect((await runs())[1]).toMatchObject({ outcome: "ok", detail: "Read 2 families, carrying on from where the last run stopped." });
    expect((await audits("money.read_all")).map((r) => r.after)).toEqual([{ families: 3, read: 2, couldNotRead: 0, carriedOnFromAnEarlierRun: true }]);
    // And the one after that starts from the first family again.
    stub.calls.length = 0;
    await runMoneyJob({ paceMs: 0, now: later(25 * HOUR) });
    expect(invoiceQueries(stub)).toHaveLength(3);
  });

  // The roadmap's known gap from step 4: a family whose read always failed stopped every run at it, and the families
  // after it were never read again.
  it(`stops at a family whose read keeps failing ${STOPS_AT_ONE_FAMILY - 1} runs in a row at most: the next passes it over, counted, and reads the rest`, async () => {
    await threeFamilies();
    // Every read of family 20's invoices finds QuickBooks out of reach; everything else answers.
    stub.onApiRequest = (c) => { stub.dropApi = c.path.endsWith("/query") && (c.query.get("query") ?? "").includes("'20'"); };
    let at = 0;
    for (let stop = 1; stop < STOPS_AT_ONE_FAMILY; stop++) {
      expect(await runMoneyJob({ paceMs: 0, now: later(at) })).toEqual({ ran: true, finished: true, ok: false });
      expect((await runs()).at(-1)!.detail).toMatch(/then stopped: QuickBooks couldn't be read \(\w+\)\. The next run carries on from there\.$/);
      at += 16 * MINUTE;
    }
    stub.calls.length = 0;
    expect(await runMoneyJob({ paceMs: 0, now: later(at) })).toEqual({ ran: true, finished: true, ok: true });
    expect(invoiceQueries(stub).map((q) => /'(\d+)'/.exec(q!)![1])).toEqual(["20", "30"]);
    expect((await runs()).at(-1)).toMatchObject({ outcome: "ok", detail: "Read 1 family; 1 family couldn't be read, carrying on from where the last run stopped." });
    expect((await audits("money.read_all")).map((r) => r.after)).toEqual([{ families: 3, read: 1, couldNotRead: 1, carriedOnFromAnEarlierRun: true, passedOverAfterStops: 1 }]);
    expect(await moneyRow("30")).toMatchObject({ totalCents: 0 });
    expect((await moneyRow("20"))!.readAt).toBeNull();
    // The next day's run starts from the first family, and stops at 20 again as a first stop: the count began again.
    expect(await runMoneyJob({ paceMs: 0, now: later(at + 25 * HOUR) })).toEqual({ ran: true, finished: true, ok: false });
    // A family that answers again clears the count: once 20 can be read, nothing is passed over.
    stub.onApiRequest = null; stub.dropApi = false;
    expect(await runMoneyJob({ paceMs: 0, now: later(at + 26 * HOUR) })).toEqual({ ran: true, finished: true, ok: true });
    expect((await audits("money.read_all")).at(-1)!.after).toEqual({ families: 3, read: 2, couldNotRead: 0, carriedOnFromAnEarlierRun: true });
  });

  it("passes over a family whose answer can't be used, counts it, and reads the rest", async () => {
    await threeFamilies();
    await addToCache([fam("NOT-DIGITS", "Typed By Hand Family")]); // an id that is never sent to QuickBooks
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: true });
    expect((await runs())[0]!.detail).toBe("Read 3 families; 1 family couldn't be read.");
    expect(await moneyRow("NOT-DIGITS")).toMatchObject({ failedCode: "bad_id", readAt: null });
    expect(invoiceQueries(stub).join(" ")).not.toContain("NOT-DIGITS");
  });

  // The roadmap's known gap from step 7: a family the run passed over as not a family was still stamped as a failed try.
  it("stamps no failed try on a family the cache stops holding as one while the run reads, and still stamps a read that truly failed", async () => {
    await threeFamilies();
    // As the run reads the Riveras, family 20 is made inactive in the cache (a roster refresh, a staff change), and
    // every request about family 30 finds QuickBooks out of reach.
    let moved = false;
    stub.onApiRequest = async (c) => {
      if (!moved) { moved = true; await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, "20")); }
      stub.dropApi = (c.query.get("query") ?? "").includes("'30'") || c.path.endsWith("/customer/30");
    };
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: false });
    expect(invoiceQueries(stub).map((q) => /'(\d+)'/.exec(q!)![1])).toEqual(["10", "30"]); // nothing asked about 20
    expect(await moneyRow("20")).toBeUndefined();
    expect(await moneyRow("10")).toMatchObject({ failedAt: null, failedCode: null });
    expect(await moneyRow("30")).toMatchObject({ readAt: null, failedCode: expect.any(String) });
    expect((await moneyRow("30"))!.failedAt).toBeInstanceOf(Date);
  });

  it("leaves the rest for the next wake when a wake's time is spent, and still writes one audit row for the run", async () => {
    await threeFamilies();
    expect(await runMoneyJob({ paceMs: 0, budgetMs: 0 })).toEqual({ ran: true, finished: false, ok: true });
    expect(await runs()).toMatchObject([{ outcome: null }]);
    expect((await moneyRunView()).running).toMatchObject({ read: 0 });
    // The next wake carries on, whether or not the run is "due": it is under way.
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: true });
    expect(await runs()).toMatchObject([{ outcome: "ok", detail: "Read 3 families." }]);
    expect(await audits("money.read_all")).toHaveLength(1);
    expect(await moneyRunView()).toMatchObject({ running: null, asked: false, last: { ok: true, detail: "Read 3 families." } });
  });

  it("runs nothing and records nothing while QuickBooks isn't connected", async () => {
    await seedShape();
    await addToCache([fam("10", "Rivera Family")]);
    await db.transaction((tx) => setRosterSource(tx, MONEY_REALM));
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: false });
    expect(await runs()).toEqual([]);
    expect((await runDueJobs()).ran.map((r) => r.job)).not.toContain(MONEY_JOB);
  });

  it("stops a run whose connection goes, saying how far it got", async () => {
    await threeFamilies();
    await runMoneyJob({ paceMs: 0, budgetMs: 0 }); // a run under way
    await db.delete(qboConnection); // disconnected
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: false });
    expect((await runs())[0]).toMatchObject({ outcome: "failed", detail: "Read 0 families of 3, then stopped: QuickBooks isn't connected (not_connected). The next run carries on from there." });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("ends a run under way from the worker's wake once QuickBooks needs an Admin, asking it nothing", async () => {
    await threeFamilies();
    await runMoneyJob({ paceMs: 0, budgetMs: 0 });
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)" });
    stub.calls.length = 0;
    expect((await runDueJobs()).ran).toContainEqual({ job: MONEY_JOB, ok: false });
    expect((await runs())[0]).toMatchObject({ outcome: "failed", detail: expect.stringContaining("then stopped: QuickBooks needs an Admin to connect it again (needs_admin)") });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("never reads the wrong company: a roster read from another company than the connected one starts no run", async () => {
    await threeFamilies();
    await db.transaction((tx) => setRosterSource(tx, "9130000000000999"));
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: false });
    expect(stub.apiCalls()).toEqual([]);
    expect(await askForMoneyRun({ actor: { door: "staff", id: "5a1e7a2e-0000-4000-8000-000000000001", label: "t@club.org" }, ip: null, permission: "Finance.Balance.Read" }))
      .toEqual({ ok: false, reason: "not_connected" });
  });

  it("forgets where it had got to, and ends a run under way, when another company is connected", async () => {
    await threeFamilies();
    stub.failQueryFrom = 2;
    await runMoneyJob({ paceMs: 0 }); // stopped after family 10, to carry on from there
    stub.failQueryFrom = null;
    await runMoneyJob({ paceMs: 0, budgetMs: 0, now: later(16 * MINUTE) }); // and a run under way
    await clearRosterOfOtherCompany("9130000000000777", { actor: { door: "system", id: null, label: "test" }, ip: null });
    expect((await runs()).map((r) => r.outcome)).toEqual(["failed", "failed"]);
    expect((await runs())[1]!.detail).toBe("Stopped: a different QuickBooks company was connected. (other_company)");
    expect(await db.select().from(setting).where(eq(setting.key, RUN_KEY))).toEqual([]);
    expect((await audits("money.records.cleared"))[0]!.after).toMatchObject({ reason: "different_company", runsEnded: 1 });
  });

  it("a run ended from outside while it reads (another company connected) writes nothing more: not its place, not 'ok'", async () => {
    await threeFamilies();
    let ended = false;
    // What clearMoneyRecords() does to a run under way, as the first family is being read.
    stub.onApiRequest = async () => {
      if (ended) return;
      ended = true;
      await db.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail: "Stopped: a different QuickBooks company was connected. (other_company)" }).where(isNull(jobRun.outcome));
      await db.delete(setting).where(eq(setting.key, RUN_KEY));
    };
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: false });
    expect((await runs()).map((r) => [r.outcome, r.detail])).toEqual([["failed", "Stopped: a different QuickBooks company was connected. (other_company)"]]);
    expect(await db.select().from(setting).where(eq(setting.key, RUN_KEY))).toEqual([]);
    expect(await audits("money.read_all")).toEqual([]);
  });

  it("refuses a staff ask while only an Admin can mend the connection, rather than promising a run that never starts", async () => {
    await threeFamilies();
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)" });
    expect(await askForMoneyRun({ actor: { door: "staff", id: "5a1e7a2e-0000-4000-8000-000000000001", label: "t@club.org" }, ip: null, permission: "Finance.Balance.Read" }))
      .toEqual({ ok: false, reason: "not_connected" });
    expect((await moneyRunView()).asked).toBe(false);
  });

  it("starts when staff ask, at the worker's next wake, whatever the day; refuses a second ask and one too soon", async () => {
    await threeFamilies();
    const staff = await seedStaff({ email: "treasurer@club.org", name: "Tess Treasurer" });
    const ask = () => askForMoneyRun({ actor: { door: "staff", id: staff.id, label: staff.email }, ip: "203.0.113.9", permission: "Finance.Balance.Read" });
    await runMoneyJob({ paceMs: 0 }); // today's run
    expect(await ask()).toEqual({ ok: false, reason: "too_soon" });
    await db.update(jobRun).set({ startedAt: later(-11 * MINUTE) });
    expect(await ask()).toEqual({ ok: true });
    expect(await ask()).toEqual({ ok: false, reason: "asked" });
    expect((await moneyRunView()).asked).toBe(true);
    expect((await audits("money.read_all.ask"))).toMatchObject([{ actorId: staff.id, permission: "Finance.Balance.Read", ip: "203.0.113.9" }]);
    expect(await runMoneyJob({ paceMs: 0, budgetMs: 0 })).toEqual({ ran: true, finished: false, ok: true });
    expect(await ask()).toEqual({ ok: false, reason: "running" });
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: true });
    expect((await runs())[1]).toMatchObject({ startedBy: staff.id, outcome: "ok" });
    expect((await audits("money.read_all"))[1]!.after).toMatchObject({ askedBy: { id: staff.id, label: staff.email } });
  });

  it("runs once at a time: a second caller while one holds the run does nothing", async () => {
    await threeFamilies();
    stub.apiDelayMs = 150;
    const [a, b] = await Promise.all([runMoneyJob({ paceMs: 0 }), new Promise((r) => setTimeout(r, 30)).then(() => runMoneyJob({ paceMs: 0 }))]);
    expect([a, b]).toEqual([{ ran: true, finished: true, ok: true }, { ran: false }]);
    expect(await runs()).toHaveLength(1);
  });
});

describe("the cross-check, customer by customer", () => {
  it("compares each customer's own balance in QuickBooks with its open invoices, and audits a difference once a day", async () => {
    await threeFamilies();
    stub.customers.find((c) => c.Id === "12")!.Balance = 50; // Leo owes $50 in QuickBooks; his open invoice is $30
    await runMoneyJob({ paceMs: 0 });
    const row = (await moneyRow("10"))!;
    expect(row.checkedAt).not.toBeNull();
    expect(row.customerChecks).toEqual([
      { customerQboId: "10", name: null, balanceCents: 8500, invoicesCents: 8500, currency: "USD" },
      { customerQboId: "11", name: "Ana Rivera", balanceCents: 0, invoicesCents: 0, currency: "USD" },
      { customerQboId: "12", name: "Leo Rivera", balanceCents: 5000, invoicesCents: 3000, currency: "USD" },
    ]);
    expect((await audits("money.balance_mismatch")).map((r) => [r.targetId, r.after])).toEqual([["10", expect.objectContaining({
      customers: [{ customerQboId: "12", balanceCents: 5000, invoicesCents: 3000, currency: "USD" }] })]]);
    await runMoneyJob({ paceMs: 0, now: later(25 * HOUR) });
    expect(await audits("money.balance_mismatch")).toHaveLength(1); // the same day: not again
  });

  it("checks a family with other customers under it too, which the family's own BalanceWithJobs can't", async () => {
    await threeFamilies();
    await addToCache([{ qboId: "15", displayName: "A Sponsor", typeQboId: "M", parentQboId: "10" }, stu("13", "Old Student", "10", { active: false })]);
    stub.customers.push(customer("15", 999), customer("13", 120));
    stub.customers.find((c) => c.Id === "10")!.BalanceWithJobs = 85 + 30 + 999 + 120;
    stub.customers.find((c) => c.Id === "12")!.Balance = 45;
    await runMoneyJob({ paceMs: 0 });
    const row = (await moneyRow("10"))!;
    expect(row.balanceWithJobsCents).toBeNull(); // it counts the sponsor and the inactive student: nothing to compare it with
    expect(row.customerChecks!.map((c) => c.customerQboId)).toEqual(["10", "11", "12"]); // the customers whose invoices the family is shown
    expect(row.customerChecks!.find((c) => c.customerQboId === "12")).toMatchObject({ balanceCents: 4500, invoicesCents: 3000 });
    expect(await audits("money.balance_mismatch")).toHaveLength(1);
  });

  it("keeps the invoices and leaves the check out when a customer's balance can't be read", async () => {
    await threeFamilies();
    stub.customers = stub.customers.filter((c) => c.Id !== "12"); // QuickBooks answers 400 for a record it doesn't hold
    await runMoneyJob({ paceMs: 0 });
    expect(await moneyRow("10")).toMatchObject({ checkedAt: null, customerChecks: null, totalCents: 11500 });
    expect((await moneyRow("20"))!.customerChecks).toHaveLength(2);
  });
});

// The roadmap's known gap from step 4: the item list was read only when staff pressed "Read the list from QuickBooks".
describe("the products and services, read by the daily run", () => {
  const items = () => db.select({ qboId: qboItem.qboId, name: qboItem.name }).from(qboItem).orderBy(asc(qboItem.qboId));
  const SOLD = [{ Id: "7", Name: "Band fee", Type: "Service", Active: true }, { Id: "8", Name: "Trip deposit", Type: "Service", Active: true }];
  const itemQueries = () => stub.apiCalls().filter((c) => (c.query.get("query") ?? "").includes("from Item"));

  it("reads them once every family is read, with the staff button's GET, at the run's pace, and keeps them", async () => {
    await threeFamilies();
    stub.items = SOLD;
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: true });
    expect(itemQueries().map((c) => [c.method, c.query.get("query")])).toEqual([["GET", "select * from Item orderby Id startposition 1 maxresults 1000"]]);
    expect(stub.apiCalls().at(-1)!.query.get("query")).toContain("from Item"); // after the last family
    expect(await items()).toEqual([{ qboId: "7", name: "Band fee" }, { qboId: "8", name: "Trip deposit" }]);
    expect((await audits("money.items.read")).map((r) => [r.actorLabel, r.after])).toEqual([["worker", { items: 2 }]]);
    expect((await runs())[0]!.detail).toBe("Read 3 families.");
  });

  it("asks for nothing when the run stops part way: the next run that reads everyone does", async () => {
    await threeFamilies();
    stub.items = SOLD;
    stub.onApiRequest = (c) => { stub.dropApi = (c.query.get("query") ?? "").includes("'20'"); };
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: false });
    expect(itemQueries()).toEqual([]);
  });

  it.each([
    ["an empty object", {}],
    ["a Fault sent as a 200", { Fault: { Error: [{ Message: "nope", code: "500" }] } }],
    ["items that aren't a list", { QueryResponse: { Item: { Id: "1" } } }],
  ])("keeps the list it had when the answer is %s, and the run's figures stand", async (_what, body) => {
    await threeFamilies();
    stub.items = SOLD;
    await runMoneyJob({ paceMs: 0 });
    stub.oddItemAnswer = { body };
    expect(await runMoneyJob({ paceMs: 0, now: later(25 * HOUR) })).toEqual({ ran: true, finished: true, ok: true });
    expect(await items()).toHaveLength(2);
    expect((await audits("money.items.read.failed")).map((r) => r.after)).toEqual([{ code: expect.any(String) }]);
    expect((await runs()).at(-1)).toMatchObject({ outcome: "ok", detail: "Read 3 families. The list of products and services couldn't be read this time; the one read before is kept." });
  });

  it("never keeps an answer with no products or services over a list that holds some, as the roster refresh never believes an empty roster", async () => {
    await threeFamilies();
    stub.items = SOLD;
    await runMoneyJob({ paceMs: 0 });
    stub.items = [];
    expect(await runMoneyJob({ paceMs: 0, now: later(25 * HOUR) })).toEqual({ ran: true, finished: true, ok: true });
    expect(await items()).toHaveLength(2);
    expect((await audits("money.items.read.failed")).map((r) => r.after)).toEqual([{ code: "no_items", kept: 2 }]);
    // With nothing stored, an empty answer is believed: a company that sells nothing yet.
    await db.delete(qboItem);
    await runMoneyJob({ paceMs: 0, now: later(50 * HOUR) });
    expect((await audits("money.items.read")).at(-1)!.after).toEqual({ items: 0 });
  });
});
