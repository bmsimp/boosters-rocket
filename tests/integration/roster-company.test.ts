import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, qboCustomer, setting } from "@/lib/db/schema";
import { beginConnect, beginSwitchConnect, completeConnect, disconnect } from "@/lib/quickbooks/connection";
import { NOT_SWITCHED_WORDS, refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";
import { loadRosterPage } from "@/lib/roster/queries";
import { saveShape, getShape } from "@/lib/roster/shape";
import { runDueJobs } from "@/lib/jobs/runner";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const A = "9130000000000001", B = "9130000000000002", C = "9130000000000003";
const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const rosterRuns = async () => db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB));
const source = async () => (await db.select().from(setting).where(eq(setting.key, "roster.source")))[0]?.value ?? null;
const switchRow = async () => (await db.select().from(setting).where(eq(setting.key, "quickbooks.switch")))[0]?.value ?? null;
const setSwitchRow = async (value: unknown) => {
  await db.insert(setting).values({ key: "quickbooks.switch", value }).onConflictDoUpdate({ target: setting.key, set: { value } });
};

describe("the roster belongs to the connected company", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  let op: { actor: { door: "staff"; id: string; label: string }; ip: string; permission: string };
  beforeEach(async () => {
    await resetDb(); stub.reset(); Object.assign(stub, fznCompany());
    admin = await seedStaff({ email: "admin@example.org", admin: true });
    op = { actor: { door: "staff", id: admin.id, label: admin.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
    await seedConnected(stub, { realmId: A });
    await refreshRoster(worker);
    await saveShape(FZN_SHAPE, op);
  });
  /** A connect through Intuit: a plain one, or one an Admin asked for on the switch page (`switching`), with `meanwhile` run between the ask and the return. */
  const connect = async (realmId: string, o: { switching?: boolean; meanwhile?: () => Promise<unknown> } = {}) => {
    const r = o.switching ? await beginSwitchConnect(admin.id, op) : await beginConnect(admin.id);
    if (!r.ok) throw new Error("not configured");
    await o.meanwhile?.();
    stub.codes.add("code-1");
    return completeConnect({ code: "code-1", state: new URL(r.url).searchParams.get("state"), realmId, error: null }, { staffUserId: admin.id, actor: op.actor, ip: op.ip });
  };
  /** Nothing of the roster's company was cleared, and no connection stands. */
  const expectNothingCleared = async () => {
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
    expect(await getShape()).toEqual(FZN_SHAPE);
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await source()).toEqual({ realmId: A });
    expect(await audits("roster.cleared")).toEqual([]);
  };

  it("a refresh records which company the cache came from", async () => {
    expect(await source()).toEqual({ realmId: A });
  });

  // Stage 4's slice M8 (the owner's choice 1): another company is connected only after an Admin asks on the switch page.
  // A connect with no ask is refused as from stage 2 to stage 4 (open question 18), and changes nothing.
  it("refuses to connect a different company with no ask, and keeps the cache, the shape and the runs", { timeout: 30_000 }, async () => {
    expect((await loadRosterPage()).roster).not.toBeNull();
    const runsBefore = await rosterRuns();
    await disconnect(op);
    expect(await connect(B)).toEqual({ ok: false, reason: "roster_company" });
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
    expect(await getShape()).toEqual(FZN_SHAPE);
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await rosterRuns()).toEqual(runsBefore);
    expect(await source()).toEqual({ realmId: A });
    expect(await audits("roster.cleared")).toEqual([]);
    expect((await audits("quickbooks.connect_refused")).map((r) => r.after)).toEqual([{ reason: "roster_company" }]);
    // Nothing for the worker to read until a company is connected again: the cache stays this company's.
    expect((await runDueJobs()).ran.map((r) => r.job)).not.toContain(ROSTER_JOB);
    expect(await source()).toEqual({ realmId: A });
  });

  it("with the ask, connects a different company and clears the earlier one's, once; the first refresh reads the new one", { timeout: 30_000 }, async () => {
    await disconnect(op);
    expect(await connect(B, { switching: true })).toEqual({ ok: true });
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: B });
    expect(await getShape()).toBeNull();
    expect(await db.select().from(qboCustomer)).toHaveLength(0);
    expect(await rosterRuns()).toEqual([]);
    expect(await source()).toEqual({ realmId: B });
    expect(await switchRow()).toBeNull(); // spent by the clear
    expect((await audits("roster.cleared")).map((r) => [r.before, r.after])).toEqual([[{ realmId: A }, { reason: "different_company", realmId: B, writesGivenUp: 0 }]]);
    expect((await audits("quickbooks.switch.asked")).map((r) => r.after)).toEqual([{ fromRealmId: A }]);
    expect((await audits("quickbooks.connect")).map((r) => r.after)).toEqual([expect.objectContaining({ realmId: B, switchedFrom: A })]);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true, customers: 9 });
    // Read with no shape, so with no contact details, until the shape is chosen for the new company.
    expect((await db.select().from(qboCustomer)).map((c) => c.email)).toEqual(Array(9).fill(null));
    expect(await source()).toEqual({ realmId: B });
    expect(await audits("roster.cleared")).toHaveLength(1);
  });

  it.each([
    ["has expired", async () => setSwitchRow({ asked: { ...((await switchRow()) as { asked: object }).asked, expiresAt: new Date(Date.now() - 1000).toISOString() } })],
    ["was made by another Admin", async () => setSwitchRow({ asked: { ...((await switchRow()) as { asked: object }).asked, staffUserId: "00000000-0000-4000-8000-000000000001" } })],
    ["was made for another sign-in to Intuit", async () => setSwitchRow({ asked: { ...((await switchRow()) as { asked: object }).asked, stateHash: "0".repeat(64) } })],
    ["is spent already", async () => db.delete(setting).where(eq(setting.key, "quickbooks.switch"))],
    ["was made while the roster named another company", async () => db.update(setting).set({ value: { realmId: C } }).where(eq(setting.key, "roster.source"))],
  ])("refuses a different company when the ask %s, and changes nothing", { timeout: 30_000 }, async (_why, meanwhile) => {
    await disconnect(op);
    expect(await connect(B, { switching: true, meanwhile })).toEqual({ ok: false, reason: "roster_company" });
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
    expect(await getShape()).toEqual(FZN_SHAPE);
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await audits("roster.cleared")).toEqual([]);
    expect(await switchRow()).toBeNull();
    expect(stub.tokenCalls()).toHaveLength(0); // refused before any code was exchanged
    expect((await audits("quickbooks.connect_refused")).map((r) => r.after)).toEqual([{ reason: "roster_company" }]);
  });

  it("refuses a different company when the ask was replaced by a plain sign-in to Intuit", { timeout: 30_000 }, async () => {
    await disconnect(op);
    const asked = await beginSwitchConnect(admin.id, op);
    expect(asked.ok).toBe(true);
    expect(await connect(B)).toEqual({ ok: false, reason: "roster_company" });
    await expectNothingCleared();
  });

  it("refuses a switch when the roster's company changed while Intuit was answering, and revokes what was issued", { timeout: 30_000 }, async () => {
    await disconnect(op);
    stub.tokenDelayMs = 300;
    const pending = connect(B, { switching: true });
    for (let i = 0; i < 200 && stub.tokenCalls().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(stub.tokenCalls()).toHaveLength(1);
    await db.update(setting).set({ value: { realmId: C } }).where(eq(setting.key, "roster.source"));
    expect(await pending).toEqual({ ok: false, reason: "roster_company" });
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
    expect(await audits("roster.cleared")).toEqual([]);
    expect((await audits("quickbooks.connect_refused")).map((r) => r.after)).toEqual([{ reason: "roster_company", revoked: true }]);
  });

  it("an ask whose Admin then chose the same company connects it and clears nothing, the ask spent", { timeout: 30_000 }, async () => {
    const runsBefore = await rosterRuns();
    await disconnect(op);
    expect(await connect(A, { switching: true })).toEqual({ ok: true });
    expect(await getShape()).toEqual(FZN_SHAPE);
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await rosterRuns()).toEqual(runsBefore);
    expect(await audits("roster.cleared")).toEqual([]);
    expect(await switchRow()).toBeNull();
    expect((await audits("quickbooks.connect")).map((r) => r.after)).toEqual([expect.not.objectContaining({ switchedFrom: expect.anything() })]);
  });

  it("reconnecting the same company keeps the cache, the shape and the runs", { timeout: 30_000 }, async () => {
    const runsBefore = await rosterRuns();
    await disconnect(op);
    expect(await connect(A)).toEqual({ ok: true });
    expect(await getShape()).toEqual(FZN_SHAPE);
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await rosterRuns()).toEqual(runsBefore);
    expect(await audits("roster.cleared")).toEqual([]);
    expect((await loadRosterPage()).roster).not.toBeNull();
  });

  it("shows no roster from another company, even if the clearing step never ran", async () => {
    await db.update(qboConnection).set({ realmId: B });
    const page = await loadRosterPage();
    expect(page).toMatchObject({ connected: true, roster: null, attention: [], lastRun: null, lastOkAt: null });
    expect(JSON.stringify(page)).not.toContain(B);
    expect(JSON.stringify(page)).not.toContain(A);
  });

  it("shows no roster from a cache that doesn't say which company it came from", async () => {
    await db.delete(setting).where(eq(setting.key, "roster.source"));
    expect(await loadRosterPage()).toMatchObject({ roster: null, lastRun: null, lastOkAt: null });
  });

  it("still shows the last roster, marked no longer current, after a disconnect", async () => {
    await disconnect(op);
    expect(await loadRosterPage()).toMatchObject({ connected: false });
    expect((await loadRosterPage()).roster).not.toBeNull();
  });

  it("reads no other company's roster over this one's, even when a connection to it was stored without the refusal", async () => {
    await db.update(qboConnection).set({ realmId: B });
    stub.customers = [];
    const calls = stub.apiCalls().length;
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed",
      error: "The roster was read from another QuickBooks company than the one connected now, and nobody chose to switch to it, so it wasn't read. Disconnect QuickBooks, then connect the company the roster was read from, or choose Connect a different company first. (roster_company)" });
    expect(NOT_SWITCHED_WORDS).toContain("(roster_company)");
    expect(stub.apiCalls()).toHaveLength(calls); // nothing was asked of QuickBooks
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await source()).toEqual({ realmId: A });
    expect(await audits("roster.cleared")).toEqual([]);
    expect((await audits("roster.refresh.failed")).at(-1)).toMatchObject({ after: { code: "roster_company" } });
  });

  it("a switch the connect stored, whose clear never ran, is cleared by the next refresh, which reads the new company", { timeout: 30_000 }, async () => {
    // As the store leaves it when step 3b throws: connected to B, the switch recorded, the roster still A's.
    await db.update(qboConnection).set({ realmId: B });
    await setSwitchRow({ stored: { fromRealmId: A, toRealmId: B, staffUserId: admin.id, at: new Date().toISOString() } });
    expect(await refreshRoster(worker)).toMatchObject({ ok: true, customers: 9 });
    expect(await source()).toEqual({ realmId: B });
    expect(await switchRow()).toBeNull();
    expect(await getShape()).toBeNull();
    expect((await db.select().from(qboCustomer)).map((c) => c.email)).toEqual(Array(9).fill(null));
    expect((await audits("roster.cleared")).map((r) => [r.before, r.after])).toEqual([[{ realmId: A }, { reason: "different_company", realmId: B, writesGivenUp: 0 }]]);
    // The run that cleared is the only roster run kept, and it is the one that read B.
    expect((await rosterRuns()).map((r) => r.outcome)).toEqual(["ok"]);
  });

  it.each([
    ["from another company than the roster's", { fromRealmId: C, toRealmId: B }],
    ["to another company than the connected one", { fromRealmId: A, toRealmId: C }],
  ])("a stored switch %s lets nothing be read", async (_why, pair) => {
    await db.update(qboConnection).set({ realmId: B });
    await setSwitchRow({ stored: { ...pair, staffUserId: admin.id, at: new Date().toISOString() } });
    const calls = stub.apiCalls().length;
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed", error: NOT_SWITCHED_WORDS });
    expect(stub.apiCalls()).toHaveLength(calls);
    expect(await source()).toEqual({ realmId: A });
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await switchRow()).toMatchObject({ stored: pair });
  });


  it("a cache that doesn't say which company it came from is not replaced by an answer with no customers", async () => {
    await db.delete(setting).where(eq(setting.key, "roster.source"));
    stub.customers = [];
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed", error: expect.stringContaining("(no_customers)") });
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
  });

  it("a refresh during which the connected company changes fails and keeps the old cache", { timeout: 30_000 }, async () => {
    stub.customers = [{ Id: "900", DisplayName: "Someone Else Entirely", Active: true, SyncToken: "0" }];
    stub.queryDelayMs = 300;
    const pending = refreshRoster(worker);
    for (let i = 0; i < 200 && stub.apiCalls().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(stub.apiCalls().length).toBeGreaterThan(0);
    await db.update(qboConnection).set({ realmId: B });
    expect(await pending).toEqual({ ok: false, reason: "failed", error: "The QuickBooks company changed during the read. (company_changed)" });
    expect((await db.select().from(qboCustomer)).map((c) => c.qboId)).not.toContain("900");
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect(await source()).toEqual({ realmId: A });
    const [last] = await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1);
    expect(last).toMatchObject({ outcome: "failed", detail: "The QuickBooks company changed during the read. (company_changed)" });
    expect((await audits("roster.refresh.failed")).at(-1)).toMatchObject({ after: { code: "company_changed" } });
  });
});
