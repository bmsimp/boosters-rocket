import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, family, guardian, parent } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { AccessDenied } from "@/lib/guards";
import { DETAILS_GONE, phoneDigits } from "@/lib/accounting/link-details";
import { leaveUnlinked, reviewCarriedOver } from "@/lib/accounting/link-writes";
import { loadAccountingLinks } from "@/lib/accounting/mapping";
import { refreshRoster } from "@/lib/roster/refresh";
import { addFamily } from "@/lib/roster/writes";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { linkDetailsAction } from "@/app/staff/(app)/links/actions";
import AccountingLinksPage from "@/app/staff/(app)/links/page";
import { resetDb, seedParent, seedStaff } from "../helpers/db";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, auditsOf, connectRoster, seedAnaRivera, staffWith, WORKER } from "../helpers/roster-writes";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";

/**
 * Show details on Accounting links (the redesign the owner approved on 2026-11-27; src/lib/accounting/link-details.ts):
 * one family beside its record in the books, loaded only when asked for, for a family the screen lists, and audited as a
 * staff read of one family's contact details before it answers. The list itself never carries a phone, and each row's
 * main press fits its status. The company is fznCompany()'s (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
const phone = (n: string) => ({ PrimaryPhone: { FreeFormNumber: n } });
async function readAgain(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}
const changeInBooks = (id: string, change: Record<string, unknown>) => { stub.customers = stub.customers.map((c) => (c.Id === id ? { ...c, ...change } : c)); };

let tag: string;
let linker: Awaited<ReturnType<typeof staffWith>>;
const linkOp = () => ({ actor: { door: "staff" as const, id: linker.id, label: linker.email }, ip: "203.0.113.9", permission: "Accounting.Link.ReadWrite", staffUserId: linker.id });

/** A family added in the portal by someone who may not link it: active, with no link, and one guardian. */
async function unlinkedFamily(name: string, email: string): Promise<AppFamilyId> {
  const op = asOp(await seedStaff({ email: `adder.${name.toLowerCase().replace(/\W+/g, ".")}@club.org`, name: "Adder" }));
  expect(await addFamily({ role: "family", name, typeQboId: null }, tag, { ...op, mayLink: false })).toMatchObject({ ok: true, unlinked: true });
  const id = (await db.select({ id: family.id }).from(family).where(eq(family.name, name)))[0]!.id;
  const p = await seedParent({ name: `${name} Parent`, email });
  await db.insert(guardian).values({ parentId: p.id, familyId: id, status: "invited" });
  return id;
}

beforeEach(async () => {
  await resetDb(); stub.reset();
  linker = await staffWith("linker@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
  tag = await connectRoster(stub);
});

const detailAudits = () => auditsOf("accounting.link.details.read");

describe("Show details", () => {
  it("loads one family beside its record in the books, each item marked, and writes exactly one audit row naming the family", async () => {
    const { ana } = await seedAnaRivera();
    await db.update(parent).set({ phone: "(555) 010-2000" }).where(eq(parent.id, ana.id));
    changeInBooks("10", { ...mail("ana@example.com"), ...phone("555.010.2000") });
    await readAgain();
    const rivera = await recordOfCustomer("10", "family");
    asStaff(linker);
    const r = await linkDetailsAction(String(rivera));
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.details).toEqual({
      family: "Rivera Family",
      portal: {
        guardians: [{ name: "Ana Rivera", email: "ana@example.com", emailMark: "matched", phone: "(555) 010-2000", phoneMark: "matched", blocked: false }],
        students: [{ name: "Leo Rivera", mark: "matched" }],
      },
      books: {
        name: "Rivera Family", email: "ana@example.com", emailMark: "matched", phone: "555.010.2000", phoneMark: "matched",
        under: [{ name: "Ana Rivera", kind: "parent", active: true, mark: "matched" }, { name: "Leo Rivera", kind: "student", active: true, mark: "matched" }],
      },
      possible: [],
      confirms: "Confirm this link marks it as checked, with Leo Rivera.",
    });
    const audits = await detailAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ door: "staff", actorId: linker.id, permission: "Accounting.Link.ReadWrite", targetType: "family", targetId: String(rivera) });
    // Each opening is its own read.
    expect((await linkDetailsAction(String(rivera))).ok).toBe(true);
    expect(await detailAudits()).toHaveLength(2);
  });

  it("marks what differs and what only the books have, a phone by its digits", async () => {
    const { ana } = await seedAnaRivera();
    await db.update(parent).set({ phone: "555-010-9999" }).where(eq(parent.id, ana.id));
    changeInBooks("10", { ...mail("someone.else@example.com"), ...phone("1 (555) 010-2000") });
    await readAgain(qc("13", "Mia Rivera", "3", { ParentRef: { value: "10" }, Job: true, Active: false }));
    asStaff(linker);
    const r = await linkDetailsAction(String(await recordOfCustomer("10", "family")));
    if (!r.ok) throw new Error(r.errors.join(" "));
    expect(r.details.books).toMatchObject({ emailMark: "differs", phoneMark: "differs" });
    expect(r.details.books!.under).toContainEqual({ name: "Mia Rivera", kind: "student", active: false, mark: "only_books" });
    // Ana's address is still on her Parent customer under the family's.
    expect(r.details.portal.guardians[0]).toMatchObject({ emailMark: "matched", phoneMark: null });
    expect(phoneDigits("1 (555) 010-2000")).toBe(phoneDigits("555.010.2000"));
    expect(phoneDigits("12")).toBeNull();
  });

  it("answers nothing, and writes no audit row, for a family the screen doesn't list, an unknown id, a customer's id or anything that isn't an id", async () => {
    await seedAnaRivera();
    const chen = await recordOfCustomer("20", "family");
    await db.update(family).set({ active: false }).where(eq(family.id, chen));
    asStaff(linker);
    for (const id of [String(chen), crypto.randomUUID(), "10", "not-an-id", "", "x".repeat(65)]) {
      expect(await linkDetailsAction(id), id).toEqual({ ok: false, errors: [DETAILS_GONE] });
    }
    for (const bad of [null, 42, { id: String(chen) }, [String(chen)]]) expect(await linkDetailsAction(bad as never)).toEqual({ ok: false, errors: [DETAILS_GONE] });
    expect(await detailAudits()).toEqual([]);
  });

  it("is refused to staff without the linking permission, or without Roster.Read, and reads nothing", async () => {
    await seedAnaRivera();
    const rivera = String(await recordOfCustomer("10", "family"));
    for (const who of [await staffWith("reader@club.org", ["Roster.Read"]), await staffWith("half@club.org", ["Accounting.Link.ReadWrite"])]) {
      asStaff(who);
      await expect(linkDetailsAction(rivera)).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(await detailAudits()).toEqual([]);
  });
});

