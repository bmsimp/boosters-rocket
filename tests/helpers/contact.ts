import type { ContactValues } from "@/lib/parents/contact-fields";
import { CHENOWETH, RIVERA, connectCompany } from "./money";
import { seedSignedInParent, type ParentFamilySpec, type SeededParent } from "./parent";
import type { QboStub } from "./qbo-stub";

/**
 * For tests of a parent's own phone and address (src/lib/parents/contact-edits.ts), which are read from and written to
 * the stub QuickBooks. The families are the two in tests/helpers/money.ts, whose QuickBooks ids are numbers as real
 * ones are: an id that isn't digits is never sent to QuickBooks, so FAMILY_A and FAMILY_B only ever see the edit page
 * say it can't reach the club's books.
 */

/** A customer as QuickBooks sends one: active, at version 0. */
export const qbCustomer = (Id: string, DisplayName: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ Id, DisplayName, Active: true, SyncToken: "0", MetaData: { CreateTime: "2026-08-01T09:00:00-05:00", LastUpdatedTime: "2026-11-01T12:00:00-06:00" }, ...extra });
/** What makes a customer a sub-customer of another. */
export const under = (parentId: string) => ({ ParentRef: { value: parentId }, Job: true });

/** The address each family's parent has in the stub, and what the edit form shows of it. */
const ADDRESSES: Record<string, { BillAddr: Record<string, string>; shown: Omit<ContactValues, "phone"> }> = {
  [RIVERA.parent.qboId]: {
    BillAddr: { Id: "301", Line1: "12 Heron Lane", City: "Austin", CountrySubDivisionCode: "TX", PostalCode: "78745" },
    shown: { line1: "12 Heron Lane", line2: "", city: "Austin", region: "TX", postalCode: "78745", country: "" },
  },
  [CHENOWETH.parent.qboId]: {
    BillAddr: { Id: "302", Line1: "48 Cormorant Court", City: "Cedar Park", CountrySubDivisionCode: "TX", PostalCode: "78613" },
    shown: { line1: "48 Cormorant Court", line2: "", city: "Cedar Park", region: "TX", postalCode: "78613", country: "" },
  },
};

/** A family as QuickBooks holds it under the layered shape the fixtures use: the family, its parent with a phone and an address, its students. */
export const customersOf = (spec: ParentFamilySpec): Record<string, unknown>[] => [
  qbCustomer(spec.family.qboId, spec.family.name),
  qbCustomer(spec.parent.qboId, spec.parent.name, { ...under(spec.family.qboId), PrimaryEmailAddr: { Address: spec.parent.email },
    PrimaryPhone: { FreeFormNumber: spec.parent.phone }, BillAddr: { ...ADDRESSES[spec.parent.qboId]!.BillAddr } }),
  ...spec.students.map((s) => qbCustomer(s.qboId, s.name, under(spec.family.qboId))),
];

/** What the edit form shows that family's parent before anything is changed. */
export const shownTo = (spec: ParentFamilySpec): ContactValues => ({ phone: spec.parent.phone, ...ADDRESSES[spec.parent.qboId]!.shown });

/**
 * The Riverquill and Chenoweth families, each with a signed-in parent, in the roster cache and in the stub QuickBooks,
 * with QuickBooks connected to the company the cache was read from.
 */
export async function seedContactFamilies(stub: QboStub): Promise<{ r: SeededParent; c: SeededParent }> {
  const r = await seedSignedInParent(RIVERA);
  const c = await seedSignedInParent(CHENOWETH);
  await connectCompany(stub);
  stub.customers = [...customersOf(RIVERA), ...customersOf(CHENOWETH)];
  return { r, c };
}

/** The form as a browser sends it: every field, and the version the page was shown. `extra` adds fields no page sends. */
export function contactForm(values: ContactValues, version: string, extra: Record<string, string | Blob> = {}): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries({ ...values, version, ...extra })) form.set(name, value);
  return form;
}

/**
 * What a browser sends back for values the form showed and the parent left alone. Each is in an `<input>`, which holds
 * one line: the browser drops every line break from the value it is given (HTML's value sanitization) and keeps the
 * rest, a tab included. A field's `maxLength` cuts nothing the page put there itself.
 */
export const sentBackUntouched = (shown: ContactValues): ContactValues =>
  Object.fromEntries(Object.entries(shown).map(([name, value]) => [name, value.replace(/[\r\n]/g, "")])) as ContactValues;

/** The stub's customer with this id. */
export const inQuickBooks = (stub: QboStub, id: string): Record<string, unknown> => {
  const customer = stub.customers.find((c) => c.Id === id);
  if (!customer) throw new Error(`inQuickBooks: the stub holds no customer ${id}`);
  return customer;
};
