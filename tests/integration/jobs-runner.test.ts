import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboConnection, qboCustomer, setting } from "@/lib/db/schema";
import { beginConnect, completeConnect } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { refreshRoster } from "@/lib/roster/refresh";
import { runDueJobs, lastWake, TOKEN_JOB } from "@/lib/jobs/runner";
import * as welcomeModule from "@/lib/parents/welcome";
import * as noticeModule from "@/lib/parents/review-notice";
import * as companyChangeModule from "@/lib/parents/company-change";
import { getPreviousCompany, PREVIOUS_COMPANY_KEY } from "@/lib/parents/company-change";
import { workerToken } from "@/lib/jobs/worker-token";
import { ROSTER_JOB } from "@/lib/roster/refresh";
import { POST, GET } from "@/app/api/internal/worker/route";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const runs = async (job: string) => (await db.select().from(jobRun).where(eq(jobRun.job, job))).sort((a, b) => a.id - b.id);
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const tokenFailures = async () => (await db.select().from(auditLog)).filter((r) => r.action === "quickbooks.token_refresh.failed");

describe("scheduled jobs", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("records the wake and does nothing while QuickBooks isn't connected", async () => {
    expect(await lastWake()).toBeNull();
    expect(await runDueJobs()).toEqual({ ran: [] });
    expect(Date.parse((await lastWake())!)).toBeGreaterThan(Date.now() - 5000);
    expect(await db.select().from(jobRun)).toHaveLength(0);
  });

  it("runs both jobs the first time, and neither again within 24 hours", async () => {
    await seedConnected(stub);
    expect(await runDueJobs()).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
    expect(stub.tokenCalls()).toHaveLength(1); // the daily refresh spends the refresh token even though the access token was still good
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect((await runs(TOKEN_JOB))[0]).toMatchObject({ outcome: "ok", startedBy: "worker" });
    expect(await runDueJobs(hours(23))).toEqual({ ran: [] });
    expect(await runDueJobs(hours(25))).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
  });

  it("records when the token job finished, not when the wake began", async () => {
    await seedConnected(stub);
    stub.tokenDelayMs = 300;
    await runDueJobs();
    const [run] = await runs(TOKEN_JOB);
    expect(run!.finishedAt!.getTime() - run!.startedAt.getTime()).toBeGreaterThanOrEqual(250);
    stub.tokenDelayMs = 300;
    stub.failToken = "server_error";
    await runDueJobs(hours(25));
    const failed = (await runs(TOKEN_JOB))[1]!;
    expect(failed.outcome).toBe("failed");
    expect(failed.finishedAt!.getTime()).toBeLessThan(Date.now() + 5000); // the real time, not the 25 hours ahead the wake was told
  });

  it("retries a failed job, but no more often than every 15 minutes", async () => {
    await seedConnected(stub);
    stub.failToken = "server_error";
    expect(await runDueJobs()).toMatchObject({ ran: [{ job: TOKEN_JOB, ok: false }, { job: ROSTER_JOB, ok: true }] });
    expect((await runs(TOKEN_JOB))[0]).toMatchObject({ outcome: "failed", detail: "Intuit refused the request. (server_error)" });
    stub.failToken = null;
    expect(await runDueJobs(new Date(Date.now() + 14 * 60_000))).toEqual({ ran: [] });
    expect(await runDueJobs(new Date(Date.now() + 16 * 60_000))).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }] });
    expect(await runs(TOKEN_JOB)).toHaveLength(2);
    expect((await db.select().from(qboConnection))[0]!.lastError).toBeNull();
  });

  it("a hand-started roster refresh counts as that day's run", async () => {
    await seedConnected(stub);
    await runDueJobs();
    await db.update(jobRun).set({ startedAt: hours(-30), finishedAt: hours(-30) });
    const { refreshRoster } = await import("@/lib/roster/refresh");
    await refreshRoster({ startedBy: "5a1e7a2e-0000-4000-8000-000000000001", actor: { door: "staff", id: "5a1e7a2e-0000-4000-8000-000000000001", label: "a@example.org" }, ip: null, manual: true });
    expect(await runDueJobs()).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }] });
  });

  it("the worker endpoint runs the jobs for the right token and is not found for anything else", async () => {
    await seedConnected(stub);
    const call = (authorization?: string) => POST(new Request("http://app:3000/api/internal/worker", { method: "POST", headers: authorization ? { authorization } : {} }));
    const real = workerToken();
    const lastChanged = real.slice(0, -1) + (real.endsWith("0") ? "1" : "0");
    // The right-length cases matter: they get past the length check and have to be turned away by the comparison itself.
    for (const bad of [undefined, "Bearer nope", `Bearer ${real}x`, real, `Bearer ${"0".repeat(64)}`, `Bearer ${lastChanged}`, `bearer ${real}`]) {
      const res = await call(bad);
      expect(res.status).toBe(404);
    }
    expect(await db.select().from(jobRun)).toHaveLength(0);
    const res = await call(`Bearer ${workerToken()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
  });

  it("a welcome step that throws is recorded as failed and the other jobs still run", async () => {
    await seedConnected(stub);
    const spy = vi.spyOn(welcomeModule, "sendOwedWelcomes").mockRejectedValueOnce(new Error("secret-detail-from-the-mail-settings"));
    const logs = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      const r = await runDueJobs();
      expect(r).toEqual({ ran: [{ job: "parents.welcome", ok: false }, { job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
      expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain("secret-detail");
    } finally { spy.mockRestore(); logs.forEach((l) => l.mockRestore()); }
  });

  it("a review-notice step that throws is recorded as failed and the other jobs still run", async () => {
    await seedConnected(stub);
    const spy = vi.spyOn(noticeModule, "sendReviewNotice").mockRejectedValueOnce(new Error("secret-detail-from-the-notice"));
    const logs = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      const r = await runDueJobs();
      expect(r).toEqual({ ran: [{ job: "parents.review_notice", ok: false }, { job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
      expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain("secret-detail");
    } finally { spy.mockRestore(); logs.forEach((l) => l.mockRestore()); }
  });

  it("deletes the previous company's snapshot once it is 90 days old, and says so", async () => {
    await db.insert(setting).values({ key: PREVIOUS_COMPANY_KEY, value: { realmId: "1111", newRealmId: "2222", at: new Date().toISOString(), families: [], approvals: [] } });
    expect(await runDueJobs(hours(89 * 24))).toEqual({ ran: [] });
    expect(await getPreviousCompany()).not.toBeNull();
    expect(await runDueJobs(hours(91 * 24))).toEqual({ ran: [{ job: "parents.snapshot_expiry", ok: true }] });
    expect(await getPreviousCompany()).toBeNull();
    expect((await db.select().from(auditLog)).filter((r) => r.action === "settings.parents.save").map((r) => r.after)).toEqual([{ previousCompany: "deleted", reason: "expired" }]);
  });

  it("a snapshot-expiry step that throws is recorded as failed and the other jobs still run", async () => {
    await seedConnected(stub);
    const spy = vi.spyOn(companyChangeModule, "expirePreviousCompany").mockRejectedValueOnce(new Error("secret-detail-from-the-snapshot"));
    const logs = (["log", "info", "warn", "error"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    try {
      const r = await runDueJobs();
      expect(r).toEqual({ ran: [{ job: "parents.snapshot_expiry", ok: false }, { job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
      expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toContain("secret-detail");
    } finally { spy.mockRestore(); logs.forEach((l) => l.mockRestore()); }
  });

  it("an unexpected error in the token job is recorded as a fixed failure and the roster job still runs", async () => {
    await seedConnected(stub);
    const client = await import("@/lib/quickbooks/client");
    const spy = vi.spyOn(client, "accessToken").mockRejectedValueOnce(new Error("secret-detail-from-intuit"));
    const res = await POST(new Request("http://app:3000/api/internal/worker", { method: "POST", headers: { authorization: `Bearer ${workerToken()}` } }));
    spy.mockRestore();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("secret-detail");
    expect(JSON.parse(text)).toEqual({ ok: true, ran: [{ job: TOKEN_JOB, ok: false }, { job: ROSTER_JOB, ok: true }] });
    expect((await runs(TOKEN_JOB))[0]).toMatchObject({ outcome: "failed", detail: "The connection couldn't be refreshed. (unexpected)" });
    expect(JSON.stringify(await runs(TOKEN_JOB))).not.toContain("secret-detail");
  });

  it("a GET is not found, with or without the token, and runs no job", async () => {
    await seedConnected(stub);
    for (const headers of [{}, { authorization: `Bearer ${workerToken()}` }] as Record<string, string>[]) {
      const res = await (GET as (r: Request) => Promise<Response>)(new Request("http://app:3000/api/internal/worker", { headers }));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not found");
    }
    expect(await db.select().from(jobRun)).toHaveLength(0);
    expect(await lastWake()).toBeNull();
  });

  it("leaves a connection Intuit no longer accepts alone until an Admin reconnects, auditing it once", { timeout: 30_000 }, async () => {
    const admin = await seedStaff({ email: "admin@example.org", admin: true });
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.failToken = "invalid_grant";
    expect(await runDueJobs(minutes(0))).toEqual({ ran: [{ job: TOKEN_JOB, ok: false }, { job: ROSTER_JOB, ok: false }] });
    const runsAfterFirst = (await db.select().from(jobRun)).length;
    expect(await runDueJobs(minutes(16))).toEqual({ ran: [] });
    expect(await runDueJobs(minutes(32))).toEqual({ ran: [] });
    expect(await db.select().from(jobRun)).toHaveLength(runsAfterFirst);
    expect(await tokenFailures()).toHaveLength(1);
    expect((await quickbooksProblems()).map((p) => p.kind)).toContain("token_failed");
    // A hand-started refresh still tries, and still records its failure.
    await db.update(jobRun).set({ startedAt: minutes(-6) }).where(eq(jobRun.job, ROSTER_JOB));
    const byHand = { startedBy: admin.id, actor: { door: "staff" as const, id: admin.id, label: admin.email }, ip: null, manual: true };
    expect(await refreshRoster(byHand)).toMatchObject({ ok: false, reason: "failed" });
    expect(await runs(ROSTER_JOB)).toHaveLength(2);
    // Reconnecting clears the recorded error, and the next wake runs both jobs.
    stub.failToken = null;
    const r = await beginConnect(admin.id);
    stub.codes.add("code-1");
    expect(await completeConnect({ code: "code-1", state: r.ok ? new URL(r.url).searchParams.get("state") : null, realmId: "9130000000000001", error: null },
      { staffUserId: admin.id, actor: byHand.actor, ip: null })).toEqual({ ok: true });
    expect(await runDueJobs(minutes(48))).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
  });

  it("still retries a passing failure every 15 minutes, auditing it once while it is unchanged", { timeout: 30_000 }, async () => {
    await seedConnected(stub);
    stub.failToken = "server_error";
    expect(await runDueJobs(minutes(0))).toEqual({ ran: [{ job: TOKEN_JOB, ok: false }, { job: ROSTER_JOB, ok: true }] });
    expect(await runDueJobs(minutes(16))).toEqual({ ran: [{ job: TOKEN_JOB, ok: false }] });
    expect(await runDueJobs(minutes(32))).toEqual({ ran: [{ job: TOKEN_JOB, ok: false }] });
    expect(await runs(TOKEN_JOB)).toHaveLength(3);
    expect(await tokenFailures()).toHaveLength(1);
    expect((await db.select().from(qboConnection))[0]!.lastErrorAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });
});
