/**
 * The phone and mailing address a parent may change from the portal (v1 spec §6.2), as the form holds them, and the
 * checks on what a browser sends. Pure: no database, no QuickBooks, no environment, so the form (a client component)
 * and the server use the same limits. What reads and saves them in the portal is ./contact-edits.ts.
 */
export type ContactValues = { phone: string; line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
export type ContactField = keyof ContactValues;
/**
 * What the form shows and sends back: the values, and the version they were read at, which says whose details they are
 * and that row's `contact_version`: `p:<n>` for the person's own, `f:<n>` for the family's (formVersion()). A change
 * saved meanwhile is noticed and not overwritten, and so is a form drawn for the person's details that comes back after
 * the membership shape made them the family's, or the other way round: the two rows count their versions apart, so a
 * number alone could match the other row's.
 */
export type ContactForm = { values: ContactValues; version: string };

/**
 * Each field with its label and the most it may hold. Intuit's reference for the Customer object would not load when
 * this was written, so these are chosen to sit at or under what QuickBooks is known to take: 30 for a phone number
 * (the limit QuickBooks itself reports for one), and for the address well under its 500 a line, 255 for a city,
 * state or country and 30 for a postal code. The owner's sandbox check confirms a phone of 30 characters is accepted
 * (CUSTOMER_UPDATE in src/lib/quickbooks/client.ts). Since stage 3's slice 11a the values are the portal's own, and
 * since slice 11b each change a parent saves is sent on to QuickBooks after the save, by the write queue's worker; a
 * value the take-in brought from QuickBooks can be longer than these (fieldErrors()).
 */
export const CONTACT_FIELDS: readonly { name: ContactField; label: string; max: number }[] = [
  { name: "phone", label: "Phone", max: 30 },
  { name: "line1", label: "Address line 1", max: 200 },
  { name: "line2", label: "Address line 2", max: 200 },
  { name: "city", label: "City", max: 100 },
  { name: "region", label: "State or region", max: 100 },
  { name: "postalCode", label: "ZIP or postal code", max: 20 },
  { name: "country", label: "Country", max: 100 },
];

/** Nothing a browser sends for one field is read past this: a full field is far shorter. */
const MAX_SENT = 2_000;
/**
 * Never saved: control characters (a line break among them: each field is one line), the line and paragraph
 * separators, and the characters that reorder the text around them, which could make a value read as something else
 * in the audit log.
 */
const range = (from: number, to: number) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;
const REORDERS = `${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}`;
const NOT_SAVED = new RegExp(`[\\p{Cc}${range(0x2028, 0x2029)}${REORDERS}]`, "u");
const VERSION = /^[pf]:\d{1,20}$/;

/** The version a form carries for details read at `version` from the person's row or the family's. */
export const formVersion = (whose: "person" | "family", version: number): string => `${whose === "family" ? "f" : "p"}:${version}`;

/** What ends a line: the control characters that do, and the line and paragraph separators. */
const BREAKS = `\\n\\r\\u000b\\u000c\\u0085${range(0x2028, 0x2029)}`;
const AS_SHOWN = {
  /** Half of a pair with no other half: a form sends U+FFFD in its place. */
  broken: /\p{Cs}/gu,
  reorders: new RegExp(`[${REORDERS}]`, "gu"),
  /** A control character that doesn't end a line: a tab, say. */
  control: new RegExp(`[^\\P{Cc}${BREAKS}]`, "gu"),
  /** One or more line breaks, with the spaces around them. */
  breaks: new RegExp(`\\s*[${BREAKS}]\\s*`, "gu"),
};

/**
 * A value QuickBooks holds, as the form shows it: one line that a browser sends back unchanged and that passes the
 * form's own checks. QuickBooks keeps what the form can't: a line break inside an address line (an `<input>` drops it
 * from the value it is given), a tab, a character that reorders text (each refused on the way in). A save decides what
 * the parent changed by comparing what came back with what was shown, so what is shown must come back as it went: a
 * value that didn't would look like a change, and the whole address would be rewritten by a parent who only changed
 * their phone. A line break is written ", " (as address lines 3 to 5 are joined onto the second), any other control
 * character as a space, and a character that reorders text is left out.
 */
export function asShown(value: string): string {
  return value.replace(AS_SHOWN.broken, "�").replace(AS_SHOWN.reorders, "").replace(AS_SHOWN.control, " ").trim()
    .replace(AS_SHOWN.breaks, ", ").normalize("NFC").trim();
}

/** A mailing address as the form holds it: every field of ContactValues but the phone. */
export type AddressValues = Omit<ContactValues, "phone">;

/** One part of a detail in the normal form detailKey() compares by. */
const normalPart = (v: string | null | undefined) => asShown(v ?? "").replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * A phone (a string) or a mailing address, in the one normal form every comparison of a phone or an address with
 * QuickBooks' uses (stage 3's slices 11a and 11b): the take-in, deciding whether a person's records agree
 * (./contact-take-in.ts), and a parent's change sent on, deciding whether QuickBooks still holds what the portal
 * last knew it held (src/lib/roster/writes.ts). Each part as the form shows it (asShown()), runs of white space as one
 * space, letter case ignored. Null for none: an empty phone, or an address whose parts are all empty. Two details are
 * the same when their keys are. Pure.
 */
