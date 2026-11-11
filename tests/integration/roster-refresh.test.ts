import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { refreshRoster, ROSTER_JOB, ROSTER_LOCK } from "@/lib/roster/refresh";
import { saveShape, getShape, SHAPE_KEY } from "@/lib/roster/shape";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
const customers = async () => Object.fromEntries((await db.select().from(qboCustomer)).map((c) => [c.qboId, c]));
const lastRun = async () => (await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1))[0]!;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);

describe("the roster refresh", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    Object.assign(stub, fznCompany());
    await seedConnected(stub);
  });

  it("copies every customer and type, active and inactive", async () => {
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 9, types: 5 });
    const c = await customers();
    expect(Object.keys(c).sort()).toEqual(["10", "11", "12", "20", "21", "30", "40", "50", "60"]);
    expect(c["11"]).toMatchObject({ displayName: "Ana Rivera", active: true, parentQboId: "10", typeQboId: "2", syncToken: "0" });
    expect(c["11"]!.qboUpdatedAt!.toISOString()).toBe("2026-11-01T18:00:00.000Z");
    expect(c["40"]!.active).toBe(false);
    expect(c["60"]!.typeQboId).toBeNull();
    expect((await db.select().from(qboCustomerType)).map((t) => t.name).sort()).toEqual(["Family", "Parent", "School", "Student", "Vendor"]);
    expect(stub.apiCalls().find((x) => x.query.get("query")!.includes("from Customer "))!.query.get("query")).toContain("Active in (true, false)");
  });

  it("records the run and audits it with the counts", async () => {
    await refreshRoster(worker);
    expect(await lastRun()).toMatchObject({ outcome: "ok", startedBy: "worker", detail: "9 customers, 5 customer types" });
    expect((await audits("roster.refresh"))[0]).toMatchObject({ door: "system", actorLabel: "worker", after: { customers: 9, types: 5 } });
  });

  it("keeps no contact details before a shape is chosen", async () => {
    await refreshRoster(worker);
    expect(Object.values(await customers()).filter((c) => c.email || c.phone)).toEqual([]);
  });

  it("keeps email and phone only for customers the shape names", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const c = await customers();
    expect(c["11"]).toMatchObject({ email: "ana@example.com", phone: "555-0101" });
    expect(c["30"]).toMatchObject({ displayName: "Lincoln High", email: null, phone: null });
  });

  it("drops contact details when a shape change stops naming a type", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    expect((await customers())["11"]).toMatchObject({ email: "ana@example.com" });
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, staffOp);
    await refreshRoster(worker);
    expect((await customers())["11"]).toMatchObject({ email: null, phone: null });
    expect(await getShape()).toEqual({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
  });

  it("removes a customer QuickBooks no longer returns", async () => {
    await refreshRoster(worker);
    stub.customers = stub.customers.filter((c) => c.Id !== "50");
    await refreshRoster(worker);
    expect((await customers())["50"]).toBeUndefined();
  });

  it("a failure on a later page keeps the old cache", { timeout: 30_000 }, async () => {
    await refreshRoster(worker); // queries 1 (types) and 2 (customers)
    stub.customers = Array.from({ length: 1500 }, (_, i) => ({ Id: String(1000 + i), DisplayName: `New ${i}`, Active: true, SyncToken: "0" }));
    stub.failQueryFrom = 5; // query 3 is types, 4 is the first page of customers, 5 is the second page
    const r = await refreshRoster(worker);
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect(Object.keys(await customers()).sort()).toEqual(["10", "11", "12", "20", "21", "30", "40", "50", "60"]);
    expect(await lastRun()).toMatchObject({ outcome: "failed", detail: "QuickBooks refused the request. (http_500)" });
    expect((await audits("roster.refresh.failed"))[0]).toMatchObject({ after: { code: "http_500" } });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("a message the portal must never store");
  });

  const OLD_IDS = ["10", "11", "12", "20", "21", "30", "40", "50", "60"];
  const expectFailedRun = async (r: unknown, detail: string, code: string) => {
    expect(r).toEqual({ ok: false, reason: "failed", error: detail });
    expect(Object.keys(await customers()).sort()).toEqual(OLD_IDS);
    expect(await lastRun()).toMatchObject({ outcome: "failed", detail });
    expect((await audits("roster.refresh.failed"))[0]).toMatchObject({ after: { code } });
    const everything = JSON.stringify([await db.select().from(auditLog), await db.select().from(jobRun)]);
    expect(everything).not.toMatch(/invalid byte sequence|null value|Cannot read|TypeError|0x00/i);
  };

  it("a failure while saving the cache is recorded and keeps the old cache", { timeout: 30_000 }, async () => {
    await refreshRoster(worker);
    stub.customers = [{ Id: "900", DisplayName: "Bad\u0000Name", Active: true, SyncToken: "0" }];
    await expectFailedRun(await refreshRoster(worker), "The roster couldn't be saved. (save_failed)", "save_failed");
  });

  it("a failure that isn't a QuickBooks error is recorded and keeps the old cache", async () => {
    await refreshRoster(worker);
    stub.nullQueryBody = true;
    await expectFailedRun(await refreshRoster(worker), "The roster couldn't be read. (unexpected)", "unexpected");
  });

  it("drops contact details at once when the shape changes, even if the refresh after it fails", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    expect((await customers())["11"]).toMatchObject({ email: "ana@example.com", phone: "555-0101" });
    stub.failQueryFrom = 1;
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, staffOp);
    expect((await customers())["11"]).toMatchObject({ email: null, phone: null });
  });

  it("a shape save waits for a running refresh", async () => {
    let save: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      save = saveShape(FZN_SHAPE, staffOp);
      await new Promise((r) => setTimeout(r, 400));
      expect(await getShape()).toBeNull();
    });
    await save;
    expect(await getShape()).toEqual(FZN_SHAPE);
  });

  it("won't run twice at once", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "running" });
    });
    expect(await db.select().from(qboCustomer)).toHaveLength(0);
  });

  it("limits a hand-started refresh to one every 5 minutes, but not the worker", async () => {
    const byHand = { startedBy: staffOp.actor.id, actor: staffOp.actor, ip: staffOp.ip, manual: true };
    expect(await refreshRoster(byHand)).toMatchObject({ ok: true });
    expect(await refreshRoster(byHand)).toEqual({ ok: false, reason: "too_soon" });
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    await db.update(jobRun).set({ startedAt: new Date(Date.now() - 6 * 60_000) });
    expect(await refreshRoster(byHand)).toMatchObject({ ok: true });
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ door: "staff", actorLabel: "admin@example.org", ip: "203.0.113.9" });
  });

  it("says so when QuickBooks isn't connected", async () => {
    await resetDb();
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("saving the shape is audited with the type names, before and after", async () => {
    await refreshRoster(worker);
    await saveShape(FZN_SHAPE, staffOp);
    await saveShape({ kind: "flat", memberTypeIds: ["3"] }, staffOp);
    const rows = await audits("settings.membership.save");
    expect(rows[0]).toMatchObject({ before: null, after: { shape: FZN_SHAPE, words: "Layered: families are Family, students are Student, parents are Parent." }, permission: "Settings.QuickBooks.ReadWrite" });
    expect(rows[1]).toMatchObject({ before: { shape: FZN_SHAPE }, after: { words: "Flat: members are Student." } });
    expect((await db.select().from(setting).where(eq(setting.key, SHAPE_KEY)))[0]!.value).toEqual({ kind: "flat", memberTypeIds: ["3"] });
  });
});
