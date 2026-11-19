import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { DrizzleQueryError } from "drizzle-orm";
import * as inStep from "@/lib/families/in-step";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, jobRun, parent, parentAuthUser, qboCustomer, student } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
/** Every sign-in the app holds, and every record the read keeps in step, as they are. */
const snapshot = async () => ({ customers: await db.select().from(qboCustomer), links: await db.select().from(guardian), people: await db.select().from(parent),
  accounts: await db.select().from(parentAuthUser), families: await db.select().from(family), students: await db.select().from(student),
  accountingLinks: await db.select().from(accountingLink) });
const SIGNIN_ACTIONS = ["parent.create", "parent.access.granted", "parent.access.ended", "parent.access.moved", "parent.email.changed", "parent.name.changed", "parent.hold.opened"];

// Who may sign in is the app's own guardian rows (stage 3 of the app-owned families spec, slice 7a): a roster read
// keeps the app's family and student records in step with QuickBooks, and makes, opens, moves or closes no sign-in.
describe("a roster refresh and the portal's sign-ins", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); await seedConnected(stub); await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null }); });
  afterEach(() => vi.restoreAllMocks());

  it("makes no person and no sign-in from QuickBooks' parents, with sign-ins on", async () => {
    await seedParentSettings(SIGNINS_ON);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await db.select().from(parent)).toEqual([]);
    expect(await db.select().from(guardian)).toEqual([]);
    const audit = await db.select().from(auditLog);
    expect(audit.filter((r) => SIGNIN_ACTIONS.includes(r.action))).toEqual([]);
    // The app's own records are made, as every read makes them.
    expect((await db.select().from(family)).length).toBeGreaterThan(0);
  });

  it("leaves a guardian row as it is when QuickBooks drops, renames or readdresses its record", async () => {
    await seedParentSettings(SIGNINS_ON);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "active" });
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const before = { links: await db.select().from(guardian), people: await db.select().from(parent), accounts: await db.select().from(parentAuthUser) };
    expect(before.links[0]).toMatchObject({ status: "active" });
    stub.customers = stub.customers.map((c) => (c.Id === "11" ? { ...c, DisplayName: "Ana R.", PrimaryEmailAddr: { Address: "new@example.com" } } : c));
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    stub.customers = stub.customers.filter((c) => c.Id !== "11");
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    // Only the records' step may touch a guardian row (its family record): status, person and address stay.
    const links = await db.select().from(guardian);
    expect(links.map((l) => ({ ...l, updatedAt: null }))).toEqual(before.links.map((l) => ({ ...l, updatedAt: null })));
    expect(await db.select().from(parent)).toEqual(before.people);
    expect(await db.select().from(parentAuthUser)).toEqual(before.accounts);
    expect((await db.select().from(auditLog)).filter((r) => SIGNIN_ACTIONS.includes(r.action))).toEqual([]);
  }, 30_000);

  it("leaves the old roster and every record as they were when bringing the records into step fails, and records the refresh as failed", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const before = await snapshot();
    stub.customers = stub.customers.filter((c) => c.Id !== "12");
    vi.spyOn(inStep, "keepAppRecordsInStep").mockRejectedValueOnce(new inStep.AppRecordsFailed("boom: ana@example.com", { cause: new Error("boom: ana@example.com") }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await refreshRoster(worker);
    // The server log says what kind of failure it was, and never the message (it can hold an address).
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toBe("[roster] app records failed");
    expect(Object.keys(logged.mock.calls[0]![1] as object).sort()).toEqual(["code", "constraint", "name"]);
    expect(logged.mock.calls[0]![1]).toEqual({ name: "Error", code: undefined, constraint: undefined });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("boom");
    expect(r).toEqual({ ok: false, reason: "failed", error: "The portal's own family and student records couldn't be brought up to date, so the roster was left as it was. (app_records_failed)" });
    expect(await snapshot()).toEqual(before);
    const last = (await db.select().from(jobRun)).sort((a, b) => b.id - a.id)[0]!;
    expect(last).toMatchObject({ outcome: "failed" });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("boom");
    const failed = (await db.select().from(auditLog)).filter((x) => x.action === "roster.refresh.failed").at(-1)!;
    expect(failed.after).toEqual({ code: "app_records_failed" });
  });

  // The gap the review of step 2 left: an answer with no customers in it was saved as an empty roster.
  it.each([
    ["a 200 that isn't a query answer", {}, "bad_answer"],
    ["a Fault sent with status 200", { Fault: { Error: [{ Message: "a message the portal must never store", code: "4000" }] } }, "fault"],
    ["a well-formed answer that holds no customers", { QueryResponse: {} }, "no_customers"],
  ])("%s changes nothing: the roster, the records and every sign-in stay as they were", async (_what, body, code) => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "active" });
    const before = await snapshot();
    stub.oddRosterAnswer = { customers: body };
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed", error: expect.stringContaining(`(${code})`) });
    expect(await snapshot()).toEqual(before);
    const audit = await db.select().from(auditLog);
    expect(audit.filter((r) => r.action === "parent.access.ended")).toEqual([]);
    expect(audit.filter((r) => r.action === "roster.refresh.failed").at(-1)!.after).toEqual({ code });
  });

  it("logs a database failure's SQLSTATE and constraint, and never its query, parameters or message", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "family_pkey": ana@example.com'), { code: "23505", constraint_name: "family_pkey" });
    vi.spyOn(inStep, "keepAppRecordsInStep").mockRejectedValueOnce(new inStep.AppRecordsFailed("The portal's own family records couldn't be brought up to date.",
      { cause: new DrizzleQueryError("insert into family values ($1)", ["ana@example.com"], pg) }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed" });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("[roster] app records failed", { name: "DrizzleQueryError", code: "23505", constraint: "family_pkey" });
    for (const secret of ["ana@example.com", "insert into", "duplicate key"]) expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
  });

  it("undoes the records' own changes too when the step fails after making them", async () => {
    await seedParentSettings(SIGNINS_ON);
    await refreshRoster(worker);
    const before = await snapshot();
    stub.customers = stub.customers.filter((c) => c.Id !== "12");                          // the real step makes Leo's record inactive
    const real = inStep.keepAppRecordsInStep;
    let inside: Awaited<ReturnType<typeof real>> | null = null;
    vi.spyOn(inStep, "keepAppRecordsInStep").mockImplementationOnce(async (tx) => { inside = await real(tx); throw new inStep.AppRecordsFailed("after writing"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed" });
    expect(inside).not.toBeNull();
    expect(await snapshot()).toEqual(before);
  });
});
