import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { PRESS_MAX } from "@/lib/bulk";
import { loadAccountingLinks, type LinksView } from "@/lib/accounting/mapping";
import { LINK_COPY } from "@/lib/accounting/link-writes";
import { NO_FAMILY_COPY } from "@/lib/roster/no-family";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily } from "@/lib/roster/writes";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { familiesFromCustomersAction, linkSuggestedManyAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, connectRoster, REALM, staffWith, WORKER } from "../helpers/roster-writes";

/**
 * The accounting links screen's bulk presses on a selection (src/lib/bulk.ts): Link to their suggested families, on the
 * Families list's Suggested rows, and Create families, on the customers with no family. Each takes ids from the browser,
 * checks them for type, count and format, then does each row by the single press's own function (Confirm's
 * linkFamilyToCustomer(), "Create a family from this"'s familyFromCustomer()), in its own transaction with that press's
 * own audit row, and answers row by row: done, or skipped with the single press's words. The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3; the Rivera (10) and Chen (20) families have their records.
 */
vi.setConfig({ testTimeout: 60_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
async function unlinkedFamily(name: string): Promise<AppFamilyId> {
  const op = asOp(await staffWith(`${randomUUID().slice(0, 8)}@club.org`, ["Roster.Read", "Roster.Family.ReadWrite"]));
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  return (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
}
async function guardianIn(familyId: AppFamilyId, name: string, email: string) {
  const p = await seedParent({ name, email });
  await db.insert(guardian).values({ parentId: p.id, familyId, status: "invited" });
}
const familyLinkOf = async (id: AppFamilyId) => (await db.select().from(accountingLink).where(eq(accountingLink.familyId, id)))[0];
const familyLinksOfCustomer = (customerId: string) => db.select().from(accountingLink)
  .where(and(eq(accountingLink.realmId, REALM), eq(accountingLink.customerId, customerId), isNotNull(accountingLink.familyId)));
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((a) => a.action === action);
/** A Suggested row's ask, as the Families list's selection sends it: the family, its suggested customer and the row's stamp. */
const askOf = (view: LinksView, id: AppFamilyId) => {
  const row = view.rows.find((r) => r.familyId === id)!;
  return { familyId: String(id), customerId: row.confirm!.customerId, stamp: row.confirm!.stamp };
};
const AGAIN = " The row is shown again as it is now.";

/** The Patels (Suggested Patel Family, 70), the Okafors (Suggested Okafor Family, 80) and the Quiets (No match). */
async function seedFamilies() {
  await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("71", "Asha Patel", "3", under("70")),
    qc("80", "Okafor Family", "1", mail("ike@example.com")), qc("90", "Quiet Family", "1"), qc("95", "Nguyen Family", "1"), qc("96", "Bao Nguyen", "3", under("95")));
  const patels = await unlinkedFamily("The Patels");
  await guardianIn(patels, "Asha Patel", "asha@example.com");
  const okafors = await unlinkedFamily("The Okafors");
  await guardianIn(okafors, "Ike Okafor", "ike@example.com");
  const quiets = await unlinkedFamily("The Quiets");
  return { patels, okafors, quiets };
}

beforeEach(async () => {
  await resetDb(); stub.reset();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite", "Roster.Family.ReadWrite"]);
  tag = await connectRoster(stub);
  asStaff(linker);
});

describe("Link to their suggested families", () => {
  it("links each valid row by Confirm's own write, and skips the rest with Confirm's words, row by row", async () => {
    const { patels, okafors, quiets } = await seedFamilies();
    const view = await loadAccountingLinks();
    const rivera = view.rows.find((r) => r.name === "Rivera Family")!.familyId;
    const gone = randomUUID();
    const r = await linkSuggestedManyAction(tag, [
      askOf(view, patels),
      { ...askOf(view, okafors), stamp: "x".repeat(22) }, // its row as some other page drew it
      { familyId: String(rivera), customerId: "10", stamp: "x".repeat(22) }, // linked already
      { familyId: gone, customerId: "70", stamp: "x".repeat(22) }, // no such family
      { familyId: String(quiets), customerId: "80", stamp: askOf(view, okafors).stamp }, // another row's customer and stamp
    ]);
    expect(r).toEqual({ ok: true, message: "1 linked, 4 skipped.", left: [], rows: [
      { id: String(patels), outcome: "done" },
      { id: String(okafors), outcome: "skipped", why: LINK_COPY.rowChanged.replace(AGAIN, "").replace(" Look it over, then press again.", "") },
      { id: String(rivera), outcome: "skipped", why: LINK_COPY.linkedAlready.replace(AGAIN, "") },
      { id: gone, outcome: "skipped", why: LINK_COPY.familyGone.replace(AGAIN, "") },
      { id: String(quiets), outcome: "skipped", why: LINK_COPY.rowChanged.replace(AGAIN, "").replace(" Look it over, then press again.", "") },
    ] });
    expect(revalidatedPaths()).toContain("/");
    expect(await familyLinkOf(patels)).toMatchObject({ customerId: "70", origin: "confirmed", linkedBy: linker.id });
    // Nothing else changed: the Okafors and the Quiets are as they were, and Okafor Family is linked to nobody.
    expect(await familyLinkOf(okafors)).toBeUndefined();
    expect(await familyLinkOf(quiets)).toBeUndefined();
    expect(await familyLinksOfCustomer("80")).toEqual([]);
    // One audit row per family linked, exactly as its own Confirm writes it.
    const confirms = await audits("accounting.link.confirm");
    expect(confirms.map((a) => [a.targetId, (a.after as { chosen: string }).chosen, a.permission])).toEqual([[String(patels), "suggested", "Accounting.Link.ReadWrite"]]);
  });

  it("links only the rows sent: an unticked Suggested row stays unlinked; two linked give two audit rows", async () => {
    const { patels, okafors } = await seedFamilies();
    let view = await loadAccountingLinks();
    expect(await linkSuggestedManyAction(tag, [askOf(view, patels)])).toMatchObject({ ok: true, message: "1 linked." });
    expect(await familyLinkOf(okafors)).toBeUndefined();
    view = await loadAccountingLinks();
    expect(view.rows.find((r) => r.familyId === okafors)!.status.key).toBe("suggested");
    expect(await linkSuggestedManyAction(tag, [askOf(view, okafors), askOf(view, okafors)])).toMatchObject({ ok: true, message: "1 linked.", rows: [{ outcome: "done" }] });
    expect((await audits("accounting.link.confirm")).map((a) => a.targetId)).toEqual([String(patels), String(okafors)]);
  });

  it("refuses what a page doesn't send, whole, and skips the rest untried once the roster is another company's", async () => {
    const { patels, okafors } = await seedFamilies();
    const view = await loadAccountingLinks();
    const notFromPage = { ok: false, errors: [LINK_COPY.notFromPage] };
    for (const asks of [[], "x", [{ ...askOf(view, patels), familyId: "not-a-uuid" }], [{ ...askOf(view, patels), customerId: "E2E-70" }],
      [{ ...askOf(view, patels), stamp: "x".repeat(65) }], [null], Array.from({ length: 2001 }, () => askOf(view, patels))]) {
      expect(await linkSuggestedManyAction(tag, asks as never), JSON.stringify(asks).slice(0, 80)).toEqual(notFromPage);
    }
    expect(await linkSuggestedManyAction("t".repeat(65), [askOf(view, patels)])).toEqual(notFromPage);
    const moved = await linkSuggestedManyAction("another-company", [askOf(view, patels), askOf(view, okafors)]);
    expect(moved).toMatchObject({ ok: true, message: "0 linked, 2 skipped.", rows: [{ outcome: "skipped", why: ROSTER_MOVED }, { outcome: "skipped", why: ROSTER_MOVED }] });
    expect(await audits("accounting.link.confirm")).toEqual([]);
  });

  it("tries at most PRESS_MAX rows in a press and hands the rest back for the next", async () => {
    await seedFamilies();
    const asks = Array.from({ length: PRESS_MAX + 1 }, () => ({ familyId: randomUUID(), customerId: "70", stamp: "x".repeat(22) }));
    const r = await linkSuggestedManyAction(tag, asks);
    if (!r.ok) throw new Error("refused");
    expect(r.rows).toHaveLength(PRESS_MAX);
    expect(r.rows.every((x) => x.outcome === "skipped")).toBe(true);
    expect(r.left).toEqual([asks[PRESS_MAX]!.familyId]);
    expect(r.message).toBe(`0 linked, ${PRESS_MAX} skipped. 1 more is still selected: up to ${PRESS_MAX} are done at a time.`);
  });

  it("is Confirm's permissions: the linking permission with Roster.Read, either alone refused as the guard refuses", async () => {
    const { patels } = await seedFamilies();
    const view = await loadAccountingLinks();
    for (const who of [await staffWith("read@club.org", ["Roster.Read"]), await staffWith("link@club.org", ["Accounting.Link.ReadWrite"])]) {
      asStaff(who);
      await expect(linkSuggestedManyAction(tag, [askOf(view, patels)])).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(await familyLinkOf(patels)).toBeUndefined();
  });

  it("draws a box on each Suggested row only, named by its family", async () => {
    await seedFamilies();
    const html = await renderPage(AccountingLinksPage);
    expect(html).toContain("Select The Patels");
    expect(html).toContain("Select The Okafors");
    expect(html).not.toContain("Select The Quiets");
    expect(html).not.toContain("Select Rivera Family");
    expect(html).toContain("Link 0 to their suggested families");
  });
});

describe("Create families", () => {
  it("makes a family of each customer offered by the single press's own function, and skips the rest with its words", async () => {
    await seedFamilies();
    const r = await familiesFromCustomersAction(["95", "90", "70", "10", "71", "999"]);
    // 70 is suggested for the Patels; 10 has the Rivera family; 71 is a student; 999 isn't in the books.
    expect(r).toMatchObject({ ok: true, message: "2 families made, 4 skipped.", left: [], rows: [
      { id: "95", outcome: "done" }, { id: "90", outcome: "done" },
      { id: "70", outcome: "skipped", why: NO_FAMILY_COPY.suggestedFor(["The Patels"]) },
      { id: "10", outcome: "skipped", why: NO_FAMILY_COPY.already },
      { id: "71", outcome: "skipped", why: NO_FAMILY_COPY.notOffered },
      { id: "999", outcome: "skipped", why: NO_FAMILY_COPY.notOffered },
    ] });
    expect(revalidatedPaths()).toContain("/");
    expect(await familyLinksOfCustomer("95")).toHaveLength(1);
    expect(await familyLinksOfCustomer("90")).toHaveLength(1);
    expect(await familyLinksOfCustomer("70")).toEqual([]);
    // One audit row per family made, exactly as its own press writes it.
    const made = await audits("accounting.family.from_customer");
    expect(made.map((a) => (a.after as { customerQboId: string }).customerQboId)).toEqual(["95", "90"]);
    expect(made.every((a) => a.permission === "Accounting.Link.ReadWrite" && a.targetType === "family")).toBe(true);
    // A second press makes none again.
    expect(await familiesFromCustomersAction(["95"])).toMatchObject({ message: "0 families made, 1 skipped.", rows: [{ outcome: "skipped", why: NO_FAMILY_COPY.already }] });
  });

  it("refuses what a page doesn't send, whole, making nothing", async () => {
    await seedFamilies();
    const notFromPage = { ok: false, errors: [NO_FAMILY_COPY.notFromPage] };
    for (const ids of [[], "95", ["95", "E2E-90"], ["9".repeat(20)], [95], Array.from({ length: 2001 }, (_, i) => String(i + 1))]) {
      expect(await familiesFromCustomersAction(ids as never), JSON.stringify(ids).slice(0, 40)).toEqual(notFromPage);
    }
    expect(await audits("accounting.family.from_customer")).toEqual([]);
  });

  it("tries at most PRESS_MAX customers in a press and hands the rest back", async () => {
    await seedFamilies();
    const ids = Array.from({ length: PRESS_MAX + 1 }, (_, i) => String(5000 + i));
    const r = await familiesFromCustomersAction(ids);
    if (!r.ok) throw new Error("refused");
    expect(r.rows).toHaveLength(PRESS_MAX);
    expect(r.left).toEqual([ids[PRESS_MAX]]);
  });

  it("is the single press's permissions: without the linking permission refused as the guard refuses, without Roster.Read not from the page", async () => {
    await seedFamilies();
    asStaff(await staffWith("read@club.org", ["Roster.Read"]));
    await expect(familiesFromCustomersAction(["95"])).rejects.toBeInstanceOf(AccessDenied);
    asStaff(await staffWith("link@club.org", ["Accounting.Link.ReadWrite"]));
    expect(await familiesFromCustomersAction(["95"])).toEqual({ ok: false, errors: [NO_FAMILY_COPY.notFromPage] });
    expect(await familyLinksOfCustomer("95")).toEqual([]);
  });

  it("draws a box on each customer it can make a family of, none on one meant for a family the portal has", async () => {
    await seedFamilies();
    const html = await renderPage(AccountingLinksPage);
    expect(html).toContain("Select Nguyen Family");
    expect(html).toContain("Select Quiet Family");
    expect(html).not.toContain("Select Patel Family");
    expect(html).toContain("Create 0 families");
  });
});
