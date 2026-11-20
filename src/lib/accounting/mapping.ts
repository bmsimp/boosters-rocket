// The accounting links screen's one reader (stage 4's slice M1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "The mapping screen"): every active family of the portal, its link to its customer in the books and how
// that link stands, or the customer that looks like its own. It reads every family's guardians' sign-in addresses and
// every customer of the roster cache, so it is staff code only, never imported by a parent page (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). It reads and never writes: nothing is stored, sent or audited. A blocked
// person's address never counts toward a suggestion: they can't sign in with it, so it is left out of what the matcher
// is given and of the row's addresses, and the person is listed in the row's opening as one who can't sign in. Since
// slice M2 it also gives each family whose link stands its differences (./differences.ts), from the same reads and the
// write queue's open items, read once: still nothing is stored, and no request goes to the books. Since slice M3a the
// same reads, made in the press's own transaction under the roster lock (readLinkBasics(tx)), are what the link presses
// check against (./link-writes.ts): the suggestion, the pool and the students a link would link with it are worked out
// by one rule for the page and the press, so the two never differ.
import { and, desc, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, family, guardian, jobRun, parent, qboCustomer, qboCustomerType, staffUser, student } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { otherCompany } from "@/lib/families/links";
import { recordNameWords } from "@/lib/families/words";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { familyCreatesOnTheQueue, noFamilyPool } from "@/lib/roster/no-family";
import { loadOpenWrites, waitingWords, type QueueView } from "@/lib/roster/queue";
import { guardianOf, keptWordsFor, madeAfterGivingUp } from "@/lib/roster/writes";
import { byRosterOrder, rosterShown } from "@/lib/roster/queries";
import { getShape, missingTypes } from "@/lib/roster/shape";
import { getRosterSource, ROSTER_JOB } from "@/lib/roster/source";
import { differencesOf, type Difference, type LinkedStudent, type QueueFact } from "./differences";
import { suggestCustomers, type Holder, type Suggestion } from "./match";
import { pairKeys, proposeStudents, type Proposals } from "./proposals";
import { linkStamp, type Chosen } from "./stamp";
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
 * - `linked`: made by a staff member's press (`confirmed`: "Create a family from this", or since slice M3a Confirm or
 *   Pick a different customer on this screen; `created`: the portal made the customer in the books), by `by` (the staff
 *   member's name, null when none is named or found) on `at`;
 * - `customer_gone`: the cache holds customers, and the linked one isn't among them (open question 13; the link is kept);
 * - `not_a_family`: the linked customer is there, but isn't a family at the top of the tree now (another type, no type,
 *   or under another customer), for `reasons`, with `inactive` among them when that is so too; a customer that is only
 *   inactive, otherwise a family, isn't this: its link stands, and being inactive is a difference (slice M2);
 * - `suggested`, `several`, `no_match`: a family with no link, by its guardians' sign-in addresses (src/lib/accounting/match.ts);
 * - `left_unlinked` (slice M3a): a family with no link that staff left unlinked, by `by` (null when not found) on `at`,
 *   in every state: it is given to no matcher, so it suggests nothing and takes no part in another family's suggestion;
 * - `not_checked`: the books can't be checked now (any state but `listed`, for a family with no link; or no link read).
 */
/** How a family's link was made, as its row says it: carried over from the roster, or by a staff member's press. */
export type LinkMade =
  | { key: "carried_over"; at: string }
  | { key: "linked"; origin: "confirmed" | "created"; by: string | null; at: string };
/** A Several possible row's candidate: as shown, with its id, which the confirm step's address names. */
export type Candidate = CustomerShown & { qboId: string };
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
  | { key: "several"; why: "many" | "shared"; candidates: Candidate[]; alsoMatches: string[] }
  | { key: "no_match"; noGuardians: boolean }
  | { key: "left_unlinked"; by: string | null; at: string }
  | { key: "not_checked" };
