/**
 * What the portal does in the club's QuickBooks, said once. The staff QuickBooks settings page, the setup step where
 * an Admin approves the access, and the Health page all say it in these words, so they can't come to disagree.
 * A slice that adds a read or a write changes them here; a write is also a deliberate change to
 * tests/unit/quickbooks-writes.test.ts.
 */
export const QUICKBOOKS_USE = {
  reads: "The portal reads the club's families and members, what each family owes, and the products and services its invoices are for, from QuickBooks.",
  writes: "It changes only what someone asks it to there: a parent's own phone and mailing address, when that parent edits them in the portal; "
    + "and, for staff allowed to change the roster, new families, students, parents and members, their names, a student's family, and making a customer inactive. "
    + "It never deletes anything, and never touches invoices or payments.",
} as const;

/** The audit actions of those changes, for the pages that say when one was last made. */
export const QUICKBOOKS_WRITE_ACTION: readonly string[] = [
  "parent.contact.save",
  "roster.customer.create", "roster.customer.rename", "roster.student.move", "roster.customer.deactivate", "roster.write.done",
];
