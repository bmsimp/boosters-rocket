import type { ReactNode } from "react";
import { Card, Notice } from "@/app/components/ui";
import type { CustomerAim, LinksState, LinksView } from "@/lib/accounting/mapping";
import { handful, type NoFamilyCustomer } from "@/lib/roster/no-family";
import { familyFromCustomerAction } from "./actions";
import { NoFamilyRows, type NoFamilyRow } from "./no-family-list";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where the screen's part for the customers no family is linked to is drawn (slice M6, conformance L.15). */
export const NO_FAMILY_H = "no-family-h";

/**
 * The words of the part for the customers no family is linked to (slice M6, the lead's decision 4: every sentence the
 * owner may change, in one place). `lead` opens the part, for every reader of the screen.
 */
export const NO_FAMILY_WORDS = {
  /** How many there are, first in the part (the screen's count before slice M6), when there is at least one. */
  count: (n: number) => `${plural(n, "active customer the books list as a family at the top level, under no other customer, has", "active customers the books list as a family at the top level, under no other customer, have")} no family in the portal.`,
  lead: (mayChangeFamilies: boolean) => "These are the active customers the books list as a family at the top level, under no other customer, that no family in the portal is linked to: one added in QuickBooks since the portal's families were set up, say."
    + " A customer a family's waiting or stuck change on Reconciliation would be found as is left out until that change goes through or is given up there. An inactive family customer isn't offered."
    + " “Create a family from this” makes the family and its students in the portal, linked to their customers, so its invoices show to its guardians."
    + ` It makes no guardian and gives nobody a sign-in: ${mayChangeFamilies ? "add its guardians" : "someone who may change families adds its guardians"} on the family's page, under Families. Nothing is sent to QuickBooks.`
    + " A customer this page suggests for, or lists as a possible customer of, a family the portal has, or one QuickBooks made for a family the portal saved first whose change was given up, isn't made a family here: its row names that family and says where the two are linked.",
  none: "Nothing: every active family customer the books have at the top level, under no other customer, is linked to a family in the portal, or is about to be by a change on Reconciliation.",
  aimedMakes: "Nothing here: it is linked to a family on this page.",
  /**
   * Said on Reconciliation, to a holder of the linking permission, in place of the list that was there until this slice
   * (stage 3's slice 10): how many there are, while there are any, beside a link to this part.
   */
  elsewhere: (n: number) => `${n === 1 ? "1 customer the books list as a family has" : `${n} customers the books list as a family have`} no family in the portal: see ${n === 1 ? "it" : "them"} on Accounting links.`,
} as const;

/** Why nothing can be listed, in words. */
const WHY_NONE: Record<Exclude<LinksState, "listed">, string> = {
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

/** The confirm step on this page for one family and one customer: an app uuid and the customer's digits, no books text. */
const pickStep = (familyId: string, customerId: string) => (/^\d{1,20}$/.test(customerId)
  ? `/staff/links?pick=${encodeURIComponent(familyId)}&customer=${customerId}#links-pick-h` : "/staff/links");

/**
 * Why a customer is meant for a family the portal has (slice M3a2), in words naming the family as text, with where on
 * this page the two are linked: the Suggested rows, the Several possible rows, or the confirm step of the one family a
 * candidate or a given-up create is for.
 */
export function aimShown(customerId: string, aim: CustomerAim): NonNullable<NoFamilyRow["aim"]> {
  const names = handful(aim.families.map((f) => f.name));
  const one = aim.families.length === 1;
  const has = one ? "a family the portal has already" : "families the portal has already";
  if (aim.why === "given_up") {
    const f = aim.families[0];
    const said = `The portal saved ${f.name} first, and QuickBooks made this customer for it before making it was given up, so it isn't made a family here.`;
    if (aim.pickable) return { words: said, href: pickStep(String(f.id), customerId), label: "Pick it for that family" };
    // That family's row is Suggested for another customer, so it offers no Pick until it is left unlinked.
    return { words: `${said} This page suggests another customer for that family: confirm that one if it is the family's, or, if this one is, leave the family unlinked first, then pick this one for it.`,
      href: "/staff/links?status=suggested", label: "See that family's row" };
  }
  if (aim.why === "suggested") return { words: `This page suggests it for ${names}, ${has}, so it isn't made a family here.`, href: "/staff/links?status=suggested", label: "Link it in the Suggested rows" };
  return { words: `This page lists it as a possible customer of ${names}, ${has}, so it isn't made a family here.`,
    href: one ? pickStep(String(aim.families[0]!.id), customerId) : "/staff/links?status=several", label: one ? "Look at it for that family" : "See them in the Several possible rows" };
}

/** The rows of the list, each as the client list draws it: the press bound to the customer, or the aim's words and link. */
export function noFamilyRows(customers: readonly NoFamilyCustomer[], aims: ReadonlyMap<string, CustomerAim>): NoFamilyRow[] {
  // Each row is keyed by its customer, so a press waiting for its answer stays on its own row when a family made takes
  // an earlier row off the list. The id is in the browser already: the press bound to the row carries it.
  return customers.map((c) => {
    const aim = aims.get(c.qboId);
    return {
      key: c.qboId, name: c.name,
      students: c.students === 0 ? "None" : `${plural(c.students, "student", "students")}${c.inactiveStudents ? `, ${c.inactiveStudents} inactive` : ""}`,
      // A customer meant for a family the portal has makes nothing here: it is linked to that family on this page.
      makes: aim === undefined ? whatItMakes(c) : NO_FAMILY_WORDS.aimedMakes,
      act: aim === undefined ? familyFromCustomerAction.bind(null, c.qboId) : null, aim: aim === undefined ? null : aimShown(c.qboId, aim),
    };
  });
}

/**
 * The screen's own part for the QuickBooks customers no family is linked to (stage 4's slice M6, conformance L.15; stage
 * 3's slice 10 put them on Reconciliation), each with "Create a family from this", or, for a customer this screen aims
 * at a family the portal has (slice M3a2: the view's `aims`, worked out once from its own reads), words naming that
 * family and a link to where the two are linked, which "Create a family from this" would refuse. Drawn from the view
 * alone (its pool, `noFamilyList`, by customersWithNoFamily()'s rule): no query of its own. A server component: the
 * client list is given each row's words and the action bound to its customer, or the words and the link's address,
 * nothing else. Names are QuickBooks text, and a family's name the portal's own, shown as text only. `children`: what
 * the part offers after the list (the import's offer, slice M6).
 */
export function CustomersWithNoFamily({ view, mayChangeFamilies, children }: { view: Pick<LinksView, "state" | "noFamilyList" | "aims">; mayChangeFamilies: boolean; children?: ReactNode }) {
  const list = view.noFamilyList;
  const rows = list === null ? [] : noFamilyRows(list, view.aims);
  return (
    <Card title={<>Customers with no family{rows.length ? ` (${rows.length})` : ""}</>} titleId={NO_FAMILY_H}>
      <p>{list !== null && list.length > 0 ? `${NO_FAMILY_WORDS.count(list.length)} ` : ""}{NO_FAMILY_WORDS.lead(mayChangeFamilies)}</p>
      {view.state !== "listed" || list === null ? <Notice tone="warning" live="none">{WHY_NONE[view.state === "listed" ? "no_shape" : view.state]}</Notice> : <NoFamilyRows rows={rows} none={NO_FAMILY_WORDS.none} />}
      {children}
    </Card>
  );
}
