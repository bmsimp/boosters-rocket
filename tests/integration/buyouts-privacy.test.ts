import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent } from "../helpers/signed-in";

// Nothing here may reach QuickBooks: the stub stands in for it, so a request that got through would be seen.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, buyout, family, writeQueue } from "@/lib/db/schema";
import { loadMyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { BUYOUT_COPY } from "@/lib/buyouts/writes";
import { loadMyBuyouts } from "@/lib/buyouts/my-buyouts";
import { buyoutFacts } from "@/lib/buyouts/standing";
import { pairKey } from "@/lib/seasons/kinds";
import { confirmBuyoutAction, switchBackAction } from "@/app/(parent)/volunteer/pay-instead/actions";
import { resetDb } from "../helpers/db";
import { FAMILY_A, FAMILY_B, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { connectCompany } from "../helpers/money";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedBuyoutRequirement } from "../helpers/buyouts";
import { recordOfCustomer } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const viewOf = (p: SeededParent) => loadMyBuyouts({ familyId: p.identity.familyId, parentId: p.identity.parentId });
const everything = async () => ({ buyouts: await db.select().from(buyout).orderBy(buyout.id), queue: await db.select().from(writeQueue), audits: (await db.select().from(auditLog)).length });

/**
 * The buy-out actions take a requirement id, a choice key and a quote's stamp from the browser (AGENTS.md: a server
 * action gets its own test as family A with family B's ids in every field). Nothing of family B is shown, nothing is
 * sent to QuickBooks, and nothing changes.
 */
describe("family A can't reach family B's buy-outs", () => {
  it("refuses B's requirement, a key and a stamp from B's page, a stale quote and a used one, and changes nothing", async () => {
    const { a, b } = await seedTwoFamilies();
    await connectCompany(stub);
    // One more requirement offered to every family, so B's page has a live quote and a stamp to take.
    const shared = await seedBuyoutRequirement({ title: "Banquet setup shifts", amount: 1, unitCents: 4000 });
    const bView = await viewOf(b);
    const bShared = bView.find((x) => x.requirementId === shared)!;
    expect(bShared.stamp).toBeTruthy();
    const aView = await viewOf(a);
    const before = await everything();
    asParent(a.identity);

    const refusals = [
      // B's own requirement, with B's key: not asked of A at all.
      await confirmBuyoutAction(b.buyout!.requirementId, b.buyout!.key, bShared.stamp),
      await switchBackAction(b.buyout!.requirementId, b.buyout!.key),
      // A requirement both families have, with the stamp B's page was given: the quote is A's to work out.
      await confirmBuyoutAction(shared, "family", bShared.stamp),
      // A's own requirement with a stale quote, and with a used one (A's buy-out is invoiced already).
      await confirmBuyoutAction(shared, "family", "stale-stamp-00000000"),
      await confirmBuyoutAction(a.buyout!.requirementId, "family", "used-stamp-0000000000"),
      // Keys that aren't A's: B's QuickBooks ids, a student key A doesn't have.
      await confirmBuyoutAction(shared, FAMILY_B.family.qboId, bShared.stamp),
      await confirmBuyoutAction(shared, "s9", bShared.stamp),
      await switchBackAction(shared, FAMILY_B.students[0]!.qboId),
    ];
    for (const r of refusals) expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(refusals[0]).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(refusals[1]).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(refusals[2]).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$40.00")] });
    expect(refusals[4]).toEqual({ ok: false, errors: [BUYOUT_COPY.already] });
    const said = JSON.stringify(refusals);
    for (const m of b.markers) expect(said, m).not.toContain(m);

    const after = await everything();
    expect(after.buyouts).toEqual(before.buyouts);
    expect(after.queue).toEqual([]);
    expect(after.audits).toBe(before.audits);
    expect(stub.apiCalls()).toEqual([]);
    // A's own list holds nothing of B's.
    const shownToA = JSON.stringify(aView);
    for (const m of b.markers) expect(shownToA, m).not.toContain(m);
  });

  it("shows and does nothing for a family whose own record is inactive, asking QuickBooks nothing and changing nothing", async () => {
    const { a } = await seedTwoFamilies();
    await connectCompany(stub);
    const familyA = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    expect((await viewOf(a)).map((x) => x.requirementId)).toContain(a.buyout!.requirementId);
    expect([...(await loadMyBuyoutInvoices(familyA)).keys()]).toEqual(["9174"]);
    // Made inactive some way the reconcile doesn't follow (a type changed in QuickBooks, say): the session still names its customer.
    await db.update(family).set({ active: false }).where(eq(family.id, familyA));
    const before = await everything();
    expect(await viewOf(a)).toEqual([]);
    expect(await loadMyBuyoutInvoices(familyA)).toEqual(new Map());
    asParent(a.identity);
    expect(await confirmBuyoutAction(a.buyout!.requirementId, a.buyout!.key, "any-stamp-0000000000")).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(await switchBackAction(a.buyout!.requirementId, a.buyout!.key)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    const after = await everything();
    expect(after.buyouts).toEqual(before.buyouts);
    expect(after.queue).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("reads a family's standing from its own buy-outs alone", async () => {
    const { a, b } = await seedTwoFamilies();
    // Asked by family A's own records, as its pages ask: B's buy-out is never in the answer.
    const familyA = await recordOfCustomer(FAMILY_A.family.qboId, "family");
    const asked = { families: [familyA], students: await Promise.all(FAMILY_A.students.map((s) => recordOfCustomer(s.qboId, "student"))) };
    const facts = await buyoutFacts([a.buyout!.requirementId, b.buyout!.requirementId], asked, pairKey);
    expect([...facts.keys()]).toEqual([pairKey(a.buyout!.requirementId, familyA)]);
    expect(facts.get(pairKey(a.buyout!.requirementId, familyA))).toEqual({ state: "invoiced", invoicePaid: false });
  });
});
