import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, parent, setting } from "@/lib/db/schema";
import { TAKE_IN_KEY } from "@/lib/parents/take-in-setting";
import type { AppFamilyId } from "@/lib/families/ids";
import type { ContactValues } from "@/lib/parents/contact-fields";
import { CHENOWETH, RIVERA, connectCompany } from "./money";
import { seedSignedInParent, type ParentFamilySpec, type SeededParent } from "./parent";
import type { QboStub } from "./qbo-stub";

/**
 * For tests of a parent's phone and address (src/lib/parents/contact-edits.ts, the portal's own since stage 3's slice
 * 11a: personDetails(), familyDetails() and their setters below) and of the email change, whose record is read from and
 * written to the stub QuickBooks. The families are the two in tests/helpers/money.ts, whose QuickBooks ids are numbers
 * as real ones are, so a test can prove nothing is asked of the stub.
 */

/** A customer as QuickBooks sends one: active, at version 0. */
export const qbCustomer = (Id: string, DisplayName: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ Id, DisplayName, Active: true, SyncToken: "0", MetaData: { CreateTime: "2026-08-01T09:00:00-05:00", LastUpdatedTime: "2026-11-01T12:00:00-06:00" }, ...extra });
/** What makes a customer a sub-customer of another. */
export const under = (parentId: string) => ({ ParentRef: { value: parentId }, Job: true });
/** A customer's type, as QuickBooks sends it. The fixtures' types are P_TYPES (tests/helpers/roster-cache.ts): "F", "P", "S", "M". */
export const ofType = (typeId: string) => ({ CustomerTypeRef: { value: typeId } });

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
  qbCustomer(spec.family.qboId, spec.family.name, ofType("F")),
  qbCustomer(spec.parent.qboId, spec.parent.name, { ...under(spec.family.qboId), ...ofType("P"), PrimaryEmailAddr: { Address: spec.parent.email },
    PrimaryPhone: { FreeFormNumber: spec.parent.phone }, BillAddr: { ...ADDRESSES[spec.parent.qboId]!.BillAddr } }),
  ...spec.students.map((s) => qbCustomer(s.qboId, s.name, { ...under(spec.family.qboId), ...ofType("S") })),
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

/**
 * A person's or a family's contact details as the portal holds them (stage 3's slice 11a), as the form shows them, with
 * the version they are at: what isn't set reads as an empty string.
 */
export type HeldDetails = { values: ContactValues; version: number };
type DetailRow = { phone: string | null; addressLine1: string | null; addressLine2: string | null; addressCity: string | null; addressRegion: string | null;
  addressPostalCode: string | null; addressCountry: string | null; contactVersion: number };
const heldOf = (r: DetailRow): HeldDetails => ({ version: r.contactVersion, values: { phone: r.phone ?? "", line1: r.addressLine1 ?? "", line2: r.addressLine2 ?? "",
  city: r.addressCity ?? "", region: r.addressRegion ?? "", postalCode: r.addressPostalCode ?? "", country: r.addressCountry ?? "" } });
const columnsOf = (v: Partial<ContactValues>) => ({
  ...(v.phone !== undefined ? { phone: v.phone || null } : {}), ...(v.line1 !== undefined ? { addressLine1: v.line1 || null } : {}),
  ...(v.line2 !== undefined ? { addressLine2: v.line2 || null } : {}), ...(v.city !== undefined ? { addressCity: v.city || null } : {}),
  ...(v.region !== undefined ? { addressRegion: v.region || null } : {}), ...(v.postalCode !== undefined ? { addressPostalCode: v.postalCode || null } : {}),
  ...(v.country !== undefined ? { addressCountry: v.country || null } : {}),
});

/** The details the portal holds on this person's row. */
export async function personDetails(parentId: string): Promise<HeldDetails> {
  const [r] = await db.select().from(parent).where(eq(parent.id, parentId));
  if (!r) throw new Error(`personDetails: there is no person ${parentId}`);
  return heldOf(r);
}
/** The details the portal holds on this family record. */
export async function familyDetails(familyId: AppFamilyId): Promise<HeldDetails> {
  const [r] = await db.select().from(family).where(eq(family.id, familyId));
  if (!r) throw new Error(`familyDetails: there is no family ${String(familyId)}`);
  return heldOf(r);
}
/** Sets some of a person's details on their row, as a save or the take-in would leave them, at `version` when given. */
export async function setPersonDetails(parentId: string, values: Partial<ContactValues>, version?: number): Promise<void> {
  await db.update(parent).set({ ...columnsOf(values), ...(version !== undefined ? { contactVersion: version } : {}) }).where(eq(parent.id, parentId));
}
/** Sets some of a family record's details, at `version` when given. */
export async function setFamilyDetails(familyId: AppFamilyId, values: Partial<ContactValues>, version?: number): Promise<void> {
  await db.update(family).set({ ...columnsOf(values), ...(version !== undefined ? { contactVersion: version } : {}) }).where(eq(family.id, familyId));
}
/** Every field empty: a person or a family nobody has given details. */
export const NO_DETAILS: ContactValues = { phone: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "" };

/**
 * The take-in of contact details has run, after a roster read that kept the addresses under the shape that holds now
 * (stage 3's slices 11a and 11b): a parent's change of their details is then sent on (contactSendsMayGo()). A test
 * that reads the roster again or saves a shape after it sees the mark move or go, as the portal does.
 */
export async function takeInDone(): Promise<void> {
  const now = new Date().toISOString();
  const value = { after: "2026-01-01T00:00:00.000Z", addressesReadAt: now, doneAt: now };
  await db.insert(setting).values({ key: TAKE_IN_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
}
/** The take-in as migration 0044 leaves it: not run, and no read noted that kept the addresses. */
export async function takeInNotRun(): Promise<void> {
  const value = { after: new Date(Date.now() - 60_000).toISOString() };
  await db.insert(setting).values({ key: TAKE_IN_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
}
