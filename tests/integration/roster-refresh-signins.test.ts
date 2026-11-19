import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parent, parentAuthUser, qboCustomer, student } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
/** Every sign-in the app holds, and every one of the app's own records, as they are. */
const snapshot = async () => ({ customers: await db.select().from(qboCustomer), links: await db.select().from(guardian), people: await db.select().from(parent),
  accounts: await db.select().from(parentAuthUser), families: await db.select().from(family), students: await db.select().from(student),
  accountingLinks: await db.select().from(accountingLink) });
const SIGNIN_ACTIONS = ["parent.create", "parent.access.granted", "parent.access.ended", "parent.access.moved", "parent.email.changed", "parent.name.changed", "parent.hold.opened"];

// Who may sign in is the app's own guardian rows (stage 3 of the app-owned families spec, slice 7a), and since slice 9c
// the app's own families and students stand alone too: a roster read stores the customer list, and makes, opens,
// moves or closes no sign-in and no record.
describe("a roster refresh and the portal's sign-ins", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); await seedConnected(stub); await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null }); });
  it("makes no person and no sign-in from QuickBooks' parents, with sign-ins on", async () => {
    await seedParentSettings(SIGNINS_ON);
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    expect(await db.select().from(parent)).toEqual([]);
    expect(await db.select().from(guardian)).toEqual([]);
    const audit = await db.select().from(auditLog);
    expect(audit.filter((r) => SIGNIN_ACTIONS.includes(r.action))).toEqual([]);
    // Nor any of the app's own records: a read makes none (stage 3's slice 9c).
    expect(await db.select().from(family)).toEqual([]);
    expect(await db.select().from(student)).toEqual([]);
    expect(await db.select().from(accountingLink)).toEqual([]);
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
    // Nothing touches a guardian row: status, family, person and address stay.
    const links = await db.select().from(guardian);
    expect(links.map((l) => ({ ...l, updatedAt: null }))).toEqual(before.links.map((l) => ({ ...l, updatedAt: null })));
    expect(await db.select().from(parent)).toEqual(before.people);
    expect(await db.select().from(parentAuthUser)).toEqual(before.accounts);
    expect((await db.select().from(auditLog)).filter((r) => SIGNIN_ACTIONS.includes(r.action))).toEqual([]);
  }, 30_000);

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
});
