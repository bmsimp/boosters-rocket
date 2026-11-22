import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Intuit's intuit_tid is kept with a failure, where the failure is kept (the connection's last error, a write's last
// try, a roster refresh's reason), and shown to staff as "Intuit reference: …" for Intuit support. Never with a success.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, writeQueue } from "@/lib/db/schema";
import { accessToken } from "@/lib/quickbooks/client";
import { errorNeedsAdmin, failureWords, QboError } from "@/lib/quickbooks/endpoints";
import { refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";
import { runWriteQueue } from "@/lib/roster/queue";
import HealthPage from "@/app/staff/(app)/settings/health/page";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";
import { connectRoster, seedQueued, WORKER } from "../helpers/roster-writes";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const TID = "1-6743d2a1-0e5f9c2b7d4a8e1f3c6b9a2d";
const everything = async () => JSON.stringify([await db.select().from(auditLog), await db.select().from(jobRun), await db.select().from(qboConnection), await db.select().from(writeQueue)]);
const lastRosterRun = async () => (await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1))[0]!;

describe("Intuit's reference on a failure", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("is in the words of a failure, before its code", () => {
    expect(failureWords(new QboError("QuickBooks refused the request.", "http_400", "abc-123"))).toBe("QuickBooks refused the request. Intuit reference: abc-123. (http_400)");
    expect(failureWords(new QboError("QuickBooks refused the request.", "http_400"))).toBe("QuickBooks refused the request. (http_400)");
  });

  it("is kept with a failed token refresh, which still needs an Admin, and shown on the Health page", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1 });
    stub.failToken = "invalid_grant"; stub.tid = TID;
    await expect(accessToken()).rejects.toMatchObject({ code: "invalid_grant", tid: TID });
    const [c] = await db.select().from(qboConnection);
    expect(c!.lastError).toBe(`Intuit no longer accepts this connection. Connect QuickBooks again. Intuit reference: ${TID}. (invalid_grant)`);
    expect(errorNeedsAdmin(c!.lastError)).toBe(true);
    // A second failure with another reference is the same error: audited once.
    stub.tid = "1-another-reference";
    await expect(accessToken()).rejects.toMatchObject({ code: "invalid_grant" });
    expect((await db.select().from(auditLog)).filter((a) => a.action === "quickbooks.token_refresh.failed")).toHaveLength(1);
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    expect(await renderPage(HealthPage)).toContain("Intuit reference: 1-another-reference.");
  });

  it("is kept with a failed roster refresh", async () => {
    await seedConnected(stub);
    stub.failQueryFrom = 1; stub.tid = TID;
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: false, error: `QuickBooks refused the request. Intuit reference: ${TID}. (http_500)` });
    expect((await lastRosterRun()).detail).toContain(`Intuit reference: ${TID}.`);
  });

  it("is kept with a write's failed try, shown on Reconciliation, and cleared when the write goes through", async () => {
    await connectRoster(stub);
    const item = await seedQueued({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leon Rivera", was: "Leo Rivera" },
      { sent: false, createdAt: new Date(Date.now() - 120_000), familyQboId: "10" });
    stub.failNext = 1; stub.tid = TID;
    await runWriteQueue();
    const [row] = await db.select().from(writeQueue).where(eq(writeQueue.id, item.id));
    expect(row).toMatchObject({ state: "waiting", lastCode: "http_500", lastIntuitTid: TID });
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    expect(await renderPage(ReconciliationPage)).toContain(`Intuit reference: ${TID}`);
    // The try may have reached QuickBooks, so the next one waits for a roster read made after it.
    stub.tid = null;
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 1000) }).where(eq(writeQueue.id, item.id));
    await runWriteQueue();
    const [done] = await db.select().from(writeQueue).where(eq(writeQueue.id, item.id));
    expect(done).toMatchObject({ state: "done", lastIntuitTid: null });
  });

  it("is never kept for a success", async () => {
    await connectRoster(stub, { accessExpiresInMs: -1 });
    stub.tid = TID;
    expect(await refreshRoster(WORKER)).toMatchObject({ ok: true });
    expect(await everything()).not.toContain(TID);
  });
});
