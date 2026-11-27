import { eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, parent, qboCustomer } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { parseEmailField } from "@/lib/parents/emails";
import { nameKey } from "@/lib/roster/names";
import { getShape, type MembershipShape } from "@/lib/roster/shape";
import { isUuid } from "@/lib/seasons/ids";
import { loadAccountingLinks, type LinkRow } from "./mapping";
import type { Proposals } from "./proposals";

/**
 * Show details on the accounting links screen (the links redesign the owner approved on 2026-11-27): one family beside
 * its record in the books, side by side, loaded only when a staff member asks for that one row. It shows one family's
 * contact details (its guardians' sign-in addresses and phones, and the books' email and phone), so it is a staff read
 * of one family's data, audited (`accounting.link.details.read`) before anything is returned. Staff only: the list
 * itself never carries a phone, and this reads any family's.
 *
 * Each item is marked by how it compares: `matched` (the same on both sides: an address, a phone by its digits, a
 * record by its name), `differs` (both sides hold one and they don't agree), or `only_books` (a record under the
 * family's in the books that the portal has no one for). Unmarked where there is nothing to compare.
 */
export type DetailMark = "matched" | "differs" | "only_books";
export type LinkDetails = {
  family: string;
  portal: {
    guardians: { name: string; email: string; emailMark: DetailMark | null; phone: string | null; phoneMark: DetailMark | null; blocked: boolean }[];
    students: { name: string; mark: DetailMark | null }[];
  };
  /** The family's record in the books (linked or suggested), as the roster's copy holds it; null for none. */
  books: {
    name: string; email: string | null; emailMark: DetailMark | null; phone: string | null; phoneMark: DetailMark | null;
    under: { name: string; kind: "student" | "parent" | null; active: boolean; mark: DetailMark | null }[];
  } | null;
  /** A Several possible row's candidates, by name. */
  possible: string[];
  /** What the row's main press would link, in one line; null where it has none. */
  confirms: string | null;
};

/** Said for a family Show details can't show now (not one the screen lists, or no family's id): the same words whatever the reason. */
export const DETAILS_GONE = "That family's details can't be shown now. Show every family again and try once more.";

/** A phone's digits, for comparing: a US number's leading 1 dropped. Null for one with too few to be a phone. */
export function phoneDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return n.length >= 7 ? n : null;
}

