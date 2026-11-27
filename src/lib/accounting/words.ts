/**
 * The words the connected accounting system supplies to the pages about it (stage 5's direction: accounting as an
 * additive plugin, not core). A page about the books says "your books" and "the books" in its own words, and takes from
 * here only what differs by system: its name (said once, in "Connected to …"), what it calls a customer record, its
 * logo, and the Settings page where it is set up. New accounting UI reads its words here, never a hard-coded
 * "QuickBooks" (docs/agents/app-records.md).
 *
 * Today the portal connects to one system, so this returns QuickBooks' words; a second integration adds its own entry
 * and the connection says which is in use.
 */
export type AccountingWords = {
  /** Which integration these words belong to: the key its logo and settings are found by. */
  system: "quickbooks";
  /** The system's name, as people read it: shown once on a page, beside its logo. */
  name: string;
  /** What the system calls one record a family is linked to, in lower case: "customer" (QuickBooks), "contact" (Xero). */
  customerNoun: string;
  /** Its plural, in lower case. */
  customerNounPlural: string;
  /** Whether its records nest (a family's record with its students' and parents' under it). */
  nests: boolean;
  /** Whether the portal may send a change to it. */
  canWrite: boolean;
  /** Its own Settings page, where an Admin sets it up. */
  settingsHref: string;
};

const QUICKBOOKS: AccountingWords = {
  system: "quickbooks",
  name: "QuickBooks",
  customerNoun: "customer",
  customerNounPlural: "customers",
  nests: true,
  canWrite: true,
  settingsHref: "/staff/settings/quickbooks",
};

/** The connected accounting system's words: QuickBooks', the one system the portal connects to today. */
export const accountingWords = (): AccountingWords => QUICKBOOKS;

/** A word with its first letter in capitals, for the start of a heading or a sentence ("Customers with no family"). */
export const capitalized = (word: string): string => (word === "" ? word : word[0]!.toLocaleUpperCase("en") + word.slice(1));
