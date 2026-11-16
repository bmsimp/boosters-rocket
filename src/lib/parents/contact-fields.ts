/**
 * The phone and mailing address a parent may change from the portal (v1 spec §6.2), as the form holds them, and the
 * checks on what a browser sends. Pure: no database, no QuickBooks, no environment, so the form (a client component)
 * and the server use the same limits. What reads and writes QuickBooks is ./contact-edits.ts.
 */
export type ContactValues = { phone: string; line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
export type ContactField = keyof ContactValues;
/** What the form shows and sends back: the values, and the version (QuickBooks' SyncToken) of the record they were read from. */
export type ContactForm = { values: ContactValues; version: string };

/**
 * Each field with its label and the most it may hold. Intuit's reference for the Customer object would not load when
 * this was written, so these are chosen to sit at or under what QuickBooks is known to take: 30 for a phone number
 * (the limit QuickBooks itself reports for one), and for the address well under its 500 a line, 255 for a city,
 * state or country and 30 for a postal code. The owner's sandbox check confirms a phone of 30 characters is accepted
 * (CUSTOMER_UPDATE in src/lib/quickbooks/client.ts). A value QuickBooks still refuses is reported as such, not saved.
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
const NOT_SAVED = new RegExp(`[\\p{Cc}${range(0x2028, 0x2029)}${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]`, "u");
const VERSION = /^\d{1,20}$/;

/** The one answer for input no page of the portal sends: it says nothing about what was wrong with it. */
export const NOT_THE_FORM = "That didn't go through. Please reload the page and try again.";

export type ParsedContact = { ok: true; form: ContactForm } | { ok: false; errors: string[] };

/**
 * What the form sent, checked. It comes from the browser, whatever its type says: anything that is not this form's
 * fields as short strings is refused whole, and each field is trimmed, then checked for length and for characters
 * that are never saved. Markup is not refused: it is text, stored as text and shown as text.
 */
export function parseContactForm(input: unknown): ParsedContact {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, errors: [NOT_THE_FORM] };
  const sent = input as Record<string, unknown>;
  const version = sent.version;
  if (typeof version !== "string" || !VERSION.test(version)) return { ok: false, errors: [NOT_THE_FORM] };
  const values = {} as ContactValues;
  const errors: string[] = [];
  for (const { name, label, max } of CONTACT_FIELDS) {
    const raw = sent[name];
    if (typeof raw !== "string" || raw.length > MAX_SENT) return { ok: false, errors: [NOT_THE_FORM] };
    const value = raw.normalize("NFC").trim();
    if (NOT_SAVED.test(value)) errors.push(`${label} has a character that can't be saved. Please type it again.`);
    else if (value.length > max) errors.push(`${label} can be up to ${max} characters. Please shorten it.`);
    values[name] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, form: { values, version } };
}

/** True when the two hold the same phone. */
export const samePhone = (a: ContactValues, b: ContactValues): boolean => a.phone === b.phone;
/** True when the two hold the same address, part for part. */
export const sameAddress = (a: ContactValues, b: ContactValues): boolean =>
  a.line1 === b.line1 && a.line2 === b.line2 && a.city === b.city && a.region === b.region && a.postalCode === b.postalCode && a.country === b.country;