describe("the list", () => {
  it("never carries a phone, from the portal or the books, and opening it writes no audit row", async () => {
    const { ana } = await seedAnaRivera();
    await db.update(parent).set({ phone: "(555) 010-2000" }).where(eq(parent.id, ana.id));
    changeInBooks("10", phone("555.010.3000"));
    await readAgain();
    asStaff(linker);
    const html = await renderPage(AccountingLinksPage);
    expect(html).toContain("Rivera Family");
    // fznCompany()'s own phones (Ana Rivera's Parent customer, Lincoln High, No Type At All) are in the cache too.
    for (const p of ["010-2000", "010.3000", "555-0101", "555-0199", "555-0160"]) expect(html, p).not.toContain(p);
    const rivera = String(await recordOfCustomer("10", "family"));
    expect(await renderPage(AccountingLinksPage, { searchParams: { review: rivera } })).not.toContain("010-2000");
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "accounting.link.details.read"))).toEqual([]);
  });

  it("gives each status the main press the approved table names, and none to the others", async () => {
    await seedAnaRivera();
    // Suggested by email; No match; 2 possible; Left unlinked; Linked (Rivera, confirmed); Carried over (Pine); Linked, 2 differ (Chen).
    // Pine's records are carried over by the import, as migration 0023 made them, before any family is added by hand.
    await readAgain(qc("95", "Pine Family", "1"), qc("96", "Pia Pine", "3", { ParentRef: { value: "95" }, Job: true }));
    await syncAppRecords();
    tag = await currentRosterTag();
    await unlinkedFamily("The Patels", "asha@example.com");
    await unlinkedFamily("The Nobodies", "nobody@example.com");
    await unlinkedFamily("The Twins", "twin@example.com");
    const lefts = await unlinkedFamily("The Lefts", "left@example.com");
    await readAgain(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("80", "Twin A", "1", mail("twin@example.com")), qc("81", "Twin B", "1", mail("twin@example.com")));
    expect(await leaveUnlinked(String(lefts), tag, linkOp())).toMatchObject({ ok: true });
    const rivera = await recordOfCustomer("10", "family");
    const riveraRow = (await loadAccountingLinks()).rows.find((r) => r.familyId === rivera)!;
    expect(await reviewCarriedOver({ familyId: String(rivera), linkId: riveraRow.review!.linkId, stamp: riveraRow.review!.stamp }, tag, linkOp())).toMatchObject({ ok: true });
    changeInBooks("20", { DisplayName: "Chen Household" });
    await readAgain();

    asStaff(linker);
    const html = await renderPage(AccountingLinksPage);
    const mainOf = (name: string) => {
      const row = [...html.matchAll(/<tr role="row">([\s\S]*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes(`>${name}</a></th>`));
      if (row === undefined) throw new Error(`no row for ${name}`);
      const cell = row.slice(row.indexOf("links-acts-cell")).split("<dialog")[0]!;
      return [...cell.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!.replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, "").trim());
    };
    expect(mainOf("The Patels")).toEqual(["Show details", "Confirm link"]);
    expect(mainOf("The Nobodies")).toEqual(["Show details", "Pick a customer"]);
    expect(mainOf("The Twins")).toEqual(["Show details", "Pick a customer"]);
    expect(mainOf("The Lefts")).toEqual(["Show details"]);
    expect(mainOf("Rivera Family")).toEqual(["Show details"]);
    expect(mainOf("Pine Family")).toEqual(["Show details", "Confirm this link"]);
    expect(mainOf("Chen Family")).toEqual(["Show details", "Settle 2 differences"]);
    // The status label says how each matched.
    for (const [name, words] of [["The Patels", "Patel FamilySuggested by email"], ["The Nobodies", "No match"], ["The Twins", "2 possible"], ["The Lefts", "Left unlinked"],
      ["Rivera Family", "Rivera FamilyLinked"], ["Pine Family", "Pine FamilyCarried over"], ["Chen Family", "Chen HouseholdLinked, 2 differ"]] as const) {
      const row = [...html.matchAll(/<tr role="row">([\s\S]*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes(`>${name}</a></th>`))!;
      const match = row.match(/<span class="links-match">([\s\S]*?)<\/span><\/div>/)![1]!.replace(/<[^>]+>/g, "");
      expect(match, name).toBe(words);
    }
  });
});
