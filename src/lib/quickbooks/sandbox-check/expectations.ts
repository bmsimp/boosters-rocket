import type { CheckLearned, CheckOutcome, CheckResult } from "@/lib/db/schema";

/**
 * Every request the portal sends QuickBooks, as the check of the portal's requests tries it, with what the portal
 * expects of the answer and how what was learned is said. This is the one list: the check (./run.ts) records a result
 * for each key, the page shows them in this order, and the tests read the same list. The expectations are the ones in
 * the roadmap's checks table and in the comments on INVOICE_QUERIES, ITEM_QUERY, CUSTOMER_UPDATE, EMAIL_UPDATE,
 * CUSTOMER_WRITES and INVOICE_WRITES in src/lib/quickbooks/client.ts. Pure: no database, no request.
 *
 * The words are for an Admin who does not code. Where an answer means the portal's code must change, `ifNot` says so
 * plainly, and `where` names the code for whoever maintains the portal. The check never changes how the portal behaves.
 */
export type ExpectationKey = (typeof EXPECTATIONS)[number]["key"];
export type Expectation = {
  key: string;
  /** Reads run against any connected company; writes only against an Intuit sandbox company. */
  group: "reads" | "writes";
  /** The request, in plain words. */
  title: string;
  /** What the portal expects QuickBooks to answer. */
  expects: string;
  /** What the check learned, in words, from the short codes and counts it kept. */
  learned: (l: CheckLearned) => string;
  /** What an answer that isn't as expected means for the club. */
  ifNot: string;
  /** Whether such an answer means a change to the portal's code, for whoever maintains it. */
  codeChange: boolean;
  /** For whoever maintains the portal: the code that holds this request. */
  where: string;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const yes = (v: unknown): boolean => v === true;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const words = (v: string[]): string => (v.length <= 1 ? v.join("") : `${v.slice(0, -1).join(", ")} and ${v.at(-1)}`);
/** QuickBooks' field names, as the check records them, in words. */
export const FIELD_WORDS: Record<string, string> = {
  DisplayName: "the name", GivenName: "the first name", FamilyName: "the last name", PrimaryEmailAddr: "the email", PrimaryPhone: "the phone",
  BillAddr: "the billing address", ParentRef: "the family it is under", CustomerTypeRef: "the customer type", Active: "whether it is active",
  Job: "whether it is a sub-customer", BillWithParent: "whether it is billed with its family", SubCustomers: "the customers under it",
  DocNumber: "the number", TxnDate: "the date", DueDate: "the due date", TotalAmt: "the total", Balance: "the balance", CustomerRef: "the customer",
  ItemRef: "the product or service", Qty: "the quantity", Id: "its ID and version",
  Line1: "address line 1", Line2: "address line 2", City: "city", CountrySubDivisionCode: "state or region", PostalCode: "postal code", Country: "country",
};
const fields = (v: unknown): string => words(list(v).map((f) => FIELD_WORDS[f] ?? f));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A QuickBooks refusal code as words: "code 5010", or how it failed when there was no code. */
export function codeWords(code: unknown): string {
  if (typeof code !== "string" || !code) return "no answer the portal could read";
  const fault = /^fault_(\d+)$/.exec(code);
  if (fault) return `a refusal with code ${fault[1]}`;
  const http = /^http_(\d+)/.exec(code);
  if (http) return `an error (HTTP ${http[1]})`;
  return CODE_WORDS[code] ?? `an answer the portal calls "${code}"`;
}
const CODE_WORDS: Record<string, string> = {
  accepted: "acceptance: it made the change",
  bad_answer: "an answer the portal couldn't read",
  fault: "a refusal sent as if it had worked",
  timeout: "no answer in time",
  unreachable: "no connection",
  other_company: "nothing: a different QuickBooks company is connected now",
  not_sandbox: "nothing: the connected company isn't an Intuit sandbox any more",
  not_mine: "nothing: the record isn't one this check made",
};

const LINK = "a Pay link";

export const EXPECTATIONS = [
  /* ---- Reads: run against any connected company ---- */
  {
    key: "customer_types", group: "reads", title: "The list of customer types",
    expects: "QuickBooks answers with every customer type, each with its ID and name.",
    learned: (l) => `${plural(num(l.count), "customer type", "customer types")} came back.`,
    ifNot: "The portal couldn't read the roster at all.", codeChange: true, where: "qboCustomerTypes() in src/lib/quickbooks/client.ts",
  },
  {
    key: "customers", group: "reads", title: "Every customer, active and inactive",
    expects: "QuickBooks answers a page at a time, each customer with its ID, its name and whether it is active.",
    learned: (l) => `${plural(num(l.count), "customer", "customers")} came back, ${num(l.inactive)} of them inactive.`,
    ifNot: "The portal couldn't read the roster, so it would show no families.", codeChange: true, where: "qboQueryAll() in src/lib/quickbooks/client.ts",
  },
  {
    key: "items", group: "reads", title: "The products and services",
    expects: "QuickBooks answers with the products and services, each with its ID, name, type and whether it is active, and a company with none answers with an empty list the portal accepts.",
    learned: (l) => `${plural(num(l.count), "product or service", "products and services")} came back${num(l.count) ? `, ${num(l.inactive)} of them inactive` : ""}${list(l.types).length ? ` (of the types ${words(list(l.types))})` : ""}. ${num(l.inactive) ? "So the list includes inactive ones." : "The list held no inactive one."}`,
    ifNot: "Staff couldn't choose the product or service a payment requirement is met by.", codeChange: true, where: "ITEM_QUERY in src/lib/quickbooks/client.ts",
  },
  {
    key: "invoices_list_form", group: "reads", title: "Invoices for several customers in one request",
    expects: "QuickBooks answers with only those customers' invoices, or refuses this form of request (the portal then asks for one customer at a time, which also works).",
    learned: (l) => l.form === "list"
      ? `This form works: ${plural(num(l.invoices), "invoice", "invoices")} came back for the ${plural(num(l.asked), "customer", "customers")} asked about, all of them theirs.`
      : l.form === "one_at_a_time" ? `QuickBooks refused this form (${codeWords(l.refusal)}), so the portal asks for one customer at a time. That works, a little more slowly.`
        : `${plural(num(l.others), "invoice", "invoices")} of customers that weren't asked about came back.`,
    ifNot: "An answer holding other customers' invoices could show a family what someone else owes.", codeChange: true, where: "INVOICE_QUERIES.inForm in src/lib/quickbooks/client.ts",
  },
  {
    key: "invoices_one_form", group: "reads", title: "Invoices for one customer",
    expects: "QuickBooks answers with only that customer's invoices.",
    learned: (l) => `${plural(num(l.invoices), "invoice", "invoices")} came back${num(l.others) ? `, ${num(l.others)} of them another customer's` : ", all of them that customer's"}.`,
    ifNot: "The portal couldn't show any family what it owes.", codeChange: true, where: "INVOICE_QUERIES.oneForm in src/lib/quickbooks/client.ts",
  },
  {
    key: "invoice_fields", group: "reads", title: "What each invoice carries",
    expects: "Each invoice has its number, its date and due date written as year-month-day, its total and balance as numbers, and the customer it is for.",
    learned: (l) => list(l.missing).length ? `${plural(num(l.checked), "invoice was", "invoices were")} looked at. Some lacked, or wrote differently: ${fields(l.missing)}.`
      : `${plural(num(l.checked), "invoice was", "invoices were")} looked at, and each carried all of these.`,
    ifNot: "Families would see invoices with parts missing or wrong.", codeChange: true, where: "shownInvoices() in src/lib/money/invoices.ts",
  },
  {
    key: "invoice_items", group: "reads", title: "The product or service on each invoice line",
    expects: "Each line of an invoice names its product or service by the same ID the list of products and services gives it.",
    learned: (l) => `${plural(num(l.lines), "invoice line was", "invoice lines were")} looked at: ${num(l.withItem)} named a product or service on the list${num(l.notOnList) ? `, ${num(l.notOnList)} named one that isn't on it` : ""}${num(l.withoutItem) ? `, ${num(l.withoutItem)} named none` : ""}.`,
    ifNot: "A payment requirement could never read as paid.", codeChange: true, where: "itemsOf() in src/lib/money/invoices.ts",
  },
  {
    key: "pay_links", group: "reads", title: "Pay links on invoices",
    expects: `An invoice that can be paid online carries ${LINK} to QuickBooks' own payment page, on intuit.com or a part of it, so the portal can show a Pay button.`,
    learned: (l) => `${num(l.withLink) === 0 ? `None of the ${plural(num(l.checked), "invoice", "invoices")} looked at carried ${LINK}.`
      : `${num(l.withLink)} of ${plural(num(l.checked), "invoice", "invoices")} carried ${LINK}, on ${words(list(l.hosts))}${num(l.unsafe) ? `; ${num(l.unsafe)} of the links weren't to QuickBooks' payment page, so they would get no Pay button` : ""}.`}${l.ownLinked !== false ? ""
      : num(l.withLink) > 0
        ? " The check's own invoice, made with no email address on it, came back without one, though other invoices of this company carry one: so the company does take payments online. The Pay link probe, under Changing, says what makes the difference."
        : " The check's own invoice, made with no email address on it, came back without one too. QuickBooks may give a Pay link only when the company takes payments online, or only to an invoice that carries a customer's email address: the Pay link probe, under Changing, says which."}`,
    ifNot: "Families would see no Pay button for invoices they could pay online.", codeChange: true, where: "INVOICE_INCLUDE in src/lib/quickbooks/client.ts and safePayLink() in src/lib/money/pay-link.ts",
  },
  {
    key: "empty_answer", group: "reads", title: "A request for invoices that matches nothing",
    expects: "QuickBooks answers with an empty list of the one shape the portal accepts, so a family with no invoices reads \"all paid up\", not \"can't show what you owe\".",
    learned: (l) => `QuickBooks answered with ${l.shape === "empty" ? "an empty answer" : l.shape === "empty_list" ? "an empty list of invoices" : l.shape === "paging_only" ? "an empty answer with paging numbers" : "an answer of another shape"}${yes(l.accepted) ? ", which the portal accepts" : ", which the portal refuses"}.`,
    ifNot: "Every family with no invoices would read that the portal can't show what they owe.", codeChange: true, where: "strictRowsOf() in src/lib/quickbooks/client.ts",
  },
  {
    key: "balance_with_jobs", group: "reads", title: "A family's balance, read by its ID",
    expects: "QuickBooks answers with the customer and its balance including the customers under it (BalanceWithJobs), as a number.",
    learned: (l) => !yes(l.number) ? "The answer had no balance of that kind."
      : l.includesSubs === undefined ? "The balance came as a number."
        : yes(l.includesSubs) ? "The balance came as a number, and it included the check's invoice on the student under the family."
          : "The balance came as a number, but it didn't include the check's invoice on the student under the family.",
    ifNot: "The portal's cross-check of a family's total would be wrong.", codeChange: true, where: "qboCustomerById() in src/lib/quickbooks/client.ts and balanceCoversTheSame() in src/lib/money/family-money.ts",
  },
  {
    key: "own_balance", group: "reads", title: "A student's own balance, read by its ID",
    expects: "QuickBooks answers with that customer's own open balance (Balance), without the customers under it.",
    learned: (l) => !yes(l.number) ? "The answer had no balance of that kind."
      : l.matches === undefined ? "The balance came as a number."
        : yes(l.matches) ? "It was the check student's own invoice, and the family's own balance didn't count it." : "It didn't match the check student's own invoice.",
    ifNot: "The treasurer's \"Worth a look\" list on Balances would be wrong.", codeChange: true, where: "src/lib/money/sweep.ts",
  },

  /* ---- Writes: run only against an Intuit sandbox company, on records the check makes ---- */
  {
    key: "create_family", group: "writes", title: "Making a family",
    expects: "QuickBooks makes the customer with the name and customer type sent, and answers with it.",
    learned: (l) => (yes(l.typeKept) ? "The family was made with the customer type sent." : "The family was made, but without the customer type sent."),
    ifNot: "Staff couldn't add a family from the roster pages.", codeChange: true, where: "CUSTOMER_WRITES.create in src/lib/quickbooks/client.ts",
  },
  {
    key: "duplicate_name", group: "writes", title: "Making a customer with a name already in use",
    expects: "QuickBooks refuses it with code 6240 and makes nothing; the portal then offers \"Name (2)\".",
    learned: (l) => (l.code === "accepted" ? "QuickBooks made a second customer with the same name." : `QuickBooks answered with ${codeWords(l.code)}.`),
    ifNot: "Staff would be told the wrong thing about a name already in use.", codeChange: true, where: "CUSTOMER_WRITES.faults.duplicateName in src/lib/quickbooks/client.ts",
  },
  {
    key: "create_student", group: "writes", title: "Making a student under a family",
    expects: "QuickBooks makes a sub-customer of the family, billed with it.",
    learned: (l) => `The student was made${yes(l.under) ? " under the family" : " but not under the family"}${yes(l.billed) ? ", billed with it" : ", not billed with it"}.`,
    ifNot: "Staff couldn't add a student from the roster pages.", codeChange: true, where: "CUSTOMER_WRITES.create in src/lib/quickbooks/client.ts",
  },
  {
    key: "contact_phone", group: "writes", title: "A parent changing a phone number",
    expects: "QuickBooks changes the phone and nothing else, and raises the record's version (SyncToken).",
    learned: (l) => list(l.changed).length ? `The phone changed, and so did: ${fields(l.changed)}.` : `Only the phone changed${yes(l.versionRaised) ? ", and the version went up" : ", but the version didn't go up"}.`,
    ifNot: "A parent's phone change could change other parts of their record.", codeChange: true, where: "CUSTOMER_UPDATE in src/lib/quickbooks/client.ts",
  },
  {
    key: "contact_address", group: "writes", title: "A parent changing a mailing address",
    expects: "QuickBooks replaces the billing address and leaves the phone and everything else as it was.",
    learned: (l) => list(l.changed).length ? `The address changed, and so did: ${fields(l.changed)}.` : `Only the address changed${yes(l.asSent) ? ", exactly as sent" : ", but not exactly as sent"}.`,
    ifNot: "A parent's address change could change other parts of their record.", codeChange: true, where: "CUSTOMER_UPDATE in src/lib/quickbooks/client.ts",
  },
  {
    key: "create_parent", group: "writes", title: "Making a parent under a family",
    expects: "QuickBooks makes a sub-customer of the family, not billed with it, with the email address sent.",
    learned: (l) => `The parent was made${yes(l.under) ? " under the family" : " but not under the family"}, ${yes(l.emailKept) ? "with the email address sent" : "without the email address sent"}. QuickBooks ${yes(l.copiedContact) ? "copied the family's phone or address onto it" : "didn't copy the family's phone or address onto it"}.`,
    ifNot: "A guardian added under Portal sign-ins wouldn't get their own Parent customer under the family.", codeChange: true, where: "CUSTOMER_WRITES.create in src/lib/quickbooks/client.ts",
  },
  {
    key: "duplicate_name_other_parent", group: "writes", title: "Making a parent with a name already used under another family",
    expects: "The portal doesn't know yet whether QuickBooks takes a second customer with the same name under a different family, or refuses it as a name already in use (code 6240). Either is fine: when a guardian is added, the portal compares nothing but the family's own customers before it sends, and QuickBooks' answer decides. If QuickBooks takes it, a person who is a guardian in two families gets a Parent customer under each. If it refuses, the second family's Parent customer is kept on the Reconciliation page with the words for a name already in use, and its ways out are renaming the person or giving it up.",
    learned: (l) => (l.code === "accepted" ? "QuickBooks made a second customer with the same name under the other family." : `QuickBooks answered with ${codeWords(l.code)}.`),
    ifNot: "Nothing in the portal is wrong either way: this tells the portal which of the two answers this company's QuickBooks gives.", codeChange: false,
    where: "the guardian's Parent customer create in src/lib/roster/writes.ts",
  },
  {
    key: "contact_stale", group: "writes", title: "A phone change from an old version of the record",
    expects: "QuickBooks refuses it with code 5010 and changes nothing, so nobody's change is overwritten.",
    learned: (l) => `QuickBooks answered with ${codeWords(l.code)}${yes(l.unchanged) ? " and changed nothing" : " and changed the record"}.`,
    ifNot: "A parent's change could overwrite one made in QuickBooks a moment before.", codeChange: true, where: "CUSTOMER_UPDATE.faults.stale in src/lib/quickbooks/client.ts",
  },
  {
    key: "phone_limit", group: "writes", title: "The longest phone number",
    expects: "QuickBooks takes a phone of 30 characters and refuses one of 31 with a code the portal reads as \"a value it won't take\" (2000 to 2999, or 6000).",
    learned: (l) => `30 characters: ${yes(l.thirty) ? "taken" : `refused (${codeWords(l.thirtyCode)})`}. 31 characters: ${l.code === "accepted" ? "taken too, so QuickBooks allows longer" : `refused with ${codeWords(l.code)}`}.`,
    ifNot: "The portal's limit on a phone number doesn't match QuickBooks'.", codeChange: true, where: "src/lib/parents/contact-fields.ts and CUSTOMER_UPDATE.faults.validation in src/lib/quickbooks/client.ts",
  },
  {
    key: "address_limits", group: "writes", title: "The longest address the portal allows",
    expects: "QuickBooks takes address lines of 200 characters, a city, state and country of 100 and a postal code of 20: its own limits are no lower than the portal's.",
    learned: (l) => list(l.refused).length ? `QuickBooks refused the longest ${fields(l.refused)} (${codeWords(l.code)}).` : "QuickBooks took the longest of each part.",
    ifNot: "A parent could type an address QuickBooks won't take.", codeChange: true, where: "src/lib/parents/contact-fields.ts",
  },
  {
    key: "clear_fields", group: "writes", title: "Clearing a phone and an address",
    expects: "Sending an empty phone and empty address parts leaves them empty in QuickBooks.",
    learned: (l) => l.code ? `QuickBooks refused the empty values (${codeWords(l.code)}).` : `The phone was ${yes(l.phoneCleared) ? "cleared" : "kept as it was"}, and the address ${yes(l.addressCleared) ? "cleared" : "kept as it was"}.`,
    ifNot: "A parent who removes their phone or address would find it still in QuickBooks.", codeChange: true, where: "CUSTOMER_UPDATE.body in src/lib/quickbooks/client.ts, with tests/helpers/qbo-stub.ts",
  },
  {
    key: "email_update", group: "writes", title: "A parent changing their sign-in email",
    expects: "QuickBooks changes the email field and nothing else, on the record and on the customers under it.",
    learned: (l) => list(l.changed).length ? `The email changed, and so did: ${fields(l.changed)}.` : `Only the email changed${yes(l.versionRaised) ? ", and the version went up" : ", but the version didn't go up"}; the customers under the family were as they were.`,
    ifNot: "A parent's email change could change other parts of their family's records.", codeChange: true, where: "EMAIL_UPDATE in src/lib/quickbooks/client.ts",
  },
  {
    key: "email_several", group: "writes", title: "An email field holding two addresses",
    expects: "QuickBooks keeps the field exactly as sent and gives it back the same way.",
    learned: (l) => (yes(l.kept) ? "It came back exactly as sent." : "It came back changed."),
    ifNot: "A parent's change of one address could lose the other addresses in the field.", codeChange: true, where: "replaceAddressInField() in src/lib/parents/email-field.ts",
  },
  {
    key: "email_length", group: "writes", title: "The longest email field",
    expects: "QuickBooks takes an email field of 100 characters, the longest the portal sends. (The portal itself refuses a longer one, so a longer one isn't tried.)",
    learned: (l) => (l.code === "accepted" ? "A field of 100 characters was taken." : `A field of 100 characters was refused (${codeWords(l.code)}).`),
    ifNot: "Some parents couldn't change their email address.", codeChange: true, where: "EMAIL_UPDATE.maxLength in src/lib/quickbooks/client.ts and EMAIL_FIELD_MAX in src/lib/parents/email-field.ts",
  },
  {
    key: "email_stale", group: "writes", title: "An email change from an old version of the record",
    expects: "QuickBooks refuses it with code 5010 and changes nothing.",
    learned: (l) => `QuickBooks answered with ${codeWords(l.code)}${yes(l.unchanged) ? " and changed nothing" : " and changed the record"}.`,
    ifNot: "An email change could overwrite one made in QuickBooks a moment before.", codeChange: true, where: "EMAIL_UPDATE.faults.stale in src/lib/quickbooks/client.ts",
  },
  {
    key: "email_invalid", group: "writes", title: "An email field that isn't an address",
    expects: "QuickBooks refuses it with a code the portal reads as \"a value it won't take\" (2000 to 2999, or 6000).",
    learned: (l) => (l.code === "accepted" ? "QuickBooks took it." : `QuickBooks answered with ${codeWords(l.code)}.`),
    ifNot: "A parent would be told the wrong thing when QuickBooks won't take an address.", codeChange: true, where: "EMAIL_UPDATE.faults.validation in src/lib/quickbooks/client.ts",
  },
  {
    key: "rename", group: "writes", title: "Renaming a family",
    expects: "QuickBooks changes the name and nothing else.",
    learned: (l) => `${list(l.changed).length ? `The name changed, and so did: ${fields(l.changed)}.` : "Only the name changed."} The full name of a customer under the family ${yes(l.subsFollow) ? "followed the new name" : "didn't follow the new name"}.`,
    ifNot: "Renaming a family could change other parts of its record.", codeChange: true, where: "CUSTOMER_WRITES.rename in src/lib/quickbooks/client.ts",
  },
  {
    key: "rename_stale", group: "writes", title: "A rename from an old version of the record",
    expects: "QuickBooks refuses it with code 5010 and changes nothing.",
    learned: (l) => `QuickBooks answered with ${codeWords(l.code)}${yes(l.unchanged) ? " and changed nothing" : " and changed the record"}.`,
    ifNot: "A staff change could overwrite one made in QuickBooks a moment before.", codeChange: true, where: "CUSTOMER_WRITES.faults.stale in src/lib/quickbooks/client.ts",
  },
  {
    key: "invoice_create", group: "writes", title: "Making a buy-out invoice on a student",
    expects: "QuickBooks makes one invoice on the student, with the product or service, quantity and amount sent, and answers with it.",
    learned: (l) => list(l.wrong).length ? `The invoice was made, but these weren't as sent: ${fields(l.wrong)}.` : "The invoice was made on the student, with the product or service, quantity and amount sent.",
    ifNot: "A guardian who chooses to pay instead of volunteering couldn't be invoiced.", codeChange: true, where: "INVOICE_WRITES.create in src/lib/quickbooks/client.ts",
  },
  {
    key: "invoice_note", group: "writes", title: "Finding a buy-out invoice again",
    expects: "The invoice's private note comes back as it was sent when the student's invoices are read: that is how the portal finds an invoice whose answer was lost.",
    learned: (l) => (yes(l.kept) ? "The note came back as sent." : yes(l.found) ? "The invoice came back, but its note had changed." : "The invoice didn't come back when the student's invoices were read."),
    ifNot: "A buy-out invoice whose answer was lost could be made twice.", codeChange: true, where: "src/lib/buyouts/writes.ts",
  },
  {
    key: "invoice_no_email", group: "writes", title: "A buy-out invoice is not emailed",
    expects: "QuickBooks keeps the invoice's email status as not set, so it sends no email. (When no due date is sent, the check notes the one QuickBooks gave.)",
    learned: (l) => `Its email status came back ${l.emailStatus === "NotSet" ? "as not set" : `as ${typeof l.emailStatus === "string" && l.emailStatus ? l.emailStatus : "nothing"}`}. Its due date was ${typeof l.dueDays === "number" ? (l.dueDays === 0 ? "the day it was made" : `${plural(l.dueDays, "day", "days")} after the day it was made`) : "not set"}.`,
    ifNot: "QuickBooks might email a family an invoice the portal made.", codeChange: true, where: "INVOICE_WRITES.create in src/lib/quickbooks/client.ts",
  },
  {
    key: "pay_link_probe", group: "writes", title: "A Pay link on a buy-out invoice",
    expects: "The check makes its invoice a second time, the same but carrying a bill-to email address (the check's own, at example.com) with its email status still not set, so nothing is emailed, as the portal makes a buy-out invoice: it carries the sign-in address of the guardian who chose it. It notes whether each came back with a Pay link, and voids the second at once.",
    learned: (l) => !yes(l.found) ? "The second invoice didn't come back when the student's invoices were read."
      : `Made with no email address, it came back ${yes(l.plainLinked) ? "with" : "without"} ${LINK}. With a bill-to email address, as a buy-out invoice is made, it came back ${yes(l.emailLinked) ? "with" : "without"} one${l.emailStatus === "NotSet" ? ", and its email status still not set" : `, and its email status ${typeof l.emailStatus === "string" && l.emailStatus ? `came back as ${l.emailStatus}` : "came back as nothing"}`}.${
        !yes(l.plainLinked) && yes(l.emailLinked) ? " So QuickBooks gives a Pay link only to an invoice with an email address, which is why the portal gives each buy-out invoice the sign-in address of the guardian who chose it (nothing is emailed)."
          : !yes(l.emailLinked) ? " So a buy-out invoice, which carries the sign-in address of the guardian who chose it, may come with no Pay button in this company." : ""}`,
    ifNot: "QuickBooks might email a family an invoice the portal made, or give it a link that isn't to its payment page.", codeChange: true, where: "INVOICE_WRITES.create in src/lib/quickbooks/client.ts",
  },
  {
    key: "move", group: "writes", title: "Moving a student to another family",
    expects: "QuickBooks puts the student under the other family, billed with it, and changes nothing else.",
    learned: (l) => `${list(l.changed).length ? `The student moved, and these changed too: ${fields(l.changed)}.` : "The student moved, and nothing else changed."} Its open invoice ${yes(l.invoiceStayed) ? "stayed on the student, still open" : "didn't stay as it was"}.`,
    ifNot: "Moving a student could change other parts of their record.", codeChange: true, where: "CUSTOMER_WRITES.reparent in src/lib/quickbooks/client.ts",
  },
  {
    key: "inactive_with_balance", group: "writes", title: "Making a customer with an open balance inactive",
    expects: "QuickBooks refuses it with code 6220 and changes nothing. The portal reads what is owed before it sends this, and says the same words if QuickBooks refuses it anyway.",
    learned: (l) => (l.code === "accepted" ? "QuickBooks took it: a customer with an open balance can be made inactive. The check made it active again to go on." : `QuickBooks refused it with ${codeWords(l.code)}.`),
    ifNot: "Staff would be told the wrong thing when someone with a balance can't be made inactive.", codeChange: true, where: "CUSTOMER_WRITES.faults.openBalance in src/lib/quickbooks/client.ts and refusalWords() in src/lib/roster/writes.ts",
  },
  {
    key: "void_stale", group: "writes", title: "Voiding an invoice from an old version of it",
    expects: "QuickBooks refuses it with code 5010 and voids nothing.",
    learned: (l) => `QuickBooks answered with ${codeWords(l.code)}.`,
    ifNot: "The portal could void an invoice that changed in QuickBooks a moment before.", codeChange: true, where: "INVOICE_WRITES.faults.stale in src/lib/quickbooks/client.ts",
  },
  {
    key: "invoice_void", group: "writes", title: "Voiding a buy-out invoice",
    expects: "QuickBooks voids it, leaving its total and balance at 0, and the invoice still comes back that way when invoices are read.",
    learned: (l) => `The invoice ${yes(l.zero) ? "was left with a total and balance of 0" : "wasn't left at 0"}${yes(l.stillListed) ? ", and still comes back when invoices are read" : ", and didn't come back when invoices were read"}.`,
    ifNot: "A guardian who switches back before paying would still owe the buy-out.", codeChange: true, where: "INVOICE_WRITES.void in src/lib/quickbooks/client.ts",
  },
  {
    key: "family_inactive_while_under", group: "writes", title: "Making a family inactive while a customer under it is active",
    expects: "QuickBooks refuses it with code 800 and changes nothing: that is why the portal makes everyone under a family inactive first.",
    learned: (l) => (l.code === "accepted" ? `QuickBooks took it. The customer under it was ${yes(l.childrenInactive) ? "made inactive too" : "left active"}.` : `QuickBooks answered with ${codeWords(l.code)}.`),
    ifNot: "The portal's way of making a family inactive, everyone under it first, would need looking at again.", codeChange: true, where: "CUSTOMER_WRITES.faults.activeUnder in src/lib/quickbooks/client.ts and askFamilyInactive() in src/lib/roster/writes.ts",
  },
  {
    key: "family_inactive_after", group: "writes", title: "Making a family inactive once everyone under it is inactive",
    expects: "With the customer under it made inactive first, QuickBooks makes the family inactive.",
    learned: (l) => `${l.code === "accepted" ? "QuickBooks made the family inactive." : `QuickBooks answered with ${codeWords(l.code)}.`} Making the customer under it inactive ${yes(l.familyVersionRose) ? "raised the family's own version" : "left the family's own version as it was"}.`,
    ifNot: "Staff couldn't make a family inactive from the roster pages.", codeChange: true, where: "askFamilyInactive() in src/lib/roster/writes.ts and CUSTOMER_WRITES.active in src/lib/quickbooks/client.ts",
  },
  {
    key: "all_inactive", group: "writes", title: "Making every record the check made inactive",
    expects: "At the end every customer the check made is inactive (QuickBooks deletes no customer) and its invoice is voided.",
    learned: (l) => (num(l.open) ? `${plural(num(l.open), "record is", "records are")} still active. The next run makes ${num(l.open) === 1 ? "it" : "them"} inactive first.` : `All ${plural(num(l.closed), "record", "records")} the check made are inactive or voided.`),
    ifNot: "Some of the check's records are still active in the sandbox company.", codeChange: false, where: "src/lib/quickbooks/sandbox-check/run.ts",
  },
] as const satisfies readonly Expectation[];

export const EXPECTATION_KEYS: readonly ExpectationKey[] = EXPECTATIONS.map((e) => e.key);
export const expectation = (key: string): Expectation | undefined => EXPECTATIONS.find((e) => e.key === key);

/** Why a request wasn't tried, in words. */
export const NOT_RUN_WORDS: Record<string, string> = {
  production: "Not tried: the check makes changes only in an Intuit sandbox company, never in the club's real books.",
  needs_earlier: "Not tried: it needs a step before it that didn't work.",
  no_item: "Not tried: the company has no active product or service to put on an invoice.",
  no_invoices: "Not tried: no invoice came back to look at.",
  no_customers: "Not tried: the company has no customer to ask about.",
  no_types: "Not tried: the company has no active customer type to make the check's records with. Add one in QuickBooks, then run the check again.",
  roster_busy: "Not tried: the portal was reading the roster from QuickBooks just then. Run the check again in a minute.",
  stopped: "Not tried: the check stopped before it got here.",
};
export const notRunWords = (code: string | null): string => NOT_RUN_WORDS[code ?? ""] ?? NOT_RUN_WORDS.stopped!;

/** Why a run stopped part way, in words. */
export const STOP_WORDS: Record<string, string> = {
  other_company: "A different QuickBooks company was connected while the check ran, so it stopped and sent nothing more.",
  not_sandbox: "The connection stopped being an Intuit sandbox company while the check ran, so it stopped and sent nothing more.",
  not_connected: "QuickBooks was disconnected while the check ran, so it stopped.",
  unreachable: "QuickBooks couldn't be reached, so the check stopped. Try again later.",
  timeout: "QuickBooks took too long to answer, so the check stopped. Try again later.",
  needs_admin: "The QuickBooks connection needs an Admin to connect it again, so the check stopped.",
  cut_off: "This run was cut off before it finished (the server restarted, perhaps). The next run made its records inactive first.",
  unexpected: "Something unexpected went wrong, so the check stopped.",
};
export const stopWords = (code: string | null): string => STOP_WORDS[code ?? ""] ?? STOP_WORDS.unexpected!;

/** The words for an outcome, as the page shows it beside each request. */
export const OUTCOME_WORDS: Record<CheckOutcome, string> = { as_expected: "As expected", not_as_expected: "Not as expected", learned: "Noted", not_run: "Not tried" };

/** No request answered other than expected. Requests not tried don't count against it, but see untriedChanges(). */
export const allAsExpected = (results: CheckResult[]): boolean => results.every((r) => r.outcome !== "not_as_expected");

/** How many of the changes weren't tried: a run asked to try them that leaves any untried hasn't shown they work. */
export const untriedChanges = (results: CheckResult[]): number =>
  results.filter((r) => r.outcome === "not_run" && EXPECTATIONS.some((x) => x.key === r.key && x.group === "writes")).length;