/** A student's or guardian row's own link: to a customer the cache holds (its name), to one it doesn't, none, or not read now. */
export type OwnLink = { state: "linked"; customer: string } | { state: "gone" } | { state: "none" } | { state: "unread" };
/** A link press as the page binds it: the customer, how it was chosen, what it would link and leave, and the stamp. */
export type LinkOffer = { customerId: string; chosen: Chosen; proposals: Proposals; stamp: string };
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
  /**
   * What the row's Confirm sends (slice M3a): a Suggested row's customer, with the students the press would link with it
   * and those it would leave, and the stamp that seals them. Null for any other row, and in any state but `listed`.
   */
  confirm: LinkOffer | null;
  /**
   * What else the row offers (slice M3a): Leave unlinked (a Suggested, Several possible or No match row, listed), Pick a
   * different customer (Several possible, No match or Left unlinked, listed), Undo (every Left unlinked row, any state).
   */
  offers: { leave: boolean; pick: boolean; undo: boolean };
};
/** A customer of the pool as the chooser lists it: the books' text, shown as text. */
export type PoolCustomer = { qboId: string; name: string; email: string | null };
/**
 * The confirm step for one family and one customer (slice M3a): the family, the customer, how it was chosen, what the
 * press would link and leave, the other families whose rows suggest or list this customer (`alsoFor`, by name), and the
 * stamp. Or why there is none: the family isn't one the screen offers a pick for now (`family`: not listed, or its row
 * offers no Pick), or the customer isn't one no family is linked to (`customer`).
 */
export type ConfirmStep =
  | { ok: true; familyId: AppFamilyId; family: string; customer: PoolCustomer; offer: LinkOffer; alsoFor: string[];
      /** The Parent customers the roster lists directly under the customer, in the roster's order, so staff can tell whose household it is; null in books with no parent type. */
      parents: { qboId: string; name: string; active: boolean }[] | null }
  | { ok: false; why: "family" | "customer" };
export type LinksView = {
  state: LinksState;
  rows: LinkRow[];
  /** How many customers no family is linked to (Reconciliation's list); null when none can be listed. */
  noFamily: number | null;
  /** Whether the families' own pages stand (loadRosterPage() has a roster: rosterShown()), so the rows may link to them. */
  familyPages: boolean;
  /** When the last successful roster read finished: the books' values are the portal's copy as of then. Null when none has. */
  readAt: string | null;
  /** The customers no family is linked to, as the chooser lists them (Pick a different customer), in the roster's order; null when none can be listed. */
  pool: PoolCustomer[] | null;
  /** The confirm step of a Pick or a Several possible candidate, from this view's reads: no query of its own. */
  step: (familyId: string, customerId: string) => ConfirmStep;
};

/**
 * A queue item as the differences need it, in the queue's own words: a waiting or stuck one as a family's page says it
 * (waitingWords()), a kept one with QuickBooks' reason or the portal's hold (keptWordsFor(), open question 10). Never
 * its buttons, and never its money note: the screen says nothing of money.
 */
export const queueFactOf = (i: QueueView): QueueFact => ({
  state: i.state, words: i.state === "refused" ? keptWordsFor(i.write, i.lastCode, i.holds, undefined, i.joined) : waitingWords(i),
  op: i.write.op, role: "role" in i.write ? i.write.role : null, qboId: "qboId" in i.write ? i.write.qboId : null,
  studentId: i.studentId === null ? null : String(i.studentId), guardianId: guardianOf(i.write),
});

const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
/** Guardians by name, then by their row's id. Families and students go in the roster's own order instead (byRosterOrder()). */
const byName = <T extends { name: string; id: unknown }>(a: T, b: T) => COLLATOR.compare(a.name, b.name) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
const group = <T>(items: readonly T[], keyOf: (t: T) => string) => {
  const out = new Map<string, T[]>();
  for (const t of items) { const k = keyOf(t); const had = out.get(k); if (had) had.push(t); else out.set(k, [t]); }
  return out;
};

