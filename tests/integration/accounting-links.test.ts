import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, pageOutcome, renderPage, withoutIds } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, jobRun, parent, qboConnection, qboCustomerType, setting, student, writeQueue } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { filterLinkRows, loadAccountingLinks, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { parseLinksFilter } from "@/lib/accounting/status";
import { placeWords } from "@/lib/roster/place";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { familyFromCustomer } from "@/lib/roster/no-family";
import { customerAimedAt } from "@/lib/accounting/link-writes";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily, keptMoveWords, NO_FAMILY_CUSTOMER } from "@/lib/roster/writes";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { SOURCE_KEY } from "@/lib/roster/source";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb, seedParent, seedStaff } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, connectRoster, REALM, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { rowNamed, tableRows } from "../helpers/table";
import { recordOfCustomer } from "../helpers/app-records";
import { moveInQuickBooksOnly } from "../helpers/roster-cache";

/**
 * The accounting links screen (stage 4's slice M1 of the app-owned families spec, section 4, "The mapping screen";
 * src/lib/accounting/mapping.ts and /staff/links): every active family with a status worked out at each view, a
 * suggestion only by an exact sign-in address, and nothing written. The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3, School 4; the Rivera (10) and Chen (20) families have
 * their records, carried over. Customers added after it are read by a roster read, which makes no record, as in the
 * portal; a family with no link is added in the portal by a staff member who may not link it, as families-by-hand does.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

/** A customer as QuickBooks answers it, as fznCompany() writes them. */
const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
/** What the links page says beside every Confirm (src/app/staff/(app)/links/page.tsx), as the text of the page reads it. */
const LINK_EFFECT = "Once linked, this family's guardians see this customer's open invoices and Pay links, and those of the students and parents the books hold directly under it, the next time they open Home or Payments, and a pay-instead choice for the family bills it. A link can be removed again on this page, with Unlink from the books in the family's row, but its guardians may have seen those invoices by then, so check it is the right household.";

/**
 * What a carried-over Rivera Family's opening says of Confirm this link since slice M3a2, and of Unlink from the books
 * since slice M3b, as the text of the page reads it: Leo Rivera's carried-over link to the student customer under the
 * family goes with the confirm; the unlink ends the family's link to its customer (as the books' copy names it), Leo's
 * link and Ana Rivera's own link; then both presses.
 */
const riveraPresses = (customer = "Rivera Family") => "Confirm this link records it as checked by you, so it no longer reads as carried over. Nothing is sent to the books."
  + "Confirmed with it, each carried over to a student customer directly under this customer:Leo Rivera"
  + `Unlink from the booksUnlinking ends this family's link to “${customer}”, with the link of its student Leo Rivera, and a guardian's own link to a Parent customer. Nothing is sent to the books, and the customer stays there as it is.`
  + "Its guardians then read that the club hasn't connected their payments to the portal yet, with no invoices, Pay or buy-out offer, until it is linked again, and its stored figures are forgotten at once."
  + " The family, its students, guardians, sign-ins, season, volunteering and forms stay as they are."
  + " It isn't unlinked while a buy-out of the family or its students isn't settled, or while a change of it waits on Reconciliation."
  + "To link it again, use this page, with Confirm or Pick a different customer once its row shows them. While its customer is still in the books, “Create in QuickBooks and link” isn't offered on its page, nor for its students whose customers are, so that no second customer is made for them."
  + "Confirm this link: Rivera FamilyUnlink from the books: Rivera Family";

/** Customers added or changed in QuickBooks, then read by a roster read (which makes no record of them). */
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
/** One customer of the stub changed, as an edit made in QuickBooks. */
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

let tag: string;
/** A family (a member, in flat books) added in the portal by someone who may not link it: active, with no link. */
async function unlinkedFamily(name: string, role: "family" | "member" = "family"): Promise<AppFamilyId> {
  const op = asOp(await seedStaff({ email: `adder.${name.toLowerCase().replace(/\W+/g, ".")}@club.org`, name: "Adder" }));
  expect(await addFamily({ role, name, typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  return (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
}
/** An open guardian row of this person in this family record (the person made once, by their address). */
const people = new Map<string, string>();
async function guardianIn(familyId: AppFamilyId, name: string, email: string, status: "invited" | "active" | "disabled" = "invited", o: { blocked?: boolean } = {}) {
  const parentId = people.get(email) ?? (await seedParent({ name, email, blocked: o.blocked ?? false })).id;
  people.set(email, parentId);
  const [row] = await db.insert(guardian).values({ parentId, familyId, status, disabledReason: status === "disabled" ? "removed" : null }).returning({ id: guardian.id });
  return row!.id;
}
beforeEach(() => people.clear());

const rowOf = (view: LinksView, name: string): LinkRow => {
  const r = view.rows.find((x) => x.name === name);
  if (!r) throw new Error(`no row named ${name}: ${view.rows.map((x) => x.name).join(", ")}`);
  return r;
};
const statusOf = async (name: string) => rowOf(await loadAccountingLinks(), name).status;

describe("the statuses of linked families", () => {
  it("reads a link from the roster as carried over, on its date, with the family's customer, students and guardians and their own links", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    const view = await loadAccountingLinks();
    expect(view.state).toBe("listed");
    const rivera = rowOf(view, "Rivera Family");
    expect(rivera.status).toEqual({ key: "carried_over", at: expect.any(String) });
    expect(rivera.customer).toEqual({ name: "Rivera Family", email: null });
    expect(rivera.addresses).toEqual(["ana@example.com"]);
    expect(rivera.students.map((s) => ({ name: s.name, link: s.link }))).toEqual([{ name: "Leo Rivera", link: { state: "linked", customer: "Leo Rivera" } }]);
    expect(rivera.guardians.map((g) => ({ name: g.name, email: g.email, link: g.link }))).toEqual([{ name: "Ana Rivera", email: "ana@example.com", link: { state: "linked", customer: "Ana Rivera" } }]);
    // The inactive Old Family (40) is not listed: only active family records are.
    expect(view.rows.map((r) => r.name)).toEqual(["Chen Family", "Rivera Family"]);
    expect(view.familyPages).toBe(true);
  });

  it("reads a link a press of Create a family from this made as linked, confirmed, by whom and when", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1"), qc("71", "Asha Patel", "3", under("70")));
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", { ...asOp(treasurer), permission: "Accounting.Link.ReadWrite", mayChangeFamilies: false }, customerAimedAt)).toMatchObject({ ok: true });
    const patel = rowOf(await loadAccountingLinks(), "Patel Family");
    expect(patel.status).toEqual({ key: "linked", origin: "confirmed", by: "treasurer", at: expect.any(String) });
    expect(patel.students.map((s) => s.link)).toEqual([{ state: "linked", customer: "Asha Patel" }]);
    expect(patel.guardians).toEqual([]);
  });

  it("reads a link made by adding a family as someone who may link families as linked, made in the books from the portal, by whom", async () => {
    tag = await connectRoster(stub);
    const linker = await staffWith("linker@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]);
    expect(await addFamily({ role: "family", name: "Oak Family", typeQboId: null }, tag, { ...asOp(linker), mayLink: true })).toMatchObject({ ok: true });
    await readAgain(); // the books' copy as QuickBooks holds it now, the new customer in it
    const oak = rowOf(await loadAccountingLinks(), "Oak Family");
    expect(oak.status).toEqual({ key: "linked", origin: "created", by: "linker", at: expect.any(String) });
    expect(oak.customer).toEqual({ name: "Oak Family", email: null });
    await asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await renderPage(AccountingLinksPage);
    const at = html.indexOf('id="links-list-h"');
    expect(rowNamed(html.slice(at, html.indexOf("</section>", at)), "Oak Family")![3]).toMatch(/^LinkedMade in the books from the portal by linker, on .+\.$/);
  });

  it("tells a customer gone from the books, and keeps the link as it is", async () => {
    tag = await connectRoster(stub);
    stub.customers = stub.customers.filter((c) => c.Id !== "20" && c.Id !== "21");
    await readAgain();
    expect(await statusOf("Chen Family")).toEqual({ key: "customer_gone" });
    expect(rowOf(await loadAccountingLinks(), "Chen Family").customer).toBeNull();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "20"))).toHaveLength(1);
  });

  it("tells a linked customer that isn't a family now apart from one that is gone: another type, under another customer; inactive alone is a difference, the link kept (open question 13)", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1"));
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", { ...asOp(treasurer), permission: "Accounting.Link.ReadWrite", mayChangeFamilies: false }, customerAimedAt)).toMatchObject({ ok: true });
    changeInBooks("10", { Active: false });
    changeInBooks("20", { CustomerTypeRef: { value: "4" } });
    changeInBooks("70", under("30"));
    await readAgain();
    // Inactive in the books but otherwise a family: a difference, its link kept, never Not a family now (slice M2 changed this on purpose).
    const rivera = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(rivera.status).toEqual({ key: "with_differences", made: { key: "carried_over", at: expect.any(String) } });
    expect(rivera.differences).toContainEqual({ kind: "active", of: "family", who: "Rivera Family", portalActive: true, queue: null });
    expect(await statusOf("Chen Family")).toEqual({ key: "not_a_family", reasons: ["other_type"] });
    expect(await statusOf("Patel Family")).toEqual({ key: "not_a_family", reasons: ["under_another"] });
    // The page says each reason in words, joined.
    await asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await renderPage(AccountingLinksPage);
    const at = html.indexOf('id="links-list-h"');
    expect(rowNamed(html.slice(at, html.indexOf("</section>", at)), "Chen Family")![3])
      .toBe("Not a family nowThe linked customer is still in the books, but isn't a family there now: it has another customer type there. The link is kept as it is.");
  });

  it("says a linked customer with no customer type at all has none, and joins each reason that applies", async () => {
    tag = await connectRoster(stub);
    stub.customers = stub.customers.map((c) => {
      if (c.Id !== "10") return c;
      const typeless: Record<string, unknown> = { ...c, Active: false };
      delete typeless.CustomerTypeRef; // the customer type cleared in QuickBooks
      return typeless as typeof c;
    });
    await readAgain();
    expect(await statusOf("Rivera Family")).toEqual({ key: "not_a_family", reasons: ["no_type", "inactive"] });
    await asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await renderPage(AccountingLinksPage);
    expect(html).toContain("isn&#x27;t a family there now: it has no customer type there; it is inactive in the books.");
  });
});

