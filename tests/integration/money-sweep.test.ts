import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, setting } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { askForMoneyRun, MONEY_JOB, moneyRunView, RUN_KEY, runMoneyJob } from "@/lib/money/sweep";
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

  it("passes over a family whose answer can't be used, counts it, and reads the rest", async () => {
    await threeFamilies();
    await addToCache([fam("NOT-DIGITS", "Typed By Hand Family")]); // an id that is never sent to QuickBooks
    expect(await runMoneyJob({ paceMs: 0 })).toEqual({ ran: true, finished: true, ok: true });
    expect((await runs())[0]!.detail).toBe("Read 3 families; 1 family couldn't be read.");
    expect(await moneyRow("NOT-DIGITS")).toMatchObject({ failedCode: "bad_id", readAt: null });
    expect(invoiceQueries(stub).join(" ")).not.toContain("NOT-DIGITS");
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