/**
 * The screen's reads, in the caller's transaction or none (`tx`), and what is worked out from them for the suggestions
 * and the link presses: each table read once, whatever the number of families. Ten reads at once (the roster's company,
 * the connection, the shape, the customer types, the last successful roster read, the cache's customers, the family
 * creates on the write queue, every family record with its Left unlinked mark, every student record, the open guardian
 * rows with their people), then the links: those of the records' company (the roster's, while the books aren't
 * connected to another; none while there is none), and beside them which student records have a student link of any
 * other company, by their ids alone (a link press never links a record linked anywhere), in one query. No row is
 * locked here: a press holds the roster lock exclusively before it calls this (./link-writes.ts), which keeps out the
 * writers that take it, shared or exclusive: roster reads, link writes, family creates and their
 * finish, a guardian's add, removal and reinstatement, and every change to a student or family record. Some writers of
 * what is read here don't take it, and may commit between these reads: blocking a person (parent.blocked), a parent's
 * confirmed change of sign-in email (parent.email, which waits for the roster lock only to write the cache, and commits
 * without it past its wait) and giving up a queue item (write_queue.state, read by familyCreatesOnTheQueue()). None of
 * them can make a press link anything but the customer and the student pairs its page sealed (linkStampHolds()); they
 * only change which suggestion the press works out again, and a press whose row now reads otherwise is refused as one
 * that changed. A reader that needs these to hold still has to lock them itself.
 */
