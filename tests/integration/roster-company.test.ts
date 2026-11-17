import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { beginConnect, completeConnect, disconnect } from "@/lib/quickbooks/connection";
import { refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";
import { loadRosterPage } from "@/lib/roster/queries";
import { saveShape, getShape } from "@/lib/roster/shape";
import { runDueJobs } from "@/lib/jobs/runner";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const A = "9130000000000001", B = "9130000000000002";
const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const rosterRuns = async () => db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB));
const source = async () => (await db.select().from(setting).where(eq(setting.key, "roster.source")))[0]?.value ?? null;

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
  const connect = async (realmId: string) => {
    const r = await beginConnect(admin.id);
    if (!r.ok) throw new Error("not configured");
    stub.codes.add("code-1");
    return completeConnect({ code: "code-1", state: new URL(r.url).searchParams.get("state"), realmId, error: null }, { staffUserId: admin.id, actor: op.actor, ip: op.ip });
  };

  it("a refresh records which company the cache came from", async () => {
    expect(await source()).toEqual({ realmId: A });
  });

  it("connecting a different company clears the old company's cache, shape and roster runs before the first read", { timeout: 30_000 }, async () => {
    expect((await loadRosterPage()).roster).not.toBeNull();
    await disconnect(op);
    expect(await connect(B)).toEqual({ ok: true });
    const page = await loadRosterPage();
    expect(page).toMatchObject({ connected: true, roster: null, shape: null, attention: [], lastRun: null, lastOkAt: null, types: [] });
    expect(await getShape()).toBeNull();
    expect(await db.select().from(qboCustomer)).toEqual([]);
    expect(await db.select().from(qboCustomerType)).toEqual([]);
    expect(await rosterRuns()).toEqual([]);
    expect(await source()).toEqual({ realmId: B });
    const cleared = await audits("roster.cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toMatchObject({ door: "staff", actorId: admin.id, after: { reason: "different_company" } });
    expect((await runDueJobs()).ran).toContainEqual({ job: ROSTER_JOB, ok: true });
    expect(await source()).toEqual({ realmId: B });
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

  it("a new company with no customers replaces another company's cache, even when the clearing step never ran", async () => {
    await db.update(qboConnection).set({ realmId: B });
    stub.customers = [];
    // The cache holds company A's customers, and that is no reason to doubt company B's empty answer.
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 0, types: 5 });
    expect(await db.select().from(qboCustomer)).toEqual([]);
    expect(await source()).toEqual({ realmId: B });
    expect(await audits("roster.cleared")).toHaveLength(1);
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
