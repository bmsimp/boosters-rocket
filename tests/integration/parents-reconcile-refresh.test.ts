import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import * as reconcile from "@/lib/parents/reconcile";
import { db } from "@/lib/db/client";
import { auditLog, guardian, jobRun, parent, parentAuthUser, qboCustomer } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };

describe("the reconcile inside a roster refresh", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); await seedConnected(stub); await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null }); });
  afterEach(() => vi.restoreAllMocks());

  it("gives the roster's parents access in the same refresh, naming the run", async () => {
    await seedParentSettings(SIGNINS_ON);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const [g] = await db.select().from(guardian);
    expect(g).toMatchObject({ familyQboId: "10", sourceQboId: "11", status: "invited" });   // Ana Rivera, the only parent with an address
    const [run] = await db.select().from(jobRun);
    const granted = (await db.select().from(auditLog)).find((r) => r.action === "parent.access.granted");
    expect(granted!.after).toMatchObject({ cause: `roster.refresh#${run!.id}` });
  });

  it("leaves the old roster and every link as they were when the reconcile fails, and records the refresh as failed", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const before = { customers: await db.select().from(qboCustomer), links: await db.select().from(guardian) };
    stub.customers = stub.customers.filter((c) => c.Id !== "11");          // would close Ana's link
    vi.spyOn(reconcile, "reconcileAccess").mockRejectedValueOnce(new Error("boom: ana@example.com"));
    const r = await refreshRoster(worker);
    expect(r).toEqual({ ok: false, reason: "failed", error: "The parent sign-ins couldn't be brought up to date, so the roster was left as it was. (reconcile_failed)" });
    expect(await db.select().from(qboCustomer)).toEqual(before.customers);
    expect(await db.select().from(guardian)).toEqual(before.links);
    const last = (await db.select().from(jobRun)).sort((a, b) => b.id - a.id)[0]!;
    expect(last).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("boom");
    const failed = (await db.select().from(auditLog)).filter((x) => x.action === "roster.refresh.failed").at(-1)!;
    expect(failed.after).toEqual({ code: "reconcile_failed" });
  });

  it("undoes the reconcile's own changes too when it fails after making them", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const snapshot = async () => ({ customers: await db.select().from(qboCustomer), links: await db.select().from(guardian),
      people: await db.select().from(parent), accounts: await db.select().from(parentAuthUser) });
    const before = await snapshot();
    stub.customers = stub.customers.filter((c) => c.Id !== "11");                          // the real reconcile closes Ana's link
    const real = reconcile.reconcileAccess;
    let inside: reconcile.ReconcileResult | null = null;
    vi.spyOn(reconcile, "reconcileAccess").mockImplementationOnce(async (tx, o) => { inside = await real(tx, o); throw new Error("boom after writing"); });
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed" });
    expect(inside).toMatchObject({ ran: true, ended: 1 });
    expect(await snapshot()).toEqual(before);
    expect((await db.select().from(auditLog)).filter((r) => r.action === "parent.access.ended")).toEqual([]);
  });
});
