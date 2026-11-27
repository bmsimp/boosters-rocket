import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, qboConnection, setting, student } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { filterLinkRows, loadAccountingLinks, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { LINK_COPY, reviewCarriedOver } from "@/lib/accounting/link-writes";
import { reviewStamp } from "@/lib/accounting/stamp";
import { auditPage, parseAuditFilters } from "@/lib/audit/query";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily } from "@/lib/roster/writes";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { SOURCE_KEY } from "@/lib/roster/source";
import { ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { reviewLinkAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, REALM, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { moveInQuickBooksOnly } from "../helpers/roster-cache";
import { rowNamed } from "../helpers/table";

/**
 * Confirm this link, for a link carried over from the roster (stage 4's slice M3a2 of the app-owned families spec; open
 * question 2, carried-over links "with their own status and filter so an admin can review them"; the lead's choice 7;
 * src/lib/accounting/link-writes.ts, reviewCarriedOver()). The family's link, and its carried-over student links of
 * active records whose customers the books hold directly under the family's customer, become `confirmed` by the staff
 * member at the press's time, aligned with nothing new; the audit row keeps that they were carried over. The company is
 * fznCompany()'s (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3, School 4; the families a test adds to the
 * books are given their records by the import (syncAppRecords()), carried over, as migration 0023 made them.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });
const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const familyLinkOf = async (id: AppFamilyId) => (await db.select().from(accountingLink).where(eq(accountingLink.familyId, id)))[0]!;
const studentLinkOf = async (id: AppStudentId) => (await db.select().from(accountingLink).where(eq(accountingLink.studentId, id)))[0]!;
/** The press as the page binds it, from the row's own offer. */
const pressRow = (familyId: AppFamilyId, row: LinkRow, t = tag) => reviewCarriedOver({ familyId: String(familyId), linkId: row.review!.linkId, stamp: row.review!.stamp }, t, linkOp());
const listOf = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };

beforeEach(async () => {
  await resetDb(); stub.reset();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
  tag = await connectRoster(stub);
});

/** Oak Family (80) with Amy Oak (81) under it, their records carried over by the import, as 0023 made them. */
async function seedOaks() {
  await readAgain(qc("80", "Oak Family", "1", { SyncToken: "7" }), qc("81", "Amy Oak", "3", { ...under("80"), SyncToken: "8" }));
  await syncAppRecords();
  return { oaks: await recordOfCustomer("80", "family"), amy: await recordOfCustomer("81", "student") };
}

describe("Confirm this link", () => {
  it("confirms a carried-over link and its student's, by the staff member at the press's time, aligning nothing; the row reads Linked and leaves Carried over", async () => {
    const { oaks, amy } = await seedOaks();
    const before = { family: await familyLinkOf(oaks), student: await studentLinkOf(amy) };
    expect(before.family).toMatchObject({ origin: "carried_over", linkedBy: null, customerId: "80" });
    const view = await loadAccountingLinks();
    const row = rowOf(view, "Oak Family");
    expect(row.status).toEqual({ key: "carried_over", at: expect.any(String) });
    expect(row.review).toEqual({ linkId: before.family.id, customerId: "80", confirms: [{ linkId: before.student.id, studentId: amy, name: "Amy Oak" }], leaves: [], stamp: expect.any(String) });
    expect(filterLinkRows(view.rows, { status: "carried_over", q: "" }).map((r) => r.name)).toContain("Oak Family");
    const pressedAt = new Date();
    stub.calls.length = 0;
    const r = await pressRow(oaks, row);
    expect(r).toEqual({ ok: true, message: "The link of Oak Family to “Oak Family” in the books is confirmed: it is recorded as checked by you, and no longer as carried over."
      + " Confirmed with it, as its student's link: Amy Oak. Nothing was sent to the books." });
    expect(stub.apiCalls()).toEqual([]);

    const after = { family: await familyLinkOf(oaks), student: await studentLinkOf(amy) };
    for (const [was, now] of [[before.family, after.family], [before.student, after.student]] as const) {
      expect(now).toMatchObject({ id: was.id, customerId: was.customerId, realmId: REALM, origin: "confirmed", linkedBy: linker.id, syncedToken: was.syncedToken, syncedAt: was.syncedAt });
      expect(now.linkedAt.getTime()).toBeGreaterThanOrEqual(pressedAt.getTime() - 1000);
      expect(now.linkedAt.getTime()).toBeGreaterThan(was.linkedAt.getTime() - 1);
    }

    const [audit] = await auditsOf("accounting.link.confirm");
    expect(audit).toMatchObject({ actorId: linker.id, permission: "Accounting.Link.ReadWrite", targetType: "family", targetId: String(oaks) });
    expect(audit!.before).toEqual({ familyId: String(oaks), customerQboId: "80", realmId: REALM,
      link: { id: before.family.id, origin: "carried_over", linkedAt: before.family.linkedAt.toISOString(), linkedBy: null },
      studentLinks: [{ id: before.student.id, origin: "carried_over", linkedAt: before.student.linkedAt.toISOString(), linkedBy: null, studentId: String(amy), customerQboId: "81" }] });
    expect(audit!.after).toEqual({ familyId: String(oaks), customerQboId: "80", realmId: REALM, chosen: "reviewed",
      link: { id: before.family.id, origin: "confirmed", linkedAt: after.family.linkedAt.toISOString(), linkedBy: linker.id },
      studentsLinked: [{ id: before.student.id, origin: "confirmed", linkedAt: after.student.linkedAt.toISOString(), linkedBy: linker.id, studentId: String(amy), customerQboId: "81" }],
      studentLinksLeft: [] });
    // The audit page's record filter finds the review under the family and under the student whose link it confirmed.
    for (const record of [`family:${oaks}`, `student:${amy}`]) {
      expect((await auditPage(parseAuditFilters({ record }))).rows.filter((x) => x.action === "accounting.link.confirm").map((x) => x.id), record).toEqual([audit!.id]);
    }

    const now = await loadAccountingLinks();
    expect(rowOf(now, "Oak Family")).toMatchObject({ status: { key: "linked", origin: "confirmed", by: "linker" }, review: null });
    expect(filterLinkRows(now.rows, { status: "carried_over", q: "" }).map((r) => r.name)).not.toContain("Oak Family");
    expect(filterLinkRows(now.rows, { status: "linked", q: "" }).map((r) => r.name)).toEqual(["Oak Family"]);
    // The page says who confirmed it and when, in words true of a review.
    asStaff(linker);
    const html = listOf(await renderPage(AccountingLinksPage));
    expect(rowNamed(html, "Oak Family")![3]).toMatch(/^LinkedConfirmed .+$/);
    expect(rowNamed(html, "Oak Family")![4]).toMatch(/^Confirmed by linker, on this page or with “Create a family from this”, on .+?\./);
    expect(rowNamed(html, "Oak Family")![4]).not.toContain("Confirm this link");
    // A second press, with the page's old stamp, changes nothing.
    expect(await pressRow(oaks, row)).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    expect(await auditsOf("accounting.link.confirm")).toHaveLength(1);
  });

  it("offers it on a carried-over link with differences, confirming the students whose records and customers agree and leaving the others carried over", async () => {
    await readAgain(qc("70", "Patel Family", "1"), qc("71", "Asha Patel", "3", under("70")), qc("72", "Ravi Patel", "3", under("70")), qc("74", "Sam Patel", "3", under("70")),
      qc("75", "Tara Patel", "3", under("70")), qc("76", "Uma Patel", "3", under("70")));
    await syncAppRecords();
    const patels = await recordOfCustomer("70", "family");
    const asha = await recordOfCustomer("71", "student"), ravi = await recordOfCustomer("72", "student"), sam = await recordOfCustomer("74", "student");
    const tara = await recordOfCustomer("75", "student"), uma = await recordOfCustomer("76", "student");
    // Ravi's record made inactive in the portal; Sam moved under the Riveras in QuickBooks alone (his record stays with
    // the Patels); Tara's customer gone from the books' copy; Uma's retyped to Parent, still under the Patels.
    await db.update(student).set({ active: false }).where(eq(student.id, ravi));
    stub.customers = stub.customers.filter((c) => c.Id !== "75");
    changeInBooks("76", { CustomerTypeRef: { value: "2" } });
    await readAgain();
    await moveInQuickBooksOnly(["74"], "10");
    const row = rowOf(await loadAccountingLinks(), "Patel Family");
    expect(row.status).toEqual({ key: "with_differences", made: { key: "carried_over", at: expect.any(String) } });
    expect(row.review).toMatchObject({ confirms: [{ studentId: asha, name: "Asha Patel" }],
      leaves: [{ studentId: ravi, name: "Ravi Patel", why: "inactive" }, { studentId: sam, name: "Sam Patel", why: "elsewhere" },
        { studentId: tara, name: "Tara Patel", why: "gone" }, { studentId: uma, name: "Uma Patel", why: "elsewhere" }] });
    // The opening says each reason in its own words, never that a gone or retyped customer is under another customer.
    asStaff(linker);
    const opening = rowNamed(listOf(await renderPage(AccountingLinksPage)), "Patel Family")![4]!.replaceAll("&#x27;", "'");
    expect(opening).toContain("Tara Patel (its customer isn't in the books' copy now)");
    expect(opening).toContain("Uma Patel (its customer isn't a student customer directly under this one in the books now)");
    expect(opening).not.toContain("under another customer in the books");
    const r = await pressRow(patels, row);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("Confirmed with it, as its student's link: Asha Patel. Left carried over: Ravi Patel (inactive in the portal), "
      + "Sam Patel (its customer isn't a student customer directly under this one in the books now), Tara Patel (its customer isn't in the books' copy now) "
      + "and Uma Patel (its customer isn't a student customer directly under this one in the books now).") });
    expect(await familyLinkOf(patels)).toMatchObject({ origin: "confirmed", linkedBy: linker.id });
    expect(await studentLinkOf(asha)).toMatchObject({ origin: "confirmed", linkedBy: linker.id });
    for (const left of [ravi, sam, tara, uma]) expect(await studentLinkOf(left)).toMatchObject({ origin: "carried_over", linkedBy: null });
    const [audit] = await auditsOf("accounting.link.confirm");
    expect(audit!.after).toMatchObject({ chosen: "reviewed", studentLinksLeft: await Promise.all([ravi, sam, tara, uma].map(async (id) => (await studentLinkOf(id)).id)) }); 
    expect(rowOf(await loadAccountingLinks(), "Patel Family").status).toEqual({ key: "with_differences", made: { key: "linked", origin: "confirmed", by: "linker", at: expect.any(String) } });
    // No guardian link was touched, nor any other family's.
    expect((await db.select().from(accountingLink).where(and(eq(accountingLink.origin, "confirmed"), isNotNull(accountingLink.guardianId))))).toEqual([]);
    expect(await familyLinkOf(await recordOfCustomer("10", "family"))).toMatchObject({ origin: "carried_over" });
  });

  it("draws the press in a carried-over row's opening with what it confirms and leaves, the books' text as text", async () => {
    await readAgain(qc("70", "<b>Patel</b> Family", "1"), qc("71", "Asha Patel", "3", under("70")));
    await syncAppRecords();
    asStaff(linker);
    const html = listOf(await renderPage(AccountingLinksPage));
    const opening = rowNamed(html, "<b>Patel</b> Family")![4]!;
    expect(opening).toContain("Confirm this link marks it as checked by you.");
    expect(opening).toContain("Confirmed with it, each carried over to a student customer directly under this customer:Asha Patel");
    expect(opening).toContain("Confirm this link: <b>Patel</b> Family");
    expect(html).not.toContain("<b>Patel</b>");
    expect(html).toContain("&lt;b&gt;Patel&lt;/b&gt; Family");
  });
});