export function detailKey(detail: string | Partial<AddressValues> | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === "string") {
    const phone = normalPart(detail);
    return phone === "" ? null : phone;
  }
  const parts = [detail.line1, detail.line2, detail.city, detail.region, detail.postalCode, detail.country].map(normalPart);
  return parts.every((p) => p === "") ? null : JSON.stringify(parts);
}
/** Nothing of one address field is kept past this: QuickBooks holds at most 500 a line, and address lines 2 to 5 are joined. */
const MAX_ADDRESS_KEPT = 2_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const shownPart = (v: unknown): string => (typeof v === "string" ? asShown(v).slice(0, MAX_ADDRESS_KEPT) : "");

/**
 * The billing address on a customer QuickBooks sent (`BillAddr`), as the form shows an address: `Line1`; `Line2` to
 * `Line5` joined with ", " on the second line; `City`; `CountrySubDivisionCode`; `PostalCode`; `Country`; each the one
 * line asShown() makes. The roster cache keeps it so (src/lib/roster/refresh.ts), and the take-in gives it to the
 * person whose record it is (src/lib/parents/contact-take-in.ts).
 */
export function billingAddressOf(customer: Record<string, unknown>): AddressValues {
  const a = isRecord(customer.BillAddr) ? customer.BillAddr : {};
  return {
    line1: shownPart(a.Line1), line2: [a.Line2, a.Line3, a.Line4, a.Line5].map(shownPart).filter(Boolean).join(", ").slice(0, MAX_ADDRESS_KEPT),
    city: shownPart(a.City), region: shownPart(a.CountrySubDivisionCode), postalCode: shownPart(a.PostalCode), country: shownPart(a.Country),
  };
}

/** The one answer for input no page of the portal sends: it says nothing about what was wrong with it. */
export const NOT_THE_FORM = "That didn't go through. Please reload the page and try again.";

export type ParsedContact = { ok: true; form: ContactForm } | { ok: false; errors: string[] };

/**
 * What the form sent, read. It comes from the browser, whatever its type says: anything that is not this form's
 * fields as short strings is refused whole, and each field is trimmed. Whether a field is too long or holds a
 * character that is never saved is fieldErrors()'s to say, once it is known which fields the parent changed.
 */
export function parseContactForm(input: unknown): ParsedContact {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: [NOT_THE_FORM] };
  const sent = input as Record<string, unknown>;
  const version = sent.version;
  if (typeof version !== "string" || !VERSION.test(version)) return { ok: false, errors: [NOT_THE_FORM] };
  const values = {} as ContactValues;
  for (const { name } of CONTACT_FIELDS) {
    const raw = sent[name];
    if (typeof raw !== "string" || raw.length > MAX_SENT) return { ok: false, errors: [NOT_THE_FORM] };
    values[name] = raw.normalize("NFC").trim();
  }
  return { ok: true, form: { values, version } };
}

/**
 * What is wrong with the fields the parent changed, in the form's order: too long, or a character that is never
 * saved. Markup is not refused: it is text, stored as text and shown as text.
 *
 * `shown` is what the form was shown (the portal's own values at the form's version). A field that still holds that is
 * not checked: it may be a value the take-in brought from QuickBooks, which can be longer than the portal lets a parent
 * type, and a parent who is changing their phone can't be asked to shorten a city they never touched. With `shown` null
 * every field is checked.
 */
export function fieldErrors(values: ContactValues, shown: ContactValues | null): string[] {
  const errors: string[] = [];
  for (const { name, label, max } of CONTACT_FIELDS) {
    const value = values[name];
    if (shown !== null && value === shown[name]) continue;
    if (NOT_SAVED.test(value)) errors.push(`${label} has a character that can't be saved. Please type it again.`);
    else if (value.length > max) errors.push(`${label} can be up to ${max} characters. Please shorten it.`);
  }
  return errors;
}

/** True when the two hold the same phone. */
export const samePhone = (a: ContactValues, b: ContactValues): boolean => a.phone === b.phone;
/** True when the two hold the same address, part for part. */
export const sameAddress = (a: ContactValues, b: ContactValues): boolean =>
  a.line1 === b.line1 && a.line2 === b.line2 && a.city === b.city && a.region === b.region && a.postalCode === b.postalCode && a.country === b.country;
