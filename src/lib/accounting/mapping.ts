// The accounting links screen's one reader (stage 4's slice M1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "The mapping screen"): every active family of the portal, its link to its customer in the books and how
// that link stands, or the customer that looks like its own. It reads every family's guardians' sign-in addresses and
// every customer of the roster cache, so it is staff code only, never imported by a parent page (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). It reads and never writes: nothing is stored, sent or audited.
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, jobRun, parent, qboCustomer, qboCustomerType, staffUser, student } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { otherCompany } from "@/lib/families/links";
import { recordNameWords } from "@/lib/families/words";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { familyCreatesOnTheQueue, noFamilyPool } from "@/lib/roster/no-family";
import { rosterShown } from "@/lib/roster/queries";
import { getShape, missingTypes } from "@/lib/roster/shape";
import { getRosterSource, ROSTER_JOB } from "@/lib/roster/source";
import { suggestCustomers, type Holder } from "./match";
import { linkStanding, searchMatches, STATUS_KEYS, type LinksFilter, type NotAFamilyReason, type StatusKey } from "./status";

/**
 * Whether suggestions can be worked out, or why not: the roster cache names no company (`no_company`), the books are
 * connected to a company other than the roster's (`other_company`: no link is read at all), or the membership shape
 * is missing or names a customer type the books no longer have (`no_shape`). The same states, in the same order, as
 * Reconciliation's customers with no family (customersWithNoFamily()).
 */
export type LinksState = "listed" | "no_company" | "other_company" | "no_shape";
/** A customer as the row shows it: its name and its whole email field, the books' text, shown as text only. */
export type CustomerShown = { name: string; email: string | null };
/**
 * A row's status:
 * - `carried_over`: the family's link was carried over from the roster when the portal's families were set up
 *   (origin `carried_over`, on `at`, by nobody; open question 2);
 * - `linked`: made by a staff member's press (`confirmed`: "Create a family from this"; `created`: the portal made the
 *   customer in the books), by `by` (the staff member's name, null when none is named or found) on `at`;
 * - `customer_gone`: the cache holds customers, and the linked one isn't among them (open question 13; the link is kept);
 * - `not_a_family`: the linked customer is there, but isn't an active family at the top of the tree now, for `reasons`;
 * - `suggested`, `several`, `no_match`: a family with no link, by its guardians' sign-in addresses (src/lib/accounting/match.ts);
 * - `not_checked`: the books can't be checked now (any state but `listed`, for a family with no link; or no link read).
 */
export type LinkStatus =
  | { key: "carried_over"; at: string }
  | { key: "linked"; origin: "confirmed" | "created"; by: string | null; at: string }
  | { key: "customer_gone" }
  | { key: "not_a_family"; reasons: NotAFamilyReason[] }
  | { key: "suggested"; holders: Holder[] }
  | { key: "several"; why: "many" | "shared"; candidates: CustomerShown[]; alsoMatches: string[] }
  | { key: "no_match"; noGuardians: boolean }
  | { key: "not_checked" };
/** A student's or guardian row's own link: to a customer the cache holds (its name), to one it doesn't, none, or not read now. */
export type OwnLink = { state: "linked"; customer: string } | { state: "gone" } | { state: "none" } | { state: "unread" };
export type LinkRow = {
  familyId: AppFamilyId;
  /** The family's name, or words saying the portal knows none (recordNameWords()). */
  name: string;
  /** Its open guardians' sign-in addresses, each once, in order. */
  addresses: string[];
  /** The linked customer as the cache holds it, or the one suggested; null for none. */
  customer: CustomerShown | null;
  status: LinkStatus;
  students: { id: AppStudentId; name: string; link: OwnLink }[];
  guardians: { id: string; name: string; email: string; link: OwnLink }[];
};
export type LinksView = {
  state: LinksState;
  rows: LinkRow[];
  /** How many customers no family is linked to (Reconciliation's list); null when none can be listed. */
  noFamily: number | null;
  /** Whether the families' own pages stand (loadRosterPage() has a roster: rosterShown()), so the rows may link to them. */
  familyPages: boolean;
};

const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
const byName = <T extends { name: string; id: unknown }>(a: T, b: T) => COLLATOR.compare(a.name, b.name) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * Every active family record, with its status. Each table is read once, whatever the number of families: the roster's
 * company and the connection, the shape and the customer types, whether a roster read has gone through, the cache's
 * customers, the family creates on the write queue, the active families and students, the open guardian rows with
 * their people, the links of the records' company (the roster's, while the books aren't connected to another; another
 * company's links are never read), and the names of the staff members those links name. The rest is worked out here.
 */