describe("suggestions for families with no link", () => {
  beforeEach(async () => { tag = await connectRoster(stub); });

  it("suggests a customer whose own field holds a guardian's address, and one whose Parent customer does, saying where", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("Asha@Example.com")), qc("80", "Okafor Family", "1"), qc("81", "Ike Okafor", "2", { ...under("80"), ...mail("ike@example.com") }));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const okafors = await unlinkedFamily("The Okafors");
    await guardianIn(okafors, "Ike Okafor", "ike@example.com");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Patels")).toMatchObject({ customer: { name: "Patel Family", email: "asha@example.com" },
      status: { key: "suggested", holders: [{ address: "asha@example.com", on: { kind: "family" } }] } });
    expect(rowOf(view, "The Okafors")).toMatchObject({ customer: { name: "Okafor Family", email: null },
      status: { key: "suggested", holders: [{ address: "ike@example.com", on: { kind: "parent", customerId: "81", name: "Ike Okafor" } }] } });
    expect(view.noFamily).toBe(2);
  });

  it("offers several when two customers hold a family's addresses, and when one customer holds two families' addresses", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("75", "Patel Household", "1", mail("ravi@example.com")),
      qc("80", "Okafor Family", "1", mail("ike@example.com, ada@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await guardianIn(patels, "Ravi Patel", "ravi@example.com");
    const ike = await unlinkedFamily("Ike's Family");
    await guardianIn(ike, "Ike Okafor", "ike@example.com");
    const ada = await unlinkedFamily("Ada's Family");
    await guardianIn(ada, "Ada Okafor", "ada@example.com");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "The Patels")).toMatchObject({ customer: null, status: { key: "several", why: "many",
      candidates: [{ name: "Patel Family", email: "asha@example.com" }, { name: "Patel Household", email: "ravi@example.com" }] } });
    expect(rowOf(view, "Ike's Family").status).toMatchObject({ key: "several", why: "shared", alsoMatches: ["Ada's Family"] });
    expect(rowOf(view, "Ada's Family").status).toMatchObject({ key: "several", why: "shared", alsoMatches: ["Ike's Family"] });
  });

  it("makes both families of a guardian in two families several possible when the address is on both customers", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("sam@example.com")), qc("80", "Okafor Family", "1", mail("sam@example.com")));
    const patels = await unlinkedFamily("The Patels");
    const okafors = await unlinkedFamily("The Okafors");
    await guardianIn(patels, "Sam Lee", "sam@example.com");
    await guardianIn(okafors, "Sam Lee", "sam@example.com");
    expect(await statusOf("The Patels")).toMatchObject({ key: "several", why: "many" });
    expect(await statusOf("The Okafors")).toMatchObject({ key: "several", why: "many" });
  });

  it("finds no match for an address on no customer, a customer another family is linked to, an inactive customer, or a name; and says when there are no guardians", async () => {
    changeInBooks("20", mail("chen@example.com"));
    await readAgain(qc("90", "Quiet Family", "1", { Active: false, ...mail("zoe@example.com") }), qc("91", "nobody@example.com", "1"));
    const a = await unlinkedFamily("Family A");
    await guardianIn(a, "Chen Again", "chen@example.com"); // on the Chen family's own customer, which the Chen family is linked to
    await guardianIn(a, "Ana Again", "ana@example.com"); // on Ana Rivera's customer, under the Rivera family, which is linked
    await guardianIn(a, "Zoe Quiet", "zoe@example.com"); // on an inactive customer
    await guardianIn(a, "No Body", "nobody@example.com"); // only a customer's name
    await guardianIn(a, "Stranger", "stranger@example.com");
    await unlinkedFamily("Family B");
    const view = await loadAccountingLinks();
    expect(rowOf(view, "Family A").status).toEqual({ key: "no_match", noGuardians: false });
    expect(rowOf(view, "Family B").status).toEqual({ key: "no_match", noGuardians: true });
  });

  it("reads only open guardians' sign-in addresses, and never an inactive family record", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com", "disabled");
    expect((await statusOf("The Patels"))).toEqual({ key: "no_match", noGuardians: true });
    await db.update(family).set({ active: false }).where(eq(family.id, patels));
    expect((await loadAccountingLinks()).rows.map((r) => r.name)).not.toContain("The Patels");
  });

  it("never matches a blocked person's address: No match while they are the only one, Suggested once unblocked or beside a guardian who can sign in", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com, ravi@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com", "invited", { blocked: true });
    let row = rowOf(await loadAccountingLinks(), "The Patels");
    expect(row.status).toEqual({ key: "no_match", noGuardians: false });
    expect(row.addresses).toEqual([]);
    expect(row.guardians.map((g) => ({ name: g.name, blocked: g.blocked }))).toEqual([{ name: "Asha Patel", blocked: true }]);
    // A guardian who can sign in, with an address on the same customer: Suggested, by their address alone.
    await guardianIn(patels, "Ravi Patel", "ravi@example.com");
    row = rowOf(await loadAccountingLinks(), "The Patels");
    expect(row.status).toEqual({ key: "suggested", holders: [{ address: "ravi@example.com", on: { kind: "family" } }] });
    expect(row.addresses).toEqual(["ravi@example.com"]);
    // Unblocked, Asha's address is matched again.
    await db.update(parent).set({ blocked: false }).where(eq(parent.email, "asha@example.com"));
    row = rowOf(await loadAccountingLinks(), "The Patels");
    expect(row.status).toMatchObject({ key: "suggested", holders: [{ address: "asha@example.com" }, { address: "ravi@example.com" }] });
    expect(row.addresses).toEqual(["asha@example.com", "ravi@example.com"]);
  });

  it("never suggests a customer a waiting family create would be found as", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    expect(await statusOf("The Patels")).toMatchObject({ key: "suggested" });
    await seedQueued({ op: "create", role: "family", name: "Patel Family", typeQboId: "1", familyQboId: null, email: null });
    expect(await statusOf("The Patels")).toEqual({ key: "no_match", noGuardians: false });
  });

  it("never reads another company's link, of a family or a student", async () => {
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "9130000000000999", customerId: "70", familyId: patels, origin: "carried_over" });
    expect(await statusOf("The Patels")).toMatchObject({ key: "suggested", holders: [{ address: "asha@example.com" }] });
    // Leo Rivera's own link moved to another company's: his row reads no link of its own, never that company's customer.
    const leo = (await db.select().from(accountingLink).where(and(eq(accountingLink.customerId, "12"), isNotNull(accountingLink.studentId))))[0]!;
    await db.update(accountingLink).set({ realmId: "9130000000000999" }).where(eq(accountingLink.id, leo.id));
    expect(rowOf(await loadAccountingLinks(), "Rivera Family").students.map((s) => s.link)).toEqual([{ state: "none" }]);
  });
});

