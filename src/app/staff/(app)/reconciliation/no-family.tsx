import Link from "next/link";
import { customersWithNoFamily, type NoFamilyList } from "@/lib/roster/no-family";
import { Notice } from "@/app/components/notice";
import { familyFromCustomerAction } from "./family-actions";
import { NoFamilyRows, type NoFamilyRow } from "./no-family-list";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why nothing can be listed, in words. */
const WHY_NONE: Record<Exclude<NoFamilyList["state"], "listed">, string> = {
  no_company: "The portal hasn't read the club's QuickBooks yet, so there are no customers to list.",
  other_company: "QuickBooks is connected to a different company than the one the roster was read from, so no customer is listed here. An Admin can see why under Settings, QuickBooks.",
  no_shape: "The membership shape isn't chosen, or names a customer type QuickBooks no longer has, so the portal can't tell which customers are families. An Admin can choose it under Settings, QuickBooks.",
};

/** What pressing the button makes, for one customer: the row's own words, since there is no second confirmation. */
function whatItMakes(c: { students: number; inactiveStudents: number; studentsWithRecord: number }): string {
  const fresh = c.students - c.studentsWithRecord;
  const parts = [fresh === 0 ? "A family, linked to this customer." : `A family, linked to this customer, with ${plural(fresh, "student", "students")}, each linked to their own.`];
  if (c.inactiveStudents > 0) parts.push(`${plural(c.inactiveStudents, "student is", "students are")} inactive in QuickBooks and stay${c.inactiveStudents === 1 ? "s" : ""} inactive here.`);
  if (c.studentsWithRecord > 0) parts.push(`${plural(c.studentsWithRecord, "student already has", "students already have")} a record in the portal, left as ${c.studentsWithRecord === 1 ? "it is" : "they are"}.`);
  return parts.join(" ");
}

/**
 * Reconciliation's list of the QuickBooks customers no family is linked to, each with "Create a family from this"
 * (stage 3's slice 10 of the app-owned families spec). Shown only to staff with the linking permission; the page checks
 * it. A server component: the client list is given each row's words and the action bound to its customer, nothing
 * else. Names are QuickBooks text, shown as text only.
 */
export async function CustomersWithNoFamily({ mayChangeFamilies }: { mayChangeFamilies: boolean }) {
  const list = await customersWithNoFamily();
  // Each row is keyed by its customer, so a press waiting for its answer stays on its own row when a family made takes
  // an earlier row off the list. The id is in the browser already: the press bound to the row carries it.
  const rows: NoFamilyRow[] = list.state !== "listed" ? [] : list.customers.map((c) => ({
    key: c.qboId, name: c.name,
    students: c.students === 0 ? "None" : `${plural(c.students, "student", "students")}${c.inactiveStudents ? `, ${c.inactiveStudents} inactive` : ""}`,
    makes: whatItMakes(c), act: familyFromCustomerAction.bind(null, c.qboId),
  }));
  return (
    <section className="box" aria-labelledby="no-family-h"><h2 id="no-family-h">Customers with no family{rows.length ? ` (${rows.length})` : ""}</h2>
      <p>The active customers QuickBooks lists as a family at the top level, under no other customer, that no family in the portal is linked to: one added in QuickBooks since the portal&apos;s families were set up, say.
        A customer a family&apos;s waiting or stuck change on this page would be found as is left out until that change goes through or is given up. An inactive family customer isn&apos;t offered.
        Creating a family from one makes the family and its students in the portal, linked to their customers, so its invoices show to its guardians.
        {` It makes no guardian and gives nobody a sign-in: ${mayChangeFamilies ? "add its guardians" : "someone who may change families adds its guardians"} on the family's page, under Families. Nothing is sent to QuickBooks.`}
        {" "}<Link href="/staff/links">Accounting links</Link> shows every family in the portal beside its customer, and which of these customers looks like a family&apos;s own by a guardian&apos;s sign-in address.</p>
      {list.state !== "listed" ? <Notice tone="warning" live="none">{WHY_NONE[list.state]}</Notice> : <NoFamilyRows rows={rows} />}
    </section>
  );
}