export async function readLinkBasics(tx?: Tx) {
  const q = tx ?? db;
  const [source, connection, shape, typeRows, okRuns, customerRows, creates, everyFamily, everyStudent, guardians] = await Promise.all([
    getRosterSource(tx), getConnection(tx), getShape(tx),
    q.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType),
    q.select({ id: jobRun.id, finishedAt: jobRun.finishedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
    q.select().from(qboCustomer), familyCreatesOnTheQueue(tx),
    // Every family record: the rows are the active ones, and a student record's family is named from any of them.
    q.select({ id: family.id, name: family.name, active: family.active, leftAt: family.accountingLeftUnlinkedAt, leftBy: family.accountingLeftUnlinkedBy }).from(family),
    // Every student record, active or not, with a family or in none: the opening lists a family's active ones, and the
    // differences read an inactive one whose customer the books have active under the family, and where the portal has
    // the record of any student customer a family's customer holds (student_elsewhere).
    q.select({ id: student.id, familyId: student.familyId, name: student.name, active: student.active }).from(student),
    q.select({ id: guardian.id, familyId: guardian.familyId, name: parent.name, email: parent.email, blocked: parent.blocked }).from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id))
      .where(and(ne(guardian.status, "disabled"), isNotNull(guardian.familyId))),
  ]);
  const elsewhere = otherCompany(source, connection?.realmId);
  // The records' company (recordsCompany()'s meaning): links are read only of it, and none while there is none.
  const realm = source !== null && !elsewhere ? source : null;
  const state: LinksState = source === null ? "no_company" : elsewhere ? "other_company"
    : shape === null || missingTypes(shape, typeRows).length > 0 ? "no_shape" : "listed";
  const linkRows = realm === null ? []
    : await q.select().from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), or(eq(accountingLink.realmId, realm), isNotNull(accountingLink.studentId))));
  // Only the records' company's links are used as links; another company's student links only say which records are linked somewhere.
  const links = linkRows.filter((l) => l.realmId === realm);
  const studentLinkedAnywhere = new Set(linkRows.flatMap((l) => (l.studentId === null ? [] : [String(l.studentId)])));

  const customers: Cust[] = customerRows.map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
  const customerById = new Map(customers.map((c) => [c.qboId, c]));
  const tokenOf = new Map(customerRows.map((c) => [c.qboId, c.syncToken]));
  const roster = state === "listed" && shape !== null ? buildRoster(shape, customers) : null;
  const families = everyFamily.filter((f) => f.active);
  const students = everyStudent.flatMap((s) => (s.familyId === null ? [] : [{ ...s, familyId: s.familyId }]));
  const linkOfFamily = new Map(links.flatMap((l) => (l.familyId === null ? [] : [[String(l.familyId), l] as const])));
  const familyOfCustomer = new Map(links.flatMap((l) => (l.familyId === null ? [] : [[l.customerId, l.familyId] as const])));
  const customerOfStudent = new Map(links.flatMap((l) => (l.studentId === null ? [] : [[String(l.studentId), l.customerId] as const])));
  const customerOfGuardian = new Map(links.flatMap((l) => (l.guardianId === null ? [] : [[l.guardianId, l.customerId] as const])));
  const studentLinked = new Set(links.flatMap((l) => (l.studentId === null ? [] : [l.customerId])));
  const pool = roster === null ? null : noFamilyPool(roster, customers, creates, { familyLinked: new Set(familyOfCustomer.keys()), studentLinked });
  const poolIds = new Set((pool ?? []).map((c) => c.qboId));

  const studentsOf = group(students, (s) => String(s.familyId));
  const guardiansOf = group(guardians, (g) => String(g.familyId));
  // Only an address its person can sign in with: a blocked person's is never matched, nor shown among the row's addresses.
  const addressesOf = new Map([...guardiansOf].map(([key, gs]) => [key, [...new Set(gs.filter((g) => !g.blocked).map((g) => g.email))].sort()]));
  const leftOf = new Map(families.flatMap((f) => (f.leftAt === null ? [] : [[String(f.id), { at: f.leftAt, by: f.leftBy }] as const])));
  // The families the matcher is given: active, with no link in the records' company, and not left unlinked.
  const unlinked = families.filter((f) => !linkOfFamily.has(String(f.id)));
  const suggestions: Map<string, Suggestion<string>> | null = roster === null || pool === null ? null
    : suggestCustomers(unlinked.filter((f) => !leftOf.has(String(f.id))).map((f) => ({ key: String(f.id), addresses: addressesOf.get(String(f.id)) ?? [] })), roster, poolIds);
  const studentsUnder = new Map(roster === null || roster.kind === "flat" ? [] : roster.families.map((f) => [f.customer.qboId, f.students]));
  const pairsStudents = shape !== null && shape.kind === "layered" && shape.studentTypeId !== null;
  /**
   * The students a link of this family to this customer would link with it, and those it would leave (./proposals.ts):
   * the family's student records (active, with no student link of any company) against the student customers the roster
   * lists directly under the customer (with no student link of the records' company). None in flat books or a shape
   * with no student type.
   */
  const proposalsFor = (familyKey: string, customerId: string): Proposals => proposeStudents({
    students: pairsStudents,
    // By name, then id, so the proposals read in one order whatever order the records were read in.
    records: [...(studentsOf.get(familyKey) ?? [])].sort((x, y) => COLLATOR.compare(x.name ?? "", y.name ?? "") || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0))
      .map((s) => ({ id: s.id, name: s.name, active: s.active, linked: studentLinkedAnywhere.has(String(s.id)) })),
    customers: (studentsUnder.get(customerId) ?? []).map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, linked: studentLinked.has(c.qboId) })),
  });
  /** The offer of a press: the proposals for the pair and the stamp that seals them with the way the customer was chosen. */
  const offerFor = (familyKey: string, customerId: string, chosen: Chosen) => {
    const proposals = proposalsFor(familyKey, customerId);
    return { customerId, chosen, proposals, stamp: linkStamp(familyKey, customerId, chosen, pairKeys(proposals)) };
  };
  /** How a customer may be chosen for a family by the rows' statuses: its suggestion, a candidate, or picked (null: the row offers no pick). */
  const chosenFor = (familyKey: string, customerId: string): Chosen | null => {
    const s = suggestions?.get(familyKey);
    if (leftOf.has(familyKey)) return "picked";
    if (s === undefined) return null;
    if (s.kind === "suggested") return s.candidate.customerId === customerId ? "suggested" : null;
    if (s.kind === "several") return s.candidates.some((c) => c.customerId === customerId) ? "several" : "picked";
    return "picked";
  };

  return { source, connection, shape, typeRows, okRuns, customerRows, customers, customerById, tokenOf, roster, realm, state, everyFamily, families, everyStudent, students,
    guardians, links, linkOfFamily, familyOfCustomer, customerOfStudent, customerOfGuardian, studentLinked, pool, poolIds, studentsOf, guardiansOf, addressesOf, leftOf,
    unlinked, suggestions, proposalsFor, offerFor, chosenFor };
}
export type LinkBasics = Awaited<ReturnType<typeof readLinkBasics>>;

