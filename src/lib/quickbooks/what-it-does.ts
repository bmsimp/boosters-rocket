/**
 * What the portal does in the club's QuickBooks, said once. The staff QuickBooks settings page, the setup step where
 * an Admin approves the access, and the Health page all say it in these words, so they can't come to disagree.
 * A slice that adds a read or a write changes them here; a write is also a deliberate change to
 * tests/unit/quickbooks-writes.test.ts.
 */
export const QUICKBOOKS_USE = {
  reads: "The portal reads the club's families and members, what each family owes, and the products and services its invoices are for, from QuickBooks.",
  writes: "It changes one thing there: a parent's own phone and mailing address, when that parent edits them in the portal.",
} as const;

/** The audit action of that one change, for the pages that say when it was last made. */
export const QUICKBOOKS_WRITE_ACTION = "parent.contact.save";
