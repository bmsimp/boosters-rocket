import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});


import { db } from "@/lib/db/client";
import { qboCustomerType } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { loadRosterPage, previewShape, rosterEntry, entryFrom } from "@/lib/roster/queries";
import { resetDb, seedParent, seedGuardian } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: null };

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
    const page = await loadRosterPage();
    expect(page.shapeWords).toBe("Layered: families are Family, students are Student, parents are Parent.");
    if (page.roster?.kind !== "layered") throw new Error("expected layered");
    expect(page.roster.families.map((f) => f.customer.displayName)).toEqual(["Chen Family", "Old Family", "Rivera Family"]);
    expect(page.roster.outside).toBe(2);
    expect(page.attention.map((a) => `${a.rule}:${a.qboId ?? a.name}`).sort()).toEqual([
      "family_no_signin:20", "family_no_student:20", "no_email:21", "not_under_family:50", "signin_unknown:Ana Rivera",
    ]);
    expect(page.signIns.map((s) => [s.familyQboId, s.status]).sort()).toEqual([["10", "invited"], ["POC-FAMILY-1", "active"]]);
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

  it("finds one family with its sign-ins, and nothing for a customer outside the shape", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    const entry = await rosterEntry("10");
    if (entry?.kind !== "family") throw new Error("expected a family");
    expect(entry.family.parents.map((p) => [p.displayName, p.email, p.phone])).toEqual([["Ana Rivera", "ana@example.com", "555-0101"]]);
    expect(entry.signIns.map((s) => s.email)).toEqual(["ana@example.com"]);
    expect(await rosterEntry("30")).toBeNull(); // Lincoln High: a School
    expect(await rosterEntry("11")).toBeNull(); // a parent is not a page of its own
    expect(await rosterEntry("nope")).toBeNull();
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
    const emails = async (id: string) => {
      const e = await rosterEntry(id);
      if (e?.kind !== "family") throw new Error("expected a family");
      return e.signIns.map((s) => s.email).sort();
    };
    expect(await emails("10")).toEqual(["ana@example.com", "raul@example.com"]);
    expect(await emails("20")).toEqual(["mei@example.com"]);
  });

  it("flat: a customer outside the member types has no page", async () => {
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    expect(await rosterEntry("12")).toBeNull(); // Leo Rivera: a Student
    expect(await rosterEntry("30")).toBeNull();
  });

  it("flat: finds a member", async () => {
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    expect(await rosterEntry("11")).toMatchObject({ kind: "member", member: { displayName: "Ana Rivera", email: "ana@example.com" } });
  });

  it("entryFrom: finds a family, a member, and nothing else, from a page already loaded", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "invited" });
    const page = await loadRosterPage();
    expect(entryFrom(page, "10")).toMatchObject({ kind: "family", family: { customer: { displayName: "Rivera Family" } }, signIns: [{ email: "ana@example.com" }] });
    for (const id of ["11", "30", "nope"]) expect(entryFrom(page, id)).toBeNull();
    expect(entryFrom({ ...page, roster: null }, "10")).toBeNull();
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    const flat = await loadRosterPage();
    expect(entryFrom(flat, "11")).toMatchObject({ kind: "member", member: { displayName: "Ana Rivera" }, signIns: [] });
    expect(entryFrom(flat, "10")).toBeNull();
  });
});
