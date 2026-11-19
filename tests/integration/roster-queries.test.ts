import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});


import { db } from "@/lib/db/client";
import { family, qboCustomerType, student } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { loadRosterPage, previewShape, rosterEntry, familyEntry, rosterFamilies } from "@/lib/roster/queries";
import { resetDb, seedParent, seedGuardian } from "../helpers/db";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { asAppFamilyId } from "@/lib/families/ids";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: null };
/** A family's page is addressed by its app family record: the roster entry of the customer this one's family record is linked to. */
const entryOf = async (customer: string) => rosterEntry(await recordOfCustomer(customer, "family"));

describe("what the roster pages load", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    Object.assign(stub, fznCompany());
    await seedConnected(stub);
  });

  it("before a shape is chosen: connected, no roster", async () => {
    await refreshRoster(worker);
    expect(await loadRosterPage()).toMatchObject({ connected: true, shape: null, shapeWords: null, roster: null, attention: [], brokenTypes: [] });
  });

  it("with the FZN shape: families, the clean-up list, the sign-ins and the last refresh", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "invited" });
    await seedGuardian({ parentId: ana.id, familyQboId: "POC-FAMILY-1" });
    await syncAppRecords(); // the records imported from the read, each membership in its family record
    const page = await loadRosterPage();
    expect(page.shapeWords).toBe("Layered: families are Family, students are Student, parents are Parent.");
    if (page.roster?.kind !== "layered") throw new Error("expected layered");
    expect(page.roster.families.map((f) => f.customer.displayName)).toEqual(["Chen Family", "Old Family", "Rivera Family"]);
    expect(page.roster.outside).toBe(2);
    expect(page.attention.map((a) => `${a.rule}:${a.qboId ?? a.name}`).sort()).toEqual([
      "family_no_student:20", "no_email:21", "not_under_family:50", "signin_unknown:Ana Rivera",
    ]);
    // Each sign-in by its membership's family record, with the customer that record is linked to.
    expect(page.signIns.map((s) => [s.customerQboId, s.status]).sort()).toEqual([["10", "invited"], ["POC-FAMILY-1", "active"]]);
    expect(page.signIns.find((s) => s.customerQboId === "10")!.familyId).toBe(await recordOfCustomer("10", "family"));
    expect(page.lastRun).toMatchObject({ ok: true, detail: "9 customers, 5 customer types" });
    expect(page.lastOkAt).not.toBeNull();
  });

  it("a shape naming a missing type is broken: no roster, and it says which type", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2"));
    const page = await loadRosterPage();
    expect(page.brokenTypes).toEqual(["2"]);
    expect(page.roster).toBeNull();
    expect(page.attention).toEqual([]);
  });

  it("after a failed refresh: the last run shows the failure, the last good time and the old roster stay", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const before = await loadRosterPage();
    stub.failQueryFrom = 3; // queries 1 and 2 were the good refresh
    expect(await refreshRoster(worker)).toMatchObject({ ok: false, reason: "failed" });
    const page = await loadRosterPage();
    expect(page.lastRun).toMatchObject({ ok: false, detail: "QuickBooks refused the request. (http_500)" });
    expect(page.lastOkAt).not.toBeNull();
    expect(page.lastOkAt).toBe(before.lastOkAt);
    expect(page.roster).toEqual(before.roster);
    expect(page.roster).not.toBeNull();
  });

  it("a refresh that returns no customer types leaves every named type missing", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    stub.types = [];
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    const page = await loadRosterPage();
    expect([...page.brokenTypes].sort()).toEqual(["1", "2", "3"]);
    expect(page.roster).toBeNull();
  });

  it("a shape before any successful refresh is not called broken", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    const page = await loadRosterPage();
    expect(page.brokenTypes).toEqual([]);
  });

  it("previews a shape with counts and the first names in each role", async () => {
    await refreshRoster(worker);
    expect(await previewShape(FZN_SHAPE)).toEqual({ families: 3, students: 1, parents: 2, members: 0, outside: 2,
      samples: { families: ["Chen Family", "Old Family", "Rivera Family"], students: ["Leo Rivera"], parents: ["Mei Chen", "Ana Rivera"], members: [] } });
    expect(await previewShape({ kind: "flat", memberTypeIds: ["3"] })).toMatchObject({ members: 2, outside: 7, samples: { members: ["Leo Rivera", "Stray Student"] } });
  });

  it("finds one family by its app record, with its sign-ins, and nothing for a record whose customer is outside the shape", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    await syncAppRecords(); // the records imported from the read, each membership in its family record
    const entry = await entryOf("10");
    if (entry?.kind !== "family") throw new Error("expected a family");
    expect(entry.family.parents.map((p) => [p.displayName, p.email, p.phone])).toEqual([["Ana Rivera", "ana@example.com", "555-0101"]]);
    expect(entry.signIns.map((s) => s.email)).toEqual(["ana@example.com"]);
    // A family record (made inactive, as 0023 made one) whose customer isn't a family of the roster has no entry.
    expect(await entryOf("30")).toBeNull(); // Lincoln High: a School
    expect(await entryOf("11")).toBeNull(); // a parent is not a page of its own
    expect(await rosterEntry(asAppFamilyId(crypto.randomUUID()))).toBeNull(); // no such record: no link, no entry
  });

  it("a family's page lists only its own sign-ins", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    const raul = await seedParent({ name: "Raul Rivera", email: "raul@example.com" });
    const mei = await seedParent({ name: "Mei Chen", email: "mei@example.com" });
    const lost = await seedParent({ name: "Lost Person", email: "lost@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    await seedGuardian({ parentId: raul.id, familyQboId: "10" });
    await seedGuardian({ parentId: mei.id, familyQboId: "20" });
    await seedGuardian({ parentId: lost.id, familyQboId: "POC-FAMILY-1" });
    await syncAppRecords(); // the records imported from the read, each membership in its family record
    const emails = async (id: string) => {
      const e = await entryOf(id);
      if (e?.kind !== "family") throw new Error("expected a family");
      return e.signIns.map((s) => s.email).sort();
    };
    expect(await emails("10")).toEqual(["ana@example.com", "raul@example.com"]);
    expect(await emails("20")).toEqual(["mei@example.com"]);
  });

  it("flat: a customer outside the member types has no page", async () => {
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    await syncAppRecords(); // the records imported from the read, as 0023 made them: a read makes none
    expect(await entryOf("12")).toBeNull(); // Leo Rivera: a Student
    expect(await entryOf("30")).toBeNull();
  });

  it("flat: finds a member", async () => {
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    await syncAppRecords();
    expect(await entryOf("11")).toMatchObject({ kind: "member", family: { name: "Ana Rivera", active: true, customer: { displayName: "Ana Rivera", email: "ana@example.com" }, students: [], parents: [] } });
  });

  it("familyEntry: finds a family, a member, and nothing else, from a page already loaded", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "invited" });
    await syncAppRecords(); // the records imported from the read, each membership in its family record
    const page = await loadRosterPage();
    const rivera = await recordOfCustomer("10", "family");
    expect(await familyEntry(page, rivera)).toMatchObject({ kind: "family", family: { name: "Rivera Family", customer: { displayName: "Rivera Family" } }, signIns: [{ email: "ana@example.com" }] });
    for (const id of ["11", "30"]) expect(await familyEntry(page, await recordOfCustomer(id, "family"))).toBeNull();
    expect(await familyEntry({ ...page, roster: null }, rivera)).toBeNull();
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    const flat = await loadRosterPage();
    expect(await familyEntry(flat, await recordOfCustomer("11", "family"))).toMatchObject({ kind: "member", family: { customer: { displayName: "Ana Rivera" } }, signIns: [] });
    // A shape changed later changes no record (stage 3's slice 9c): the Rivera family's record stays active, and its page
    // shows it with no customer, since the flat roster lists none of its as a member.
    expect(await familyEntry(flat, rivera)).toMatchObject({ kind: "member", family: { name: "Rivera Family", active: true, customer: null } });
  });

  it("rosterFamilies: the app's family records, each with what QuickBooks holds for its customer, in the roster's order", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    await syncAppRecords();
    const page = await loadRosterPage();
    const shown = async () => (await rosterFamilies(page))!.map((f) => [f.name, f.active, f.customer?.qboId ?? null, f.students.map((s) => [s.name, s.customer?.qboId ?? null]), f.parents.map((p) => p.displayName)]);
    // An inactive family is listed as the roster lists its customer; the school, the stray and the untyped customer are QuickBooks' alone.
    expect(await shown()).toEqual([
      ["Chen Family", true, "20", [], ["Mei Chen"]],
      ["Old Family", false, "40", [], []],
      ["Rivera Family", true, "10", [["Leo Rivera", "12"]], ["Ana Rivera"]],
    ]);
    if (page.roster?.kind !== "layered") throw new Error("expected layered");
    expect((await rosterFamilies(page))!.map((f) => f.customer!.qboId)).toEqual(page.roster.families.map((f) => f.customer.qboId));
    // A record a roster row names as a family (made inactive, as 0023 made one) whose customer isn't a family isn't listed.
    await recordOfCustomer("30", "family");
    expect(await shown()).toHaveLength(3);
    // A family made in the portal with no QuickBooks customer (as staff add one since stage 3's slice 9d) is listed, with no customer.
    const [hand] = await db.insert(family).values({ name: "Handmade Family", active: true }).returning();
    await db.insert(student).values({ name: "Hal Handmade", active: true, familyId: hand!.id });
    expect((await shown())[1]).toEqual(["Handmade Family", true, null, [["Hal Handmade", null]], []]);
    expect(await familyEntry(page, hand!.id)).toMatchObject({ kind: "family", family: { name: "Handmade Family", customer: null }, signIns: [] });
  });
});