export async function loadAccountingLinks(): Promise<LinksView> {
  const [source, connection, shape, typeRows, okRuns, customerRows, creates, families, students, guardians] = await Promise.all([
    getRosterSource(), getConnection(), getShape(),
    db.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType),
    db.select({ id: jobRun.id }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).limit(1),
    db.select().from(qboCustomer), familyCreatesOnTheQueue(),
    db.select({ id: family.id, name: family.name }).from(family).where(eq(family.active, true)),
    db.select({ id: student.id, familyId: student.familyId, name: student.name }).from(student).where(and(eq(student.active, true), isNotNull(student.familyId))),
    db.select({ id: guardian.id, familyId: guardian.familyId, name: parent.name, email: parent.email }).from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id))
      .where(and(ne(guardian.status, "disabled"), isNotNull(guardian.familyId))),
  ]);
  const elsewhere = otherCompany(source, connection?.realmId);
  // The records' company (recordsCompany()'s meaning): links are read only of it, and none while there is none.
  const realm = source !== null && !elsewhere ? source : null;
  const state: LinksState = source === null ? "no_company" : elsewhere ? "other_company"
    : shape === null || missingTypes(shape, typeRows).length > 0 ? "no_shape" : "listed";
  const links = realm === null ? [] : await db.select().from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realm)));
  const staffIds = [...new Set(links.flatMap((l) => (l.linkedBy === null ? [] : [l.linkedBy])))];
  const staffNames = new Map(staffIds.length ? (await db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, staffIds))).map((s) => [s.id, s.name]) : []);

  const customers: Cust[] = customerRows.map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
  const customerById = new Map(customers.map((c) => [c.qboId, c]));
  const roster = state === "listed" && shape !== null ? buildRoster(shape, customers) : null;
  const linkOfFamily = new Map(links.flatMap((l) => (l.familyId === null ? [] : [[String(l.familyId), l] as const])));
  const customerOfStudent = new Map(links.flatMap((l) => (l.studentId === null ? [] : [[String(l.studentId), l.customerId] as const])));
  const customerOfGuardian = new Map(links.flatMap((l) => (l.guardianId === null ? [] : [[l.guardianId, l.customerId] as const])));
  const pool = roster === null ? null : noFamilyPool(roster, customers, creates, {
    familyLinked: new Set(links.flatMap((l) => (l.familyId === null ? [] : [l.customerId]))),
    studentLinked: new Set(links.flatMap((l) => (l.studentId === null ? [] : [l.customerId]))),
  });
  const listedAsFamily = roster === null ? null : new Set(roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId));

  const addressesOf = new Map<string, string[]>();
  for (const g of guardians) {
    const key = String(g.familyId);
    const had = addressesOf.get(key) ?? [];
    if (!had.includes(g.email)) addressesOf.set(key, [...had, g.email].sort());
  }
  const unlinked = families.filter((f) => !linkOfFamily.has(String(f.id)));
  const suggestions = roster === null || pool === null ? null
    : suggestCustomers(unlinked.map((f) => ({ key: String(f.id), addresses: addressesOf.get(String(f.id)) ?? [] })), roster, new Set(pool.map((c) => c.qboId)));
  const familyName = new Map(families.map((f) => [String(f.id), recordNameWords(f.name, "family")]));
  const shown = (c: { name: string; email: string | null }): CustomerShown => ({ name: c.name, email: c.email });
  const own = (customerId: string | undefined): OwnLink => (realm === null ? { state: "unread" } : customerId === undefined ? { state: "none" }
    : customerById.has(customerId) ? { state: "linked", customer: customerById.get(customerId)!.displayName } : { state: "gone" });

  const rows: LinkRow[] = families.map((f) => {
    const key = String(f.id);
    const link = linkOfFamily.get(key);
    const base = {
      familyId: f.id, name: familyName.get(key)!, addresses: addressesOf.get(key) ?? [],
      students: students.filter((s) => String(s.familyId) === key).map((s) => ({ id: s.id, name: recordNameWords(s.name, "student"), link: own(customerOfStudent.get(String(s.id))) }))
        .sort(byName),
      guardians: guardians.filter((g) => String(g.familyId) === key).map((g) => ({ id: g.id, name: g.name, email: g.email, link: own(customerOfGuardian.get(g.id)) }))
        .sort(byName),
    };
    if (link !== undefined) {
      const customer = customerById.get(link.customerId);
      const standing = linkStanding(customer, { cacheHasCustomers: customers.length > 0, listedAsFamily });
      const status: LinkStatus = standing.is === "gone" ? { key: "customer_gone" }
        : standing.is === "not_a_family" ? { key: "not_a_family", reasons: standing.reasons }
        : link.origin === "carried_over" ? { key: "carried_over", at: link.linkedAt.toISOString() }
        : { key: "linked", origin: link.origin, by: link.linkedBy === null ? null : staffNames.get(link.linkedBy) ?? null, at: link.linkedAt.toISOString() };
      return { ...base, customer: customer ? { name: customer.displayName, email: customer.email } : null, status };
    }
    const s = suggestions?.get(key);
    if (s === undefined) return { ...base, customer: null, status: { key: "not_checked" } };
    if (s.kind === "suggested") return { ...base, customer: shown(s.candidate), status: { key: "suggested", holders: s.candidate.holders } };
    if (s.kind === "several") {
      return { ...base, customer: null, status: { key: "several", why: s.why, candidates: s.candidates.map(shown),
        alsoMatches: s.why === "shared" ? s.alsoMatches.map((k) => familyName.get(k)!) : [] } };
    }
    return { ...base, customer: null, status: { key: "no_match", noGuardians: base.addresses.length === 0 } };
  });

  return {
    state, rows: rows.sort((a, b) => byName({ name: a.name, id: a.familyId }, { name: b.name, id: b.familyId })), noFamily: pool === null ? null : pool.length,
    familyPages: rosterShown({ connected: Boolean(connection?.realmId && connection.refreshTokenCiphertext), connectedRealmId: connection?.realmId ?? null, source,
      hasCache: typeRows.length > 0 || customerRows.length > 0, shape, readOnce: okRuns.length > 0, typeRows }),
  };
}

/** How many rows each status has, over the whole list. */
export function statusCounts(rows: readonly LinkRow[]): Record<StatusKey, number> {
  const out = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0])) as Record<StatusKey, number>;
  for (const r of rows) out[r.status.key]++;
  return out;
}

/**
 * The rows a filter shows: of its status (every status when none), and matching its search, ignoring case, in the
 * family's name, its guardians' sign-in addresses, or the linked or suggested customer's name or email field.
 */
export function filterLinkRows(rows: readonly LinkRow[], filter: LinksFilter): LinkRow[] {
  return rows.filter((r) => (filter.status === null || r.status.key === filter.status)
    && searchMatches(filter.q, [r.name, ...r.addresses, r.customer?.name ?? null, r.customer?.email ?? null]));
}
