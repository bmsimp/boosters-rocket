/**
 * What the portal does in the club's QuickBooks, said once, in two sentences: the staff QuickBooks settings page, the
 * setup step where an Admin approves the access, and the Health page's QuickBooks line all say it in these words, so
 * they can't come to disagree (the owner's choice of 2026-11-25: no fold-out of details under it). A slice that adds a
 * read or a write keeps these true; a write is also a deliberate change to tests/unit/quickbooks-writes.test.ts.
 */
export const QUICKBOOKS_USE = {
  summary: "The portal reads the club's families, members and what each family owes from QuickBooks. "
    + "It changes something there only when someone asks it to, and it never deletes anything or touches payments.",
} as const;

/** The same words, for the Health page's QuickBooks line. */
export const QUICKBOOKS_USE_TEXT: string = QUICKBOOKS_USE.summary;

/** The audit actions of those changes, for the pages that say when one was last made. */
export const QUICKBOOKS_WRITE_ACTION: readonly string[] = [
  "parent.contact.save", "roster.customer.contact", "roster.customer.email",
  "roster.customer.create", "roster.customer.rename", "roster.student.move", "roster.customer.deactivate", "roster.write.done",
  "volunteer.buyout.invoiced", "volunteer.buyout.voided",
];