/**
 * Every active family record, with its status and, for a link that stands, its differences. The screen's own reads
 * touch each table once, whatever the number of families (readLinkBasics()), then, only in the `listed` state, the
 * write queue's open items (loadOpenWrites(), with no family and no amounts), and then the names of the staff members
 * the links and the Left unlinked marks name, in one query. loadOpenWrites() reads some of those tables again, a fixed
 * number of times and never per family (below). The rest is worked out here.
 *
 * Queries per view, whatever the number of families (statements, not counting a transaction's begin and end): ten at
 * once, then the links (one query, while the roster names a company the books aren't connected away from), then the
 * queue's open items, then the staff names when a link or a mark names one. With no company named, or the books
 * connected to another company, no link and no queue item is read: 10, or 11 with a mark's staff name. With the shape
 * missing or broken, the links but not the queue: 11 or 12. Listed with an empty queue: 12 or 13. loadOpenWrites()
 * makes one query for its items and, when there are any, up to 38 more of its own, re-reads of tables the screen has
 * read already, each made only when an item needs it: the cache's customers; a move's families through their links
 * (3: each lookup through a link reads the roster's company and the connection first), their names (1), the items'
 * family records and links (4), refused students' and guardians' names (2), a parent's contact details' read state,
 * people, families and cache rows (4), the move money note (6), the families joined's links (3), and a kept contact
 * change's checks (14). So at most 39 for the queue and 51 a view: 10 to 51. The confirm step and the chooser read
 * nothing more but what a family's create given up after a try left (madeAfterGivingUp(): 4 to 8, the page's own).
 * On four hundred families with two thousand customers that is the same number of queries; memory holds the two
 * thousand cached customers (twice, while the queue holds items, as loadOpenWrites() reads its own), the records,
 * guardian rows and links (a few thousand small rows), and the rows rendered are the four hundred families, each
 * opening listing its students, guardians and differences.
 */
