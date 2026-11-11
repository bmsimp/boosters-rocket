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
import { jobRun, qboConnection, qboCustomer } from "@/lib/db/schema";
import { runDueJobs, lastWake, TOKEN_JOB } from "@/lib/jobs/runner";
import { workerToken } from "@/lib/jobs/worker-token";
import { ROSTER_JOB } from "@/lib/roster/refresh";
import { POST, GET } from "@/app/api/internal/worker/route";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const runs = async (job: string) => (await db.select().from(jobRun).where(eq(jobRun.job, job))).sort((a, b) => a.id - b.id);
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

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
});
