import type { ReactNode } from "react";
import { Card, Notice } from "@/app/components/ui";
import type { CustomerAim, LinksState, LinksView } from "@/lib/accounting/mapping";
import { capitalized, type AccountingWords } from "@/lib/accounting/words";
import { handful, type NoFamilyCustomer } from "@/lib/roster/no-family";
import { familiesFromCustomersAction, familyFromCustomerAction } from "./actions";
import { NoFamilyRows, type NoFamilyRow } from "./no-family-list";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where the screen's part for the customers no family is linked to is drawn (slice M6, conformance L.15). */
export const NO_FAMILY_H = "no-family-h";

/**
 * The words of the part for the customers no family is linked to (slice M6, the lead's decision 4: every sentence the
 * owner may change, in one place), in the provider's own nouns (src/lib/accounting/words.ts). `lead` opens the part, for
 * every reader of the screen.
 */
export const NO_FAMILY_WORDS = {
  title: (w: AccountingWords) => `${capitalized(w.customerNounPlural)} with no family`,
  lead: (mayChangeFamilies: boolean) => "Records in your books that no family here is linked to yet."
    + ` Create a family makes it here, linked, with its students but no guardians (${mayChangeFamilies ? "add them" : "someone who may change families adds them"} on its page), and sends nothing to the books.`,
  none: "Nothing: every active family in the books is linked to a family, or is about to be.",
  aimedMakes: "Nothing: link it to its family instead.",
  /**
   * Said on Reconciliation, to a holder of the linking permission, in place of the list that was there until this slice
   * (stage 3's slice 10): how many there are, while there are any, beside a link to this part.
   */
  elsewhere: (n: number) => `${n === 1 ? "1 customer the books list as a family has" : `${n} customers the books list as a family have`} no family in the portal: see ${n === 1 ? "it" : "them"} on Accounting links.`,
} as const;

/** Why nothing can be listed, in words. */
const whyNone = (w: AccountingWords): Record<Exclude<LinksState, "listed">, string> => ({
  no_company: `The portal hasn't read the books yet, so there are no ${w.customerNounPlural} to list.`,
  other_company: `${w.name} is connected to a different company than the one the roster was read from, so nothing is listed here. An Admin can see why under Settings, ${w.name}.`,
  no_shape: `The membership shape isn't chosen, or names a ${w.customerNoun} type the books no longer have, so the portal can't tell which are families. An Admin can choose it under Settings, ${w.name}.`,
});

/** What pressing the button makes, for one customer: the row's own words, since there is no second confirmation. */
function whatItMakes(c: { students: number; inactiveStudents: number; studentsWithRecord: number }): string {
  const fresh = c.students - c.studentsWithRecord;
  const parts = [fresh === 0 ? "A linked family." : `A linked family with ${plural(fresh, "student", "students")}.`];
  if (c.inactiveStudents > 0) parts.push(`${plural(c.inactiveStudents, "student stays", "students stay")} inactive.`);
  if (c.studentsWithRecord > 0) parts.push(`${plural(c.studentsWithRecord, "student is", "students are")} in the portal already.`);
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
  if (aim.why === "given_up") {
    const f = aim.families[0];
    const said = `The books made it for ${f.name}.`;
    if (aim.pickable) return { words: said, href: pickStep(String(f.id), customerId), label: "Pick it for that family" };
    // That family's row is Suggested for another customer, so it offers no Pick until it is left unlinked.
    return { words: `${said} To pick it, leave that family unlinked first.`,
      href: "/staff/links?status=suggested", label: "See that family's row" };
  }
  // A customer is suggested for one family only (the matcher's rule): its button shows that family's row, searched by its name.
  if (aim.why === "suggested") {
    const name = aim.families[0]!.name;
    return { words: `Suggested for ${names}.`, label: "Show its family's row",
      href: name.length <= 100 ? `/staff/links?status=suggested&q=${encodeURIComponent(name)}` : "/staff/links?status=suggested" };
  }
  return { words: `A possible customer of ${names}.`,
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
export function CustomersWithNoFamily({ view, mayChangeFamilies, words, children }: { view: Pick<LinksView, "state" | "noFamilyList" | "aims">; mayChangeFamilies: boolean; words: AccountingWords; children?: ReactNode }) {
  const list = view.noFamilyList;
  const rows = list === null ? [] : noFamilyRows(list, view.aims);
  const title = NO_FAMILY_WORDS.title(words);
  // With none to list (and so nothing to offer), the part is one line, so the next part comes up the page.
  if (view.state === "listed" && list !== null && rows.length === 0) {
    return <Notice tone="done" live="none" title={title} titleId={NO_FAMILY_H} className="notice-inline">{NO_FAMILY_WORDS.none}</Notice>;
  }
  return (
    <Card title={<>{title}{rows.length ? ` (${rows.length})` : ""}</>} titleId={NO_FAMILY_H} description={NO_FAMILY_WORDS.lead(mayChangeFamilies)}>
      {view.state !== "listed" || list === null ? <Notice tone="warning" live="none">{whyNone(words)[view.state === "listed" ? "no_shape" : view.state]}</Notice> : <NoFamilyRows rows={rows} none={NO_FAMILY_WORDS.none} bulk={familiesFromCustomersAction} />}
      {children}
    </Card>
  );
}