describe("refused, keeping nothing", () => {
  it("for a confirmed link, a created one, a customer gone and one that isn't a family now, with no press offered for any", async () => {
    const { oaks } = await seedOaks();
    // Created: a family added by someone who may link families, made in the books from the portal.
    const both = asOp(await staffWith("both@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]));
    expect(await addFamily({ role: "family", name: "Elm Family", typeQboId: null }, tag, { ...both, mayLink: true })).toMatchObject({ ok: true });
    await readAgain();
    const view = await loadAccountingLinks();
    const elm = rowOf(view, "Elm Family");
    expect(elm).toMatchObject({ status: { key: "linked", origin: "created" }, review: null });
    const forged = async (familyId: AppFamilyId) => {
      const link = await familyLinkOf(familyId);
      return reviewCarriedOver({ familyId: String(familyId), linkId: link.id, stamp: reviewStamp(String(familyId), link.id, link.customerId, []) }, tag, linkOp());
    };
    expect(await forged(elm.familyId)).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    // Confirmed: once reviewed, a forged second press is refused.
    expect(await pressRow(oaks, rowOf(view, "Oak Family"))).toMatchObject({ ok: true });
    expect(await forged(oaks)).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    // Customer gone (the Chens' customer, 20, gone from the books) and Not a family now (the Riveras', 10, given another type).
    stub.customers = stub.customers.filter((c) => c.Id !== "20" && c.Id !== "21");
    changeInBooks("10", { CustomerTypeRef: { value: "4" } });
    await readAgain();
    const chen = await recordOfCustomer("20", "family"), rivera = await recordOfCustomer("10", "family");
    const again = await loadAccountingLinks();
    expect(rowOf(again, "Chen Family")).toMatchObject({ status: { key: "customer_gone" }, review: null });
    expect(rowOf(again, "Rivera Family")).toMatchObject({ status: { key: "not_a_family" }, review: null });
    expect(await forged(chen)).toEqual({ ok: false, errors: [LINK_COPY.reviewNotStanding] });
    expect(await forged(rivera)).toEqual({ ok: false, errors: [LINK_COPY.reviewNotStanding] });
    for (const f of [chen, rivera]) expect(await familyLinkOf(f)).toMatchObject({ origin: "carried_over", linkedBy: null });
    expect(await auditsOf("accounting.link.confirm")).toHaveLength(1);
  });

  it("in each state but listed, offering no press", async () => {
    const { oaks } = await seedOaks();
    const row = rowOf(await loadAccountingLinks(), "Oak Family");
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    expect(rowOf(await loadAccountingLinks(), "Oak Family").review).toBeNull();
    expect(await pressRow(oaks, row)).toEqual({ ok: false, errors: [LINK_COPY.other_company] });
    await db.update(qboConnection).set({ realmId: REALM });
    const shape = (await db.select().from(setting).where(eq(setting.key, SHAPE_KEY)))[0]!;
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect(rowOf(await loadAccountingLinks(), "Oak Family").review).toBeNull();
    expect(await pressRow(oaks, row)).toEqual({ ok: false, errors: [LINK_COPY.no_shape] });
    await db.insert(setting).values({ key: SHAPE_KEY, value: shape.value });
    // With no company named, a page carries the tag "none"; the press is refused as nothing can be checked.
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await pressRow(oaks, row, "none")).toEqual({ ok: false, errors: [LINK_COPY.no_company] });
    expect(await pressRow(oaks, row)).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    expect(await familyLinkOf(oaks)).toMatchObject({ origin: "carried_over", linkedBy: null });
    expect(await auditsOf("accounting.link.confirm")).toEqual([]);
  });

  it("for a student link added or removed since the page, a forged link, and values no page sends", async () => {
    const { oaks, amy } = await seedOaks();
    // Added: Ben Oak, under the family in the books, given his record and carried-over link by the import.
    let row = rowOf(await loadAccountingLinks(), "Oak Family");
    await readAgain(qc("82", "Ben Oak", "3", under("80")));
    await syncAppRecords();
    expect(await pressRow(oaks, row)).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    // Removed: Amy's student link gone.
    row = rowOf(await loadAccountingLinks(), "Oak Family");
    expect(row.review!.confirms).toHaveLength(2);
    await db.delete(accountingLink).where(eq(accountingLink.studentId, amy));
    expect(await pressRow(oaks, row)).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    row = rowOf(await loadAccountingLinks(), "Oak Family");
    // A forged link id, another family's, a forged stamp, and values that aren't ids.
    expect(await reviewCarriedOver({ familyId: String(oaks), linkId: "00000000-0000-4000-8000-000000000999", stamp: row.review!.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    const rivera = await recordOfCustomer("10", "family");
    expect(await reviewCarriedOver({ familyId: String(rivera), linkId: row.review!.linkId, stamp: row.review!.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    expect(await reviewCarriedOver({ familyId: String(oaks), linkId: row.review!.linkId, stamp: "forged" }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.reviewChanged] });
    for (const odd of [{ familyId: "not-a-uuid" }, { linkId: 7 }, { stamp: null }]) {
      expect(await reviewCarriedOver({ familyId: String(oaks), linkId: row.review!.linkId, stamp: row.review!.stamp, ...odd }, tag, linkOp()), JSON.stringify(odd)).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    }
    expect(await reviewCarriedOver({ familyId: "00000000-0000-4000-8000-000000000998", linkId: row.review!.linkId, stamp: row.review!.stamp }, tag, linkOp())).toEqual({ ok: false, errors: [LINK_COPY.familyGone] });
    expect(await familyLinkOf(oaks)).toMatchObject({ origin: "carried_over" });
    expect(await auditsOf("accounting.link.confirm")).toEqual([]);
    // The row as it is now goes through.
    expect(await pressRow(oaks, row)).toMatchObject({ ok: true });
  });
});

describe("who may press", () => {
  it("is the linking permission's with Roster.Read: either alone is refused as the guard refuses", async () => {
    const { oaks } = await seedOaks();
    const row = rowOf(await loadAccountingLinks(), "Oak Family");
    const onlyLink = await staffWith("onlylink@club.org", ["Accounting.Link.ReadWrite"]);
    const onlyRead = await staffWith("onlyread@club.org", ["Roster.Read"]);
    for (const who of [onlyLink, onlyRead]) {
      asStaff(who);
      await expect(reviewLinkAction(String(oaks), row.review!.linkId, tag, row.review!.stamp)).rejects.toBeInstanceOf(AccessDenied);
    }
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === onlyLink.id).map((a) => a.permission)).toEqual(["Roster.Read"]);
    expect(refusals.filter((a) => a.actorId === onlyRead.id).map((a) => a.permission)).toEqual(["Accounting.Link.ReadWrite"]);
    asStaff(linker);
    expect(await reviewLinkAction(String(oaks), null as never, tag, row.review!.stamp)).toEqual({ ok: false, errors: [LINK_COPY.notFromPage] });
    expect(await familyLinkOf(oaks)).toMatchObject({ origin: "carried_over" });
    expect(await reviewLinkAction(String(oaks), row.review!.linkId, tag, row.review!.stamp)).toMatchObject({ ok: true });
    expect(await familyLinkOf(oaks)).toMatchObject({ origin: "confirmed", linkedBy: linker.id });
  });
});