describe("the books' shape", () => {
  // In both shapes here no type names Parent customer 81's type (2), so the roster read keeps no email for it
  // (customerRow() in src/lib/roster/refresh.ts): The Okafors read No match whatever the matcher does with a customer
  // under the family. That rule, that only a Parent customer of the shape's parent type counts, is carried by
  // tests/unit/accounting-match.test.ts; these prove the whole read in each shape.
  it("in flat books suggests the member by its own field, never by a customer under it", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("80", "Okafor Family", "1"), qc("81", "Ike Okafor", "2", { ...under("80"), ...mail("ike@example.com") }));
    const patels = await unlinkedFamily("The Patels", "member");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const okafors = await unlinkedFamily("The Okafors", "member");
    await guardianIn(okafors, "Ike Okafor", "ike@example.com");
    expect(await statusOf("The Patels")).toMatchObject({ key: "suggested", holders: [{ address: "asha@example.com", on: { kind: "family" } }] });
    expect(await statusOf("The Okafors")).toEqual({ key: "no_match", noGuardians: false });
  });

  it("in layered books with no parent type suggests by the family's own field alone", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("80", "Okafor Family", "1"), qc("81", "Ike Okafor", "2", { ...under("80"), ...mail("ike@example.com") }));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const okafors = await unlinkedFamily("The Okafors");
    await guardianIn(okafors, "Ike Okafor", "ike@example.com");
    expect(await statusOf("The Patels")).toMatchObject({ key: "suggested" });
    expect(await statusOf("The Okafors")).toEqual({ key: "no_match", noGuardians: false });
  });
});

describe("when the books can't be checked", () => {
  beforeEach(async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
  });

  it("connected to another company: no link is read, and every family is not checked", async () => {
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    const view = await loadAccountingLinks();
    expect(view.state).toBe("other_company");
    expect(view.rows.map((r) => r.status.key)).toEqual(["not_checked", "not_checked", "not_checked"]);
    expect(rowOf(view, "Rivera Family").students.map((s) => s.link)).toEqual([{ state: "unread" }]);
    expect(view.noFamily).toBeNull();
    expect(view.familyPages).toBe(false);
  });

  it("with no shape, or a broken one: links shown with their origin and a gone customer told, nothing suggested, not a family not worked out", async () => {
    changeInBooks("10", { Active: false });
    stub.customers = stub.customers.filter((c) => c.Id !== "20" && c.Id !== "21");
    await readAgain();
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "3")); // the shape's student type, gone from the books
    let view = await loadAccountingLinks();
    expect(view.state).toBe("no_shape");
    expect(rowOf(view, "Rivera Family").status).toMatchObject({ key: "carried_over" });
    expect(rowOf(view, "Chen Family").status).toEqual({ key: "customer_gone" });
    expect(rowOf(view, "The Patels").status).toEqual({ key: "not_checked" });
    expect(view.noFamily).toBeNull();
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    view = await loadAccountingLinks();
    expect(view.state).toBe("no_shape");
    expect(rowOf(view, "The Patels").status).toEqual({ key: "not_checked" });
    expect(view.familyPages).toBe(false);
  });

  it("with no company named: nothing read of links, every family not checked", async () => {
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    const view = await loadAccountingLinks();
    expect(view.state).toBe("no_company");
    expect(view.rows.every((r) => r.status.key === "not_checked")).toBe(true);
  });
});

