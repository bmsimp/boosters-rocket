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
import { jobRun } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { askForRosterRefresh, rosterRefreshAsked } from "@/lib/parents/refresh-ask";
import { ROSTER_JOB } from "@/lib/roster/refresh";
import { resetDb } from "../helpers/db";
import { fznCompany, seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const ask = (at = new Date()) => db.transaction((tx) => askForRosterRefresh(tx, at));
const aRun = (startedAt: Date, outcome: "ok" | "failed" | null) =>
  db.insert(jobRun).values({ job: ROSTER_JOB, startedAt, finishedAt: outcome ? startedAt : null, outcome, startedBy: "worker" });
const rosterRuns = () => db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB));

describe("asking the worker to read the roster again at its next wake (a parent's email change met a busy roster)", () => {
  it("is answered by a successful read that started after the ask, and by nothing else", async () => {
    expect(await rosterRefreshAsked()).toBe(false);
    await aRun(minutes(-10), "ok");
    await ask();
    expect(await rosterRefreshAsked()).toBe(true);
    // A read under way that started before the ask read QuickBooks before the change: it doesn't answer it.
    await aRun(minutes(-1), null);
    expect(await rosterRefreshAsked()).toBe(true);
    await aRun(minutes(1), "ok");
    expect(await rosterRefreshAsked(minutes(2))).toBe(false);
  });

  it("is not answered by a read that started in the ask's own millisecond, and the next wake reads again", async () => {
    const at = minutes(-5);
    await ask(at);
    // The same instant on purpose: that read may have asked QuickBooks before the change landed there.
    await aRun(at, "ok");
    expect(await rosterRefreshAsked(minutes(-4))).toBe(true);
    await aRun(new Date(at.getTime() + 1), "ok");
    expect(await rosterRefreshAsked(minutes(-4))).toBe(false);
  });

  it("a read that failed after the ask is tried again after the worker's usual 15 minutes", async () => {
    await ask();
    await aRun(minutes(1), "failed");
    expect(await rosterRefreshAsked(minutes(10))).toBe(false);
    expect(await rosterRefreshAsked(minutes(17))).toBe(true);
  });

  it("the worker reads the roster at its next wake, though the daily read isn't due, and only once", async () => {
    await seedConnected(stub);
    expect((await runDueJobs()).ran.map((r) => r.job)).toContain(ROSTER_JOB); // the first read of the day
    expect((await runDueJobs(minutes(2))).ran.map((r) => r.job)).not.toContain(ROSTER_JOB);
    // That read started a minute ago; the ask half a minute ago, so the read the wake makes now (a read records the real
    // time it started, whatever `now` says) starts after it, never in the same millisecond.
    await db.update(jobRun).set({ startedAt: minutes(-1) }).where(eq(jobRun.job, ROSTER_JOB));
    await ask(minutes(-0.5));
    expect((await runDueJobs(minutes(3))).ran).toContainEqual({ job: ROSTER_JOB, ok: true });
    expect((await runDueJobs(minutes(4))).ran.map((r) => r.job)).not.toContain(ROSTER_JOB);
    expect(await rosterRuns()).toHaveLength(2);
  });
});
