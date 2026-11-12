import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, qboConnection, qboCustomerType } from "@/lib/db/schema";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { disconnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const kinds = async (now?: Date) => (await quickbooksProblems(now)).map((p) => p.kind);

describe("the QuickBooks warning", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("says nothing on a site that never connected, or one that disconnected", async () => {
    expect(await kinds()).toEqual([]);
    await seedConnected(stub);
    await disconnect({ actor: worker.actor, ip: null });
    expect(await kinds()).toEqual([]);
  });
  it("says nothing while everything is fine", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await kinds()).toEqual([]);
  });
  it("a failed token refresh", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    await db.update(qboConnection).set({ lastError: "Intuit refused the request. (server_error)", lastErrorAt: new Date() });
    const [p] = await quickbooksProblems();
    expect(p).toEqual({ kind: "token_failed", text: "The QuickBooks connection couldn't be refreshed: Intuit refused the request. (server_error)" });
  });
  it("a connection that expires within 30 days, but not one with 31 days left", async () => {
    await seedConnected(stub, { refreshExpiresInMs: 29 * 86_400_000 });
    await refreshRoster(worker);
    expect(await kinds()).toEqual(["expiring"]);
    await db.update(qboConnection).set({ refreshExpiresAt: new Date(Date.now() + 31 * 86_400_000) });
    expect(await kinds()).toEqual([]);
  });
  it("warns of expiry from just under 30 days, not at exactly 30", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    const now = new Date();
    await db.update(qboConnection).set({ refreshExpiresAt: new Date(now.getTime() + 30 * 86_400_000) });
    expect(await kinds(now)).toEqual([]);
    await db.update(qboConnection).set({ refreshExpiresAt: new Date(now.getTime() + 30 * 86_400_000 - 1) });
    expect(await kinds(now)).toEqual(["expiring"]);
  });
  it("calls the roster old from just over 48 hours, not at exactly 48", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    const now = new Date();
    await db.update(jobRun).set({ finishedAt: new Date(now.getTime() - 48 * 3_600_000) });
    expect(await kinds(now)).toEqual([]);
    await db.update(jobRun).set({ finishedAt: new Date(now.getTime() - 48 * 3_600_000 - 1) });
    expect(await kinds(now)).toEqual(["roster_old"]);
  });
  it("a failed roster refresh", async () => {
    await seedConnected(stub);
    stub.failQueryFrom = 1;
    await refreshRoster(worker);
    expect(await quickbooksProblems()).toEqual([{ kind: "roster_failed", text: "The last roster refresh failed: QuickBooks refused the request. (http_500)" }]);
  });
  it("a roster more than 48 hours old", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await kinds(new Date(Date.now() + 47 * 3_600_000))).toEqual([]);
    expect(await kinds(new Date(Date.now() + 49 * 3_600_000))).toEqual(["roster_old"]);
  });
  it("a connection with no refresh yet warns only once it is 48 hours old", async () => {
    await seedConnected(stub);
    expect(await kinds()).toEqual([]);
    expect(await kinds(new Date(Date.now() + 49 * 3_600_000))).toEqual(["roster_old"]);
  });
  it("a shape that names a type QuickBooks no longer has", async () => {
    await seedConnected(stub);
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2"));
    expect(await kinds()).toEqual(["shape_broken"]);
  });
});