describe("the filter and the search", () => {
  it("filters by a status key and searches names, addresses and the customer's name and field, ignoring case", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const { rows } = await loadAccountingLinks();
    const names = (sp: Record<string, string | string[] | undefined>) => filterLinkRows(rows, parseLinksFilter(sp)).map((r) => r.name);
    expect(names({ status: "suggested" })).toEqual(["The Patels"]);
    expect(names({ status: "carried_over" })).toEqual(["Chen Family", "Rivera Family"]);
    expect(names({ status: "nonsense" })).toEqual(["Chen Family", "Rivera Family", "The Patels"]);
    expect(names({ status: ["suggested", "linked"] })).toEqual(["Chen Family", "Rivera Family", "The Patels"]);
    expect(names({ q: "  ASHA@ " })).toEqual(["The Patels"]);
    expect(names({ q: "patel family" })).toEqual(["The Patels"]); // the suggested customer's name
    expect(names({ q: "chen" })).toEqual(["Chen Family"]);
    expect(names({ q: ["chen"] })).toEqual(["Chen Family", "Rivera Family", "The Patels"]);
    expect(parseLinksFilter({ q: "x".repeat(101) })).toEqual({ status: null, q: "", tooLong: true });
    expect(parseLinksFilter({ q: ` ${"x".repeat(100)} ` })).toEqual({ status: null, q: "x".repeat(100), tooLong: false });
  });
});

describe("the page", () => {
  /** The list's own section, from its heading to the end of its box. */
  const list = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };
  const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));

  it("shows an Admin and a role holding the linking permission and Roster.Read; refuses either alone", async () => {
    tag = await connectRoster(stub);
    await asAdmin();
    expect(list(await renderPage(AccountingLinksPage))).toContain("Rivera Family");
    asStaff(await staffWith("treasurer@club.org", ["Accounting.Link.ReadWrite", "Roster.Read"]));
    expect(list(await renderPage(AccountingLinksPage))).toContain("Chen Family");
    const linker = await staffWith("linker@club.org", ["Accounting.Link.ReadWrite"]);
    asStaff(linker);
    expect(await pageOutcome(AccountingLinksPage)).toEqual({ redirect: "/refused" });
    const reader = await staffWith("reader@club.org", ["Roster.Read"]);
    asStaff(reader);
    expect(await pageOutcome(AccountingLinksPage)).toEqual({ redirect: "/refused" });
    // Each refusal leaves the guard's own row, naming the permission missing: the page's second check refuses as the guard does.
    const refusals = (await db.select().from(auditLog)).filter((a) => a.action === "access.refused");
    expect(refusals.filter((a) => a.actorId === linker.id)).toMatchObject([{ permission: "Roster.Read" }]);
    expect(refusals.filter((a) => a.actorId === reader.id)).toMatchObject([{ permission: "Accounting.Link.ReadWrite" }]);
  });

  it("draws each row with its family, addresses, customer and status, opens to students and guardians, and writes nothing", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await asAdmin();
    const audits = (await db.select().from(auditLog)).length;
    // The cells are read from the markup as drawn: withoutIds() puts "<id>" inside a link's href, which a cell's text
    // would then keep a piece of. Only the href itself is compared with its id masked.
    const html = list(await renderPage(AccountingLinksPage));
    expect(tableRows(html)).toHaveLength(3);
    const rivera = rowNamed(html, "Rivera Family")!;
    expect(rivera.slice(0, 3)).toEqual(["Rivera Family", "ana@example.com", "Rivera FamilyNo email address"]);
    expect(rivera[3]).toMatch(/^Carried overCarried over from the roster by the portal, on .+\. Nobody has confirmed it since\.$/);
    expect(rivera[4]).toBe("Students and guardians: Rivera FamilyStudents:Leo Rivera: linked to Leo RiveraGuardians:Ana Rivera (ana@example.com): linked to Ana Rivera" + riveraPresses());
    const patel = rowNamed(html, "The Patels")!;
    expect(patel.slice(1)).toEqual(["asha@example.com", "Patel Familyasha@example.com",
      "SuggestedA guardian's sign-in address matches: asha@example.com, on this customer.",
      // Since slice M3a a Suggested row's opening says what Confirm links, and offers it and Leave unlinked.
      "Students and guardians: The PatelsNo active students.Guardians:Asha Patel (asha@example.com): no link of its own"
        + "Confirming links it to “Patel Family”. Nothing is sent to the books.No student would be linked with it." + LINK_EFFECT + "Confirm: The PatelsLeave unlinked: The Patels"]);
    expect(withoutIds(html)).toContain('href="/staff/roster/<id>"');
    expect(html).toContain("<details class=\"more\"><summary>Students and guardians<span class=\"visually-hidden\">: The Patels</span></summary>");
    expect((await db.select().from(auditLog)).length).toBe(audits);
    // The customers with no family stay on Reconciliation, linked from here, counted by the pool's own rule, and the
    // page says a family the portal has is linked here, that Reconciliation refuses "Create a family from this" for a
    // customer it aims at a family (slice M3a2), and that "Create in QuickBooks and link" would make a second customer
    // for a family never linked to its customer, and isn't offered for one unlinked while its customer is in the books (slice M3b2).
    const whole = await renderPage(AccountingLinksPage);
    expect(whole).toContain('href="/staff/reconciliation#no-family-h"');
    expect(whole).toContain("1 active customer the books list as a family at the top level, under no other customer, has no family in the portal.");
    expect(whole).toContain("A family the portal has is linked here: Confirm its suggestion, or one of its possible customers, or pick a different customer from those no family is linked to.");
    expect(whole).not.toContain("would still make a second family");
    expect(whole).toContain("Reconciliation refuses “Create a family from this” for a customer this page suggests or lists for a family the portal has, or that a given-up change of a family the portal saved first made.");
    expect(whole).toContain("would make a second customer in the books for a family whose customer is already there but was never linked to it; it isn&#x27;t offered for one unlinked while its customer is still in the books.");
    expect(whole).toContain("makes a new customer in the books for a family that has none, but not for one unlinked while its customer is still in the books, nor for a student of it whose customer is; and adding a family under Families makes one too, when someone who may link families adds it while the books are connected.");
    // And Reconciliation's section links back here.
    const recon = await renderPage(ReconciliationPage);
    const at = recon.indexOf('id="no-family-h"');
    expect(recon.slice(at, recon.indexOf("</section>", at))).toContain('href="/staff/links"');
    expect(whole).toContain("A guardian who can&#x27;t sign in, because they are blocked, is listed under the family, but their address is never matched.");
  });

  it("lists a blocked guardian in the row's opening as one who can't sign in, never among the addresses matched, and says why nothing matches", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com", "invited", { blocked: true });
    await asAdmin();
    const patel = rowNamed(list(await renderPage(AccountingLinksPage)), "The Patels")!;
    expect(patel.slice(1)).toEqual(["None that can sign in", "None",
      "No matchNone of this family's guardians can sign in, so there is no address to match.",
      "Students and guardians: The PatelsNo active students.Guardians:Asha Patel (asha@example.com), can't sign in, so this address isn't matched: no link of its own"
        + "Pick a different customer: The PatelsLeave unlinked: The Patels"]);
  });

  it("renders the books' text as text", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("75", "<b>Bold</b> Family", "1", mail("bold@example.com")));
    const bold = await unlinkedFamily("Plain Family");
    await guardianIn(bold, "Bo Bold", "bold@example.com");
    await asAdmin();
    const html = list(await renderPage(AccountingLinksPage));
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; Family");
    expect(html).not.toContain("<b>Bold</b>");
  });

  it("filters by status with each status's count, searches, says when nothing matches and when a search is too long", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await asAdmin();
    let html = list(await renderPage(AccountingLinksPage, { searchParams: { status: "suggested" } }));
    expect(tableRows(html).map((r) => r[0])).toEqual(["The Patels"]);
    expect(html).toContain("1 family of 3 shown");
    expect(html).toContain('<option value="">Every status (3)</option>'); // a status asked for: React marks that option alone
    expect(html).toContain('<option value="carried_over">Carried over (2)</option>');
    // With no guardian seeded, the Riveras' Ana Rivera and the Chens' Mei Chen are Parent customers no guardian is linked to.
    expect(html).toContain('<option value="with_differences">Linked, with differences (2)</option>');
    expect(html).toContain('<option value="suggested" selected="">Suggested (1)</option>');
    expect(html).toContain('<option value="not_checked">Not checked (0)</option>');
    html = list(await renderPage(AccountingLinksPage, { searchParams: { status: ["suggested", "x"], q: ["patel"] } }));
    expect(tableRows(html)).toHaveLength(3);
    html = list(await renderPage(AccountingLinksPage, { searchParams: { q: "nobody-at-all" } }));
    expect(tableRows(html)).toHaveLength(0);
    expect(html).toContain("No family matches that.");
    html = list(await renderPage(AccountingLinksPage, { searchParams: { q: "y".repeat(101) } }));
    expect(html).toContain("That search was too long, so nothing was searched for.");
    expect(tableRows(html)).toHaveLength(3);
  });

  it("says why nothing is suggested while the books can't be checked, and lists each family as not checked", async () => {
    tag = await connectRoster(stub);
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    await asAdmin();
    let html = await renderPage(AccountingLinksPage);
    expect(html).toContain("QuickBooks is connected to a different company than the one the roster was read from, so no link is read and nothing is suggested.");
    expect(tableRows(list(html)).map((r) => r[3]!.startsWith("Not checked"))).toEqual([true, true]);
    // A linked family's customer isn't said to be none: it isn't checked now.
    expect(tableRows(list(html)).map((r) => r[2])).toEqual(["Not checked now", "Not checked now"]);
    expect(list(html)).not.toContain('href="/staff/roster/');
    // No shape: links shown as they are, a family with no link not checked, and the shape's own words.
    await db.update(qboConnection).set({ realmId: REALM });
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    html = await renderPage(AccountingLinksPage);
    expect(html).toContain("The membership shape isn&#x27;t chosen, or names a customer type the books no longer have, so the portal can&#x27;t tell which customers are families.");
    expect(tableRows(list(html)).map((r) => r[3]!.startsWith("Carried over"))).toEqual([true, true]);
    // No company named: the portal hasn't read the books.
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    html = await renderPage(AccountingLinksPage);
    expect(html).toContain("The portal hasn&#x27;t read the club&#x27;s books yet, so no family&#x27;s link can be checked and nothing is suggested.");
    expect(tableRows(list(html)).map((r) => r[3]!.startsWith("Not checked"))).toEqual([true, true]);
  });
});

