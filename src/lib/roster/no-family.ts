// Customers with no family (stage 3's slice 10 of the app-owned families spec, open question 19): the QuickBooks
// customers the membership shape calls a family that no family record of the portal is linked to, and "Create a family
// from this", the way in for one such customer at a time. Stage 4's mapping screen brings the reviewed import of many.
// The list reads every customer of the roster cache, so this module is staff code only, never imported by a parent page
// (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { qboCustomer } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { connectedToAnotherCompany, familyLinkedTo, linksOfCustomers } from "@/lib/families/links";
import { importRecordsFromRoster } from "@/lib/families/roster-import";
import { isQboId } from "@/lib/quickbooks/client";
import { buildRoster, type Cust } from "./model";
import { getShape, ROSTER_LOCK, shapeHolds } from "./shape";
import { getRosterSource } from "./source";

/**
 * One customer no family is linked to, as Reconciliation lists it: its name (QuickBooks text, shown as text only) and
 * the student customers QuickBooks holds directly under it (layered books with a student type; none otherwise): how
 * many, how many of those are inactive in QuickBooks, and how many already have a student record of the portal (another
 * family's, or inactive), which "Create a family from this" leaves as they are.
 */
export type NoFamilyCustomer = { qboId: string; name: string; students: number; inactiveStudents: number; studentsWithRecord: number };
/**
 * The list, or why there is none: the cache names no company (`no_company`), QuickBooks is connected to a company
 * other than the roster's (`other_company`: no link of the roster's company may answer then), or there is no
 * membership shape or it names a customer type QuickBooks no longer has (`no_shape`), so nobody can say which
 * customers are families.
 */
export type NoFamilyList = { state: "listed"; customers: NoFamilyCustomer[] } | { state: "no_company" | "other_company" | "no_shape" };

/**
 * The customers of the roster cache that the membership shape calls a family (a customer of the family type in layered
 * books, a member in flat books, as the roster lists them: buildRoster()), active in QuickBooks, not under another
 * customer, of the roster's own company (the cache holds no other), that have no family link in that company; by name,
 * as the roster lists them. The students under each are those the roster lists under it, active or not, which are the
 * ones the import makes records of (src/lib/families/plan.ts). Reads every customer: staff only.
 */
export async function customersWithNoFamily(tx?: Tx): Promise<NoFamilyList> {
  if ((await getRosterSource(tx)) === null) return { state: "no_company" };
  if (await connectedToAnotherCompany(tx)) return { state: "other_company" };
  const shape = await getShape(tx);
  if (shape === null || !(await shapeHolds(tx))) return { state: "no_shape" };
  const customers: Cust[] = (await (tx ?? db).select().from(qboCustomer)).map((c) =>
    ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: null, phone: null }));
  const roster = buildRoster(shape, customers);
  const listed: { customer: Cust; students: Cust[] }[] = roster.kind === "flat"
    ? roster.members.map((m) => ({ customer: m, students: [] })) : roster.families.map((f) => ({ customer: f.customer, students: f.students }));
  const families = listed.filter((f) => f.customer.active && f.customer.parentQboId === null);
  const links = await linksOfCustomers({ families: families.map((f) => f.customer.qboId), students: families.flatMap((f) => f.students.map((s) => s.qboId)) }, tx);
  return {
    state: "listed",
    customers: families.filter((f) => !links.familyOfCustomer.has(f.customer.qboId)).map((f) => ({
      qboId: f.customer.qboId, name: f.customer.displayName, students: f.students.length,
      inactiveStudents: f.students.filter((s) => !s.active).length,
      studentsWithRecord: f.students.filter((s) => links.studentOfCustomer.has(s.qboId)).length,
    })),
  };
}

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const no = (...errors: string[]): Done => ({ ok: false, errors });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What staff read when a family isn't made, in words. Nothing is ever made in these cases. */
export const NO_FAMILY_COPY = {
  notFromPage: "That didn't go through. Reload the page and try again.",
  already: "This customer has a family in the portal already, so nothing was made. Find it under Families.",
  notOffered: "The portal can't make a family from this customer now: in QuickBooks it may have been made inactive, put under another customer or given another type. Nothing was made. Reload the page to see the list as it is now.",
  no_company: "The portal hasn't read the club's QuickBooks yet, so there are no customers to make a family from. Nothing was made.",
  other_company: "QuickBooks is connected to a different company than the one the roster was read from, so nothing was made. An Admin can see why under Settings, QuickBooks.",
  no_shape: "The membership shape isn't chosen, or names a customer type QuickBooks no longer has, so the portal can't tell which customers are families. Nothing was made. An Admin can choose it under Settings, QuickBooks.",
} as const;

