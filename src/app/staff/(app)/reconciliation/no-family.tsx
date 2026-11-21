import Link from "next/link";
import type { CustomerAim } from "@/lib/accounting/mapping";
import { customersWithNoFamily, handful, type NoFamilyList } from "@/lib/roster/no-family";
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

/** The confirm step on Accounting links for one family and one customer: an app uuid and the customer's digits, no books text. */
const pickStep = (familyId: string, customerId: string) => (/^\d{1,20}$/.test(customerId)
  ? `/staff/links?pick=${encodeURIComponent(familyId)}&customer=${customerId}#links-pick-h` : "/staff/links");

/**
 * Why a customer is meant for a family the portal has (slice M3a2), in words naming the family as text, with where on
 * Accounting links the two are linked: the Suggested rows, the Several possible rows, or the confirm step of the one
 * family a candidate or a given-up create is for.
 */
function aimShown(customerId: string, aim: CustomerAim): NonNullable<NoFamilyRow["aim"]> {
  const names = handful(aim.families.map((f) => f.name));
  const one = aim.families.length === 1;
  const has = one ? "a family the portal has already" : "families the portal has already";
  if (aim.why === "given_up") {
    const f = aim.families[0];
    const said = `The portal saved ${f.name} first, and QuickBooks made this customer for it before making it was given up, so it isn't made a family here.`;
    if (aim.pickable) return { words: said, href: pickStep(String(f.id), customerId), label: "Pick it for that family on Accounting links" };
    // That family's row is Suggested for another customer, so it offers no Pick until it is left unlinked.
    return { words: `${said} Accounting links suggests another customer for that family: confirm that one there if it is the family's, or, if this one is, leave the family unlinked there first, then pick this one for it.`,
      href: "/staff/links?status=suggested", label: "See that family's row on Accounting links" };
  }
  if (aim.why === "suggested") return { words: `Accounting links suggests it for ${names}, ${has}, so it isn't made a family here.`, href: "/staff/links?status=suggested", label: "Link it on Accounting links" };
  return { words: `Accounting links lists it as a possible customer of ${names}, ${has}, so it isn't made a family here.`,
    href: one ? pickStep(String(aim.families[0]!.id), customerId) : "/staff/links?status=several", label: one ? "Look at it for that family on Accounting links" : "See them on Accounting links" };
}

/**
 * Reconciliation's list of the QuickBooks customers no family is linked to, each with "Create a family from this"
 * (stage 3's slice 10 of the app-owned families spec), or, for a customer the accounting links screen aims at a family
 * the portal has (stage 4's slice M3a2: `aims`, read once by the page with readCustomerAims()), words naming that family
 * and a link to where the two are linked, which "Create a family from this" would refuse. Shown only to staff with the
 * linking permission; the page checks it. A server component: the client list is given each row's words and the action
 * bound to its customer, or the words and the link's address, nothing else. Names are QuickBooks text, and a family's
 * name the portal's own, shown as text only. Queries, whatever the number of customers: customersWithNoFamily()'s own
 * (a fixed handful), beside the page's one read of the aims (readCustomerAims(): 11 or 12, then 4 to 8).
 */
export async function CustomersWithNoFamily({ mayChangeFamilies, aims }: { mayChangeFamilies: boolean; aims: ReadonlyMap<string, CustomerAim> }) {
  const list = await customersWithNoFamily();
  // Each row is keyed by its customer, so a press waiting for its answer stays on its own row when a family made takes
  // an earlier row off the list. The id is in the browser already: the press bound to the row carries it.
  const rows: NoFamilyRow[] = list.state !== "listed" ? [] : list.customers.map((c) => {
    const aim = aims.get(c.qboId);
    return {
      key: c.qboId, name: c.name,
      students: c.students === 0 ? "None" : `${plural(c.students, "student", "students")}${c.inactiveStudents ? `, ${c.inactiveStudents} inactive` : ""}`,
      // A customer meant for a family the portal has makes nothing here: it is linked to that family on Accounting links.
      makes: aim === undefined ? whatItMakes(c) : "Nothing here: it is linked to a family on Accounting links.",
      act: aim === undefined ? familyFromCustomerAction.bind(null, c.qboId) : null, aim: aim === undefined ? null : aimShown(c.qboId, aim),
    };
  });
  return (
    <section className="box" aria-labelledby="no-family-h"><h2 id="no-family-h">Customers with no family{rows.length ? ` (${rows.length})` : ""}</h2>
      <p>The active customers QuickBooks lists as a family at the top level, under no other customer, that no family in the portal is linked to: one added in QuickBooks since the portal&apos;s families were set up, say.
        A customer a family&apos;s waiting or stuck change on this page would be found as is left out until that change goes through or is given up. An inactive family customer isn&apos;t offered.
        Creating a family from one makes the family and its students in the portal, linked to their customers, so its invoices show to its guardians.
        {` It makes no guardian and gives nobody a sign-in: ${mayChangeFamilies ? "add its guardians" : "someone who may change families adds its guardians"} on the family's page, under Families. Nothing is sent to QuickBooks.`}
        {" "}<Link href="/staff/links">Accounting links</Link> shows every family in the portal beside its customer, and which of these customers looks like the customer of a family the portal has already, by a guardian&apos;s sign-in address.
        Such a customer, or one QuickBooks made for a family the portal saved first whose change was given up, isn&apos;t made a family here: its row names that family and links to Accounting links, where the two are linked.</p>
      {list.state !== "listed" ? <Notice tone="warning" live="none">{WHY_NONE[list.state]}</Notice> : <NoFamilyRows rows={rows} />}
    </section>
  );
}
