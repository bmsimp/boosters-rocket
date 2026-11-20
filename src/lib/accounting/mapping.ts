// The accounting links screen's one reader (stage 4's slice M1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "The mapping screen"): every active family of the portal, its link to its customer in the books and how
// that link stands, or the customer that looks like its own. It reads every family's guardians' sign-in addresses and
// every customer of the roster cache, so it is staff code only, never imported by a parent page (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). It reads and never writes: nothing is stored, sent or audited. A blocked
// person's address never counts toward a suggestion: they can't sign in with it, so it is left out of what the matcher
// is given and of the row's addresses, and the person is listed in the row's opening as one who can't sign in. Since
// slice M2 it also gives each family whose link stands its differences (./differences.ts), from the same reads and the
// write queue's open items, read once: still nothing is stored, and no request goes to the books.
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, jobRun, parent, qboCustomer, qboCustomerType, staffUser, student } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { otherCompany } from "@/lib/families/links";
import { recordNameWords } from "@/lib/families/words";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { familyCreatesOnTheQueue, noFamilyPool } from "@/lib/roster/no-family";
import { loadOpenWrites, waitingWords, type QueueView } from "@/lib/roster/queue";
import { guardianOf, keptWordsFor } from "@/lib/roster/writes";
import { byRosterOrder, rosterShown } from "@/lib/roster/queries";
import { getShape, missingTypes } from "@/lib/roster/shape";
import { getRosterSource, ROSTER_JOB } from "@/lib/roster/source";
import { differencesOf, type Difference, type QueueFact } from "./differences";
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
/** How a family's link was made, as its row says it: carried over from the roster, or by a staff member's press. */
export type LinkMade =
  | { key: "carried_over"; at: string }
  | { key: "linked"; origin: "confirmed" | "created"; by: string | null; at: string };
/**
 * `with_differences` (slice M2): a link that would read Carried over or Linked (`made`, how it was made, which the row
 * still says), with at least one difference between the portal's records and the books' copy (LinkRow.differences).
 */
export type LinkStatus =
  | LinkMade
  | { key: "with_differences"; made: LinkMade }
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
  /** The sign-in addresses of its open guardians who aren't blocked, each once, in order: exactly what was matched. */
  addresses: string[];
  /** The linked customer as the cache holds it, or the one suggested; null for none. */
  customer: CustomerShown | null;
  status: LinkStatus;
  students: { id: AppStudentId; name: string; link: OwnLink }[];
  /** Its open guardians; `blocked`: the person is blocked, so they can't sign in and their address isn't matched. */
  guardians: { id: string; name: string; email: string; blocked: boolean; link: OwnLink }[];
  /** Where the portal and the books' copy differ (slice M2): only for a link that stands, in the `listed` state; none otherwise. */
  differences: Difference[];
  /** Inactive student customers under its customer with no student record: counted in words, never a difference. */
  inactiveUnrecorded: number;
};
export type LinksView = {
  state: LinksState;
  rows: LinkRow[];
  /** How many customers no family is linked to (Reconciliation's list); null when none can be listed. */
  noFamily: number | null;
  /** Whether the families' own pages stand (loadRosterPage() has a roster: rosterShown()), so the rows may link to them. */
  familyPages: boolean;
  /** When the last successful roster read finished: the books' values are the portal's copy as of then. Null when none has. */
  readAt: string | null;
};

/**
 * A queue item as the differences need it, in the queue's own words: a waiting or stuck one as a family's page says it
 * (waitingWords()), a kept one with QuickBooks' reason or the portal's hold (keptWordsFor(), open question 10). Never
 * its buttons, and never its money note: the screen says nothing of money.
 */
export const queueFactOf = (i: QueueView): QueueFact => ({
  state: i.state, words: i.state === "refused" ? keptWordsFor(i.write, i.lastCode, i.holds) : waitingWords(i),
  op: i.write.op, role: "role" in i.write ? i.write.role : null, qboId: "qboId" in i.write ? i.write.qboId : null,
  studentId: i.studentId === null ? null : String(i.studentId), guardianId: guardianOf(i.write),
});