/** The unique index on a customer's family link: the last line against making a second family of one customer. */
const FAMILY_LINK_UQ = "accounting_link_family_customer_uq";
/** The import found a family record of the customer after the list said it had none: nothing is kept. */
class HasFamilyAlready extends Error {}
/** Whether the database refused a second family link of the customer: a unique violation of that index, anywhere in the causes. */
const secondFamilyLink = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const pg = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
  if (pg.code === "23505") return pg.constraint_name === undefined || pg.constraint_name === FAMILY_LINK_UQ;
  return secondFamilyLink(pg.cause);
};

/**
 * "Create a family from this": makes, in one transaction under the roster lock held exclusively, a family record named
 * as the customer and active, with its family link to that customer, and a student record in that family for each
 * customer directly under it that the shape calls a student, named and active as its customer is, each with its
 * student link; every link `confirmed` by the staff member who asked. It runs the import of the app's records
 * (importRecordsFromRoster(), src/lib/families/roster-import.ts) narrowed to the one family, so the rules for which
 * customers are a family's students and what each record is named are the import's own. It makes no guardian and gives
 * nobody a sign-in, and sends nothing to QuickBooks.
 *
 * `customerId` comes from the page: it must be digits (isQboId()), and under the lock the customer must still be one the
 * list offers (customersWithNoFamily(): of the roster's company, active, a family by the shape, under nobody, with no
 * family link). A student customer under it that already has a student record (another family's, or inactive) is left
 * exactly as it is, and counted in the answer and the audit row. A second press, or two at once, makes one family: the
 * second finds the link the first made. The unique index on a customer's family link is the last line, answered in
 * words. One audit row (`accounting.family.from_customer`) in the same transaction, naming the app's new family.
 */
export async function familyFromCustomer(customerId: string, o: { actor: Actor; ip: string | null; permission: string; staffUserId: string }): Promise<Done> {
  if (typeof customerId !== "string" || !isQboId(customerId)) return no(NO_FAMILY_COPY.notFromPage);
  try {
    return await db.transaction(async (tx): Promise<Done> => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      const list = await customersWithNoFamily(tx);
      if (list.state !== "listed") return no(NO_FAMILY_COPY[list.state]);
      const offered = list.customers.find((c) => c.qboId === customerId);
      if (!offered) return no((await familyLinkedTo(customerId, tx)) !== null ? NO_FAMILY_COPY.already : NO_FAMILY_COPY.notOffered);
      const realmId = (await getRosterSource(tx))!;
      const made = await importRecordsFromRoster(tx, { familyCustomerId: customerId, linkedBy: o.staffUserId });
      // The list offered it, so the import's plan holds its family record and it had none. Had it found one after all,
      // anything it made would be filed under that family: thrown, so the transaction keeps nothing.
      if (made.family === null) throw new HasFamilyAlready();
      const [c] = await tx.select({ displayName: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, customerId));
      await writeAudit({ actor: o.actor, action: "accounting.family.from_customer", permission: o.permission, targetType: "family", targetId: String(made.family), ip: o.ip,
        after: { familyId: String(made.family), name: c?.displayName ?? offered.name, customerQboId: customerId, realmId,
          studentsMade: made.students.made.map((s) => ({ studentId: String(s.id), customerQboId: s.customerId })),
          studentsLeftAlone: made.students.leftAlone.map((s) => ({ studentId: String(s.id), customerQboId: s.customerId })),
          appRecords: made.changes } }, tx);
      const students = made.students.made.length, left = made.students.leftAlone.length;
      return { ok: true, message: `${offered.name} is a family in the portal now, linked to its QuickBooks customer${students ? `, with ${plural(students, "student", "students")}` : ""}.`
        + (left ? ` ${plural(left, "student", "students")} under it in QuickBooks already had a record in the portal and ${left === 1 ? "was" : "were"} left as ${left === 1 ? "it was" : "they were"}.` : "")
        + " Nobody can sign in for it yet: add its guardians on its page, under Families." };
    });
  } catch (e) {
    if (e instanceof HasFamilyAlready || secondFamilyLink(e)) return no(NO_FAMILY_COPY.already);
    throw e;
  }
}
