import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asStaff, renderPage, revalidatedPaths } from "../helpers/signed-in";

// Every request goes to the QuickBooks stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, qboConnection, qboCustomer, qboCustomerType, setting, student } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { addGuardian } from "@/lib/parents/guardians";
import { customersWithNoFamily, familyFromCustomer, isSecondFamilyLink, NO_FAMILY_COPY } from "@/lib/roster/no-family";
import { customerAimedAt, leaveUnlinked } from "@/lib/accounting/link-writes";
import { rosterEntry } from "@/lib/roster/queries";
import { refreshRoster } from "@/lib/roster/refresh";
import { askRosterWrite } from "@/lib/roster/writes";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { ROSTER_LOCK, SHAPE_KEY } from "@/lib/roster/shape";
import { SOURCE_KEY } from "@/lib/roster/source";
import { familyFromCustomerAction } from "@/app/staff/(app)/reconciliation/family-actions";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import { resetDb, seedParent, untilALockIsAwaited } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { asOp, connectRoster, REALM, seedQueued, staffWith, WORKER } from "../helpers/roster-writes";
import { appRecordRows, NO_CHANGES, recordOfCustomer, whatAFreshRunWouldChange } from "../helpers/app-records";
import { rowNamed, tableRows } from "../helpers/table";
import { stubInvoice } from "../helpers/money";

/**
 * Customers with no family (stage 3's slice 10 of the app-owned families spec, open question 19): since slice 9c a
 * family customer added in QuickBooks gets no family in the portal, so Reconciliation lists the customers the shape
 * calls a family that no family is linked to, and "Create a family from this" makes one, with its students, each linked
 * to its customer, confirmed by the staff member who asked (src/lib/roster/no-family.ts). The company is fznCompany()'s
 * (tests/helpers/qbo-stub.ts): Family 1, Parent 2, Student 3, School 4; the Rivera (10) and Chen (20) families have
 * their records. Customers added after it are read by a roster read, which makes no record, as in the portal.
 */
vi.setConfig({ testTimeout: 30_000 });

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });
let tag: string;

/** A customer as QuickBooks answers it, as fznCompany() writes them. */
const qc = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
  Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
  ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
});
const under = (id: string) => ({ ParentRef: { value: id }, Job: true });

