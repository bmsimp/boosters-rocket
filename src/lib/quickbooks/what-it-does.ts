/**
 * What the portal does in the club's QuickBooks, said once. The staff QuickBooks settings page, the setup step where
 * an Admin approves the access, and the Health page all say it in these words, so they can't come to disagree.
 * A slice that adds a read or a write changes them here; a write is also a deliberate change to
 * tests/unit/quickbooks-writes.test.ts.
 */
export const QUICKBOOKS_USE = {
  reads: "The portal reads the club's families and members, what each family owes, and the products and services its invoices are for, from QuickBooks.",
  writes: "It changes only what someone asks it to there: a parent's own phone and mailing address, and the email address they sign in with, in their own record's email field, "
    + "each only when that parent changes it in the portal; "
    + "and, for staff allowed to change the roster, new families, students, parents and members, their names, a student's family, and making a customer inactive "
    + "(a family together with everyone under it, and never anyone with an open balance). "
    + "And one kind of invoice: when a guardian chooses to pay instead of volunteering, it creates that invoice, and voids it if they switch back before paying anything on it. "
    + "It never deletes anything, never changes any other invoice, and never touches payments. "
    + "In an Intuit sandbox company only, an Admin can also run a check of these requests: it makes a few test records named “Booster Rocket check”, tries each change on them, and makes them inactive at the end.",
} as const;

/** The audit actions of those changes, for the pages that say when one was last made. */
export const QUICKBOOKS_WRITE_ACTION: readonly string[] = [
  "parent.contact.save", "parent.email.save",
  "roster.customer.create", "roster.customer.rename", "roster.student.move", "roster.customer.deactivate", "roster.write.done",
  "volunteer.buyout.invoiced", "volunteer.buyout.voided",
];
