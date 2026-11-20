import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, pageOutcome, renderPage, withoutIds } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, qboConnection, qboCustomerType, setting } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { filterLinkRows, loadAccountingLinks, type LinkRow, type LinksView } from "@/lib/accounting/mapping";
import { parseLinksFilter } from "@/lib/accounting/status";
import { familyFromCustomer } from "@/lib/roster/no-family";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily } from "@/lib/roster/writes";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { SOURCE_KEY } from "@/lib/roster/source";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent, seedStaff } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, connectRoster, seedAnaRivera, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { rowNamed, tableRows } from "../helpers/table";

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

/** Customers added or changed in QuickBooks, then read by a roster read (which makes no record of them). */
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
/** One customer of the stub changed, as an edit made in QuickBooks. */
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

let tag: string;
/** A family added in the portal by someone who may not link it: active, with no link. */
async function unlinkedFamily(name: string): Promise<AppFamilyId> {
  const op = asOp(await seedStaff({ email: `adder.${name.toLowerCase().replace(/\W+/g, ".")}@club.org`, name: "Adder" }));
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  return (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
}
/** An open guardian row of this person in this family record (the person made once, by their address). */
const people = new Map<string, string>();
async function guardianIn(familyId: AppFamilyId, name: string, email: string, status: "invited" | "active" | "disabled" = "invited") {
  const parentId = people.get(email) ?? (await seedParent({ name, email })).id;
  people.set(email, parentId);
  await db.insert(guardian).values({ parentId, familyId, familyQboId: null, status, disabledReason: status === "disabled" ? "removed" : null });
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
    expect(await familyFromCustomer("70", { ...asOp(treasurer), permission: "Accounting.Link.ReadWrite", mayChangeFamilies: false })).toMatchObject({ ok: true });
    const patel = rowOf(await loadAccountingLinks(), "Patel Family");
    expect(patel.status).toEqual({ key: "linked", origin: "confirmed", by: "treasurer", at: expect.any(String) });
    expect(patel.students.map((s) => s.link)).toEqual([{ state: "linked", customer: "Asha Patel" }]);
    expect(patel.guardians).toEqual([]);
  });

  it("tells a customer gone from the books, and keeps the link as it is", async () => {
    tag = await connectRoster(stub);
    stub.customers = stub.customers.filter((c) => c.Id !== "20" && c.Id !== "21");
    await readAgain();
    expect(await statusOf("Chen Family")).toEqual({ key: "customer_gone" });
    expect(rowOf(await loadAccountingLinks(), "Chen Family").customer).toBeNull();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.customerId, "20"))).toHaveLength(1);
  });

  it("tells a linked customer that isn't a family now apart from one that is gone: inactive, another type, under another customer", async () => {
    tag = await connectRoster(stub);
    await readAgain(qc("70", "Patel Family", "1"));
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", { ...asOp(treasurer), permission: "Accounting.Link.ReadWrite", mayChangeFamilies: false })).toMatchObject({ ok: true });
    changeInBooks("10", { Active: false });
    changeInBooks("20", { CustomerTypeRef: { value: "4" } });
    changeInBooks("70", under("30"));
    await readAgain();
    expect(await statusOf("Rivera Family")).toEqual({ key: "not_a_family", reasons: ["inactive"] });
    expect(await statusOf("Chen Family")).toEqual({ key: "not_a_family", reasons: ["other_type"] });
    expect(await statusOf("Patel Family")).toEqual({ key: "not_a_family", reasons: ["under_another"] });
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
    await readAgain(qc("90", "Quiet Family", "1", { Active: false, ...mail("zoe@example.com") }), qc("91", "nobody@example.com", "1"));
    const a = await unlinkedFamily("Family A");
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
  });
});

describe("the books' shape", () => {
  it("in flat books suggests the member by its own field, never by a customer under it", async () => {
    tag = await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("80", "Okafor Family", "1"), qc("81", "Ike Okafor", "2", { ...under("80"), ...mail("ike@example.com") }));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const okafors = await unlinkedFamily("The Okafors");
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
    asStaff(await staffWith("linker@club.org", ["Accounting.Link.ReadWrite"]));
    expect(await pageOutcome(AccountingLinksPage)).toEqual({ redirect: "/refused" });
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    expect(await pageOutcome(AccountingLinksPage)).toEqual({ redirect: "/refused" });
  });

  it("draws each row with its family, addresses, customer and status, opens to students and guardians, and writes nothing", async () => {
    tag = await connectRoster(stub);
    await seedAnaRivera();
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinkedFamily("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    await asAdmin();
    const audits = (await db.select().from(auditLog)).length;
    const html = withoutIds(list(await renderPage(AccountingLinksPage)));
    expect(tableRows(html)).toHaveLength(3);
    const rivera = rowNamed(html, "Rivera Family")!;
    expect(rivera.slice(0, 3)).toEqual(["Rivera Family", "ana@example.com", "Rivera FamilyNo email address"]);
    expect(rivera[3]).toMatch(/^Carried overCarried over from the roster when the portal's families were first set up, on .+\. Nobody has confirmed it since\.$/);
    expect(rivera[4]).toBe("Students and guardians: Rivera FamilyStudents:Leo Rivera: linked to Leo RiveraGuardians:Ana Rivera (ana@example.com): linked to Ana Rivera");
    const patel = rowNamed(html, "The Patels")!;
    expect(patel.slice(1)).toEqual(["asha@example.com", "Patel Familyasha@example.com",
      "SuggestedA guardian's sign-in address matches: asha@example.com, on this customer.",
      "Students and guardians: The PatelsNo active students.Guardians:Asha Patel (asha@example.com): no link of its own"]);
    expect(html).toContain('href="/staff/roster/<id>"');
    expect(html).toContain("<details class=\"more\"><summary>Students and guardians<span class=\"visually-hidden\">: The Patels</span></summary>");
    expect((await db.select().from(auditLog)).length).toBe(audits);
    // The customers with no family stay on Reconciliation, linked from here.
    expect(await renderPage(AccountingLinksPage)).toContain('href="/staff/reconciliation#no-family-h"');
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
    expect(html).toContain('<option value="">Every status (3)</option>');
    expect(html).toContain('<option value="carried_over">Carried over (2)</option>');
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
    const html = await renderPage(AccountingLinksPage);
    expect(html).toContain("QuickBooks is connected to a different company than the one the roster was read from, so no link is read and nothing is suggested.");
    expect(tableRows(list(html)).map((r) => r[3]!.startsWith("Not checked"))).toEqual([true, true]);
    expect(list(html)).not.toContain('href="/staff/roster/');
  });
});