/** Customers added in QuickBooks, then read by a roster read (which, since slice 9c, makes no record of them). */
async function addInQuickBooks(...customers: ReturnType<typeof qc>[]) {
  stub.customers.push(...customers);
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${JSON.stringify(r)}`);
}

/** The Patel family added in QuickBooks: Asha (a student), Ravi (a student made inactive) and Nita (a parent). */
const PATELS = [qc("70", "Patel Family", "1"), qc("71", "Asha Patel", "3", under("70")), qc("72", "Ravi Patel", "3", { ...under("70"), Active: false }),
  qc("73", "Nita Patel", "2", under("70"))];

/** How the action calls familyFromCustomer() for a staff member with the linking permission (and, unless told, Roster.Family.ReadWrite). */
const asLinker = (staff: { id: string; email: string }, mayChangeFamilies = true) => ({ ...asOp(staff), permission: "Accounting.Link.ReadWrite", mayChangeFamilies });
/** The family record a customer's family link names, as made by a press. */
const madeFamilyOf = async (customerId: string) => (await familyLinksOf(customerId))[0]!.familyId!;

const listed = async () => {
  const list = await customersWithNoFamily();
  return list.state === "listed" ? list.customers : list.state;
};
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((a) => a.action === action);
const familyLinksOf = (customerId: string) => db.select().from(accountingLink)
  .where(and(eq(accountingLink.realmId, REALM), eq(accountingLink.customerId, customerId), isNotNull(accountingLink.familyId)));
const studentLinkOf = async (customerId: string) => (await db.select().from(accountingLink)
  .where(and(eq(accountingLink.realmId, REALM), eq(accountingLink.customerId, customerId), isNotNull(accountingLink.studentId))))[0];

describe("the customers no family is linked to", () => {
  it("lists a family-type customer with no family link, with the students QuickBooks holds directly under it", async () => {
    await connectRoster(stub);
    expect(await listed()).toEqual([]); // every family of the company has its record
    await addInQuickBooks(...PATELS);
    expect(await listed()).toEqual([{ qboId: "70", name: "Patel Family", students: 2, inactiveStudents: 1, studentsWithRecord: 0 }]);
  });

  it("leaves out an inactive customer, a sub-customer, a customer of another type, a student, and a family already linked", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("80", "Okafor Family", "1", { Active: false }), qc("85", "Branch Family", "1", under("10")),
      qc("86", "Westside School", "4"), qc("87", "Lone Student", "3"), qc("88", "No Type", null));
    // 10 and 20 have their records; 40 (Old Family) is inactive and has its record too.
    expect(await listed()).toEqual([]);
  });

  it("counts a student under it whose record is another family's: QuickBooks moved them, the portal didn't", async () => {
    await connectRoster(stub);
    stub.customers = stub.customers.map((c) => (c.Id === "12" ? { ...c, ...under("70") } : c)); // Leo Rivera, moved in QuickBooks
    await addInQuickBooks(...PATELS);
    expect(await listed()).toEqual([{ qboId: "70", name: "Patel Family", students: 3, inactiveStudents: 1, studentsWithRecord: 1 }]);
  });

  it("in flat books lists a member with no family link, with no students", async () => {
    await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    await addInQuickBooks(qc("70", "Patel Family", "1"), qc("71", "Asha Patel", "3", under("70")));
    expect(await listed()).toEqual([{ qboId: "70", name: "Patel Family", students: 0, inactiveStudents: 0, studentsWithRecord: 0 }]);
  });

  it("lists nothing while the cache names no company, QuickBooks is connected to another company, or the shape is missing or broken", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    expect(await listed()).toBe("other_company");
    await db.update(qboConnection).set({ realmId: REALM });
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "3")); // the shape's student type, gone from QuickBooks
    expect(await listed()).toBe("no_shape");
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect(await listed()).toBe("no_shape");
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await listed()).toBe("no_company");
  });
});

describe("Create a family from this", () => {
  it("makes the family and its students, named and active as their customers, each linked and confirmed by who asked, with one audit row", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    const treasurer = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    const r = await familyFromCustomer("70", asLinker(treasurer), customerAimedAt);
    expect(r).toEqual({ ok: true, message: "Patel Family is a family in the portal now, linked to its QuickBooks customer, with 2 students. Nobody can sign in for it yet: add its guardians on its page, under Families." });

    const [link] = await familyLinksOf("70");
    expect(link).toMatchObject({ system: "quickbooks", origin: "confirmed", linkedBy: treasurer.id });
    const [made] = await db.select().from(family).where(eq(family.id, link!.familyId!));
    expect(made).toMatchObject({ name: "Patel Family", active: true });
    const kids = await db.select().from(student).where(eq(student.familyId, made!.id));
    expect(kids.map((k) => ({ name: k.name, active: k.active })).sort((a, b) => (a.name! < b.name! ? -1 : 1)))
      .toEqual([{ name: "Asha Patel", active: true }, { name: "Ravi Patel", active: false }]);
    for (const id of ["71", "72"]) expect(await studentLinkOf(id), id).toMatchObject({ origin: "confirmed", linkedBy: treasurer.id });
    expect(await studentLinkOf("73")).toBeUndefined(); // a parent: no record, and no guardian either
    // Each new link starts aligned with its customer's version in the cache (stage 3's slice 9e), as 0041 filled them.
    const cacheToken = async (id: string) => (await db.select({ token: qboCustomer.syncToken }).from(qboCustomer).where(eq(qboCustomer.qboId, id)))[0]!.token;
    expect(link!.syncedToken).toBe(await cacheToken("70"));
    expect(link!.syncedAt).not.toBeNull();
    for (const id of ["71", "72"]) expect((await studentLinkOf(id))!.syncedToken, id).toBe(await cacheToken(id));

    const [row] = await audits("accounting.family.from_customer");
    expect(row).toMatchObject({ actorId: treasurer.id, permission: "Accounting.Link.ReadWrite", targetType: "family", targetId: String(made!.id), ip: "203.0.113.9" });
    expect(row!.after).toMatchObject({ familyId: String(made!.id), name: "Patel Family", customerQboId: "70", realmId: REALM, studentsLeftAlone: [] });
    expect((row!.after as { studentsMade: { customerQboId: string }[] }).studentsMade.map((s) => s.customerQboId).sort()).toEqual(["71", "72"]);

    // A family like any other: on the Families pages, with its customer and its students' joined, so staff can add
    // its guardians and make changes to it from its page.
    const entry = await rosterEntry(made!.id);
    expect(entry?.family).toMatchObject({ name: "Patel Family", active: true, customer: { qboId: "70" } });
    expect(entry!.family.students.map((k) => [k.name, k.customer?.qboId]).sort()).toEqual([["Asha Patel", "71"], ["Ravi Patel", "72"]]);
    expect(entry!.family.parents.map((p) => p.qboId)).toEqual(["73"]);

    // It is off the list, and an import run now would make it as it is: the import's own rules made it.
    expect(await listed()).toEqual([]);
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });

  it("leaves a student whose record is another family's exactly as it is, and says so", async () => {
    await connectRoster(stub);
    const leo = await recordOfCustomer("12", "student");
    const rivera = await recordOfCustomer("10", "family");
    stub.customers = stub.customers.map((c) => (c.Id === "12" ? { ...c, ...under("70") } : c));
    await addInQuickBooks(...PATELS);
    const leoBefore = await db.select().from(student).where(eq(student.id, leo));
    const linkBefore = await studentLinkOf("12");
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    const r = await familyFromCustomer("70", asLinker(staff), customerAimedAt);
    expect(r).toEqual({ ok: true, message: "Patel Family is a family in the portal now, linked to its QuickBooks customer, with 2 students. 1 student under it in QuickBooks already had a record in the portal and was left as it was. Nobody can sign in for it yet: add its guardians on its page, under Families." });
    expect(await db.select().from(student).where(eq(student.id, leo))).toEqual(leoBefore);
    expect(leoBefore[0]!.familyId).toEqual(rivera);
    expect(await studentLinkOf("12")).toEqual(linkBefore);
    const [row] = await audits("accounting.family.from_customer");
    expect((row!.after as { studentsLeftAlone: unknown[] }).studentsLeftAlone).toEqual([{ studentId: String(leo), customerQboId: "12" }]);
  });

  it("leaves a student whose record is inactive and in no family exactly as it is, and says so", async () => {
    await connectRoster(stub);
    // Sam's customer was off the roster when the records were made: his record is inactive, in no family, linked to
    // his customer (as migration 0023 made one). QuickBooks now holds him under the Patel family; a read changes no record.
    const sam = await recordOfCustomer("74", "student");
    await addInQuickBooks(...PATELS, qc("74", "Sam Patel", "3", under("70")));
    const samBefore = await db.select().from(student).where(eq(student.id, sam));
    expect(samBefore[0]).toMatchObject({ active: false, familyId: null });
    const linkBefore = await studentLinkOf("74");
    expect(await listed()).toEqual([{ qboId: "70", name: "Patel Family", students: 3, inactiveStudents: 1, studentsWithRecord: 1 }]);
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual({ ok: true, message: "Patel Family is a family in the portal now, linked to its QuickBooks customer, with 2 students. 1 student under it in QuickBooks already had a record in the portal and was left as it was. Nobody can sign in for it yet: add its guardians on its page, under Families." });
    expect(await db.select().from(student).where(eq(student.id, sam))).toEqual(samBefore);
    expect(await studentLinkOf("74")).toEqual(linkBefore);
    const kids = await db.select({ name: student.name }).from(student).where(eq(student.familyId, await madeFamilyOf("70")));
    expect(kids.map((k) => k.name).sort()).toEqual(["Asha Patel", "Ravi Patel"]);
    const [row] = await audits("accounting.family.from_customer");
    expect((row!.after as { studentsLeftAlone: unknown[] }).studentsLeftAlone).toEqual([{ studentId: String(sam), customerQboId: "74" }]);
  });

  it("tells a treasurer who may not change families that someone who may adds the guardians", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", asLinker(staff, false), customerAimedAt)).toEqual({ ok: true, message: "Patel Family is a family in the portal now, linked to its QuickBooks customer, with 2 students. Nobody can sign in for it yet: someone who may change families adds its guardians on its page, under Families." });
  });

  it("leaves a family like any other: staff add a guardian and a student to it, and a page load reads its money", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    stub.invoices.push(stubInvoice("9001", "70", { TotalAmt: 20, Balance: 20 }));
    const staff = await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toMatchObject({ ok: true });
    const patels = await madeFamilyOf("70");

    expect(await addGuardian(patels, { name: "Nita Patel", email: "nita@example.com" }, asOp(staff))).toMatchObject({ ok: true, outcome: "added" });
    expect(await db.select({ status: guardian.status }).from(guardian).where(eq(guardian.familyId, patels))).toEqual([{ status: "invited" }]);
    expect(await askRosterWrite({ op: "create", role: "student", name: "Dev Patel", familyQboId: "70", email: null, typeQboId: null }, await currentRosterTag(), asOp(staff)))
      .toMatchObject({ ok: true });
    const kids = await db.select({ name: student.name }).from(student).where(eq(student.familyId, patels));
    expect(kids.map((k) => k.name).sort()).toEqual(["Asha Patel", "Dev Patel", "Ravi Patel"]);

    // Its money, through the family link the press confirmed, read live at the page load.
    expect((await loadFamilyMoney(patels)).figures).toMatchObject({ current: true, totalCents: 2000 });
  });

  it("answers in words when the unique index finds a family link made meanwhile outside the roster lock, keeping nothing", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    // A family link of the customer made by a transaction that takes no roster lock and hasn't committed: the press
    // can't see it, so its re-check of the list passes, and its insert of the link waits on the unique index.
    let commit = () => {};
    let other: Promise<void> = Promise.resolve();
    await new Promise<void>((ready) => {
      other = db.transaction(async (tx) => {
        const [f] = await tx.insert(family).values({ name: "Patel Family (made elsewhere)", active: true }).returning({ id: family.id });
        await tx.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "70", familyId: f!.id, origin: "confirmed", linkedBy: staff.id });
        ready();
        await new Promise<void>((r) => { commit = () => r(); });
      });
    });
    const press = familyFromCustomer("70", asLinker(staff), customerAimedAt);
    await untilALockIsAwaited(15_000, 1);
    commit();
    await other;
    expect(await press).toEqual({ ok: false, errors: [NO_FAMILY_COPY.already] });
    // Only the other transaction's family and link: the press kept nothing.
    const links = await familyLinksOf("70");
    expect(links).toHaveLength(1);
    expect((await db.select().from(family).where(eq(family.id, links[0]!.familyId!)))[0]!.name).toBe("Patel Family (made elsewhere)");
    expect(await db.select().from(family).where(eq(family.name, "Patel Family"))).toEqual([]);
    for (const id of ["71", "72"]) expect(await studentLinkOf(id), id).toBeUndefined();
    expect(await audits("accounting.family.from_customer")).toEqual([]);
  });

  it("knows a second family link by its index under any wrapping, and no other unique violation", () => {
    const violation = (constraint_name?: string) => ({ code: "23505", ...(constraint_name === undefined ? {} : { constraint_name }) });
    // As the import throws it: AppRecordsFailed, around drizzle's error, around the database's.
    expect(isSecondFamilyLink(new Error("records", { cause: new Error("query", { cause: violation("accounting_link_family_customer_uq") }) }))).toBe(true);
    expect(isSecondFamilyLink(new Error("records", { cause: new Error("query", { cause: violation("accounting_link_student_customer_uq") }) }))).toBe(false);
    expect(isSecondFamilyLink(violation())).toBe(false);
    expect(isSecondFamilyLink({ code: "23503", constraint_name: "accounting_link_family_customer_uq" })).toBe(false);
    expect(isSecondFamilyLink(new Error("something else"))).toBe(false);
    expect(isSecondFamilyLink(null)).toBe(false);
  });

  it("makes a member's family in flat books, with no students", async () => {
    await connectRoster(stub, { shape: { kind: "flat", memberTypeIds: ["1"] } });
    await addInQuickBooks(qc("70", "Patel Family", "1"), qc("71", "Asha Patel", "3", under("70")));
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toMatchObject({ ok: true });
    const [link] = await familyLinksOf("70");
    expect(await db.select().from(student).where(eq(student.familyId, link!.familyId!))).toEqual([]);
    expect(await studentLinkOf("71")).toBeUndefined();
  });

  it("makes one family for a second press, and for two presses at once", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    // Two at once: both wait for the roster lock, then one makes the family and the other finds it made.
    let release = () => {};
    let held: Promise<void> = Promise.resolve();
    await new Promise<void>((took) => {
      held = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
        took();
        await new Promise<void>((r) => { release = () => r(); });
      });
    });
    const presses = [familyFromCustomer("70", asLinker(staff), customerAimedAt), familyFromCustomer("70", asLinker(staff), customerAimedAt)];
    await untilALockIsAwaited(15_000, 2);
    release();
    await held;
    const answers = await Promise.all(presses);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.ok)).toEqual([{ ok: false, errors: [NO_FAMILY_COPY.already] }]);
    // And a press after them.
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.already] });
    expect(await familyLinksOf("70")).toHaveLength(1);
    expect(await db.select().from(student).where(eq(student.familyId, (await familyLinksOf("70"))[0]!.familyId!))).toHaveLength(2);
    expect(await audits("accounting.family.from_customer")).toHaveLength(1);
  });

  it("refuses, changing nothing, what isn't digits, a customer it doesn't offer, a family already linked, and while nothing can be listed", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS, qc("80", "Okafor Family", "1", { Active: false }), qc("85", "Branch Family", "1", under("10")), qc("86", "Westside School", "4"));
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    const before = await appRecordRows();
    const refused = (errors: string) => ({ ok: false, errors: [errors] });
    for (const odd of ["", "7O", "70 ", "-70", "1".repeat(20), "x".repeat(100)]) expect(await familyFromCustomer(odd, asLinker(staff), customerAimedAt), odd).toEqual(refused(NO_FAMILY_COPY.notFromPage));
    for (const id of ["80", "85", "86", "71", "73", "99999"]) expect(await familyFromCustomer(id, asLinker(staff), customerAimedAt), id).toEqual(refused(NO_FAMILY_COPY.notOffered));
    expect(await familyFromCustomer("10", asLinker(staff), customerAimedAt)).toEqual(refused(NO_FAMILY_COPY.already));

    await db.update(qboConnection).set({ realmId: "9130000000000999" });
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual(refused(NO_FAMILY_COPY.other_company));
    await db.update(qboConnection).set({ realmId: REALM });
    const shape = (await db.select().from(setting).where(eq(setting.key, SHAPE_KEY)))[0]!;
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual(refused(NO_FAMILY_COPY.no_shape));
    await db.insert(setting).values({ key: SHAPE_KEY, value: shape.value });
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual(refused(NO_FAMILY_COPY.no_company));

    expect(await appRecordRows()).toEqual(before);
    expect(await audits("accounting.family.from_customer")).toEqual([]);
  });
});

describe("the action and the Reconciliation section", () => {
  const NOT_FROM_PAGE = { ok: false, errors: [NO_FAMILY_COPY.notFromPage] };
  /** The section from its heading to the end of its box: a count or a row read from anywhere else isn't its. */
  const section = (html: string) => {
    const at = html.indexOf('id="no-family-h"');
    return at < 0 ? null : html.slice(at, html.indexOf("</section>", at));
  };

  it("is the linking permission's, with Roster.Read: refused without it, and for a parent", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    const { identity } = await seedSignedInParent();
    for (const who of [await staffWith("nobody@club.org", []), await staffWith("reader@club.org", ["Roster.Read", "Roster.Family.ReadWrite"])]) {
      asStaff(who);
      await expect(familyFromCustomerAction("70")).rejects.toBeInstanceOf(AccessDenied);
    }
    asParent(identity);
    await expect(familyFromCustomerAction("70")).rejects.toBeInstanceOf(AccessDenied);
    // The linking permission without the page's own: refused as a value no page sends.
    asStaff(await staffWith("linker@club.org", ["Accounting.Link.ReadWrite"]));
    expect(await familyFromCustomerAction("70")).toEqual(NOT_FROM_PAGE);
    expect(await familyLinksOf("70")).toEqual([]);
  });

  it("refuses values no page sends, and makes the family for staff who hold both, asking the pages to be read again", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS);
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    for (const odd of [undefined, null, 70, ["70"], { id: "70" }, "", "x".repeat(65)]) {
      expect(await familyFromCustomerAction(odd as never), JSON.stringify(odd)).toEqual(NOT_FROM_PAGE);
    }
    expect(await familyLinksOf("70")).toEqual([]);
    // A treasurer who may not change families is told who adds the guardians: the family's page offers them no add.
    const made = await familyFromCustomerAction("70");
    expect(made).toMatchObject({ ok: true });
    expect((made as { message: string }).message).toMatch(/Nobody can sign in for it yet: someone who may change families adds its guardians on its page, under Families\.$/);
    expect(await familyLinksOf("70")).toHaveLength(1);
    expect(revalidatedPaths()).toContain("/");
  });

  it("shows the list only to staff who may link families to accounting, the name as text, and what pressing makes", async () => {
    await connectRoster(stub);
    await addInQuickBooks(...PATELS, qc("75", "<b>Bold</b> Family", "1"));
    asStaff(await staffWith("reader@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    expect(section(await renderPage(ReconciliationPage))).toBeNull();
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    const html = section(await renderPage(ReconciliationPage))!;
    expect(html).toContain("Customers with no family");
    expect(html).toContain("It makes no guardian and gives nobody a sign-in: someone who may change families adds its guardians on the family&#x27;s page, under Families.");
    expect(tableRows(html)).toHaveLength(2);
    expect(rowNamed(html, "Patel Family")).toEqual(["Patel Family", "2 students, 1 inactive",
      "A family, linked to this customer, with 2 students, each linked to their own. 1 student is inactive in QuickBooks and stays inactive here.",
      "Create a family from this: Patel Family"]);
    // QuickBooks text is text: escaped, never markup.
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; Family");
    expect(html).not.toContain("<b>Bold</b>");
    expect(rowNamed(html, "<b>Bold</b> Family")).toEqual(["<b>Bold</b> Family", "None", "A family, linked to this customer.", "Create a family from this: <b>Bold</b> Family"]);
  });

  it("says so when every family customer has a family, and why when nothing can be listed", async () => {
    await connectRoster(stub);
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    let html = section(await renderPage(ReconciliationPage))!;
    expect(html).toContain("Nothing: every active family customer QuickBooks has at the top level, under no other customer, is linked to a family in the portal, or is about to be by a change on this page.");
    expect(tableRows(html)).toEqual([]);
    await db.delete(setting).where(eq(setting.key, SHAPE_KEY));
    html = section(await renderPage(ReconciliationPage))!;
    expect(html).toContain("the portal can&#x27;t tell which customers are families");
  });
});

describe("a customer meant for a family the portal has (stage 4's slice M3a2)", () => {
  const mail = (address: string) => ({ PrimaryEmailAddr: { Address: address } });
  const section = (html: string, id: string) => { const at = html.indexOf(`id="${id}"`); return at < 0 ? "" : html.slice(at, html.indexOf("</section>", at)); };
  /** A family the portal has with no link: a record of its own, active. */
  const unlinked = async (name: string) => (await db.insert(family).values({ name, active: true }).returning({ id: family.id }))[0]!.id;
  /** An open guardian row of a new person in this family record. */
  const guardianIn = async (familyId: Awaited<ReturnType<typeof unlinked>>, name: string, email: string) => {
    const p = await seedParent({ name, email });
    await db.insert(guardian).values({ parentId: p.id, familyId, status: "invited" });
  };
  /** Everything "Create a family from this" would make, read before and after a refusal. */
  const made = async () => ({ records: await appRecordRows(), audits: await audits("accounting.family.from_customer") });

  it("refuses a Suggested row's customer, a Several possible candidate and a given-up create's customer of an unlinked family, making nothing", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("75", "Okafor Family", "1", mail("ike@example.com")),
      qc("76", "Okafor Household", "1", mail("ada@example.com")), qc("90", "Quiet Family", "1"));
    const patels = await unlinked("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const okafors = await unlinked("The Okafors");
    await guardianIn(okafors, "Ike Okafor", "ike@example.com");
    await guardianIn(okafors, "Ada Okafor", "ada@example.com");
    // The Quiets' own create, given up after a try QuickBooks took: it made Quiet Family (90), linked to nobody.
    const quiets = await unlinked("The Quiets");
    await seedQueued({ op: "create", role: "family", name: "Quiet Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: quiets, sent: true, state: "given_up", lastTriedAt: new Date() });
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    // Each is still a customer with no family: the list is unchanged, only the press refuses.
    expect((await listed() as { qboId: string }[]).map((c) => c.qboId).sort()).toEqual(["70", "75", "76", "90"]);
    const before = await made();
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.suggestedFor(["The Patels"])] });
    for (const id of ["75", "76"]) expect(await familyFromCustomer(id, asLinker(staff), customerAimedAt), id).toEqual({ ok: false, errors: [NO_FAMILY_COPY.suggestedFor(["The Okafors"])] });
    expect(await familyFromCustomer("90", asLinker(staff), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.givenUpFor("The Quiets", true)] });
    expect(await made()).toEqual(before);
    expect(NO_FAMILY_COPY.suggestedFor(["The Patels"])).toBe("Accounting links suggests this customer for, or lists it as a possible customer of, The Patels, a family the portal has already, so no second family was made. Link the two on Accounting links.");
    expect(NO_FAMILY_COPY.givenUpFor("The Quiets", true)).toBe("The portal saved The Quiets first, and QuickBooks made this customer for it before making it was given up, so no second family was made. If it is that family's, pick it for that family on Accounting links.");
  });

  it("names two families or more that a customer is listed for, up to a handful", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("70", "Shared Family", "1", mail("one@example.com, two@example.com")));
    await guardianIn(await unlinked("The Ones"), "One", "one@example.com");
    await guardianIn(await unlinked("The Twos"), "Two", "two@example.com");
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", asLinker(staff), customerAimedAt)).toEqual({ ok: false, errors: [
      "Accounting links suggests this customer for, or lists it as a possible customer of, The Ones and The Twos, families the portal has already, so no second family was made. Link it to the right one on Accounting links."] });
  });

  it("makes the family for a customer only a Left unlinked family's guardians match, ", async () => {
    tag = await connectRoster(stub);
    await addInQuickBooks(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinked("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const linker = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("70", asLinker(linker), customerAimedAt)).toMatchObject({ ok: false });
    expect(await leaveUnlinked(String(patels), tag, asLinker(linker))).toMatchObject({ ok: true });
    expect(await familyFromCustomer("70", asLinker(linker), customerAimedAt)).toMatchObject({ ok: true });
    expect(await familyLinksOf("70")).toHaveLength(1);
  });

  it("refuses, under its own lock, a customer a guardian added between the page and the press makes suggested", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("70", "Patel Family", "1", mail("asha@example.com")));
    const patels = await unlinked("The Patels");
    const staff = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    // The page: Patel Family offered, no row aiming at it.
    asStaff(staff);
    expect(rowNamed(section(await renderPage(ReconciliationPage), "no-family-h"), "Patel Family")![3]).toBe("Create a family from this: Patel Family");
    // The press waits for the roster lock; meanwhile Asha's address joins the Patels (a write that takes no roster lock).
    let release = () => {};
    let held: Promise<void> = Promise.resolve();
    await new Promise<void>((took) => {
      held = db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
        took();
        await new Promise<void>((r) => { release = () => r(); });
      });
    });
    const press = familyFromCustomer("70", asLinker(staff), customerAimedAt);
    await untilALockIsAwaited(15_000, 1);
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    release();
    await held;
    expect(await press).toEqual({ ok: false, errors: [NO_FAMILY_COPY.suggestedFor(["The Patels"])] });
    expect(await familyLinksOf("70")).toEqual([]);
    expect(await audits("accounting.family.from_customer")).toEqual([]);
  });

  it("shows the aimed customer's row with words naming the family and a link to Accounting links instead of the button, the books' text as text, and the action reads the page again on a refusal", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("70", "<b>Patel</b> Family", "1", mail("asha@example.com")), qc("75", "Okafor Family", "1", mail("ike@example.com")),
      qc("76", "Okafor Household", "1", mail("ada@example.com")), qc("90", "Quiet Family", "1"), qc("95", "Plain Family", "1"));
    const patels = await unlinked("The Patels");
    await guardianIn(patels, "Asha Patel", "asha@example.com");
    const okafors = await unlinked("The Okafors");
    await guardianIn(okafors, "Ike Okafor", "ike@example.com");
    await guardianIn(okafors, "Ada Okafor", "ada@example.com");
    const quiets = await unlinked("The Quiets");
    await seedQueued({ op: "create", role: "family", name: "Quiet Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: quiets, sent: true, state: "given_up", lastTriedAt: new Date() });
    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]));
    const html = await renderPage(ReconciliationPage);
    const list = section(html, "no-family-h");
    expect(rowNamed(list, "<b>Patel</b> Family")![3]).toBe("Accounting links suggests it for The Patels, a family the portal has already, so it isn't made a family here. Link it on Accounting links: <b>Patel</b> Family");
    // Its "What it makes" cell says it makes nothing here, never what the press it isn't offered would make.
    expect(rowNamed(list, "<b>Patel</b> Family")![2]).toBe("Nothing here: it is linked to a family on Accounting links.");
    expect(rowNamed(list, "Plain Family")![2]).toBe("A family, linked to this customer.");
    expect(list).toContain('href="/staff/links?status=suggested"');
    expect(list).toContain("&lt;b&gt;Patel&lt;/b&gt; Family");
    expect(list).not.toContain("<b>Patel</b>");
    expect(rowNamed(list, "Okafor Household")![3]).toBe("Accounting links lists it as a possible customer of The Okafors, a family the portal has already, so it isn't made a family here. Look at it for that family on Accounting links: Okafor Household");
    expect(list).toContain(`href="/staff/links?pick=${String(okafors)}&amp;customer=76#links-pick-h"`);
    expect(rowNamed(list, "Quiet Family")![3]).toBe("The portal saved The Quiets first, and QuickBooks made this customer for it before making it was given up, so it isn't made a family here. Pick it for that family on Accounting links: Quiet Family");
    expect(list).toContain(`href="/staff/links?pick=${String(quiets)}&amp;customer=90#links-pick-h"`);
    expect(rowNamed(list, "Plain Family")![3]).toBe("Create a family from this: Plain Family");
    expect(list).not.toContain("nothing can link the two yet");
    expect(list).toContain("isn&#x27;t made a family here: its row names that family and links to Accounting links, where the two are linked.");
    // The given-up create's own section points at picking it for the family saved first, with a link to that step.
    const madeAnyway = section(html, "made-anyway-h").replaceAll("<!-- -->", "");
    expect(madeAnyway).toContain("It isn&#x27;t offered to bring in under Customers with no family: if it is the family the portal saved first, pick it for that family on Accounting links");
    expect(madeAnyway).toContain(`href="/staff/links?pick=${String(quiets)}&amp;customer=90#links-pick-h"`);
    // The action refuses as the library does, and asks Reconciliation to be read again.
    expect(await familyFromCustomerAction("70")).toEqual({ ok: false, errors: [NO_FAMILY_COPY.suggestedFor(["The Patels"])] });
    expect(revalidatedPaths()).toContain("/staff/reconciliation");
    expect(await familyLinksOf("70")).toEqual([]);
  });

  it("for a given-up create's customer whose family saved first is Suggested for another customer, says to confirm that one or leave the family unlinked first, and the refusal says so", async () => {
    tag = await connectRoster(stub);
    await addInQuickBooks(qc("70", "Patel Family", "1", mail("asha@example.com")), qc("90", "Quiet Family", "1"));
    // The Quiets' guardian signs in with the address on Patel Family, so their row is Suggested for 70; their own
    // create, given up after a try QuickBooks took, made Quiet Family (90). Their row offers no Pick a different customer.
    const quiets = await unlinked("The Quiets");
    await guardianIn(quiets, "Asha Quiet", "asha@example.com");
    await seedQueued({ op: "create", role: "family", name: "Quiet Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: quiets, sent: true, state: "given_up", lastTriedAt: new Date() });
    const linker = await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("90", asLinker(linker), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.givenUpFor("The Quiets", false)] });
    expect(NO_FAMILY_COPY.givenUpFor("The Quiets", false)).toBe("The portal saved The Quiets first, and QuickBooks made this customer for it before making it was given up, so no second family was made."
      + " Accounting links suggests another customer for that family: confirm that one there if it is the family's, or, if this one is, leave the family unlinked there first, then pick this one for it.");
    asStaff(linker);
    const html = await renderPage(ReconciliationPage);
    const list = section(html, "no-family-h");
    expect(rowNamed(list, "Quiet Family")![3]).toBe("The portal saved The Quiets first, and QuickBooks made this customer for it before making it was given up, so it isn't made a family here."
      + " Accounting links suggests another customer for that family: confirm that one there if it is the family's, or, if this one is, leave the family unlinked there first, then pick this one for it."
      + " See that family's row on Accounting links: Quiet Family");
    expect(list).not.toContain(`pick=${String(quiets)}`);
    const madeAnyway = section(html, "made-anyway-h").replaceAll("<!-- -->", "").replaceAll("&#x27;", "'");
    expect(madeAnyway).toContain("It isn't offered to bring in under Customers with no family: Accounting links suggests another customer for the family the portal saved first."
      + " If that one is the family's, confirm it there; if this one is, leave the family unlinked there first, then pick this one for it; if it isn't wanted, make it inactive in QuickBooks.");
    expect(madeAnyway).toContain('href="/staff/links?status=suggested"');
    expect(madeAnyway).not.toContain(`pick=${String(quiets)}`);
    // Left unlinked, the family's row offers Pick: the words and the link point at its confirm step, and the refusal says to pick it.
    expect(await leaveUnlinked(String(quiets), tag, asLinker(linker))).toMatchObject({ ok: true });
    expect(await familyFromCustomer("90", asLinker(linker), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.givenUpFor("The Quiets", true)] });
    const after = await renderPage(ReconciliationPage);
    expect(rowNamed(section(after, "no-family-h"), "Quiet Family")![3]).toBe("The portal saved The Quiets first, and QuickBooks made this customer for it before making it was given up, so it isn't made a family here. Pick it for that family on Accounting links: Quiet Family");
    expect(section(after, "made-anyway-h")).toContain(`href="/staff/links?pick=${String(quiets)}&amp;customer=90#links-pick-h"`);
    expect(await familyLinksOf("90")).toEqual([]);
  });

  it("makes the family for a given-up create's customer once the family saved first is inactive, or linked to another customer", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("90", "Quiet Family", "1"), qc("91", "Oak Family", "1"), qc("95", "Oak Household", "1"));
    const quiets = await unlinked("The Quiets");
    await seedQueued({ op: "create", role: "family", name: "Quiet Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: quiets, sent: true, state: "given_up", lastTriedAt: new Date() });
    const oaks = await unlinked("The Oaks");
    await seedQueued({ op: "create", role: "family", name: "Oak Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: oaks, sent: true, state: "given_up", lastTriedAt: new Date() });
    const linker = await staffWith("treasurer@club.org", ["Roster.Read", "Accounting.Link.ReadWrite"]);
    expect(await familyFromCustomer("90", asLinker(linker), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.givenUpFor("The Quiets", true)] });
    expect(await familyFromCustomer("91", asLinker(linker), customerAimedAt)).toEqual({ ok: false, errors: [NO_FAMILY_COPY.givenUpFor("The Oaks", true)] });
    // The Quiets made inactive in the portal; the Oaks linked to Oak Household: neither is a family the customer is meant for now.
    await db.update(family).set({ active: false }).where(eq(family.id, quiets));
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "95", familyId: oaks, origin: "confirmed", linkedBy: linker.id });
    expect(await familyFromCustomer("90", asLinker(linker), customerAimedAt)).toMatchObject({ ok: true });
    expect(await familyFromCustomer("91", asLinker(linker), customerAimedAt)).toMatchObject({ ok: true });
    for (const id of ["90", "91"]) expect(await familyLinksOf(id), id).toHaveLength(1);
    expect((await familyLinksOf("90"))[0]!.familyId).not.toBe(quiets);
    expect((await familyLinksOf("91"))[0]!.familyId).not.toBe(oaks);
  });

  it("tells staff who may not link families the same thing about a given-up create's customer, with no link to Accounting links and nothing about making the family inactive", async () => {
    await connectRoster(stub);
    await addInQuickBooks(qc("90", "Quiet Family", "1"));
    const quiets = await unlinked("The Quiets");
    await seedQueued({ op: "create", role: "family", name: "Quiet Family", typeQboId: "1", familyQboId: null, email: null }, { familyId: quiets, sent: true, state: "given_up", lastTriedAt: new Date() });
    asStaff(await staffWith("registrar@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]));
    const html = await renderPage(ReconciliationPage);
    expect(section(html, "no-family-h")).toBe("");
    const madeAnyway = section(html, "made-anyway-h").replaceAll("<!-- -->", "").replaceAll("&#x27;", "'");
    expect(madeAnyway).toContain("It isn't offered to bring in under Customers with no family: if it is the family the portal saved first, pick it for that family on Accounting links;"
      + " if it isn't wanted, make it inactive in QuickBooks. Someone who may link families to accounting does this on Accounting links.");
    expect(madeAnyway).not.toContain("saved first inactive");
    expect(madeAnyway).not.toContain('href="/staff/links');
  });
});
