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
import { loadRosterPage, previewShape, rosterEntry } from "@/lib/roster/queries";
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
      "family_no_student:20", "no_email:21", "not_under_family:50", "signin_unknown:Ana Rivera (ana@example.com)",
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

  it("flat: finds a member", async () => {
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    expect(await rosterEntry("11")).toMatchObject({ kind: "member", member: { displayName: "Ana Rivera", email: "ana@example.com" } });
  });
});
