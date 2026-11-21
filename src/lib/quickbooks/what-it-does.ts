/**
 * What the portal does in the club's QuickBooks, said once. The staff QuickBooks settings page, the setup step where
 * an Admin approves the access, and the Health page all say it in these words, so they can't come to disagree.
 * A slice that adds a read or a write changes them here; a write is also a deliberate change to
 * tests/unit/quickbooks-writes.test.ts.
 */
export const QUICKBOOKS_USE = {
  reads: "The portal reads the club's families and members, with the email, phone and mailing address on their records, what each family owes, and the products and services its invoices are for, from QuickBooks. "
    + "What it reads there decides whose invoices each family sees; it changes none of the portal's own families, students or sign-ins, "
    + "so a name, a student's family, or a customer made inactive or active again in QuickBooks stays as the portal has it until someone who may link families to accounting takes it into the portal, on the accounting links screen, "
    + "and the guardians of a family made active again that way sign in to it only once someone who may change families lets them in. "
    + "A guardian's phone and mailing address are the portal's own: it takes them in once, from the guardian's own record, after the first roster read since the update that made them so, "
    + "and a change made to them in QuickBooks after that stays there.",
  writes: "It changes only what someone asks it to there: "
    + "a guardian's phone and mailing address, on their own record (or, where the club's books have no parents of their own, the family's), after the portal saves a change a parent or staff make to them, "
    + "and never over details QuickBooks holds that the portal didn't know of; "
    + "the address a parent signs in with, in the email field of each record of theirs (their own record in each family, or, where the club's books have no parents of their own, the family's), after the portal changes it, "
    + "replacing only the address the portal knew there and never over an address it didn't know of; "
    + "and, for staff allowed to change the roster, new families, students, parents and members, their names, a student's family, and making a customer inactive "
    + "(a family together with everyone under it, and never anyone with any balance, owed or a credit). "
    + "Where the club's books have parents of their own, a guardian staff add to a linked family gets a parent record under it, with their name and sign-in email address, unless QuickBooks already has a customer of that name there; "
    + "it is renamed with them, and made inactive when they are removed only when it has no balance the portal can read, owed or a credit. "
    + "And one kind of invoice: when a guardian chooses to pay instead of volunteering, it creates that invoice, and voids it if they switch back before paying anything on it. "
    + "The invoice carries that guardian's sign-in email address as its bill-to address, so it can be paid online; nothing is emailed, by the portal or by QuickBooks. "
    + "It never deletes anything, never changes any other invoice, and never touches payments. "
    + "In an Intuit sandbox company only, an Admin can also run a check of these requests: it makes a few test records named “Booster Rocket check”, tries each change on them, and makes them inactive at the end.",
} as const;

/** The audit actions of those changes, for the pages that say when one was last made. */
export const QUICKBOOKS_WRITE_ACTION: readonly string[] = [
  "parent.contact.save", "roster.customer.contact", "roster.customer.email",
  "roster.customer.create", "roster.customer.rename", "roster.student.move", "roster.customer.deactivate", "roster.write.done",
  "volunteer.buyout.invoiced", "volunteer.buyout.voided",
];