const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
/** Guardians by name, then by their row's id. Families and students go in the roster's own order instead (byRosterOrder()). */
const byName = <T extends { name: string; id: unknown }>(a: T, b: T) => COLLATOR.compare(a.name, b.name) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * Every active family record, with its status and, for a link that stands, its differences. The screen's own reads
 * touch each table once, whatever the number of families: the roster's company and the connection, the shape and the customer types, the last
 * successful roster read, the cache's customers, the family creates on the write queue, the active families, every
 * student record with a family (active or not), the open guardian rows with their people, the links of the records'
 * company (the roster's, while the books aren't connected to another; another company's links are never read), the
 * names of the staff members those links name, and, only in the `listed` state, the write queue's open items
 * (loadOpenWrites(), with no family and no amounts). loadOpenWrites() then reads some of those tables again, a fixed
 * number of times and never per family (below). The rest is worked out here.
 *
 * Queries per view, whatever the number of families: ten at once (the roster's company, the connection, the shape, the
 * types, the last good read, the customers, the family creates, the families, the students, the guardian rows), then
 * the links and the queue's open items together, then the staff names when a link names one. With no company named,
 * or the books connected to another company, no link and no queue item is read: 10. With the shape missing or broken,
 * the links but not the queue: 11 or 12. Listed with an empty queue: 12 or 13. loadOpenWrites() makes one query for
 * its items and, when there are any, up to 20 more of its own, re-reads of tables the screen has read already (the
 * cache's customers again, the family records the items are filed under and their links, the names of refused
 * students and guardians with their people, and a move's families, links and money note: each lookup through a link
 * reads the roster's company and the connection first), so at most 33 in all: 10 to 33 a view. On four hundred
 * families with two thousand customers that is the same 10 to 33 queries; memory holds the two thousand cached customers (twice, while the queue holds items, as
 * loadOpenWrites() reads its own), the records, guardian rows and links (a few thousand small rows), and the rows
 * rendered are the four hundred families, each opening listing its students, guardians and differences.
 */
export async function loadAccountingLinks(): Promise<LinksView> {
  const [source, connection, shape, typeRows, okRuns, customerRows, creates, families, students, guardians] = await Promise.all([
    getRosterSource(), getConnection(), getShape(),
    db.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType),
    db.select({ id: jobRun.id, finishedAt: jobRun.finishedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
    db.select().from(qboCustomer), familyCreatesOnTheQueue(),
    db.select({ id: family.id, name: family.name }).from(family).where(eq(family.active, true)),
    // Every student record with a family, active or not: the opening lists the active ones, and the differences read an
    // inactive one whose customer the books have active under the family.
    db.select({ id: student.id, familyId: student.familyId, name: student.name, active: student.active }).from(student).where(isNotNull(student.familyId)),
    db.select({ id: guardian.id, familyId: guardian.familyId, name: parent.name, email: parent.email, blocked: parent.blocked }).from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id))
      .where(and(ne(guardian.status, "disabled"), isNotNull(guardian.familyId))),
  ]);
  const elsewhere = otherCompany(source, connection?.realmId);
  // The records' company (recordsCompany()'s meaning): links are read only of it, and none while there is none.
  const realm = source !== null && !elsewhere ? source : null;
  const state: LinksState = source === null ? "no_company" : elsewhere ? "other_company"
    : shape === null || missingTypes(shape, typeRows).length > 0 ? "no_shape" : "listed";
  // The queue's open items only where differences are worked out: every one of them is of the roster's company, since a
  // change of company's clear deletes the queue and a different company is refused.
  const [links, queue] = await Promise.all([
    realm === null ? Promise.resolve([]) : db.select().from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realm))),
    state === "listed" ? loadOpenWrites() : Promise.resolve([]),
  ]);
  const staffIds = [...new Set(links.flatMap((l) => (l.linkedBy === null ? [] : [l.linkedBy])))];
  const staffNames = new Map(staffIds.length ? (await db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, staffIds))).map((s) => [s.id, s.name]) : []);

  const customers: Cust[] = customerRows.map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
  const customerById = new Map(customers.map((c) => [c.qboId, c]));
  const roster = state === "listed" && shape !== null ? buildRoster(shape, customers) : null;
  const linkOfFamily = new Map(links.flatMap((l) => (l.familyId === null ? [] : [[String(l.familyId), l] as const])));
  const customerOfStudent = new Map(links.flatMap((l) => (l.studentId === null ? [] : [[String(l.studentId), l.customerId] as const])));
  const customerOfGuardian = new Map(links.flatMap((l) => (l.guardianId === null ? [] : [[l.guardianId, l.customerId] as const])));
  const studentLinked = new Set(links.flatMap((l) => (l.studentId === null ? [] : [l.customerId])));
  const pool = roster === null ? null : noFamilyPool(roster, customers, creates, {
    familyLinked: new Set(links.flatMap((l) => (l.familyId === null ? [] : [l.customerId]))), studentLinked,
  });
  // The differences of a link that stands, over this view's roster (none to work out while it has none: the state isn't `listed`).
  const compare = roster === null || shape === null ? null : differencesOf({ shape, roster, customers, studentLinked,
    guardianLinked: new Set(links.flatMap((l) => (l.guardianId === null ? [] : [l.customerId]))), queue: queue.map(queueFactOf) });
  const listedAsFamily = roster === null ? null : new Set(roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId));

  // Each family's students, guardian rows and addresses, grouped once, so the rows' work grows with the club, not its square.
  const group = <T>(items: readonly T[], keyOf: (t: T) => string) => {
    const out = new Map<string, T[]>();
    for (const t of items) { const k = keyOf(t); const had = out.get(k); if (had) had.push(t); else out.set(k, [t]); }
    return out;
  };
  const studentsOf = group(students, (s) => String(s.familyId));
  const activeStudentsOf = group(students.filter((s) => s.active), (s) => String(s.familyId));
  const guardiansOf = group(guardians, (g) => String(g.familyId));
  // Only an address its person can sign in with: a blocked person's is never matched, nor shown among the row's addresses.
  const addressesOf = new Map([...guardiansOf].map(([key, gs]) => [key, [...new Set(gs.filter((g) => !g.blocked).map((g) => g.email))].sort()]));
  // What the Families pages break a tie of names by (rosterFamilies()): a family's linked customer where the roster lists
  // it as a family, and a student's where the roster lists it under that family's; with no roster, where the cache holds it.
  const studentsListedUnder = new Map(roster === null || roster.kind === "flat" ? [] : roster.families.map((f) => [f.customer.qboId, new Set(f.students.map((c) => c.qboId))]));
  const familyTie = (customerId: string | undefined) => (customerId === undefined ? null
    : listedAsFamily !== null ? (listedAsFamily.has(customerId) ? customerId : null) : customerById.has(customerId) ? customerId : null);
  const studentTie = (familyCustomer: string | null, customerId: string | undefined) => (customerId === undefined ? null
    : roster !== null ? (familyCustomer !== null && studentsListedUnder.get(familyCustomer)?.has(customerId) ? customerId : null)
    : customerById.has(customerId) ? customerId : null);
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
      students: (activeStudentsOf.get(key) ?? []).map((s) => ({ id: s.id, name: recordNameWords(s.name, "student"), customerId: studentTie(familyTie(link?.customerId), customerOfStudent.get(String(s.id))) }))
        .sort(byRosterOrder).map((s) => ({ id: s.id, name: s.name, link: own(customerOfStudent.get(String(s.id))) })),
      guardians: (guardiansOf.get(key) ?? []).map((g) => ({ id: g.id, name: g.name, email: g.email, blocked: g.blocked, link: own(customerOfGuardian.get(g.id)) }))
        .sort(byName),
      differences: [] as Difference[], inactiveUnrecorded: 0,
    };
    if (link !== undefined) {
      const customer = customerById.get(link.customerId);
      const standing = linkStanding(customer, { cacheHasCustomers: customers.length > 0, listedAsFamily });
      const shownCustomer = customer ? { name: customer.displayName, email: customer.email } : null;
      if (standing.is === "gone") return { ...base, customer: shownCustomer, status: { key: "customer_gone" } };
      if (standing.is === "not_a_family") return { ...base, customer: shownCustomer, status: { key: "not_a_family", reasons: standing.reasons } };
      const made: LinkMade = link.origin === "carried_over" ? { key: "carried_over", at: link.linkedAt.toISOString() }
        : { key: "linked", origin: link.origin, by: link.linkedBy === null ? null : staffNames.get(link.linkedBy) ?? null, at: link.linkedAt.toISOString() };
      // Differences only for a link that stands, in the `listed` state (compare is null otherwise), against a customer the cache holds.
      const found = compare === null || customer === undefined ? null : compare({
        kind: roster?.kind === "flat" ? "member" : "family", name: f.name, customerId: link.customerId,
        students: (studentsOf.get(key) ?? []).map((s) => ({ id: s.id, name: s.name, active: s.active, customerId: customerOfStudent.get(String(s.id)) ?? null })),
        guardians: (guardiansOf.get(key) ?? []).map((g) => ({ id: g.id, customerId: customerOfGuardian.get(g.id) ?? null })),
      });
      const status: LinkStatus = found !== null && found.differences.length > 0 ? { key: "with_differences", made } : made;
      return { ...base, customer: shownCustomer, status, differences: found?.differences ?? [], inactiveUnrecorded: found?.inactiveUnrecorded ?? 0 };
    }
    const s = suggestions?.get(key);
    if (s === undefined) return { ...base, customer: null, status: { key: "not_checked" } };
    if (s.kind === "suggested") return { ...base, customer: shown(s.candidate), status: { key: "suggested", holders: s.candidate.holders } };
    if (s.kind === "several") {
      return { ...base, customer: null, status: { key: "several", why: s.why, candidates: s.candidates.map(shown),
        alsoMatches: s.why === "shared" ? s.alsoMatches.map((k) => familyName.get(k)!) : [] } };
    }
    return { ...base, customer: null, status: { key: "no_match", noGuardians: base.guardians.length === 0 } };
  });

  return {
    state, noFamily: pool === null ? null : pool.length,
    // In the order the Families pages list them: by name, then the linked customer's id as a number, then the record's id.
    rows: rows.map((r) => ({ r, customerId: familyTie(linkOfFamily.get(String(r.familyId))?.customerId) }))
      .sort((a, b) => byRosterOrder({ id: a.r.familyId, name: a.r.name, customerId: a.customerId }, { id: b.r.familyId, name: b.r.name, customerId: b.customerId }))
      .map((x) => x.r),
    familyPages: rosterShown({ connected: Boolean(connection?.realmId && connection.refreshTokenCiphertext), connectedRealmId: connection?.realmId ?? null, source,
      hasCache: typeRows.length > 0 || customerRows.length > 0, shape, readOnce: okRuns.length > 0, typeRows }),
    readAt: okRuns[0]?.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The filters a row is found under. Each row has one status, but the filters aren't the statuses one for one (open
 * question 2: carried-over links keep their own filter, so an admin can review them): Carried over lists every family
 * whose link is carried over, with differences or not, and Linked, with differences every row with differences,
 * carried over or not. So a carried-over family with differences is found, and counted, under both.
 */
export function filtersOf(r: LinkRow): StatusKey[] {
  if (r.status.key !== "with_differences") return [r.status.key];
  return r.status.made.key === "carried_over" ? ["with_differences", "carried_over"] : ["with_differences"];
}

/** How many rows each filter finds, over the whole list (filtersOf(): a carried-over family with differences counts under two). */
export function statusCounts(rows: readonly LinkRow[]): Record<StatusKey, number> {
  const out = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0])) as Record<StatusKey, number>;
  for (const r of rows) for (const k of filtersOf(r)) out[k]++;
  return out;
}

/**
 * The rows a filter shows: found under it (filtersOf(); every row when none), and matching its search, ignoring case, in the
 * family's name, its open guardians' sign-in addresses (a blocked person's too, so staff can find their family), or the
 * linked or suggested customer's name or email field.
 */
export function filterLinkRows(rows: readonly LinkRow[], filter: LinksFilter): LinkRow[] {
  return rows.filter((r) => (filter.status === null || filtersOf(r).includes(filter.status))
    && searchMatches(filter.q, [r.name, ...r.guardians.map((g) => g.email), r.customer?.name ?? null, r.customer?.email ?? null]));
}
