import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// When a company's plan stops offering customer types (a downgrade, say), the roster can't be sorted into families.
// The refresh records that as its own reason, the three places that warn staff say it in plain words and link the shape
// step, and nothing the portal holds is cleared.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { renderToStaticMarkup } from "react-dom/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import HealthPage from "@/app/staff/(app)/settings/health/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import { QuickBooksWarning } from "@/app/staff/(app)/quickbooks-warning";
import { NO_CUSTOMER_TYPES_WORDS, refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";
import { getShape, saveShape } from "@/lib/roster/shape";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: null, permission: "Settings.QuickBooks.ReadWrite" };
const DETAIL = `${NO_CUSTOMER_TYPES_WORDS} (no_customer_types)`;
const SHAPE_LINK = 'href="/staff/settings/quickbooks/setup?step=shape"';
const lastRun = async () => (await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1))[0]!;
const held = async () => ({ customers: (await db.select().from(qboCustomer)).map((c) => c.qboId).sort(), types: (await db.select().from(qboCustomerType)).map((t) => t.qboId).sort() });
const ODD_FAULT = { Fault: { Error: [{ Message: "Feature Not Supported", Detail: "a detail the portal must never store", code: "5020" }], type: "ValidationFault" } };

/** Answers the CustomerType query with this HTTP status, and passes every other request to the stub. */
function refuseTypes(status: number) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const query = new URL(String(input instanceof Request ? input.url : input)).searchParams.get("query") ?? "";
    if (query === "select * from CustomerType") return new Response(JSON.stringify(ODD_FAULT), { status, headers: { "content-type": "application/json" } });
    return realFetch(input, init);
  });
}

describe("a company whose plan doesn't offer customer types", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset(); Object.assign(stub, fznCompany());
    await seedConnected(stub);
    await saveShape(FZN_SHAPE, staffOp);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true }); // the last good read
  });

  const expectNothingCleared = async (before: Awaited<ReturnType<typeof held>>) => {
    expect(await held()).toEqual(before);
    expect(await getShape()).toEqual(FZN_SHAPE);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("a detail the portal must never store");
  };

  it.each([400, 403])("is its own failure when QuickBooks refuses the type query with %i but reads the customers", async (status) => {
    const before = await held();
    const spy = refuseTypes(status);
    const r = await refreshRoster(worker);
    spy.mockRestore();
    expect(r).toEqual({ ok: false, reason: "failed", error: DETAIL });
    expect(await lastRun()).toMatchObject({ outcome: "failed", detail: DETAIL });
    expect((await db.select().from(auditLog)).filter((a) => a.action === "roster.refresh.failed").at(-1)).toMatchObject({ after: { code: "no_customer_types" } });
    await expectNothingCleared(before);
  });

  it("is its own failure when the type query answers a Fault with status 200", async () => {
    const before = await held();
    stub.oddRosterAnswer = { types: ODD_FAULT };
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed", error: DETAIL });
    await expectNothingCleared(before);
  });

  it("is its own failure when QuickBooks says the company has no customer types while the shape names some", async () => {
    const before = await held();
    stub.oddRosterAnswer = { types: { QueryResponse: {} } };
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed", error: DETAIL });
    await expectNothingCleared(before);
  });

  it("stays the generic failure when QuickBooks refuses everything, the customers too", async () => {
    stub.failNext = 10;
    const r = await refreshRoster(worker);
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect((r as { error: string }).error).not.toContain("customer types");
  });

  it("is said in plain words, with the shape step linked, on Settings, QuickBooks, the Health page and the staff home", async () => {
    const admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
    asStaff(admin);
    stub.oddRosterAnswer = { types: ODD_FAULT };
    await refreshRoster(worker);
    expect((await quickbooksProblems()).map((p) => p.kind)).toEqual(["no_customer_types"]);
    const pages = {
      settings: await renderPage(QuickBooksSettingsPage),
      health: await renderPage(HealthPage),
      home: renderToStaticMarkup((await QuickBooksWarning())!),
    };
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).toContain("QuickBooks no longer offers customer types on this company&#x27;s plan");
      expect(html, name).toContain(SHAPE_LINK);
      expect(html, name).not.toContain("The last roster refresh failed");
      expect(html, name).not.toContain("Feature Not Supported");
    }
  });
});