describe("differences, for a link that stands (slice M2)", () => {
  /** The list's own section, from its heading to the end of its box. */
  const list = (html: string) => { const at = html.indexOf('id="links-list-h"'); return html.slice(at, html.indexOf("</section>", at)); };
  const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
  const diffsOf = async (name: string) => rowOf(await loadAccountingLinks(), name).differences;
  const placesIn = async (name: string) => (await diffsOf(name)).flatMap((d) => (d.kind === "place" ? [d.place] : []));

  it("names: the family's and a student's, made in the books and read again, a difference of case shows and one of spacing alone doesn't", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    expect(await diffsOf("Rivera Family")).toEqual([]);
    changeInBooks("10", { DisplayName: "Rivera family" }); // case alone
    changeInBooks("12", { DisplayName: "Leo M. Rivera" });
    await readAgain();
    expect(await diffsOf("Rivera Family")).toEqual([
      { kind: "name", of: "family", portal: "Rivera Family", books: "Rivera family", queue: null },
      { kind: "name", of: "student", studentId: await recordOfCustomer("12", "student"), portal: "Leo Rivera", books: "Leo M. Rivera", queue: null }]);
    changeInBooks("10", { DisplayName: "Rivera  Family " }); // spaces alone, which the portal's names never hold
    changeInBooks("12", { DisplayName: "Leo Rivera" });
    await readAgain();
    expect(await diffsOf("Rivera Family")).toEqual([]);
  });

  it("a record with no name differs from the books' name, said in the portal's words for none", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    await db.update(family).set({ name: null }).where(eq(family.id, await recordOfCustomer("10", "family")));
    const row = rowOf(await loadAccountingLinks(), "A family whose name the portal doesn't know");
    expect(row.differences).toEqual([{ kind: "name", of: "family", portal: null, books: "Rivera Family", queue: null }]);
    await asAdmin();
    expect(await renderPage(AccountingLinksPage)).toContain("The family&#x27;s name. In the portal: A family whose name the portal doesn&#x27;t know. In the books: “Rivera Family”.");
  });

  it("whether each is active: the family and a student inactive in the books, and an inactive student record active there", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    changeInBooks("10", { Active: false });
    changeInBooks("12", { Active: false });
    await readAgain();
    expect(await diffsOf("Rivera Family")).toEqual([
      { kind: "active", of: "family", who: "Rivera Family", portalActive: true, queue: null },
      { kind: "active", of: "student", studentId: await recordOfCustomer("12", "student"), who: "Leo Rivera", portalActive: true, queue: null }]);
    changeInBooks("10", { Active: true });
    changeInBooks("12", { Active: true });
    await readAgain();
    await db.update(student).set({ active: false }).where(eq(student.id, await recordOfCustomer("12", "student")));
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.differences).toEqual([{ kind: "active", of: "student", studentId: await recordOfCustomer("12", "student"), who: "Leo Rivera", portalActive: false, queue: null }]);
    expect(row.students).toEqual([]); // the opening still lists the active students only
  });

  it("where a student is: under another family, under no customer, under one that is no family, no longer a student customer, or gone", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    changeInBooks("12", under("20"));
    await readAgain();
    expect(await placesIn("Rivera Family")).toEqual([{ at: "other_family", familyQboId: "20", familyName: "Chen Family" }]);
    changeInBooks("12", { ParentRef: undefined, Job: false });
    await readAgain();
    expect(await placesIn("Rivera Family")).toEqual([{ at: "top" }]);
    changeInBooks("12", under("30"));
    await readAgain();
    expect(await placesIn("Rivera Family")).toEqual([{ at: "under_other" }]);
    changeInBooks("12", { ...under("10"), CustomerTypeRef: { value: "4" } });
    await readAgain();
    expect(await placesIn("Rivera Family")).toEqual([{ at: "not_student" }]);
    stub.customers = stub.customers.filter((c) => c.Id !== "12");
    await readAgain();
    expect(await placesIn("Rivera Family")).toEqual([{ at: "gone" }]);
  });

  it("a move made in the books alone is told in both rows: as its place in the student's own family's, as a student whose record is elsewhere in the other's, never as one with no record", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    await moveInQuickBooksOnly(["12"], "20");
    const view = await loadAccountingLinks();
    const leo = await recordOfCustomer("12", "student");
    expect(rowOf(view, "Rivera Family").differences).toEqual([{ kind: "place", who: "Leo Rivera", studentId: leo,
      place: { at: "other_family", familyQboId: "20", familyName: "Chen Family" }, queue: null }]);
    expect(rowOf(view, "Chen Family").differences).toEqual([ // and Mei Chen's Parent customer
      { kind: "student_elsewhere", books: "Leo Rivera", studentId: leo, portal: { at: "family", family: "Rivera Family" }, queue: null }, { kind: "parent_customers", count: 1 }]);
  });

  it("a student moved in the portal to a family with no link, the move kept refused, is told in the row of the family the books have them under, with the move's words", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    const rivera = await recordOfCustomer("10", "family"), leo = await recordOfCustomer("12", "student");
    const patels = await unlinkedFamily("The Patels");
    // As moveStudent() leaves it: the record in the Patels', the move kept as the Patels have no customer (slice 9f).
    await db.update(student).set({ familyId: patels }).where(eq(student.id, leo));
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "", fromFamilyId: rivera, toFamilyId: patels },
      { state: "refused", code: NO_FAMILY_CUSTOMER });
    const view = await loadAccountingLinks();
    const words = keptMoveWords(NO_FAMILY_CUSTOMER, null);
    const riveras = rowOf(view, "Rivera Family");
    expect(riveras.differences).toEqual([{ kind: "student_elsewhere", books: "Leo Rivera", studentId: leo, portal: { at: "family", family: "The Patels" }, queue: { state: "refused", words } }]);
    expect(riveras.status).toMatchObject({ key: "with_differences" });
    expect(rowOf(view, "The Patels").differences).toEqual([]); // no link: nothing compared there
    await asAdmin();
    const html = list(await renderPage(AccountingLinksPage));
    expect(rowNamed(html, "Rivera Family")![3]).toMatch(/1 difference with the books: where a student is.$/);
    expect(rowNamed(html, "Rivera Family")![4]).toContain(
      `A student the books have under this family. In the portal: Their record is in The Patels. In the books: “Leo Rivera”, a student customer under this family. ${words} See the change on Reconciliation`);
  });

  it("the family's page and this page say a move in the same words", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    changeInBooks("12", under("20"));
    await readAgain();
    await asAdmin();
    const words = placeWords({ at: "other_family", familyQboId: "20", familyName: "Chen Family" });
    expect(words).toBe("Under Chen Family in QuickBooks");
    const riveraPage = { params: { id: String(await recordOfCustomer("10", "family")) } };
    expect(await renderPage(RosterEntryPage, riveraPage)).toContain(words);
    expect(await renderPage(AccountingLinksPage)).toContain(`In the books: ${words}.`);
    // At the top of the tree, both say it in the one new string.
    changeInBooks("12", { ParentRef: undefined, Job: false });
    await readAgain();
    const top = placeWords({ at: "top" });
    expect(await renderPage(RosterEntryPage, riveraPage)).toContain(top);
    expect(await renderPage(AccountingLinksPage)).toContain(`In the books: ${top}.`);
  });

  it("students on one side only: a student customer with no record, by name, inactive ones counted; a student record with no link", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    await readAgain(qc("13", "Zoe Rivera", "3", under("10")), qc("14", "Old Rivera", "3", { ...under("10"), Active: false }));
    const [ivy] = await db.insert(student).values({ familyId: await recordOfCustomer("10", "family"), name: "Ivy Rivera", active: true }).returning({ id: student.id });
    const row = rowOf(await loadAccountingLinks(), "Rivera Family");
    expect(row.differences).toEqual([{ kind: "student_unlinked", who: "Ivy Rivera", studentId: ivy!.id, queue: null }, { kind: "student_customer", books: "Zoe Rivera" }]);
    expect(row.inactiveUnrecorded).toBe(1);
    await asAdmin();
    const cell = rowNamed(list(await renderPage(AccountingLinksPage)), "Rivera Family")![4]!;
    expect(cell).toContain("A student in the books only. In the portal: No student record. In the books: “Zoe Rivera”, a student customer under this family.");
    expect(cell).toContain("A student in the portal only. In the portal: Ivy Rivera. In the books: No customer of their own.");
    expect(cell).toContain("The books also have 1 inactive student customer under this family with no student record in the portal.");
  });

  it("Parent customers and guardians, as counts only, with a guardian's create on the queue counted in its words", async () => {
    tag = await connectRoster(stub);
    const rivera = await recordOfCustomer("10", "family");
    const sol = await guardianIn(rivera, "Sol Rivera", "sol@example.com");
    await guardianIn(rivera, "Tia Rivera", "tia@example.com");
    await seedQueued({ op: "create", role: "parent", name: "Sol Rivera", typeQboId: "2", familyQboId: "10", email: "sol@example.com", guardianId: sol });
    expect(await diffsOf("Rivera Family")).toEqual([{ kind: "parent_customers", count: 1 },
      { kind: "guardians_unlinked", count: 2, queue: [{ note: { state: "waiting", words: "Waiting to reach QuickBooks" }, count: 1 }] }]);
    await asAdmin();
    const cell = rowNamed(list(await renderPage(AccountingLinksPage)), "Rivera Family")![4]!;
    expect(cell).toContain("Parent customers in the books only. In the portal: No guardian linked to them. In the books: 1 active Parent customer under this family.");
    expect(cell).toContain("Guardians in the portal only. In the portal: 2 guardians with no Parent customer of their own. In the books: No Parent customer linked to them. For 1 of them: Waiting to reach QuickBooks. See the change on Reconciliation");
    // Nothing per guardian: no name of theirs beyond the opening's list of guardians.
    expect(cell.split("Sol Rivera").length - 1).toBe(1);
  });

  it("a family with several differences at once lists each, and its status line says how many of what kinds", async () => {
    tag = await connectRoster(stub);
    changeInBooks("10", { DisplayName: "Rivera Household" });
    changeInBooks("12", under("20"));
    await readAgain();
    expect((await diffsOf("Rivera Family")).map((d) => d.kind)).toEqual(["name", "place", "parent_customers"]);
    await asAdmin();
    expect(rowNamed(list(await renderPage(AccountingLinksPage)), "Rivera Family")![3])
      .toMatch(/^Linked, with differencesCarried over from the roster by the portal, on .+\. Nobody has confirmed it since\. 3 differences with the books: names, where a student is, Parent customers or guardians on one side only\.$/);
  });

  it("in flat books: the member's name and whether it is active, and nothing of students or guardians", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    changeInBooks("10", { DisplayName: "The Riveras", Active: false });
    await readAgain();
    const view = await loadAccountingLinks();
    expect(rowOf(view, "Rivera Family").differences).toEqual([
      { kind: "name", of: "member", portal: "Rivera Family", books: "The Riveras", queue: null },
      { kind: "active", of: "member", who: "Rivera Family", portalActive: true, queue: null }]);
    expect(rowOf(view, "Chen Family").differences).toEqual([]);
  });

  it("in layered books with no parent type, no Parent customer is counted", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null } });
    expect((await loadAccountingLinks()).rows.map((r) => r.differences)).toEqual([[], []]);
  });

  it("in layered books with no student type, no student's place or record", async () => {
    tag = await connectRoster(stub, { shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" } });
    await readAgain(qc("13", "Zoe Rivera", "3", under("10")));
    expect((await diffsOf("Rivera Family")).map((d) => d.kind)).toEqual(["parent_customers"]);
  });

  it("the status, and the filters and their counts: a carried-over family with differences under both, a confirmed one only under Linked, with differences", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera(); // the Riveras match the books; the Chens have Mei Chen's Parent customer with no guardian
    await readAgain(qc("70", "Patel Family", "1"), qc("71", "Asha Patel", "3", under("70")));
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", { ...asOp(treasurer), permission: "Accounting.Link.ReadWrite", mayChangeFamilies: false }, customerAimedAt)).toMatchObject({ ok: true });
    changeInBooks("70", { DisplayName: "Patel Household" });
    await readAgain();
    const view = await loadAccountingLinks();
    expect(rowOf(view, "Rivera Family").status).toEqual({ key: "carried_over", at: expect.any(String) });
    expect(rowOf(view, "Chen Family").status).toEqual({ key: "with_differences", made: { key: "carried_over", at: expect.any(String) } });
    expect(rowOf(view, "Patel Family").status).toEqual({ key: "with_differences", made: { key: "linked", origin: "confirmed", by: "treasurer", at: expect.any(String) } });
    const names = (status: string) => filterLinkRows(view.rows, parseLinksFilter({ status })).map((r) => r.name);
    expect(names("carried_over")).toEqual(["Chen Family", "Rivera Family"]);
    expect(names("with_differences")).toEqual(["Chen Family", "Patel Family"]);
    expect(names("linked")).toEqual([]);
    await asAdmin();
    const whole = await renderPage(AccountingLinksPage);
    const html = list(whole);
    expect(html).toContain('<option value="" selected="">Every status (3)</option>'); // no status asked for: React marks the empty option
    expect(html).toContain('<option value="carried_over">Carried over (2)</option>');
    expect(html).toContain('<option value="linked">Linked (0)</option>');
    expect(html).toContain('<option value="with_differences">Linked, with differences (2)</option>');
    expect(html).toContain("1 family whose link was carried over has differences, so it is counted under both Carried over and Linked, with differences.");
    expect(whole).toContain("A family whose link was carried over and that has differences is found under both Carried over and Linked, with differences, and counted under both.");
    // Each row says how its link was made, beside its differences.
    expect(rowNamed(html, "Patel Family")![3]).toMatch(/^Linked, with differencesConfirmed by treasurer, on this page or with “Create a family from this”, on .+\. 1 difference with the books: names\.$/);
    expect(rowNamed(html, "Chen Family")![3]).toMatch(/^Linked, with differencesCarried over from the roster by the portal, on .+\. Nobody has confirmed it since\. 1 difference with the books: Parent customers or guardians on one side only\.$/);
    const filtered = list(await renderPage(AccountingLinksPage, { searchParams: { status: "carried_over" } }));
    expect(tableRows(filtered).map((r) => r[0])).toEqual(["Chen Family", "Rivera Family"]);
  });

  it("says a kept change once, in its words, with Reconciliation's link and no button; and a waiting move as on its way", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    const rivera = await recordOfCustomer("10", "family"), chen = await recordOfCustomer("20", "family");
    const leo = await recordOfCustomer("12", "student");
    // A rename saved in the portal first that QuickBooks refused, kept.
    await db.update(family).set({ name: "Riveras" }).where(eq(family.id, rivera));
    await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" }, { state: "refused", code: "fault_6240" });
    // Leo moved to the Chens in the portal, the move waiting to reach QuickBooks.
    await db.update(student).set({ familyId: chen }).where(eq(student.id, leo));
    await seedQueued({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "10", toFamilyQboId: "20", fromFamilyId: rivera, toFamilyId: chen });
    const view = await loadAccountingLinks();
    const kept = "QuickBooks refused it: that name is already used in QuickBooks (by another customer, a vendor or an employee), and every name there must be different.";
    // Leo's customer stays under the Riveras in the books: their row tells it too, with the move's words.
    expect(rowOf(view, "Riveras").differences).toEqual([{ kind: "name", of: "family", portal: "Riveras", books: "Rivera Family", queue: { state: "refused", words: kept } },
      { kind: "student_elsewhere", books: "Leo Rivera", studentId: leo, portal: { at: "family", family: "Chen Family" }, queue: { state: "waiting", words: "Waiting to reach QuickBooks" } }]);
    expect(rowOf(view, "Chen Family").differences).toContainEqual({ kind: "place", who: "Leo Rivera", studentId: leo,
      place: { at: "other_family", familyQboId: "10", familyName: "Rivera Family" }, queue: { state: "waiting", words: "Waiting to reach QuickBooks" } });
    await asAdmin();
    const html = list(await renderPage(AccountingLinksPage));
    expect(html.split(kept).length - 1).toBe(1);
    expect(rowNamed(html, "Riveras")![4]).toContain(`The family's name. In the portal: “Riveras”. In the books: “Rivera Family”. ${kept} See the change on Reconciliation`);
    expect(rowNamed(html, "Chen Family")![4]).toContain("Where Leo Rivera is. In the portal: In this family. In the books: Under Rivera Family in QuickBooks. Waiting to reach QuickBooks. See the change on Reconciliation");
    expect(html.split('href="/staff/reconciliation#writes-h"').length - 1).toBe(3);
    // No button but the filter's own, since slice M3a2 each carried-over row's Confirm this link, and since slice M3b each
    // linked row's Unlink from the books, and since slice M4a the kept rename's Take QuickBooks' into the app (a waiting
    // move offers none); nothing of money but each unlink's own words of what the guardians then read.
    expect(html.split("<button").length - 1).toBe(6);
    expect(html.split("Take QuickBooks&#x27; into the app<span").length - 1).toBe(1);
    expect(html.split("Confirm this link<span").length - 1).toBe(2);
    expect(html.split("Unlink from the books<span").length - 1).toBe(2);
    expect(html.split("invoices").length - 1).toBe(2);
    expect(html.split("with no invoices, Pay or buy-out offer").length - 1).toBe(2);
  });

  it("says a stuck item, one QuickBooks took that the portal has to finish, a waiting student's create and a kept guardian's create each in the queue's words", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    const rivera = await recordOfCustomer("10", "family");
    // A rename saved in the portal first, stuck.
    await db.update(family).set({ name: "Riveras" }).where(eq(family.id, rivera));
    await seedQueued({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Riveras", was: "Rivera Family" }, { state: "stuck" });
    // The Chens made inactive: QuickBooks took it, and the portal has yet to finish it on its side.
    changeInBooks("20", { Active: false });
    await readAgain();
    await seedQueued({ op: "deactivate", role: "family", qboId: "20", syncToken: "0" }, { sent: true, code: "cache_failed" });
    // A student added to the Riveras, their create waiting, filed under their record.
    const [ivy] = await db.insert(student).values({ familyId: rivera, name: "Ivy Rivera", active: true }).returning({ id: student.id });
    const create = await seedQueued({ op: "create", role: "student", name: "Ivy Rivera", typeQboId: "3", familyQboId: "10", email: null });
    await db.update(writeQueue).set({ studentId: ivy!.id }).where(eq(writeQueue.id, create.id));
    // A guardian's Parent customer QuickBooks refused, kept.
    const sol = await guardianIn(rivera, "Sol Rivera", "sol@example.com");
    await seedQueued({ op: "create", role: "parent", name: "Sol Rivera", typeQboId: "2", familyQboId: "10", email: "sol@example.com", guardianId: sol }, { state: "refused", code: "fault_6240" });
    const view = await loadAccountingLinks();
    const kept = "QuickBooks refused it: that name is already used in QuickBooks (by another customer, a vendor or an employee), and every name there must be different.";
    const riveras = rowOf(view, "Riveras").differences;
    expect(riveras).toContainEqual({ kind: "name", of: "family", portal: "Riveras", books: "Rivera Family", queue: { state: "stuck", words: "Stuck: it needs someone to look at it" } });
    expect(riveras).toContainEqual({ kind: "student_unlinked", who: "Ivy Rivera", studentId: ivy!.id, queue: { state: "waiting", words: "Waiting to reach QuickBooks" } });
    expect(riveras).toContainEqual({ kind: "guardians_unlinked", count: 1, queue: [{ note: { state: "refused", words: kept }, count: 1 }] });
    expect(rowOf(view, "Chen Family").differences).toContainEqual({ kind: "active", of: "family", who: "Chen Family", portalActive: true,
      queue: { state: "waiting", words: "Done in QuickBooks: the portal finishes it on its side after its next read of QuickBooks" } });
    await asAdmin();
    const html = list(await renderPage(AccountingLinksPage));
    expect(rowNamed(html, "Riveras")![4]).toContain("Stuck: it needs someone to look at it. See the change on Reconciliation");
    expect(rowNamed(html, "Riveras")![4]).toContain(`For 1 of them: ${kept} See the change on Reconciliation`);
    expect(rowNamed(html, "Chen Family")![4]).toContain("Done in QuickBooks: the portal finishes it on its side after its next read of QuickBooks. See the change on Reconciliation");
    // With no successful read of the books on record, the page says so rather than a time.
    await db.delete(jobRun);
    expect(await renderPage(AccountingLinksPage)).toContain("against its copy of the books, though it hasn&#x27;t read the books yet.");
  });

  it("none for a family with no link, a Not a family now row or a Customer gone row, and an inactive family record isn't listed", async () => {
    tag = await connectRoster(stub);
    const hand = await unlinkedFamily("The Patels");
    await db.insert(student).values({ familyId: hand, name: "Asha Patel", active: true });
    changeInBooks("20", { CustomerTypeRef: { value: "4" } });
    await readAgain();
    let view = await loadAccountingLinks();
    expect(rowOf(view, "The Patels").differences).toEqual([]);
    expect(rowOf(view, "Chen Family")).toMatchObject({ status: { key: "not_a_family" }, differences: [] });
    stub.customers = stub.customers.filter((c) => c.Id !== "20" && c.Id !== "21");
    await readAgain();
    view = await loadAccountingLinks();
    expect(rowOf(view, "Chen Family")).toMatchObject({ status: { key: "customer_gone" }, differences: [] });
    // The inactive Old Family (40) is not listed at all.
    expect(view.rows.map((r) => r.name)).not.toContain("Old Family");
  });

  it("none in the three states where the books can't be checked, each warning saying so", async () => {
    tag = await connectRoster(stub);
    changeInBooks("10", { DisplayName: "Rivera Household" });
    await readAgain();
    expect((await diffsOf("Rivera Family")).length).toBeGreaterThan(0);
    await asAdmin();
    const noneIn = async () => { const v = await loadAccountingLinks(); expect(v.rows.map((r) => r.differences)).toEqual(v.rows.map(() => [])); return v.state; };
    const SAYS = "Differences between the portal and the books aren&#x27;t checked either.";
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    expect(await noneIn()).toBe("other_company");
    expect(await renderPage(AccountingLinksPage)).toContain(SAYS);
    await db.update(qboConnection).set({ realmId: REALM });
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "3"));
    expect(await noneIn()).toBe("no_shape");
    expect(await renderPage(AccountingLinksPage)).toContain(SAYS);
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await noneIn()).toBe("no_company");
    expect(await renderPage(AccountingLinksPage)).toContain(SAYS);
  });

  it("draws the differences as text, a books name holding markup escaped, with the copy's time, and writes nothing", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    changeInBooks("10", { DisplayName: "<b>Bold</b> Rivera" });
    await readAgain();
    await asAdmin();
    const audits = (await db.select().from(auditLog)).length;
    const queue = await db.select().from(writeQueue);
    const whole = await renderPage(AccountingLinksPage);
    // Read as drawn: withoutIds() would put "<id>" in the family link's href, of which a cell's text would keep a piece.
    const html = list(whole);
    expect(html).not.toContain("<b>Bold</b>");
    expect(html).toContain("In the books: “&lt;b&gt;Bold&lt;/b&gt; Rivera”.");
    expect(html).toContain("<details class=\"more\"><summary>Students, guardians and differences<span class=\"visually-hidden\">: Rivera Family</span></summary>");
    expect(rowNamed(html, "Rivera Family")![4]).toBe("Students, guardians and differences: Rivera FamilyStudents:Leo Rivera: linked to Leo RiveraGuardians:Ana Rivera (ana@example.com): linked to Ana Rivera"
      + "Where the portal and the books differ:The family's name. In the portal: “Rivera Family”. In the books: “<b>Bold</b> Rivera”."
      // Since slice M4a, the press that takes the books' name, with what it does, the books' name as text.
      + "Takes “<b>Bold</b> Rivera” as this family's name in the portal, as the books have it. Nothing is sent to the books.Take QuickBooks' into the app: Rivera Family's name"
      + riveraPresses("<b>Bold</b> Rivera"));
    // The books' values are the portal's copy from its last read, said with its time; drawing the page settles nothing
    // (since slice M4a a press may take some of them into the portal, and says which).
    expect(whole).toContain("against its copy of the books, from its last read of them on ");
    expect(whole).toContain("with Take QuickBooks&#x27; into the app, which changes only the portal&#x27;s records, except that a student&#x27;s move voids an unpaid volunteer buy-out invoice of theirs in the books, as any move does; every other difference is only shown.");
    expect((await db.select().from(auditLog)).length).toBe(audits);
    expect(await db.select().from(writeQueue)).toEqual(queue);
  });
});