const listed = (names: readonly string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** What Confirm would link, in one line, from the proposals the row's press is bound to. */
export function confirmsLine(p: Proposals): string {
  const students = p.pairs.map((x) => x.recordName);
  const guardians = p.guardians.map((g) => g.who);
  const parts = [students.length > 0 ? listed(students) : null, guardians.length > 0 ? `${listed(guardians)} with ${guardians.length === 1 ? "their parent record" : "their parent records"}` : null]
    .filter((x): x is string => x !== null);
  const left = p.customersLeft.map((c) => c.name);
  return `${parts.length === 0 ? "Confirm links the family alone." : `Confirm links ${parts.join(", and ")}.`}${left.length === 0 ? "" : ` ${listed(left)} ${left.length === 1 ? "stays" : "stay"} unlinked.`}`;
}

const kindOf = (shape: MembershipShape | null, typeQboId: string | null): "student" | "parent" | null =>
  shape?.kind !== "layered" || typeQboId === null ? null : typeQboId === shape.studentTypeId ? "student" : typeQboId === shape.parentTypeId ? "parent" : null;

/** The comparison of one row with its customer and the records under it in the roster's copy, and its guardians' phones. Pure. */
export function detailsOf(row: LinkRow, o: {
  phones: ReadonlyMap<string, string | null>; shape: MembershipShape | null;
  customer: { displayName: string; email: string | null; phone: string | null } | null;
  under: readonly { displayName: string; typeQboId: string | null; active: boolean; email: string | null; phone: string | null }[];
}): LinkDetails {
  const { customer, under, shape } = o;
  const fieldAddresses = new Set(parseEmailField(customer?.email ?? null).usable);
  const underAddresses = new Set(under.flatMap((c) => parseEmailField(c.email).usable));
  const booksPhones = new Set([customer?.phone, ...under.map((c) => c.phone)].map(phoneDigits).filter((d): d is string => d !== null));
  const guardians = row.guardians.map((g) => {
    const email = g.email.toLowerCase();
    const phone = o.phones.get(g.id) ?? null;
    const digits = phoneDigits(phone);
    return {
      name: g.name, email: g.email, blocked: g.blocked, phone,
      emailMark: customer === null ? null : fieldAddresses.has(email) || underAddresses.has(email) ? "matched" as const : null,
      phoneMark: customer === null || digits === null ? null : booksPhones.has(digits) ? "matched" as const : null,
    };
  });
  const portalAddresses = new Set(row.guardians.filter((g) => !g.blocked).map((g) => g.email.toLowerCase()));
  const portalPhones = new Set(guardians.map((g) => phoneDigits(g.phone)).filter((d): d is string => d !== null));
  const studentNames = new Set(row.students.map((s) => nameKey(s.name)));
  const guardianNames = new Set(row.guardians.map((g) => nameKey(g.name)));
  const underShown = under.map((c) => {
    const kind = kindOf(shape, c.typeQboId);
    const key = nameKey(c.displayName);
    const known = kind === "parent" ? guardianNames.has(key) : kind === "student" ? studentNames.has(key) : studentNames.has(key) || guardianNames.has(key);
    return { name: c.displayName, kind, active: c.active, mark: known ? "matched" as const : "only_books" as const };
  });
  const studentsUnder = new Set(under.filter((c) => kindOf(shape, c.typeQboId) !== "parent").map((c) => nameKey(c.displayName)));
  const booksPhone = phoneDigits(customer?.phone);
  const books = customer === null ? null : {
    name: customer.displayName, email: customer.email, phone: customer.phone,
    emailMark: fieldAddresses.size === 0 ? null : [...fieldAddresses].some((a) => portalAddresses.has(a)) ? "matched" as const : portalAddresses.size > 0 ? "differs" as const : null,
    phoneMark: booksPhone === null ? null : portalPhones.has(booksPhone) ? "matched" as const : portalPhones.size > 0 ? "differs" as const : null,
    under: underShown,
  };
  const confirms = row.confirm !== null ? confirmsLine(row.confirm.proposals)
    : row.review !== null ? `Confirm this link marks it as checked${row.review.confirms.length === 0 ? "" : `, with ${listed(row.review.confirms.map((c) => c.name))}`}.`
    : null;
  return {
    family: row.name,
    portal: { guardians, students: row.students.map((s) => ({ name: s.name, mark: customer !== null && studentsUnder.has(nameKey(s.name)) ? "matched" as const : null })) },
    books,
    possible: row.status.key === "several" ? row.status.candidates.map((c) => c.name) : [],
    confirms,
  };
}

/**
 * One family's details, for Show details: the family must be a row the screen lists now (any other id, or one that
 * isn't an app family's uuid, gets null, with nothing read of it and no audit row); the read is audited before it is
 * returned, naming the app's family.
 */
export async function loadLinkDetails(familyId: unknown, who: { actor: Actor; ip: string | null; permission: string }): Promise<LinkDetails | null> {
  if (!isUuid(familyId)) return null;
  const view = await loadAccountingLinks();
  const row = view.rows.find((r) => String(r.familyId) === familyId.toLowerCase());
  if (row === undefined) return null;
  const ids = row.guardians.map((g) => g.id);
  const [phoneRows, cached, shape] = await Promise.all([
    ids.length === 0 ? Promise.resolve([]) : db.select({ id: guardian.id, phone: parent.phone }).from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id)).where(inArray(guardian.id, ids)),
    row.customerId === null ? Promise.resolve([]) : db.select().from(qboCustomer).where(or(eq(qboCustomer.qboId, row.customerId), eq(qboCustomer.parentQboId, row.customerId))),
    getShape(),
  ]);
  const customer = cached.find((c) => c.qboId === row.customerId) ?? null;
  const under = cached.filter((c) => c.parentQboId === row.customerId && c.qboId !== row.customerId).sort((a, b) => a.displayName.localeCompare(b.displayName, "en"));
  await writeAudit({ actor: who.actor, action: "accounting.link.details.read", permission: who.permission, targetType: "family", targetId: String(row.familyId), ip: who.ip });
  return detailsOf(row, { phones: new Map(phoneRows.map((p) => [p.id, p.phone])), shape, customer, under });
}