export async function loadAccountingLinks(): Promise<LinksView> {
  const b = await readLinkBasics();
  const { state, shape, roster, customers, customerById, links, realm, linkOfFamily, customerOfStudent, customerOfGuardian, pool, studentsOf, guardiansOf, addressesOf, leftOf, suggestions } = b;
  // The queue's open items only where differences are worked out: every one of them is of the roster's company, since a
  // change of company's clear deletes the queue and a different company is refused.
  const queue = state === "listed" ? await loadOpenWrites() : [];
  const staffIds = [...new Set([...links.flatMap((l) => (l.linkedBy === null ? [] : [l.linkedBy])), ...[...leftOf.values()].flatMap((m) => (m.by === null ? [] : [m.by]))])];
  const staffNames = new Map(staffIds.length ? (await db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, staffIds))).map((s) => [s.id, s.name]) : []);

  // The differences of a link that stands, over this view's roster (none to work out while it has none: the state isn't `listed`).
  // Each student link's record, by its customer: where the portal has it, for the row of the family whose customer holds it.
  const familyWords = new Map(b.everyFamily.map((f) => [String(f.id), recordNameWords(f.name, "family")]));
  const studentById = new Map(b.everyStudent.map((s) => [String(s.id), s]));
  const studentRecords = new Map(links.flatMap((l): [string, LinkedStudent][] => {
    const s = l.studentId === null ? undefined : studentById.get(String(l.studentId));
    return s === undefined ? [] : [[l.customerId, { id: s.id, active: s.active, family: s.familyId === null ? null : familyWords.get(String(s.familyId)) ?? null }]];
  }));
  const compare = roster === null || shape === null ? null : differencesOf({ shape, roster, customers, studentRecords,
    guardianLinked: new Set(links.flatMap((l) => (l.guardianId === null ? [] : [l.customerId]))), queue: queue.map(queueFactOf) });
  const listedAsFamily = roster === null ? null : new Set(roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId));

  // Each family's active students, grouped once, so the rows' work grows with the club, not its square.
  const activeStudentsOf = group(b.students.filter((s) => s.active), (s) => String(s.familyId));
  // What the Families pages break a tie of names by (rosterFamilies()): a family's linked customer where the roster lists
  // it as a family, and a student's where the roster lists it under that family's; with no roster, where the cache holds it.
  const studentsListedUnder = new Map(roster === null || roster.kind === "flat" ? [] : roster.families.map((f) => [f.customer.qboId, new Set(f.students.map((c) => c.qboId))]));
  const familyTie = (customerId: string | undefined) => (customerId === undefined ? null
    : listedAsFamily !== null ? (listedAsFamily.has(customerId) ? customerId : null) : customerById.has(customerId) ? customerId : null);
  const studentTie = (familyCustomer: string | null, customerId: string | undefined) => (customerId === undefined ? null
    : roster !== null ? (familyCustomer !== null && studentsListedUnder.get(familyCustomer)?.has(customerId) ? customerId : null)
    : customerById.has(customerId) ? customerId : null);
  const familyName = new Map(b.families.map((f) => [String(f.id), recordNameWords(f.name, "family")]));
  const shown = (c: { name: string; email: string | null }): CustomerShown => ({ name: c.name, email: c.email });
  const own = (customerId: string | undefined): OwnLink => (realm === null ? { state: "unread" } : customerId === undefined ? { state: "none" }
    : customerById.has(customerId) ? { state: "linked", customer: customerById.get(customerId)!.displayName } : { state: "gone" });
  const none = { leave: false, pick: false, undo: false };
  const listed = state === "listed";

  const rows: LinkRow[] = b.families.map((f) => {
    const key = String(f.id);
    const link = linkOfFamily.get(key);
    const base = {
      familyId: f.id, name: familyName.get(key)!, addresses: addressesOf.get(key) ?? [],
      students: (activeStudentsOf.get(key) ?? []).map((s) => ({ id: s.id, name: recordNameWords(s.name, "student"), customerId: studentTie(familyTie(link?.customerId), customerOfStudent.get(String(s.id))) }))
        .sort(byRosterOrder).map((s) => ({ id: s.id, name: s.name, link: own(customerOfStudent.get(String(s.id))) })),
      guardians: (guardiansOf.get(key) ?? []).map((g) => ({ id: g.id, name: g.name, email: g.email, blocked: g.blocked, link: own(customerOfGuardian.get(g.id)) }))
        .sort(byName),
      differences: [] as Difference[], inactiveUnrecorded: 0, confirm: null, offers: none,
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
    // Left unlinked, in every state: the matcher was never given it (readLinkBasics()).
    const left = leftOf.get(key);
    if (left !== undefined) {
      return { ...base, customer: null, status: { key: "left_unlinked", by: left.by === null ? null : staffNames.get(left.by) ?? null, at: left.at.toISOString() },
        offers: { leave: false, pick: listed, undo: true } };
    }
    const s = suggestions?.get(key);
    if (s === undefined) return { ...base, customer: null, status: { key: "not_checked" } };
    if (s.kind === "suggested") {
      return { ...base, customer: shown(s.candidate), status: { key: "suggested", holders: s.candidate.holders },
        confirm: b.offerFor(key, s.candidate.customerId, "suggested"), offers: { leave: true, pick: false, undo: false } };
    }
    if (s.kind === "several") {
      return { ...base, customer: null, status: { key: "several", why: s.why, candidates: s.candidates.map((c) => ({ ...shown(c), qboId: c.customerId })),
        alsoMatches: s.why === "shared" ? s.alsoMatches.map((k) => familyName.get(k)!) : [] }, offers: { leave: true, pick: true, undo: false } };
    }
    return { ...base, customer: null, status: { key: "no_match", noGuardians: base.guardians.length === 0 }, offers: { leave: true, pick: true, undo: false } };
  });

  // The families whose rows aim at each customer (a suggestion or a candidate), by name, for the confirm step's warning.
  const aimedBy = new Map<string, string[]>();
  for (const [key, s] of suggestions ?? []) {
    const aims = s.kind === "suggested" ? [s.candidate.customerId] : s.kind === "several" ? s.candidates.map((c) => c.customerId) : [];
    for (const c of aims) aimedBy.set(c, [...(aimedBy.get(c) ?? []), key]);
  }
  const poolShown: PoolCustomer[] | null = pool === null ? null : pool.map((c) => ({ qboId: c.qboId, name: c.name, email: customerById.get(c.qboId)?.email ?? null }));
  const rowOf = new Map(rows.map((r) => [String(r.familyId), r]));
  const step = (familyId: string, customerId: string): ConfirmStep => {
    const row = rowOf.get(familyId.toLowerCase());
    const chosen = row === undefined || !row.offers.pick ? null : b.chosenFor(String(row.familyId), customerId);
    if (row === undefined || chosen === null) return { ok: false, why: "family" };
    const customer = poolShown?.find((c) => c.qboId === customerId);
    if (customer === undefined) return { ok: false, why: "customer" };
    const key = String(row.familyId);
    const parents = roster === null || roster.kind === "flat" || shape === null || shape.kind === "flat" || shape.parentTypeId === null ? null
      : (roster.families.find((f) => f.customer.qboId === customerId)?.parents ?? []).map((c) => ({ qboId: c.qboId, name: c.displayName, active: c.active }));
    return { ok: true, familyId: row.familyId, family: row.name, customer, parents, offer: b.offerFor(key, customerId, chosen),
      alsoFor: (aimedBy.get(customerId) ?? []).filter((k) => k !== key).map((k) => familyName.get(k)!).sort((x, y) => COLLATOR.compare(x, y)) };
  };

  return {
    state, noFamily: pool === null ? null : pool.length,
    // In the order the Families pages list them: by name, then the linked customer's id as a number, then the record's id.
    rows: rows.map((r) => ({ r, customerId: familyTie(linkOfFamily.get(String(r.familyId))?.customerId) }))
      .sort((a, c) => byRosterOrder({ id: a.r.familyId, name: a.r.name, customerId: a.customerId }, { id: c.r.familyId, name: c.r.name, customerId: c.customerId }))
      .map((x) => x.r),
    familyPages: rosterShown({ connected: Boolean(b.connection?.realmId && b.connection.refreshTokenCiphertext), connectedRealmId: b.connection?.realmId ?? null, source: b.source,
      hasCache: b.typeRows.length > 0 || b.customerRows.length > 0, shape, readOnce: b.okRuns.length > 0, typeRows: b.typeRows }),
    readAt: b.okRuns[0]?.finishedAt?.toISOString() ?? null,
    pool: poolShown, step,
  };
}

/**
 * The customers the books have from a create of this family given up after a try they may have taken, that no family is
 * linked to and that the pool (the view's) holds: picking one ties the two together (madeAfterGivingUp(), filed under the
 * family). For the chooser only; its reads are the confirm step's own, counted above.
 */
export async function givenUpCustomersOf(familyId: AppFamilyId, view: Pick<LinksView, "pool">): Promise<{ queueId: string; name: string; customerQboId: string }[]> {
  const pool = new Set((view.pool ?? []).map((c) => c.qboId));
  if (pool.size === 0) return [];
  const made = await db.transaction((tx) => madeAfterGivingUp(tx, { familyId }));
  return made.filter((m) => pool.has(m.customerQboId)).map((m) => ({ queueId: m.queueId, name: m.name, customerQboId: m.customerQboId }));
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
