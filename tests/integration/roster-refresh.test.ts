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
import { TAKE_IN_KEY } from "@/lib/parents/contact-take-in";
import { resetDb, untilALockIsAwaited } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
const customers = async () => Object.fromEntries((await db.select().from(qboCustomer)).map((c) => [c.qboId, c]));
const lastRun = async () => (await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1))[0]!;
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);

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

  it("sends exactly the query strings tried against the sandbox (spec §8), the types in one unpaged request", async () => {
    stub.types = Array.from({ length: 150 }, (_, i) => ({ Id: String(i + 1), Name: `Type ${i + 1}`, Active: true }));
    expect(await refreshRoster(worker)).toMatchObject({ ok: true, types: 150 });
    expect(stub.apiCalls().map((x) => x.query.get("query"))).toEqual([
      "select * from CustomerType",
      "select * from Customer where Active in (true, false) orderby Id startposition 1 maxresults 1000",
    ]);
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
    expect(c["60"]).toMatchObject({ displayName: "No Type At All", email: null, phone: null }); // no type, so no shape can name it
  });

  it("keeps the billing address only for customers the shape names, as the parent's form shows one, and a shape save drops it", async () => {
    const billTo = { Line1: "12 Oak St\nRear door", Line2: "Unit 4", Line3: "c/o Rivera", City: "Austin", CountrySubDivisionCode: "TX", PostalCode: "78701", Country: "USA" };
    stub.customers = stub.customers.map((c) => (c.Id === "11" || c.Id === "30" ? { ...c, BillAddr: billTo } : c));
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const shown = { addressLine1: "12 Oak St, Rear door", addressLine2: "Unit 4, c/o Rivera", addressCity: "Austin", addressRegion: "TX", addressPostalCode: "78701", addressCountry: "USA" };
    const none = { addressLine1: null, addressLine2: null, addressCity: null, addressRegion: null, addressPostalCode: null, addressCountry: null };
    let c = await customers();
    expect(c["11"]).toMatchObject(shown);
    expect(c["30"]).toMatchObject({ displayName: "Lincoln High", ...none }); // a School: the shape doesn't name it
    expect(c["10"]).toMatchObject(none); // no address in QuickBooks: nothing kept, never an empty string
    // A shape that stops naming the Parent type drops the address with the email and phone, before any refresh runs.
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, staffOp);
    c = await customers();
    expect(c["11"]).toMatchObject({ email: null, phone: null, ...none });
  });

  it("marks, for the take-in of contact details, that this build's read kept the billing addresses, and only a successful read while it waits", async () => {
    const takeIn = async () => (await db.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY)))[0]?.value as Record<string, unknown> | undefined;
    await saveShape(FZN_SHAPE, staffOp);
    // No setting (a database migration 0044 never wrote it into): nothing is made.
    await refreshRoster(worker);
    expect(await takeIn()).toBeUndefined();
    const after = new Date(Date.now() - 60_000).toISOString();
    await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after } });
    // A failed read marks nothing.
    stub.oddRosterAnswer = { customers: { QueryResponse: "nothing" } };
    expect(await refreshRoster(worker)).toMatchObject({ ok: false });
    expect(await takeIn()).toEqual({ after });
    stub.oddRosterAnswer = null;
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const run = await lastRun();
    // `addressesSince`, the first read since the mark was last withdrawn, which a contact item counts its age from.
    expect(await takeIn()).toEqual({ after, addressesReadAt: run.startedAt.toISOString(), addressesSince: run.startedAt.toISOString() });
    // Once the take-in has run, a read still marks it, keeping `doneAt`, and a shape save still withdraws it: a
    // parent's change of their details is sent on only while it stands (stage 3's slice 11b, contactSendsMayGo()).
    const done = { after, addressesReadAt: run.startedAt.toISOString(), doneAt: new Date().toISOString() };
    await db.update(setting).set({ value: done }).where(eq(setting.key, TAKE_IN_KEY));
    await refreshRoster(worker);
    const since = (await lastRun()).startedAt.toISOString();
    expect(await takeIn()).toEqual({ ...done, addressesReadAt: since, addressesSince: since });
    // A later read moves the mark and keeps `addressesSince`; a shape save withdraws both.
    await refreshRoster(worker);
    expect(await takeIn()).toEqual({ ...done, addressesReadAt: (await lastRun()).startedAt.toISOString(), addressesSince: since });
    await saveShape(FZN_SHAPE, staffOp);
    expect(await takeIn()).toEqual({ after, doneAt: done.doneAt });
  });

  it("marks nothing for the take-in from a read made under a shape that doesn't hold, and a shape save withdraws the mark", async () => {
    const takeIn = async () => (await db.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY)))[0]?.value as Record<string, unknown> | undefined;
    const after = new Date(Date.now() - 60_000).toISOString();
    await db.insert(setting).values({ key: TAKE_IN_KEY, value: { after } });
    // No shape at all: the read keeps nobody's contact details, so it marks nothing.
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await takeIn()).toEqual({ after });
    // A shape naming a Parent type QuickBooks doesn't have: that type's rows keep nothing either.
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "GONE" }, staffOp);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await takeIn()).toEqual({ after });
    // A shape that holds: the read marks it.
    await saveShape(FZN_SHAPE, staffOp);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const read = (await lastRun()).startedAt.toISOString();
    expect(await takeIn()).toEqual({ after, addressesReadAt: read, addressesSince: read });
    // A shape save, before any read under it: the mark goes in the save's own transaction.
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, staffOp);
    expect(await takeIn()).toEqual({ after });
  });

  it("stores a customer QuickBooks sends twice once, and counts what it stored", async () => {
    stub.customers = [...stub.customers, { ...stub.customers[0]!, DisplayName: "Rivera Family again" }];
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 9, types: 5 });
    expect(Object.keys(await customers())).toHaveLength(9);
    expect(await lastRun()).toMatchObject({ outcome: "ok", detail: "9 customers, 5 customer types" });
    expect((await audits("roster.refresh"))[0]).toMatchObject({ after: { customers: 9, types: 5 } });
  });

  it("refuses to save a shape the stored form wouldn't read back", async () => {
    await expect(saveShape({ kind: "flat", memberTypeIds: [] }, staffOp)).rejects.toThrow();
    expect(await getShape()).toBeNull();
    expect(await audits("settings.membership.save")).toHaveLength(0);
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
    const client = await import("@/lib/quickbooks/client");
    const spy = vi.spyOn(client, "qboCustomerTypes").mockRejectedValueOnce(new TypeError("Cannot read properties of null"));
    const r = await refreshRoster(worker);
    spy.mockRestore();
    await expectFailedRun(r, "The roster couldn't be read. (unexpected)", "unexpected");
  });

  // An answer with no customers in it would be saved as an empty roster, and every family would then be shown no
  // invoices. So only a well-formed query answer counts, for the customers and for the types alike.
  const FAULT = { Fault: { Error: [{ Message: "a message the portal must never store", code: "4000" }], type: "ValidationFault" } };
  const NOT_AN_ANSWER: [string, unknown][] = [
    ["null", null],
    ["a string", "QueryResponse"],
    ["a list", [{ QueryResponse: {} }]],
    ["an empty object", {}],
    ["a QueryResponse that is null", { QueryResponse: null }],
    ["a QueryResponse that is a list", { QueryResponse: [] }],
    ["rows that are one object", { QueryResponse: { Customer: { Id: "10" }, CustomerType: { Id: "1" } } }],
    ["rows that are a number", { QueryResponse: { Customer: 0, CustomerType: 0 } }],
    ["rows of another entity", { QueryResponse: { Invoice: [{ Id: "1" }] } }],
  ];
  const UNREADABLE = "QuickBooks sent an answer the portal couldn't read. (bad_answer)";

  it.each(NOT_AN_ANSWER)("a 200 for the customers that is %s fails the refresh and keeps the old cache", async (_what, body) => {
    await refreshRoster(worker);
    stub.oddRosterAnswer = { customers: body };
    await expectFailedRun(await refreshRoster(worker), UNREADABLE, "bad_answer");
  });

  it.each(NOT_AN_ANSWER)("a 200 for the customer types that is %s fails the refresh and keeps the old cache", async (_what, body) => {
    await refreshRoster(worker);
    stub.oddRosterAnswer = { types: body };
    await expectFailedRun(await refreshRoster(worker), UNREADABLE, "bad_answer");
    expect((await db.select().from(qboCustomerType)).map((t) => t.name).sort()).toEqual(["Family", "Parent", "School", "Student", "Vendor"]);
  });

  it("a Fault sent with status 200 fails the refresh, and none of its text is kept", async () => {
    await refreshRoster(worker);
    stub.oddRosterAnswer = { customers: FAULT };
    await expectFailedRun(await refreshRoster(worker), "QuickBooks refused the request. (fault)", "fault");
    stub.oddRosterAnswer = { types: FAULT };
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed", error: "QuickBooks refused the request. (fault)" });
    expect(JSON.stringify([await db.select().from(auditLog), await db.select().from(jobRun)])).not.toContain("a message the portal must never store");
  });

  it("a second page that isn't a query answer fails the whole read, and is never a short last page", { timeout: 30_000 }, async () => {
    await refreshRoster(worker);
    const all = Array.from({ length: 1000 }, (_, i) => ({ Id: String(1000 + i), DisplayName: `New ${i}`, Active: true, SyncToken: "0" }));
    const realFetch = globalThis.fetch;
    // The first page is full and well formed; the page after it is an empty object.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      if (/from Customer .*startposition 1001 /.test(query)) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      return realFetch(input, init);
    });
    stub.customers = all;
    const r = await refreshRoster(worker);
    spy.mockRestore();
    await expectFailedRun(r, UNREADABLE, "bad_answer");
  });

  const NO_CUSTOMERS = "QuickBooks sent a roster with no customers in it, so the roster was left as it was. (no_customers)";

  it.each([
    ["an empty QueryResponse", { QueryResponse: {}, time: "2026-11-15T10:00:00.000-08:00" }],
    ["an empty list of customers", { QueryResponse: { Customer: [], startPosition: 1, maxResults: 0 } }],
    ["customers that are no rows at all", { QueryResponse: { Customer: [null, "not a customer", { DisplayName: "No Id" }] } }],
  ])("won't replace a cache that holds customers with %s", async (_what, body) => {
    await refreshRoster(worker);
    stub.oddRosterAnswer = { customers: body };
    await expectFailedRun(await refreshRoster(worker), NO_CUSTOMERS, "no_customers");
    expect(await db.select().from(qboCustomerType)).toHaveLength(5); // the types are left as they were too
  });

  it("takes a well-formed answer with no customers for a company that has none yet", async () => {
    stub.customers = [];
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 0, types: 5 });
    expect(await lastRun()).toMatchObject({ outcome: "ok", detail: "0 customers, 5 customer types" });
    // And again: an empty cache is replaced by an empty answer.
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 0, types: 5 });
  });

  it("takes a well-formed answer with no customer types", async () => {
    stub.oddRosterAnswer = { types: { QueryResponse: {}, time: "2026-11-15T10:00:00.000-08:00" } };
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 9, types: 0 });
  });

  it("skips rows QuickBooks sends that aren't objects, and keeps the real ones", async () => {
    stub.customers = [null, ...stub.customers.slice(0, 3), "not a customer", 42, [], ...stub.customers.slice(3)] as unknown as Record<string, unknown>[];
    stub.types = [...stub.types, null, "not a type"] as unknown as Record<string, unknown>[];
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 9, types: 5 });
    expect(Object.keys(await customers()).sort()).toEqual(OLD_IDS);
  });

  it("anything unexpected between the read and the save is a recorded failure that keeps the old cache", async () => {
    await refreshRoster(worker);
    stub.customers = [{ Id: "900", DisplayName: "New Customer", Active: true, SyncToken: "0" }];
    const shapeModule = await import("@/lib/roster/shape");
    const spy = vi.spyOn(shapeModule, "getShape").mockRejectedValueOnce(new TypeError("Cannot read properties of null"));
    const r = await refreshRoster(worker);
    spy.mockRestore();
    await expectFailedRun(r, "The roster couldn't be read. (unexpected)", "unexpected");
  });

  it("drops contact details at once when the shape changes, even if the refresh after it fails", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    expect((await customers())["11"]).toMatchObject({ email: "ana@example.com", phone: "555-0101" });
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, staffOp); // no refresh has run since
    expect(stub.apiCalls()).toHaveLength(2);
    expect((await customers())["11"]).toMatchObject({ email: null, phone: null });
  });

  it("a shape save waits for a running refresh", async () => {
    let save: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      save = saveShape(FZN_SHAPE, staffOp);
      await untilALockIsAwaited();
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
    expect(stub.calls).toHaveLength(0); // the refused run asked QuickBooks nothing
    expect(await db.select().from(jobRun)).toHaveLength(0); // and left no run for the worker's retry rule to count
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
