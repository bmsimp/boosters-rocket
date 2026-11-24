/**
 * What the portal does in the club's QuickBooks, said once. The staff QuickBooks settings page, the setup step where
 * an Admin approves the access, and the Health page all say it in these words, so they can't come to disagree: two
 * sentences of summary, then the details under four short headings (the pages fold them into a disclosure,
 * `QuickBooksUse`, and the Health page's line carries them as one note, `QUICKBOOKS_USE_TEXT`).
 * A slice that adds a read or a write changes them here; a write is also a deliberate change to
 * tests/unit/quickbooks-writes.test.ts.
 */
export const QUICKBOOKS_USE = {
  summary: "The portal reads the club's families, members and what each family owes from QuickBooks. "
    + "It changes something there only when someone asks it to, and it never deletes anything or touches payments.",
  groups: [
    {
      key: "reads", heading: "What it reads",
      items: [
        "The club's families and members, with the email, phone and mailing address on their records, what each family owes, and the products and services its invoices are for.",
        "What it reads decides whose invoices each family sees. It changes none of the portal's own families, students or sign-ins.",
        "So a name, a student's family, or a customer made inactive or active again in QuickBooks stays as the portal has it until someone who can link families takes it into the portal, on the accounting links screen. "
          + "The guardians of a family made active again that way sign in to it only once someone who may change families lets them in.",
        "A guardian's phone and mailing address are the portal's own: it takes them in once, from the guardian's own record, after the first roster read since the update that made them so. "
          + "A change made to them in QuickBooks after that stays there.",
      ],
    },
    {
      key: "writes", heading: "What it changes in QuickBooks, and only when someone asks",
      items: [
        "A guardian's phone and mailing address, on their own record (or, where the club's books have no parents of their own, the family's), after the portal saves a change a parent or staff make to them, "
          + "and never over details QuickBooks holds that the portal didn't know of.",
        "The address a parent signs in with, in the email field of each record of theirs (their own record in each family, or, where the club's books have no parents of their own, the family's), after the portal changes it, "
          + "replacing only the address the portal knew there and never over an address it didn't know of.",
        "From the Families pages, for staff allowed to change the roster: new families, students, parents and members, their names, a student's family, and making a customer inactive "
          + "(a family together with everyone under it, and never anyone with any balance, owed or a credit).",
        "From the accounting links screen: a name, a student's family, or an inactive student, member or family of the portal's (a family together with everyone under it), sent over what the books changed, under the same rules. "
          + "One at a time, or every name and student's family a list there shows at once (except one that must wait for another sent with it), which it sends within a few minutes.",
        "Where the club's books have parents of their own, a guardian staff add to a linked family gets a parent record under it, with their name and sign-in email address, unless QuickBooks already has a customer of that name there. "
          + "That record is renamed with them, and made inactive when they are removed, but only when it has no balance the portal can read, owed or a credit.",
        "One kind of invoice: when a guardian chooses to pay instead of volunteering, it creates that invoice, and voids it if they switch back before paying anything on it. "
          + "The invoice carries that guardian's sign-in email address as its bill-to address, so it can be paid online; nothing is emailed, by the portal or by QuickBooks.",
        "Each change is in the audit log.",
      ],
    },
    {
      key: "never", heading: "What it never does",
      items: ["It never deletes anything.", "It never changes any other invoice.", "It never touches payments."],
    },
    {
      key: "check", heading: "Sandbox check",
      items: ["In an Intuit sandbox company only, an Admin can run a check of these requests: it makes a few test records named “Boosters Rocket check”, tries each change on them, and makes them inactive at the end."],
    },
  ],
} as const;

/** Every detail, as one line of text, for the Health page's QuickBooks line, which has room for words but not for headings. */
export const QUICKBOOKS_USE_TEXT: string = QUICKBOOKS_USE.groups.flatMap((g) => g.items).join(" ");

/** The audit actions of those changes, for the pages that say when one was last made. */
export const QUICKBOOKS_WRITE_ACTION: readonly string[] = [
  "parent.contact.save", "roster.customer.contact", "roster.customer.email",
  "roster.customer.create", "roster.customer.rename", "roster.student.move", "roster.customer.deactivate", "roster.write.done",
  "volunteer.buyout.invoiced", "volunteer.buyout.voided",
];
