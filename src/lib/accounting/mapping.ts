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
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, family, guardian, jobRun, parent, qboCustomer, qboCustomerType, staffUser, student, writeQueue } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { otherCompany } from "@/lib/families/links";
import { recordNameWords } from "@/lib/families/words";
import { parseEmailField } from "@/lib/parents/emails";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { checkName, nameKey } from "@/lib/roster/names";
import { familyCreatesFiled, noFamilyPool } from "@/lib/roster/no-family";
import { loadOpenWrites, waitingWords, type QueueView } from "@/lib/roster/queue";
import { blocksOthers, guardianOf, heldWords, KEPT_OFF_STAYS, keptWordsFor, madeAfterGivingUp, SEND_FAMILY_INACTIVE, type MadeAfterGivingUp } from "@/lib/roster/writes";
import { deactivateOf, offers, renameOf } from "@/lib/roster/operations";
import { getParentSettings } from "@/lib/parents/settings";
import { studentsRuleApplies } from "@/lib/parents/sessions";
import { byRosterOrder, rosterShown } from "@/lib/roster/queries";
import { getShape, missingTypes } from "@/lib/roster/shape";
import { getRosterSource, ROSTER_JOB } from "@/lib/roster/source";
import { differencesOf, type Difference, type LinkedStudent, type QueueFact } from "./differences";
import { suggestCustomers, type Holder, type Suggestion } from "./match";
import { pairKeys, proposeGuardians, proposeStudents, type Proposals } from "./proposals";
import { bulkStamp, guardianLinkStamp, guardianUnlinkStamp, linkStamp, reviewStamp, sendStamp, takeStamp, unlinkStamp, type Chosen } from "./stamp";
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
/**
 * A carried-over link confirmed as reviewed (slice M3a2, the lead's choice 7; open question 2): the family's link, and
 * the family's carried-over student links it confirms with it (`confirms`: of an active student record of the family,
 * to a customer the roster lists directly under the family's customer) and those it leaves carried over (`leaves`: of
 * an inactive record, `inactive`; to a customer the books' copy doesn't hold, `gone`; or to one it holds that isn't a
 * student customer directly under the family's customer, `elsewhere`: of another type now, at the top of the tree or
 * under another customer, which the screen shows as a difference), each by the record's name, and the stamp that seals
 * them (reviewStamp()).
 */
export type ReviewLeftWhy = "inactive" | "gone" | "elsewhere";
/** Why a carried-over student link is left carried over by Confirm this link, in the row's opening and the press's answer alike. */
export const REVIEW_LEFT_WORDS: Record<ReviewLeftWhy, string> = {
  inactive: "inactive in the portal",
  gone: "its customer isn't in the books' copy now",
  elsewhere: "its customer isn't a student customer directly under this one in the books now",
};
export type ReviewOffer = {
  linkId: string; customerId: string;
  confirms: { linkId: string; studentId: AppStudentId; name: string }[];
  leaves: { linkId: string; studentId: AppStudentId; name: string; why: ReviewLeftWhy }[];
  stamp: string;
};
/**
 * Unlink from the books (slice M3b): a family whose family link of the records' company the page shows, in the `listed`
 * state, whatever its status (Linked, Carried over, with differences, Customer gone, Not a family now): the link and its
 * customer (`customer`: its name as the cache holds it, null when the books' copy doesn't hold it), the links of the
 * family's student records it ends with it (every record whose family is this one, active or not, by name then id), how
 * many of its open guardian rows have a link of their own (ended with it, beside any closed row's), and the stamp that
 * seals them (unlinkStamp()).
 */
export type UnlinkOffer = {
  linkId: string; customerId: string; customer: string | null;
  students: { linkId: string; studentId: AppStudentId; name: string }[];
  guardianLinks: number;
  stamp: string;
};
/**
 * How a guardian row's own link stands (slice M3c), for an open row with a guardian link of the records' company, in the
 * `listed` state: `own`, to a customer the cache holds as of the parent type directly under the family's customer, and
 * no other open row is linked to it (ownParentCustomer()'s rule, src/lib/roster/writes.ts: what is sent for the row);
 * `shared`, such a customer another open row is linked to too (`sharedWith`: the other families of those rows, by
 * name, none when every one is this family's); `elsewhere`, the cache holds it, but not of the parent type or not
 * directly under the family's customer (or the family has no link, or the books no parent type), shared or not;
 * `gone`, the cache doesn't hold it.
 */
export type GuardianStanding = "own" | "shared" | "elsewhere" | "gone";
/** A Parent customer a guardian row may be linked to (slice M3c), as the row's opening shows it: the books' text, shown as text only. */
export type GuardianCandidate = { qboId: string; name: string; email: string | null };
/**
 * Link a guardian (slice M3c): the Parent customers the row may be linked to (`candidates`: active, of the parent type,
 * directly under the family's customer in the roster, in the roster's order, with no guardian row of the company, open
 * or closed, linked to it and no student or family link naming it), the one filled in (`suggested`: the one candidate whose name
 * is the person's by nameKey() or whose email field holds the row's sign-in address, when exactly one does; null
 * otherwise), and each candidate's stamp (guardianLinkStamp(), `suggested` for the one filled in, `picked` for the rest).
 */
export type GuardianLinkOffer = { familyLinkId: string; candidates: GuardianCandidate[]; suggested: string | null; stamps: Record<string, string> };
/**
 * Why a row that could be linked is offered no Parent customer (slice M3c): none under the family's customer that no
 * guardian is linked to (`none`); or none, and the person's own active Parent customer of their name is under another
 * family of theirs, an open row's there (`elsewhere`, that family's name: ownNamedElsewhere()'s rule), so the portal
 * links it there and not here.
 */
export type GuardianNoOffer = { why: "none" } | { why: "elsewhere"; family: string };
/** An open guardian row as the row's opening shows it (since slice M3c with its link's standing and its presses). */
export type GuardianShown = {
  id: string; name: string; email: string; blocked: boolean; link: OwnLink;
  /** A row with a link, in the `listed` state: how it stands; null otherwise. */
  standing: GuardianStanding | null;
  /** For `shared`: the other families whose open rows are linked to the customer too, by name (none when they are all this family's). */
  sharedWith: string[];
  /**
   * Unlink this guardian (slice M3c): a row with a link, in the `listed` state, while nothing on the write queue holds
   * it back (`unlinkHeld` 0).
   */
  unlink: { linkId: string; stamp: string } | null;
  /**
   * How many items on the write queue, waiting, stuck or kept, hold Unlink this guardian back (unlinkGuardian()'s
   * refusal): a change that blocks others naming the row or targeting its link's customer. 0 for none.
   */
  unlinkHeld: number;
  /**
   * Link this guardian (slice M3c): a row with no link of a family whose link stands, in the `listed` state, in layered
   * books with a parent type, with candidates; only those the press would take now (linkGuardian()'s queue refusals): none
   * while an item names the row, and none with a blocking change targeting it. The one filled in is dropped with its
   * customer, and the rest keep their stamps.
   */
  offer: GuardianLinkOffer | null;
  /**
   * What on the write queue, waiting, stuck or kept, holds Link this guardian back, where the row has candidates:
   * `row`, the items naming the row (any op); `customers`, the candidates a blocking change targets. Null for neither.
   */
  linkHeld: { row: number; customers: number } | null;
  /** Where the row could be linked but has no candidate, why (slice M3c). */
  noOffer: GuardianNoOffer | null;
  /**
   * Whether the row's family may have a guardian linked here now (guardianBooksOf()): what Unlink this guardian's warning
   * says of linking them again.
   */
  relink: boolean;
};
/**
 * A removed guardian of the family (slice M3c, the lead's decision 4): a closed row (not closed by a change of company)
 * with a guardian link of the records' company, by the person's name, its customer's name as the cache holds it (null
 * when the books' copy doesn't hold it) and whether the cache holds it active. Shown, never pressed: the customer is
 * theirs again if they are reinstated, so no other guardian is offered it.
 */
export type RemovedGuardian = { id: string; name: string; customer: string | null; active: boolean };
/**
 * Take QuickBooks' into the app (slice M4a), for one difference of a row: `at`, its index in the row's differences;
 * what it takes (`field`) of which record (`kind`, `recordId`: the family's or the student's app id; a place is a
 * student's); `about`, the record and the field in words, for the press's name; `words`, what it does, said beside the
 * press; and the stamp sealing the value the row showed (takeStamp()).
 */
export type TakeOffer = { at: number; field: "name" | "inactive" | "active" | "place"; kind: "family" | "student"; recordId: string; about: string; words: string[]; stamp: string };
/**
 * A family record inactive in the portal whose family link of the records' company names a customer the books' copy
 * holds active and the roster lists as a family (a member in flat books) that stands (slice M4b): its name and the
 * customer's (the books' text), its inactive students by name, and Take QuickBooks' into the app making it active
 * again (`take`, `field: "active"`, `at` 0), or in its place one sentence saying what stands in the way (`note`: a
 * change on the queue, or its name held by an active family). Not a LinkRow: no status, filter or count includes it.
 */
export type InactiveRow = { familyId: AppFamilyId; name: string; customer: string; students: string[]; take: TakeOffer | null; note: string | null;
  /** Send the app's to QuickBooks (slice M5a): a member of flat books made inactive in the books, or in its place one sentence (`sendNote`); a layered family is never sent from here. */
  send: SendOffer | null; sendNote: string | null };
/**
 * Send the app's to QuickBooks (slice M5a), for one difference of a row (or an inactive row): `at`, its index in the
 * row's differences; what it sends (`field`) of which record (`kind`, `recordId`: the family's or the student's app id;
 * a place is a student's); `about`, the record and the field in words, for the press's name; `words`, what QuickBooks
 * will hold and what it held, said beside the press; and the stamp sealing what the row showed (sendStamp()). Built for
 * every reader; the page draws the press only for one who holds Roster.Family.ReadWrite too.
 */
export type SendOffer = { at: number; field: "name" | "inactive" | "place"; kind: "family" | "student"; recordId: string; about: string; words: string[]; stamp: string };
/**
 * Said beside a difference in place of Take QuickBooks' into the app when a change on the write queue would make the
 * take refuse (takeOffersOf()): one waiting to reach QuickBooks or stuck, or a move kept on the Reconciliation page.
 */
export const QUEUE_IN_THE_WAY = "Another change on the Reconciliation page stands in the way (waiting to reach QuickBooks, stuck, or a move kept there), so this can't be taken from the books until it is done or given up.";
/** Said beside a difference in place of Send the app's to QuickBooks when a change on the write queue would make the send refuse (sendOffersOf()). */
export const QUEUE_IN_THE_WAY_OF_SEND = "Another change on the Reconciliation page stands in the way (waiting to reach QuickBooks, stuck, or a move kept there), so the portal's value can't be sent to the books until it is done or given up.";
/** At most this many families are linked by one press of Confirm all exact email matches (the lead's decision 3 for slice M3a2). */
export const BULK_MAX = 200;
/** A Suggested row the filter shows, as the bulk press links it: the family, its name in words, its suggested customer and the row's own offer. */
export type SuggestedShown = { familyId: AppFamilyId; familyKey: string; name: string; customerId: string; offer: LinkOffer };
/**
 * Confirm all exact email matches, for the rows a filter shows (slice M3a2): how many Suggested rows it takes and the
 * stamp sealing them (null when it takes none, or more than BULK_MAX, when the button isn't offered), and how many
 * Suggested rows the filter shows that it leaves out (`waiting`: the family's own create in the books is waiting or
 * stuck on the queue, or it has a family link of another company, so a press would refuse it; its row's own Confirm
 * says why).
 */
export type BulkOffer = { count: number; stamp: string | null; waiting: number };
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
  guardians: GuardianShown[];
  /** Its removed guardians whose link to a Parent customer stands (slice M3c), by name: shown, never pressed. */
  removed: RemovedGuardian[];
  /** Where the portal and the books' copy differ (slice M2): only for a link that stands, in the `listed` state; none otherwise. */
  differences: Difference[];
  /** Inactive student customers under its customer with no student record: counted in words, never a difference. */
  inactiveUnrecorded: number;
  /**
   * What the row's Confirm sends (slice M3a): a Suggested row's customer, with the students the press would link with it
   * and those it would leave, and the stamp that seals them. Null for any other row, and in any state but `listed`.
   */
  confirm: LinkOffer | null;
  /** Confirm this link (slice M3a2): a carried-over link whose customer stands, in the `listed` state; null for any other row. */
  review: ReviewOffer | null;
  /** Unlink from the books (slice M3b): a family with a family link of the records' company, in the `listed` state; null for any other row. */
  unlink: UnlinkOffer | null;
  /** Take QuickBooks' into the app (slice M4a): the differences of a link that stands a press settles, in the `listed` state (takeOffersOf()); none otherwise. */
  takes: TakeOffer[];
  /** Why a difference a take would settle offers no press now, in one sentence beside it (takeOffersOf()). */
  takeNotes: { at: number; words: string }[];
  /** Send the app's to QuickBooks (slice M5a): the differences of a link that stands whose portal value a press sends, in the `listed` state (sendOffersOf()); none otherwise. */
  sends: SendOffer[];
  /** Why a difference offers no send, in one sentence beside it, only where it helps (sendOffersOf()). */
  sendNotes: { at: number; words: string }[];
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
  /** Confirm all exact email matches for the rows this filter shows (suggestedRowsShown()), from this view's reads; null when it shows no Suggested row, or in any state but `listed`. */
  bulk: (filter: Pick<LinksFilter, "status" | "q">) => BulkOffer | null;
  /** The inactive families the books have active (slice M4b), by name, only in the `listed` state (inactiveRowsOf()); none otherwise. */
  inactive: InactiveRow[];
  /** Whether the books have a parent type (layered books whose shape names one), so a family's Confirm may link guardians with it (slice M3c2). */
  guardianLinks: boolean;
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
 * and the link presses: each table read once, whatever the number of families. Twelve reads at once (the roster's company,
 * the connection, the shape, the customer types, the last successful roster read, the cache's customers, the family
 * creates on the write queue with the family each is filed under, every family record with its Left unlinked mark, every
 * student record, every guardian row with its person, open or closed, since slice M3c, and since slice M3c2 the write
 * queue's open items that name a guardian row or block others for a customer, which hold a guardian pair back, and every
 * guardian row's ended links, which keep a removed guardian's Parent customer for them), then the links: those of the records' company (the
 * roster's, while the books aren't connected to another; none while there is none), and beside them which family and
 * student records have a link of any other company, by their ids alone (a link press never links a record linked
 * anywhere), in one query. No row is
 * locked here: a press holds the roster lock exclusively before it calls this (./link-writes.ts), which keeps out the
 * writers that take it, shared or exclusive: roster reads, link writes, family creates and their
 * finish, a guardian's add, removal and reinstatement, and every change to a student or family record. Some writers of
 * what is read here don't take it, and may commit between these reads: blocking a person (parent.blocked), a parent's
 * confirmed change of sign-in email (parent.email, which waits for the roster lock only to write the cache, and commits
 * without it past its wait), giving up a queue item (write_queue.state, read by familyCreatesFiled() and since slice
 * M3c2 by the guardian holds) and, since slice M3c2, a parent's save of their details or sign-in email, which queues an
 * item naming their row without it (src/lib/parents/contact-queue.ts). None of
 * them can make a press link anything but the customer and the student and guardian pairs its page sealed (linkStampHolds()); they
 * only change which suggestion the press works out again, and a press whose row now reads otherwise is refused as one
 * that changed. A reader that needs these to hold still has to lock them itself.
 */
export async function readLinkBasics(tx?: Tx) {
  const q = tx ?? db;
  const [source, connection, shape, typeRows, okRuns, customerRows, filed, everyFamily, everyStudent, guardianRows, queueHolds, guardianEnded] = await Promise.all([
    getRosterSource(tx), getConnection(tx), getShape(tx),
    q.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType),
    q.select({ id: jobRun.id, finishedAt: jobRun.finishedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
    q.select().from(qboCustomer), familyCreatesFiled(tx),
    // Every family record: the rows are the active ones, and a student record's family is named from any of them.
    q.select({ id: family.id, name: family.name, active: family.active, leftAt: family.accountingLeftUnlinkedAt, leftBy: family.accountingLeftUnlinkedBy, heldAt: family.signinHeldAt }).from(family),
    // Every student record, active or not, with a family or in none: the opening lists a family's active ones, and the
    // differences read an inactive one whose customer the books have active under the family, and where the portal has
    // the record of any student customer a family's customer holds (student_elsewhere).
    q.select({ id: student.id, familyId: student.familyId, name: student.name, active: student.active }).from(student),
    // Every guardian row, open or closed (slice M3c: a closed row's link is a removed guardian's, shown in the row's
    // opening and offered to no other guardian); the matcher, the addresses and the rows' guardians read the open ones only.
    q.select({ id: guardian.id, familyId: guardian.familyId, parentId: guardian.parentId, status: guardian.status, disabledReason: guardian.disabledReason,
      name: parent.name, email: parent.email, blocked: parent.blocked }).from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id)),
    // Slice M3c2: the write queue's items waiting, stuck or kept that name a guardian row (any op, a parent's details and
    // sign-in email among them) or that block others and target a customer: they hold a guardian pair back (proposalsFor()).
    q.select({ guardianId: sql<string | null>`${writeQueue.request}->>'guardianId'`, targetQboId: writeQueue.targetQboId, blocks: sql<boolean>`(${blocksOthers})` })
      .from(writeQueue).where(and(inArray(writeQueue.state, ["waiting", "stuck", "refused"]),
        or(sql`${writeQueue.request}->>'guardianId' is not null`, and(blocksOthers, isNotNull(writeQueue.targetQboId))))),
    // Slice M3c2: every guardian row's ended links, latest first (endedLinksHeld()'s order): the customer of a row's latest
    // one in the records' company, while the row has no link there, is kept for it (keptFor, proposalsFor()).
    q.select({ guardianId: accountingLinkEnded.guardianId, realmId: accountingLinkEnded.realmId, customerId: accountingLinkEnded.customerId }).from(accountingLinkEnded)
      .where(and(eq(accountingLinkEnded.system, QUICKBOOKS), isNotNull(accountingLinkEnded.guardianId))).orderBy(desc(accountingLinkEnded.endedAt), desc(accountingLinkEnded.id)),
  ]);
  const everyGuardian = guardianRows;
  // The open guardian rows with a family: what the matcher, the addresses and the rows' guardians read (as before slice M3c).
  const guardians = everyGuardian.filter((g) => g.status !== "disabled" && g.familyId !== null);
  const elsewhere = otherCompany(source, connection?.realmId);
  // The records' company (recordsCompany()'s meaning): links are read only of it, and none while there is none.
  const realm = source !== null && !elsewhere ? source : null;
  const state: LinksState = source === null ? "no_company" : elsewhere ? "other_company"
    : shape === null || missingTypes(shape, typeRows).length > 0 ? "no_shape" : "listed";
  const linkRows = realm === null ? []
    : await q.select().from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), or(eq(accountingLink.realmId, realm), isNotNull(accountingLink.studentId), isNotNull(accountingLink.familyId))));
  // Only the records' company's links are used as links; another company's family and student links only say which records are linked somewhere.
  const links = linkRows.filter((l) => l.realmId === realm);
  const studentLinkedAnywhere = new Set(linkRows.flatMap((l) => (l.studentId === null ? [] : [String(l.studentId)])));
  const familyLinkedAnywhere = new Set(linkRows.flatMap((l) => (l.familyId === null ? [] : [String(l.familyId)])));
  const creates = filed.map((c) => c.write);
  // The families whose own create is waiting or stuck on the queue, filed under them: a link press refuses them (familyToLink()).
  const createQueuedFor = new Set(filed.flatMap((c) => (c.familyId === null ? [] : [c.familyId])));

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
  // Slice M3c2: the customers the roster lists directly under each family customer, of any type, and each family's guardian rows, open or closed.
  const parentsUnder = new Map(roster === null || roster.kind === "flat" ? [] : roster.families.map((f) => [f.customer.qboId, f.parents]));
  const rowsOfFamily = group(guardianRows.flatMap((g) => (g.familyId === null ? [] : [g])), (g) => String(g.familyId));
  const heldRows = new Set(queueHolds.flatMap((i) => (i.guardianId === null ? [] : [i.guardianId.toLowerCase()])));
  const heldCustomers = new Set(queueHolds.flatMap((i) => (i.blocks && i.targetQboId !== null ? [i.targetQboId] : [])));
  // The customers the roster lists as families (members in flat books): a family's own link stands only to one of them (linkStanding()).
  const listedAsFamily = roster === null ? null : new Set(roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId));
  const studentLinkOfRecord = new Map(links.flatMap((l) => (l.studentId === null ? [] : [[String(l.studentId), l] as const])));
  /**
   * The students a link of this family to this customer would link with it, and those it would leave (./proposals.ts):
   * the family's student records (active, with no student link of any company) against the student customers the roster
   * lists directly under the customer (with no student link of the records' company). None in flat books or a shape
   * with no student type. Since slice M3c2 the guardians with them (proposeGuardians()): the family's guardian rows
   * (open, not blocked, with no guardian link of the records' company), by name then id, against the customers the
   * roster lists directly under the customer (active, of the parent type, that no link of the records' company names,
   * and one a row's ended link keeps for it taking part for that row alone), by sign-in address alone; a pair whose row an item on the write queue names, or whose customer a change that blocks
   * others targets, held back (`guardiansHeld`), as Link this guardian refuses for them (linkGuardian()). None in books
   * with no parent type.
   */
  const proposalsFor = (familyKey: string, customerId: string): Proposals => ({
    ...proposeStudents({
      students: pairsStudents,
      // By name, then id, so the proposals read in one order whatever order the records were read in.
      records: [...(studentsOf.get(familyKey) ?? [])].sort((x, y) => COLLATOR.compare(x.name ?? "", y.name ?? "") || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0))
        .map((s) => ({ id: s.id, name: s.name, active: s.active, linked: studentLinkedAnywhere.has(String(s.id)) })),
      customers: (studentsUnder.get(customerId) ?? []).map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, linked: studentLinked.has(c.qboId) })),
    }),
    ...proposeGuardians({
      parents: parentTypeId !== null && roster !== null && roster.kind === "layered", parentTypeId, customerId,
      rows: [...(rowsOfFamily.get(familyKey) ?? [])].sort(byName)
        .map((g) => ({ id: g.id, name: g.name, email: g.email, blocked: g.blocked, open: g.status !== "disabled", linked: linkOfGuardian.has(g.id) })),
      customers: (parentsUnder.get(customerId) ?? []).map((c) => ({ qboId: c.qboId, displayName: c.displayName, email: c.email, active: c.active, typeQboId: c.typeQboId,
        parentQboId: c.parentQboId, linked: guardianLinked.has(c.qboId) || studentLinked.has(c.qboId) || familyOfCustomer.has(c.qboId), keptFor: keptForRows.get(c.qboId) ?? [] })),
      held: { rows: heldRows, customers: heldCustomers },
    }),
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

  /**
   * Confirm this link, for a family whose family link of the records' company is carried over (slice M3a2): only in the
   * `listed` state and while its customer stands (linkStanding(): neither gone nor not a family now, whose rows offer
   * Unlink from the books instead, slice M3b). With it go the family's carried-over student links of an active student record whose customer the roster
   * lists directly under the family's customer; every other carried-over student link of the family's records is left
   * carried over (an inactive record's, or one to a customer elsewhere in the books). By the record's name, then id.
   */
  const reviewOf = (familyKey: string): ReviewOffer | null => {
    const link = linkOfFamily.get(familyKey);
    if (state !== "listed" || link === undefined || link.origin !== "carried_over") return null;
    if (linkStanding(customerById.get(link.customerId), { cacheHasCustomers: customers.length > 0, listedAsFamily }).is !== "stands") return null;
    const under = new Set((studentsUnder.get(link.customerId) ?? []).map((c) => c.qboId));
    const carried = [...(studentsOf.get(familyKey) ?? [])]
      .sort((x, y) => COLLATOR.compare(x.name ?? "", y.name ?? "") || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0))
      .flatMap((s) => { const l = studentLinkOfRecord.get(String(s.id)); return l !== undefined && l.origin === "carried_over" ? [{ s, l }] : []; });
    const confirms = carried.filter(({ s, l }) => s.active && under.has(l.customerId)).map(({ s, l }) => ({ linkId: l.id, studentId: s.id, name: recordNameWords(s.name, "student") }));
    const confirming = new Set(confirms.map((c) => c.linkId));
    const leaves = carried.filter(({ l }) => !confirming.has(l.id))
      .map(({ s, l }) => ({ linkId: l.id, studentId: s.id, name: recordNameWords(s.name, "student"),
        why: (!s.active ? "inactive" : customerById.has(l.customerId) ? "elsewhere" : "gone") as ReviewLeftWhy }));
    return { linkId: link.id, customerId: link.customerId, confirms, leaves, stamp: reviewStamp(familyKey, link.id, link.customerId, confirms.map((c) => c.linkId)) };
  };

  /**
   * Unlink from the books (slice M3b), for a family whose family link of the records' company the page shows: only in the
   * `listed` state, whatever the link's standing. The press ends it with every link of the family's student records
   * (studentsOf(): each record whose family is this one, active or not), sealed by id in the stamp, and every link of
   * its guardian rows, open or closed (counted here for the open ones, which the row shows). No query of its own.
   */
  const unlinkOf = (familyKey: string): UnlinkOffer | null => {
    const link = linkOfFamily.get(familyKey);
    if (state !== "listed" || link === undefined) return null;
    const students = [...(studentsOf.get(familyKey) ?? [])]
      .sort((x, y) => COLLATOR.compare(x.name ?? "", y.name ?? "") || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0))
      .flatMap((s) => { const l = studentLinkOfRecord.get(String(s.id)); return l === undefined ? [] : [{ linkId: l.id, studentId: s.id, name: recordNameWords(s.name, "student") }]; });
    const guardianLinks = (guardiansOf.get(familyKey) ?? []).filter((g) => customerOfGuardian.has(g.id)).length;
    return { linkId: link.id, customerId: link.customerId, customer: customerById.get(link.customerId)?.displayName ?? null, students, guardianLinks,
      stamp: unlinkStamp(familyKey, link.id, link.customerId, students.map((s) => s.linkId)) };
  };

  // A guardian's own link (slice M3c): every guardian row by id, the customers any guardian row of the company is linked
  // to (open or closed: a closed row's is a removed guardian's, which they take back if reinstated), and the open rows
  // linked to each customer (several may share one, whatever their family).
  const guardianById = new Map(everyGuardian.map((g) => [g.id, g]));
  const guardianLinked = new Set(links.flatMap((l) => (l.guardianId === null ? [] : [l.customerId])));
  const linkOfGuardian = new Map(links.flatMap((l) => (l.guardianId === null ? [] : [[l.guardianId, l] as const])));
  // Slice M3c2: each customer kept for the guardian rows with no link in the records' company whose latest ended link
  // there names it (M3b2's hold, endedLinksHeld()'s rule; a customer a live guardian link names is `linked` already).
  const keptForRows = new Map<string, string[]>();
  const latestEnded = new Set<string>();
  for (const e of guardianEnded) {
    if (e.guardianId === null || e.realmId !== realm || latestEnded.has(e.guardianId)) continue;
    latestEnded.add(e.guardianId);
    if (linkOfGuardian.has(e.guardianId)) continue;
    keptForRows.set(e.customerId, [...(keptForRows.get(e.customerId) ?? []), e.guardianId]);
  }
  const openRowsOn = group(links.flatMap((l) => {
    const g = l.guardianId === null ? undefined : guardianById.get(l.guardianId);
    return g === undefined || g.status === "disabled" ? [] : [{ customerId: l.customerId, row: g }];
  }), (x) => x.customerId);
  const familyNames = new Map(everyFamily.map((f) => [String(f.id), f.name]));
  const familyNameOf = (familyId: string | null) => recordNameWords(familyId === null ? null : familyNames.get(familyId) ?? null, "family");
  const parentTypeId = shape !== null && shape.kind === "layered" ? shape.parentTypeId : null;
  /**
   * Where a guardian of this family may be linked to a Parent customer (slice M3c): in the `listed` state, in layered
   * books with a parent type, for an active family whose family link of the records' company stands (linkStanding()):
   * that link and its customer; null otherwise.
   */
  const guardianBooksOf = (familyKey: string): { familyLink: (typeof links)[number]; familyCustomer: string; parentTypeId: string } | null => {
    const link = linkOfFamily.get(familyKey);
    if (state !== "listed" || parentTypeId === null || link === undefined || !families.some((f) => String(f.id) === familyKey)) return null;
    if (linkStanding(customerById.get(link.customerId), { cacheHasCustomers: customers.length > 0, listedAsFamily }).is !== "stands") return null;
    return { familyLink: link, familyCustomer: link.customerId, parentTypeId };
  };
  /**
   * Link a guardian (slice M3c), for an open row of an active family with no guardian link of the records' company,
   * where guardianBooksOf() holds: the offer, with its candidates (GuardianLinkOffer), or why there is none
   * (GuardianNoOffer); null where nothing is offered (a closed row, a row with a link, or guardianBooksOf() null). The
   * page and the press read it alike. No query of its own.
   */
  const guardianOfferOf = (guardianId: string): { offer: GuardianLinkOffer } | { none: GuardianNoOffer } | null => {
    const g = guardianById.get(guardianId);
    if (g === undefined || g.status === "disabled" || g.familyId === null || linkOfGuardian.has(g.id)) return null;
    const books = guardianBooksOf(String(g.familyId));
    if (books === null) return null;
    const under = roster === null || roster.kind === "flat" ? [] : roster.families.find((f) => f.customer.qboId === books.familyCustomer)?.parents ?? [];
    // No customer a link of any kind names: a guardian row's (open or closed), a student's, or a family record's (one
    // retyped and moved under this family in the books keeps its family link until someone unlinks it).
    const candidates = under.filter((c) => c.active && c.typeQboId === books.parentTypeId && c.parentQboId === books.familyCustomer
      && !guardianLinked.has(c.qboId) && !studentLinked.has(c.qboId) && !familyOfCustomer.has(c.qboId)).map((c): GuardianCandidate => ({ qboId: c.qboId, name: c.displayName, email: c.email }));
    if (candidates.length === 0) {
      // ownNamedElsewhere()'s rule (src/lib/roster/writes.ts): another open row of the person's, linked to an active
      // Parent customer of their name, the first by the row's id.
      const key = nameKey(g.name);
      const there = everyGuardian.filter((o) => o.parentId === g.parentId && o.id !== g.id && o.status !== "disabled").sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
        .find((o) => {
          const l = linkOfGuardian.get(o.id);
          const c = l === undefined ? undefined : customerById.get(l.customerId);
          return c !== undefined && c.active && c.typeQboId === books.parentTypeId && nameKey(c.displayName) === key;
        });
      return { none: there === undefined ? { why: "none" } : { why: "elsewhere", family: familyNameOf(there.familyId === null ? null : String(there.familyId)) } };
    }
    const address = g.email.toLowerCase();
    const matching = candidates.filter((c) => nameKey(c.name) === nameKey(g.name) || parseEmailField(c.email).usable.includes(address));
    const suggested = matching.length === 1 ? matching[0]!.qboId : null;
    const stamps = Object.fromEntries(candidates.map((c) => [c.qboId, guardianLinkStamp(g.id, books.familyLink.id, c.qboId, c.qboId === suggested ? "suggested" : "picked")]));
    return { offer: { familyLinkId: books.familyLink.id, candidates, suggested, stamps } };
  };
  /**
   * An open row's own link (slice M3c), in the `listed` state, whatever it stands as: how it stands (GuardianStanding),
   * the other families sharing its customer, and Unlink this guardian's link id and stamp (guardianUnlinkStamp()); null
   * for a closed row, a row with no link, or another state. No query of its own.
   */
  const guardianLinkOf = (guardianId: string): { standing: GuardianStanding; sharedWith: string[]; linkId: string; customerId: string; stamp: string } | null => {
    const g = guardianById.get(guardianId);
    const link = linkOfGuardian.get(guardianId);
    if (state !== "listed" || g === undefined || g.status === "disabled" || g.familyId === null || link === undefined) return null;
    const c = customerById.get(link.customerId);
    const others = (openRowsOn.get(link.customerId) ?? []).filter((x) => x.row.id !== g.id);
    const familyLink = linkOfFamily.get(String(g.familyId));
    // Where it is before whether it is shared: a customer that isn't a Parent customer directly under this family's is
    // no guardian's own here however many rows are unlinked from it, so only one under it is said to be split.
    const standing: GuardianStanding = c === undefined ? "gone"
      : parentTypeId === null || familyLink === undefined || c.typeQboId !== parentTypeId || c.parentQboId !== familyLink.customerId ? "elsewhere"
      : others.length > 0 ? "shared" : "own";
    const sharedWith = standing !== "shared" ? [] : [...new Set(others.flatMap((x) => (x.row.familyId !== null && String(x.row.familyId) === String(g.familyId) ? []
      : [familyNameOf(x.row.familyId === null ? null : String(x.row.familyId))])))].sort((x, y) => COLLATOR.compare(x, y));
    return { standing, sharedWith, linkId: link.id, customerId: link.customerId, stamp: guardianUnlinkStamp(g.id, link.id, link.customerId) };
  };
  /** A family's removed guardians with a link of the records' company (slice M3c): closed rows, not closed by a change of company. By name. */
  const removedOf = (familyKey: string): RemovedGuardian[] => everyGuardian
    .filter((g) => g.status === "disabled" && g.disabledReason !== "company_changed" && g.familyId !== null && String(g.familyId) === familyKey && linkOfGuardian.has(g.id))
    .map((g) => { const c = customerById.get(linkOfGuardian.get(g.id)!.customerId); return { id: g.id, name: g.name, customer: c?.displayName ?? null, active: c?.active ?? false }; })
    .sort(byName);

  return { source, connection, shape, typeRows, okRuns, customerRows, customers, customerById, tokenOf, roster, realm, state, everyFamily, families, everyStudent, students,
    guardians, links, linkOfFamily, familyOfCustomer, customerOfStudent, customerOfGuardian, studentLinked, pool, poolIds, studentsOf, guardiansOf, addressesOf, leftOf,
    unlinked, suggestions, listedAsFamily, proposalsFor, offerFor, chosenFor, reviewOf, unlinkOf, createQueuedFor, familyLinkedAnywhere, creates,
    everyGuardian, guardianById, linkOfGuardian, guardianBooksOf, guardianOfferOf, guardianLinkOf, removedOf };
}
export type LinkBasics = Awaited<ReturnType<typeof readLinkBasics>>;

/**
 * Every active family record, with its status and, for a link that stands, its differences. The screen's own reads
 * touch each table once, whatever the number of families (readLinkBasics()), then, only in the `listed` state, the
 * write queue's open items (loadOpenWrites(), with no family and no amounts), and then the names of the staff members
 * the links and the Left unlinked marks name, in one query. loadOpenWrites() reads some of those tables again, a fixed
 * number of times and never per family (below). The rest is worked out here.
 *
 * Queries per view, whatever the number of families (statements, not counting a transaction's begin and end): twelve at
 * once, then the links (one query, while the roster names a company the books aren't connected away from), then the
 * queue's open items and, beside them, the parents' settings (since slice M4b), then the staff names when a link or a
 * mark names one. Since slice M3c2 two of the twelve are the
 * queue's open items that name a guardian row or block others for a customer and every guardian row's ended links
 * (readLinkBasics()), read whatever the state: the guardian pairs a family's Confirm proposes are worked out in the press's own transaction from the same
 * reads (./link-writes.ts), where loadOpenWrites() isn't read, so page and press hold the same pairs back by one rule.
 * With no company named, or the books connected to another company, no link and no open item for the differences is
 * read: 12, or 13 with a mark's staff name. With the shape missing or broken, the links but not the queue's open items
 * for the differences: 13 or 14. Listed with an empty queue: 15 or 16. loadOpenWrites()
 * makes one query for its items and, when there are any, up to 38 more of its own, re-reads of tables the screen has
 * read already, each made only when an item needs it: the cache's customers; a move's families through their links
 * (3: each lookup through a link reads the roster's company and the connection first), their names (1), the items'
 * family records and links (4), refused students' and guardians' names (2), a parent's contact details' read state,
 * people, families and cache rows (4), the move money note (6), the families joined's links (3), and a kept contact
 * change's checks (14). So at most 39 for the queue and 54 a view: 12 to 54. The confirm step and the chooser read
 * nothing more but what a family's create given up after a try left (madeAfterGivingUp(): 4 to 8, the page's own).
 * Since slice M3a2 the rows' Confirm this link (reviewOf()) and Confirm all exact email matches (bulk(), by
 * suggestedRowsShown()) are worked out from the same reads, with no query of their own, and since slice M3b so is each
 * linked row's Unlink from the books (unlinkOf()). Since slice M3c so are each open guardian's link standing, Unlink
 * this guardian and Link this guardian's candidates (guardianLinkOf(), guardianOfferOf()) and the removed guardians
 * (removedOf()): the guardian query reads closed rows too, one query still, so the count is as it was; what on the
 * write queue holds each guardian press back is read from the queue's open items it loads already (loadOpenWrites()).
 * Since slice M4a so are the presses that take the books' value of a difference into the portal (takeOffersOf()), with
 * no query of their own: the count is unchanged. Since slice M4b, in the `listed` state, the parents' settings are read
 * beside the queue's items (the one query it adds, counted above), for whether the students rule is in force, which says
 * whether a student's take of active holds the family's sign-ins; the inactive families the books have active
 * (inactiveRowsOf()) come from the reads above, with no query of their own.
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
  const [queue, parentSettings] = state === "listed" ? await Promise.all([loadOpenWrites(), getParentSettings()]) : [[], null];
  // Whether a family's guardians sign in by its active students (enterableGuardianRows()): a student's take of active may open it.
  const studentsRule = parentSettings !== null && studentsRuleApplies(parentSettings.requireActiveStudents, shape);
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
  const listedAsFamily = b.listedAsFamily;
  // What the sends are worked out from, once for the view (sendFactsOf()): from the reads above and the queue, no query of its own.
  const sendFacts = compare === null ? null : sendFactsOf(b, queue);

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
  // What on the write queue holds a guardian press back (linkGuardian(), unlinkGuardian(): the same items they refuse
  // for, read here from the queue this view has already loaded): the items naming each row, of any op; of those, the
  // ones that block others (not a parent's details or sign-in email: blocksOthers); and the blocking ones by the
  // customer they target (none for a create), with those that do both counted once.
  const itemsOfRow = new Map<string, number>(), blockingOfRow = new Map<string, number>(), blockingOn = new Map<string, number>(), blockingBoth = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const i of queue) {
    const w = i.write as unknown as Record<string, unknown>;
    const rowId = typeof w.guardianId === "string" ? w.guardianId : null;
    const blocks = i.write.op !== "contact" && i.write.op !== "email";
    const target = blocks && i.write.op !== "create" && typeof w.qboId === "string" ? w.qboId : null;
    if (rowId !== null) bump(itemsOfRow, rowId);
    if (rowId !== null && blocks) bump(blockingOfRow, rowId);
    if (target !== null) bump(blockingOn, target);
    if (rowId !== null && target !== null) bump(blockingBoth, `${rowId} ${target}`);
  }
  /** Link this guardian's offer as the page draws it: only the candidates the press would take now, and what holds the rest back. */
  const offerShown = (guardianId: string, offer: GuardianLinkOffer | null): { offer: GuardianLinkOffer | null; linkHeld: { row: number; customers: number } | null } => {
    if (offer === null) return { offer: null, linkHeld: null };
    const row = itemsOfRow.get(guardianId) ?? 0;
    const free = row > 0 ? [] : offer.candidates.filter((c) => !blockingOn.has(c.qboId));
    const customers = offer.candidates.filter((c) => blockingOn.has(c.qboId)).length;
    return {
      offer: free.length === 0 ? null : { familyLinkId: offer.familyLinkId, candidates: free, suggested: free.some((c) => c.qboId === offer.suggested) ? offer.suggested : null,
        stamps: Object.fromEntries(free.map((c) => [c.qboId, offer.stamps[c.qboId]!])) },
      linkHeld: row > 0 || customers > 0 ? { row, customers } : null,
    };
  };

  const rows: LinkRow[] = b.families.map((f) => {
    const key = String(f.id);
    const link = linkOfFamily.get(key);
    const base = {
      familyId: f.id, name: familyName.get(key)!, addresses: addressesOf.get(key) ?? [],
      students: (activeStudentsOf.get(key) ?? []).map((s) => ({ id: s.id, name: recordNameWords(s.name, "student"), customerId: studentTie(familyTie(link?.customerId), customerOfStudent.get(String(s.id))) }))
        .sort(byRosterOrder).map((s) => ({ id: s.id, name: s.name, link: own(customerOfStudent.get(String(s.id))) })),
      guardians: (guardiansOf.get(key) ?? []).map((g): GuardianShown => {
        // Slice M3c: the row's link, its standing and Unlink this guardian, or Link this guardian's candidates, from the same reads.
        // Since its review, a press the write queue holds back isn't drawn, and what holds it is said instead.
        const linked = b.guardianLinkOf(g.id);
        const offered = linked === null ? b.guardianOfferOf(g.id) : null;
        const unlinkHeld = linked === null ? 0
          : (blockingOfRow.get(g.id) ?? 0) + (blockingOn.get(linked.customerId) ?? 0) - (blockingBoth.get(`${g.id} ${linked.customerId}`) ?? 0);
        return { id: g.id, name: g.name, email: g.email, blocked: g.blocked, link: own(customerOfGuardian.get(g.id)),
          standing: linked?.standing ?? null, sharedWith: linked?.sharedWith ?? [],
          unlink: linked === null || unlinkHeld > 0 ? null : { linkId: linked.linkId, stamp: linked.stamp }, unlinkHeld,
          ...offerShown(g.id, offered !== null && "offer" in offered ? offered.offer : null), noOffer: offered !== null && "none" in offered ? offered.none : null,
          relink: b.guardianBooksOf(key) !== null };
      }).sort(byName),
      removed: b.removedOf(key),
      differences: [] as Difference[], inactiveUnrecorded: 0, confirm: null, review: null, unlink: null, takes: [] as TakeOffer[], takeNotes: [] as { at: number; words: string }[],
      sends: [] as SendOffer[], sendNotes: [] as { at: number; words: string }[], offers: none,
    };
    if (link !== undefined) {
      const customer = customerById.get(link.customerId);
      const standing = linkStanding(customer, { cacheHasCustomers: customers.length > 0, listedAsFamily });
      const shownCustomer = customer ? { name: customer.displayName, email: customer.email } : null;
      const unlink = b.unlinkOf(key);
      if (standing.is === "gone") return { ...base, customer: shownCustomer, status: { key: "customer_gone" }, unlink };
      if (standing.is === "not_a_family") return { ...base, customer: shownCustomer, status: { key: "not_a_family", reasons: standing.reasons }, unlink };
      const made: LinkMade = link.origin === "carried_over" ? { key: "carried_over", at: link.linkedAt.toISOString() }
        : { key: "linked", origin: link.origin, by: link.linkedBy === null ? null : staffNames.get(link.linkedBy) ?? null, at: link.linkedAt.toISOString() };
      // Differences only for a link that stands, in the `listed` state (compare is null otherwise), against a customer the cache holds.
      const found = compare === null || customer === undefined ? null : compare({
        kind: roster?.kind === "flat" ? "member" : "family", name: f.name, customerId: link.customerId,
        students: (studentsOf.get(key) ?? []).map((s) => ({ id: s.id, name: s.name, active: s.active, customerId: customerOfStudent.get(String(s.id)) ?? null })),
        guardians: (guardiansOf.get(key) ?? []).map((g) => ({ id: g.id, customerId: customerOfGuardian.get(g.id) ?? null })),
      });
      const status: LinkStatus = found !== null && found.differences.length > 0 ? { key: "with_differences", made } : made;
      const takes = found === null ? { takes: [], takeNotes: [] } : takeOffersOf(b, f, link.customerId, found.differences, queue, studentsRule);
      const sends = found === null || sendFacts === null ? { sends: [], sendNotes: [] } : sendOffersOf(b, sendFacts, f, link.customerId, found.differences, queue);
      return { ...base, customer: shownCustomer, status, differences: found?.differences ?? [], inactiveUnrecorded: found?.inactiveUnrecorded ?? 0, review: b.reviewOf(key), unlink, ...takes, ...sends };
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

  // The families whose rows aim at each customer (a suggestion or a candidate), for the confirm step's warning: the one
  // rule "Create a family from this" refuses by too (aimIndex()).
  const aimedBy = aimIndex(b);
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
      alsoFor: (aimedBy.get(customerId) ?? []).map((a) => a.familyKey).filter((k) => k !== key).map((k) => familyName.get(k)!).sort((x, y) => COLLATOR.compare(x, y)) };
  };
  const bulk = (filter: Pick<LinksFilter, "status" | "q">): BulkOffer | null => {
    const all = suggestedRowsOf(b, filter);
    if (all.length === 0) return null;
    const taken = all.filter((r) => !r.held);
    return { count: taken.length, waiting: all.length - taken.length,
      stamp: taken.length === 0 || taken.length > BULK_MAX ? null : bulkStamp(filter, taken.length, bulkKeys(taken)) };
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
    pool: poolShown, step, bulk,
    inactive: listed ? inactiveRowsOf(b, queue) : [],
    guardianLinks: shape !== null && shape.kind === "layered" && shape.parentTypeId !== null,
  };
}

/**
 * The inactive family records the books have active (slice M4b, open question 12: Take QuickBooks' into the app is the
 * only way a record becomes active again), from the screen's reads alone (no query of its own, so the view's count
 * above is unchanged): each family record inactive in the portal with a family link of the records' company whose
 * customer the books' copy holds active and the roster lists as a family (a member in flat books) that stands
 * (linkStanding()), by name then id. One with no link, or whose customer the books have inactive, don't hold or don't
 * list as a family, isn't listed. Its press makes the family active alone (takeFromBooks(), `active`), and holds its
 * sign-ins: the words say both, and that nothing is sent. No press, and one sentence in its place, where the press
 * would refuse by what the view read: a change waiting or stuck for its customer, its own create waiting, a move into
 * or out of it pending (QUEUE_IN_THE_WAY), or its name held by an active family. The books' text (a name) is said as text.
 */
function inactiveRowsOf(b: LinkBasics, queue: readonly QueueView[]): InactiveRow[] {
  if (b.listedAsFamily === null) return [];
  const listedAsFamily = b.listedAsFamily;
  const open = (i: QueueView) => i.state === "waiting" || i.state === "stuck";
  const noun = b.roster?.kind === "flat" ? "member" : "family";
  const sent = "Nothing is sent to the books.";
  const rows = b.everyFamily.filter((f) => !f.active).flatMap((f): InactiveRow[] => {
    const key = String(f.id);
    const link = b.linkOfFamily.get(key);
    const c = link === undefined ? undefined : b.customerById.get(link.customerId);
    if (c === undefined || !c.active || linkStanding(c, { cacheHasCustomers: true, listedAsFamily }).is !== "stands") return [];
    const words = recordNameWords(f.name, "family");
    const students = [...(b.studentsOf.get(key) ?? [])].filter((s) => !s.active)
      .sort((x, y) => COLLATOR.compare(x.name ?? "", y.name ?? "") || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0))
      .map((s) => recordNameWords(s.name, "student"));
    const base = { familyId: f.id, name: words, customer: c.displayName, students };
    const inTheWay = queue.some((i) => (open(i) && i.write.op !== "create" && i.write.op !== "contact" && i.write.op !== "email" && "qboId" in i.write && i.write.qboId === c.qboId)
      || (open(i) && i.write.op === "create" && (i.write.role === "family" || i.write.role === "member") && String(i.familyId) === key)
      || (i.write.op === "move" && (String(i.familyId) === key || String(i.write.toFamilyId) === key || i.write.fromFamilyQboId === c.qboId || i.write.toFamilyQboId === c.qboId)));
    const kept = queue.some((i) => i.state === "refused" && i.write.op === "deactivate" && i.write.qboId === c.qboId);
    // Send the app's to QuickBooks (slice M5a): a member of flat books is one customer, made inactive in the books by the
    // balance rule; a layered family goes with everyone under it, which this screen doesn't send.
    const send: Pick<InactiveRow, "send" | "sendNote"> = noun === "family" ? { send: null, sendNote: SEND_FAMILY_INACTIVE }
      : inTheWay ? { send: null, sendNote: QUEUE_IN_THE_WAY_OF_SEND }
      : b.shape === null || !offers(b.shape, deactivateOf("member")) ? { send: null, sendNote: null }
      : !sendConnected(b) ? { send: null, sendNote: SEND_NOT_CONNECTED }
      : { sendNote: null, send: { at: 0, field: "inactive", kind: "family", recordId: key, about: `${words}'s active status`,
        words: [inactiveSendWords(words, "it"), ...(kept ? [KEPT_OFF_SENT] : [])], stamp: sendStamp("inactive", key, c.qboId, [c.qboId]) } };
    if (inTheWay) return [{ ...base, take: null, note: QUEUE_IN_THE_WAY, ...send }];
    const own = f.name;
    if (own !== null && b.families.some((x) => x.name !== null && nameKey(x.name) === nameKey(own))) {
      return [{ ...base, take: null, note: `Another ${noun} in the portal is called “${own}”, and every ${noun}'s name must be different, so ${words} can't be made active until one of them is renamed on its page.`, ...send }];
    }
    const alone = noun === "family" ? " alone: its students stay inactive in the portal, and each the books have active shows on its row once it is listed, with a press of its own" : "";
    return [{ ...base, note: null, take: { at: 0, field: "active", kind: "family", recordId: key, about: `${words}'s active status`,
      words: [`Makes ${words} active in the portal, as the books have it${alone}. ${sent}`, heldWords(words), ...(kept ? [KEPT_OFF_STAYS] : [])],
      stamp: takeStamp("active", key, c.qboId, [f.name]) }, ...send }];
  });
  return rows.sort((x, y) => COLLATOR.compare(x.name, y.name) || (String(x.familyId) < String(y.familyId) ? -1 : String(x.familyId) > String(y.familyId) ? 1 : 0));
}

/**
 * Take QuickBooks' into the app (slice M4a): which of a row's differences a press settles, from the screen's reads
 * alone (no query of its own, so the view's count above is unchanged), each with what it does in words and the stamp
 * sealing what the row showed; the press (takeFromBooks(), src/lib/roster/writes.ts) works each value out again under
 * the roster lock. Only for a link that stands, in the `listed` state (its caller's), and only where the difference has
 * no change on the queue explaining it or only a kept one: a change waiting or stuck is on its way, and its words stand
 * alone. Offered:
 * - a name, of the family, the member or an active student, that checkName() takes and, for a family or member, that
 *   no other active family of the portal holds;
 * - a record active in the portal whose customer the books have inactive: a student, the member, or a family in layered
 *   books whose every active student record has no link or is linked to a customer the books' copy has inactive (it
 *   goes with them); otherwise a note names those the books still have active, or whose customer the copy doesn't hold;
 * - where a student is, as the books have it under another family (`place` at `other_family`, or this family's
 *   `student_elsewhere` of a record in another family), when an active family of the portal other than the record's own
 *   is linked to that customer: a move, with its follow-ups said beside it; otherwise, for a place, a note that no
 *   family of the portal is linked to it;
 * - since slice M4b, an inactive student record of the family whose customer the books have active directly under the
 *   family's (the `active` difference with `portalActive` false): made active alone, with the hold of the family's
 *   sign-ins said when the take would set one or one stands (the students rule in force, and no active student).
 * Nothing else: any other place, a student or Parent customer on one side only and a guardian's link are only shown.
 * The books' text (a name) is said as text.
 * Nor is a press drawn that the queue would make the take refuse, by the open writes the view read (`queue`): a change
 * waiting or stuck for a customer the take checks (the record's, those of the students a family goes with, either
 * family's of a move), a family's or a student's create waiting, or a move waiting, stuck or kept that the take refuses
 * on (the student's, for a student's inactive or active; one into or out of the family, for a family's or member's). The queue's
 * sentence stands in its place (QUEUE_IN_THE_WAY). The "being made" and "being sent" locks, held for the seconds of a
 * send, are left to the press, as the move form's list leaves them (moveRefusals(), src/lib/roster/writes.ts).
 */
function takeOffersOf(b: LinkBasics, f: { id: AppFamilyId; name: string | null }, familyCustomer: string, differences: readonly Difference[], queue: readonly QueueView[],
  studentsRule: boolean): { takes: TakeOffer[]; takeNotes: { at: number; words: string }[] } {
  const takes: TakeOffer[] = [], takeNotes: { at: number; words: string }[] = [];
  // What the press's own checks refuse on, read from the queue's open items (takeFromBooks(), moveRefusals()).
  const open = (i: QueueView) => i.state === "waiting" || i.state === "stuck";
  const waitingFor = (customer: string | null | undefined) => customer != null && queue.some((i) => open(i) && i.write.op !== "create" && i.write.op !== "contact"
    && i.write.op !== "email" && "qboId" in i.write && i.write.qboId === customer);
  const familyCreating = (id: AppFamilyId) => queue.some((i) => open(i) && i.write.op === "create" && (i.write.role === "family" || i.write.role === "member") && String(i.familyId) === String(id));
  const studentCreating = (id: AppStudentId) => queue.some((i) => open(i) && i.write.op === "create" && i.write.role === "student" && String(i.studentId) === String(id));
  const studentMoving = (id: AppStudentId) => queue.some((i) => i.write.op === "move" && String(i.studentId) === String(id));
  const familyMoving = (id: AppFamilyId, customer: string) => queue.some((i) => i.write.op === "move" && (String(i.familyId) === String(id)
    || String(i.write.toFamilyId) === String(id) || i.write.fromFamilyQboId === customer || i.write.toFamilyQboId === customer));
  const customerOfFamily = (id: AppFamilyId) => b.linkOfFamily.get(String(id))?.customerId;
  /** The take, or in its place the queue's sentence when the queue stands in its way. */
  const offer = (t: TakeOffer, blocked: boolean) => { if (blocked) takeNotes.push({ at: t.at, words: QUEUE_IN_THE_WAY }); else takes.push(t); };
  const key = String(f.id);
  const familyWords = recordNameWords(f.name, "family");
  const studentOf = (id: AppStudentId) => b.everyStudent.find((s) => String(s.id) === String(id));
  const activeFamily = (id: AppFamilyId | null | undefined) => (id == null ? undefined : b.families.find((x) => String(x.id) === String(id)));
  const sent = "Nothing is sent to the books.";
  /** The words of a move taken from the books, true by afterStudentMoved(): what a move made on a family's page does. */
  const moveWords = (who: string, to: string) => [`Moves ${who} to ${to} in the portal, where the books have them, as a move made on the family's page does: their forms not yet complete start again under ${to}, their volunteer places still to come are given up and their guardians told by email, and an unpaid volunteer buy-out invoice of theirs is voided in the books. Nothing about the student is sent to the books.`];
  const move = (at: number, studentId: AppStudentId, fromFamilyId: AppFamilyId, to: { id: AppFamilyId; name: string | null }, toCustomer: string) => {
    const studentCustomer = b.customerOfStudent.get(String(studentId));
    const s = studentOf(studentId);
    if (studentCustomer === undefined || s === undefined || !s.active || activeFamily(fromFamilyId) === undefined || String(to.id) === String(fromFamilyId)) return;
    const who = recordNameWords(s.name, "student");
    offer({ at, field: "place", kind: "student", recordId: String(studentId), about: `${who}'s family`, words: moveWords(who, recordNameWords(to.name, "family")),
      stamp: takeStamp("place", String(studentId), studentCustomer, [studentCustomer, toCustomer, String(fromFamilyId), String(to.id)]) },
    waitingFor(studentCustomer) || studentCreating(studentId) || [fromFamilyId, to.id].some((id) => familyCreating(id) || waitingFor(customerOfFamily(id))));
  };
  differences.forEach((d, at) => {
    if ("queue" in d && d.kind !== "guardians_unlinked" && d.queue !== null && d.queue.state !== "refused") return;
    if (d.kind === "name") {
      const name = checkName(d.books);
      if (!name.ok) return;
      if (d.of === "student") {
        const customer = b.customerOfStudent.get(String(d.studentId));
        if (customer === undefined) return;
        const who = recordNameWords(studentOf(d.studentId)?.name ?? null, "student");
        offer({ at, field: "name", kind: "student", recordId: String(d.studentId), about: `${who}'s name`, words: [`Takes “${d.books}” as ${who}'s name in the portal, as the books have it. ${sent}`],
          stamp: takeStamp("name", String(d.studentId), customer, [d.books]) }, waitingFor(customer));
        return;
      }
      if (b.families.some((x) => String(x.id) !== key && x.name !== null && nameKey(x.name) === nameKey(name.name))) return;
      offer({ at, field: "name", kind: "family", recordId: key, about: `${familyWords}'s name`, words: [`Takes “${d.books}” as this ${d.of}'s name in the portal, as the books have it. ${sent}`],
        stamp: takeStamp("name", key, familyCustomer, [d.books]) }, waitingFor(familyCustomer));
      return;
    }
    if (d.kind === "active") {
      if (!d.portalActive) {
        // An inactive student record whose customer the books have active directly under the family's (slice M4b): made
        // active alone; the family's sign-ins held when it has no active student and the students rule is in force (the
        // take would open it to its guardians), or held already.
        if (d.of !== "student") return;
        const customer = b.customerOfStudent.get(String(d.studentId));
        if (customer === undefined) return;
        const opens = studentsRule && !b.students.some((s) => String(s.familyId) === key && s.active);
        const holds = opens || b.everyFamily.some((x) => String(x.id) === key && x.heldAt !== null);
        const kept = d.queue !== null && d.queue.state === "refused";
        offer({ at, field: "active", kind: "student", recordId: String(d.studentId), about: `${d.who}'s active status`,
          words: [`Makes ${d.who} active in the portal, as the books have them. ${sent}`, ...(holds ? [heldWords(familyWords)] : []), ...(kept ? [KEPT_OFF_STAYS] : [])],
          stamp: takeStamp("active", String(d.studentId), customer, [holds]) },
        waitingFor(customer) || studentMoving(d.studentId) || familyCreating(f.id));
        return;
      }
      if (d.of === "student") {
        const customer = b.customerOfStudent.get(String(d.studentId));
        if (customer === undefined) return;
        offer({ at, field: "inactive", kind: "student", recordId: String(d.studentId), about: `${d.who}'s active status`,
          words: [`Makes ${d.who} inactive in the portal, as the books have them. ${sent}`], stamp: takeStamp("inactive", String(d.studentId), customer, []) },
        waitingFor(customer) || studentCreating(d.studentId) || studentMoving(d.studentId) || familyCreating(f.id));
        return;
      }
      if (d.of === "member") {
        offer({ at, field: "inactive", kind: "family", recordId: key, about: `${familyWords}'s active status`,
          words: [`Makes ${familyWords} inactive in the portal, as the books have it. Its guardians can't sign in to the member then. ${sent}`], stamp: takeStamp("inactive", key, familyCustomer, []) },
        waitingFor(familyCustomer) || familyCreating(f.id) || familyMoving(f.id, familyCustomer));
        return;
      }
      const under = b.students.filter((s) => String(s.familyId) === key && s.active)
        .sort((x, y) => COLLATOR.compare(x.name ?? "", y.name ?? "") || (String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0));
      const stillActive: string[] = [], notHeld: string[] = [];
      for (const s of under) {
        const customer = b.customerOfStudent.get(String(s.id));
        if (customer === undefined) continue;
        const c = b.customerById.get(customer);
        if (c === undefined) notHeld.push(recordNameWords(s.name, "student"));
        else if (c.active) stillActive.push(recordNameWords(s.name, "student"));
      }
      if (stillActive.length) {
        takeNotes.push({ at, words: `${stillActive.join(", ")} ${stillActive.length === 1 ? "is" : "are"} still active in the books, so the family can't be taken as inactive until they are made inactive there or moved.` });
        return;
      }
      if (notHeld.length) {
        takeNotes.push({ at, words: `The books' copy doesn't hold the customer of ${notHeld.join(", ")} now, so the family can't be taken as inactive.` });
        return;
      }
      const withThem = under.length === 0 ? "" : `, with ${under.length === 1 ? "its student" : `its ${under.length} students`} ${under.map((s) => recordNameWords(s.name, "student")).join(", ")}`;
      offer({ at, field: "inactive", kind: "family", recordId: key, about: `${familyWords}'s active status`,
        words: [`Makes ${familyWords} inactive in the portal${withThem}, as the books have it. Its guardians can't sign in to the family then. ${sent}`],
        stamp: takeStamp("inactive", key, familyCustomer, under.map((s) => String(s.id)).sort()) },
      waitingFor(familyCustomer) || familyCreating(f.id) || familyMoving(f.id, familyCustomer)
        || under.some((s) => { const c = b.customerOfStudent.get(String(s.id)); return c === undefined ? studentCreating(s.id) : waitingFor(c); }));
      return;
    }
    if (d.kind === "place" && d.place.at === "other_family") {
      const to = activeFamily(b.familyOfCustomer.get(d.place.familyQboId));
      if (to === undefined || String(to.id) === key) {
        takeNotes.push({ at, words: `No active family of the portal is linked to ${d.place.familyName}.` });
        return;
      }
      move(at, d.studentId, f.id, to, d.place.familyQboId);
      return;
    }
    if (d.kind === "student_elsewhere" && d.portal.at === "family") {
      const from = studentOf(d.studentId)?.familyId;
      if (from === null || from === undefined) return;
      move(at, d.studentId, from, f, familyCustomer);
    }
  });
  return { takes, takeNotes };
}

/** A make-inactive sent from the screen, in words: what QuickBooks will hold, and that the balance is read first and any balance stops it. */
const inactiveSendWords = (who: string, pronoun: "it" | "them") =>
  `Makes ${who} inactive in the books, as the portal has ${pronoun}, in place of active there. QuickBooks is asked what is owed first, and any balance, owed or a credit, stops it with nothing sent.`;
/** Said beside a name in place of Send when only a create or rename waiting or stuck on the queue holds the portal's name: on its way to QuickBooks, not there yet. */
export const sendNameQueuedNote = (name: string) =>
  `A change on its way to QuickBooks, on the Reconciliation page, gives another customer the name “${name}”, and every name there must be different, so the portal's name can't be sent: rename the record on its page instead, or give that change up.`;
/** Said with a send whose make-inactive of the customer is kept on Reconciliation: the send takes its place once QuickBooks has the customer inactive. */
const KEPT_OFF_SENT = "The make-inactive kept on the Reconciliation page is closed once QuickBooks has the customer inactive, as this takes its place.";

/**
 * What the screen's sends are worked out from, once for the view (slice M5a), from its reads and the queue's open items
 * (no query of its own, so the view's count is unchanged): the student customers the roster lists directly under a
 * family (a rename and a make-inactive of a student need one), each cached customer's name by nameKey(), and the names
 * of the creates and renames waiting or stuck on the queue (namesTaken()'s rule, src/lib/roster/writes.ts).
 */
type SendFacts = { studentListed: Set<string>; holders: Map<string, string[]>; queuedNames: Set<string>; connected: boolean };
/**
 * Whether a send could go through now, by the connection the view read: QuickBooks connected, with a live refresh token,
 * to the roster's company (readyToSend()'s rule, src/lib/roster/writes.ts). Not so, no press is drawn, and one sentence
 * stands in its place (SEND_NOT_CONNECTED).
 */
const sendConnected = (b: LinkBasics) => Boolean(b.connection?.realmId && b.connection.refreshTokenCiphertext) && b.source !== null && b.source === b.connection?.realmId;
/** Said beside a difference in place of Send the app's to QuickBooks while QuickBooks isn't connected to the roster's company. */
export const SEND_NOT_CONNECTED = "QuickBooks isn't connected to the roster's company just now, so the portal's value can be sent once an Admin connects it under QuickBooks.";
function sendFactsOf(b: LinkBasics, queue: readonly QueueView[]): SendFacts {
  const studentListed = new Set(b.roster === null || b.roster.kind === "flat" ? [] : b.roster.families.flatMap((f) => f.students.map((c) => c.qboId)));
  const holders = new Map<string, string[]>();
  for (const c of b.customers) { const k = nameKey(c.displayName); const had = holders.get(k); if (had) had.push(c.qboId); else holders.set(k, [c.qboId]); }
  const queuedNames = new Set(queue.flatMap((i) => ((i.state === "waiting" || i.state === "stuck") && (i.write.op === "create" || i.write.op === "rename") && "name" in i.write
    && typeof i.write.name === "string" ? [nameKey(i.write.name)] : [])));
  return { studentListed, holders, queuedNames, connected: sendConnected(b) };
}

/**
 * Send the app's to QuickBooks (slice M5a): which of a row's differences a press sends the portal's value of, from the
 * screen's reads alone (no query of its own, so the view's count is unchanged), each with what QuickBooks will hold and
 * what it held, and the stamp sealing what the row showed; the press (sendToBooks(), src/lib/roster/writes.ts) works each
 * value out again under the roster lock, with a live connection. Only for a link that stands, in the `listed` state (its
 * caller's), and only where the difference has no change on the queue explaining it or only a kept one, which the press
 * takes the place of (said beside it). Offered:
 * - a name, of the family, the member or an active student, whose customer the cache has active (a student's listed
 *   directly under a family), where the portal's name is one checkName() takes as it is and no other customer of the
 *   cache, nor a create or rename waiting, holds (otherwise one sentence: QuickBooks has another customer of that name,
 *   or a change on its way there gives one that name);
 * - where an active student is, as the books have them under another family, at the top of the tree or under another
 *   customer (`place` at `other_family`, `top`, `under_other`), and this family's `student_elsewhere` of an active record
 *   in another family whose own link stands: the same send from either row, one stamp, the student's customer and the
 *   family's active in the cache;
 * - an inactive student record whose customer the books have active directly under the family's (`active` with
 *   `portalActive` false): made inactive in the books by the balance rule.
 * Not offered: `active` with `portalActive` true (it would make a customer active in the books: open question 12, said),
 * a place at `not_student` or `gone`, a student elsewhere with no family or inactive, and the links (a student or Parent
 * customer on one side only, a guardian with none). Nor is a press drawn that the queue would make the send refuse, by
 * the checks takeOffersOf() makes from the queue's open items (QUEUE_IN_THE_WAY_OF_SEND in its place). The books' text
 * is said as text.
 */
function sendOffersOf(b: LinkBasics, s: SendFacts, f: { id: AppFamilyId; name: string | null }, familyCustomer: string, differences: readonly Difference[],
  queue: readonly QueueView[]): { sends: SendOffer[]; sendNotes: { at: number; words: string }[] } {
  const sends: SendOffer[] = [], sendNotes: { at: number; words: string }[] = [];
  if (b.shape === null) return { sends, sendNotes };
  const shape = b.shape;
  const open = (i: QueueView) => i.state === "waiting" || i.state === "stuck";
  const waitingFor = (customer: string | null | undefined) => customer != null && queue.some((i) => open(i) && i.write.op !== "create" && i.write.op !== "contact"
    && i.write.op !== "email" && "qboId" in i.write && i.write.qboId === customer);
  const familyCreating = (id: AppFamilyId) => queue.some((i) => open(i) && i.write.op === "create" && (i.write.role === "family" || i.write.role === "member") && String(i.familyId) === String(id));
  const studentCreating = (id: AppStudentId) => queue.some((i) => open(i) && i.write.op === "create" && i.write.role === "student" && String(i.studentId) === String(id));
  const studentMoving = (id: AppStudentId) => queue.some((i) => i.write.op === "move" && String(i.studentId) === String(id));
  const offer = (o: SendOffer, blocked: boolean) => {
    if (!s.connected) sendNotes.push({ at: o.at, words: SEND_NOT_CONNECTED });
    else if (blocked) sendNotes.push({ at: o.at, words: QUEUE_IN_THE_WAY_OF_SEND });
    else sends.push(o);
  };
  const key = String(f.id);
  const familyWords = recordNameWords(f.name, "family");
  const studentOf = (id: AppStudentId) => b.everyStudent.find((x) => String(x.id) === String(id));
  const inactiveThere = "QuickBooks has this customer inactive, and the portal sends nothing to a customer inactive there.";
  /** A family of the portal whose own link stands to an active family customer: that customer, or undefined. */
  const standingCustomerOf = (id: AppFamilyId | null | undefined) => {
    if (id == null || !b.families.some((x) => String(x.id) === String(id))) return undefined;
    const c = b.customerById.get(b.linkOfFamily.get(String(id))?.customerId ?? "");
    return c !== undefined && c.active && b.listedAsFamily !== null && linkStanding(c, { cacheHasCustomers: true, listedAsFamily: b.listedAsFamily }).is === "stands" ? c.qboId : undefined;
  };
  /** The same send of a student's family from either row: the student in `to`, the family record they are in, as the portal has it. */
  const place = (at: number, studentId: AppStudentId, to: { id: AppFamilyId; name: string | null }, toCustomer: string, kept: boolean) => {
    const studentCustomer = b.customerOfStudent.get(String(studentId));
    const st = studentOf(studentId);
    const c = studentCustomer === undefined ? undefined : b.customerById.get(studentCustomer);
    if (studentCustomer === undefined || st === undefined || !st.active || c === undefined || !offers(shape, "move_student")) return;
    if (!c.active) { sendNotes.push({ at, words: inactiveThere }); return; }
    if (c.parentQboId === toCustomer) return;
    const who = recordNameWords(st.name, "student"), toWords = recordNameWords(to.name, "family");
    const parent = c.parentQboId === null ? undefined : b.customerById.get(c.parentQboId);
    const held = parent === undefined ? "at the top of its list, under no customer" : `under “${parent.displayName}”`;
    // Whose invoices a family sees follows QuickBooks' tree (open question 14): said, as a move's money note says it.
    const invoices = `Once QuickBooks has them there, ${toWords} sees their invoices in the portal${parent === undefined ? "" : `, and no family sees them through “${parent.displayName}” any more`}.`;
    offer({ at, field: "place", kind: "student", recordId: String(studentId), about: `${who}'s family`,
      words: [`Sends ${who}'s family to the books: QuickBooks will have them under ${toWords}'s customer, where it has them ${held} now. The books' place is replaced. ${invoices} Nothing else of theirs in the portal moves: their forms, volunteer places and buy-outs stay as they are.`,
        ...(kept ? ["The move kept on the Reconciliation page is closed, as this takes its place."] : [])],
      stamp: sendStamp("place", String(studentId), studentCustomer, [studentCustomer, c.parentQboId ?? "", String(to.id), toCustomer]) },
    waitingFor(studentCustomer) || studentCreating(studentId) || familyCreating(to.id) || waitingFor(toCustomer) || waitingFor(c.parentQboId));
  };
  differences.forEach((d, at) => {
    if ("queue" in d && d.kind !== "guardians_unlinked" && d.queue !== null && d.queue.state !== "refused") return;
    const kept = "queue" in d && d.kind !== "guardians_unlinked" && d.queue !== null && d.queue.state === "refused";
    if (d.kind === "name") {
      const student = d.of === "student" ? studentOf(d.studentId) : undefined;
      const customer = d.of === "student" ? b.customerOfStudent.get(String(d.studentId)) : familyCustomer;
      const c = customer === undefined ? undefined : b.customerById.get(customer);
      if (c === undefined || !offers(shape, renameOf(d.of)) || (d.of === "student" && !s.studentListed.has(c.qboId))) return;
      if (!c.active) { sendNotes.push({ at, words: inactiveThere }); return; }
      const name = checkName(d.portal ?? "");
      if (!name.ok || name.name !== d.portal) return;
      if ((s.holders.get(nameKey(name.name)) ?? []).some((id) => id !== c.qboId)) {
        sendNotes.push({ at, words: `QuickBooks has another customer named “${name.name}”, and every name there must be different, so the portal's name can't be sent: rename the record on its page instead.` });
        return;
      }
      // A name only a change on its way to QuickBooks holds: QuickBooks doesn't have it yet, so it isn't said that it does.
      if (s.queuedNames.has(nameKey(name.name))) { sendNotes.push({ at, words: sendNameQueuedNote(name.name) }); return; }
      const recordId = d.of === "student" ? String(d.studentId) : key;
      const whose = d.of === "student" ? `${recordNameWords(student?.name ?? null, "student")}'s` : `this ${d.of}'s`;
      offer({ at, field: "name", kind: d.of === "student" ? "student" : "family", recordId, about: `${d.of === "student" ? recordNameWords(student?.name ?? null, "student") : familyWords}'s name`,
        words: [`Sends “${name.name}” to the books as ${whose} name, in place of “${d.books}” there. The books' name is replaced.`,
          ...(kept ? ["The rename kept on the Reconciliation page is closed, as this takes its place."] : [])],
        stamp: sendStamp("name", recordId, c.qboId, [d.books, d.portal]) }, waitingFor(c.qboId));
      return;
    }
    if (d.kind === "active") {
      if (d.portalActive) { sendNotes.push({ at, words: "The portal never makes a customer active in the books, so this can only be taken from them." }); return; }
      if (d.of !== "student" || !offers(shape, deactivateOf("student"))) return;
      const customer = b.customerOfStudent.get(String(d.studentId));
      if (customer === undefined) return;
      offer({ at, field: "inactive", kind: "student", recordId: String(d.studentId), about: `${d.who}'s active status`,
        words: [inactiveSendWords(d.who, "them"), ...(kept ? [KEPT_OFF_SENT] : [])], stamp: sendStamp("inactive", String(d.studentId), customer, [customer]) },
      waitingFor(customer) || studentCreating(d.studentId) || studentMoving(d.studentId) || familyCreating(f.id));
      return;
    }
    if (d.kind === "place" && (d.place.at === "other_family" || d.place.at === "top" || d.place.at === "under_other")) {
      const own = standingCustomerOf(f.id);
      if (own === undefined) { sendNotes.push({ at, words: "QuickBooks has this family's customer inactive, so no student is sent to it." }); return; }
      place(at, d.studentId, f, own, kept);
      return;
    }
    if (d.kind === "student_elsewhere" && d.portal.at === "family") {
      const st = studentOf(d.studentId);
      const toCustomer = standingCustomerOf(st?.familyId);
      const to = st?.familyId == null ? undefined : b.families.find((x) => String(x.id) === String(st.familyId));
      if (toCustomer === undefined || to === undefined) return;
      place(at, d.studentId, to, toCustomer, kept);
    }
  });
  return { sends, sendNotes };
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
export function filterLinkRows(rows: readonly LinkRow[], filter: Pick<LinksFilter, "status" | "q">): LinkRow[] {
  return rows.filter((r) => shownBy(filter, filtersOf(r), rowTexts(r.name, r.guardians.map((g) => g.email), r.customer)));
}

/**
 * The one rule of what a filter shows (slice M3a2), for the list (filterLinkRows()) and the bulk press
 * (suggestedRowsShown()) alike: a row found under the filter's status (every row when none), whose texts the search
 * matches (searchMatches(), ignoring case).
 */
const shownBy = (filter: Pick<LinksFilter, "status" | "q">, filters: readonly StatusKey[], texts: readonly (string | null)[]) =>
  (filter.status === null || filters.includes(filter.status)) && searchMatches(filter.q, texts);
/** The texts a row's search reads: the family's name in words, its open guardians' sign-in addresses (a blocked person's too), and the customer's name and email field. */
const rowTexts = (name: string, guardianEmails: readonly string[], customer: CustomerShown | null): (string | null)[] =>
  [name, ...guardianEmails, customer?.name ?? null, customer?.email ?? null];

/**
 * The Suggested rows a filter shows (slice M3a2: Confirm all exact email matches), worked out from the screen's reads
 * alone, so the page's button and the press read the same rows by the same rule: each active family with no family
 * link of the records' company, not left unlinked, whose suggestion is `suggested`, found under the filter as its row
 * is (filtersOf() of a Suggested row is `suggested` alone) by the texts its row's search reads (rowTexts(): the
 * family's name in words, its open guardians' sign-in addresses, the suggested customer's name and email field). Each
 * with its row's own offer (offerFor(..., "suggested")), in the roster's order (byRosterOrder(), a family with no link
 * breaking a tie of names by its record's id). None but in the `listed` state, where suggestions are worked out.
 * `held`: a row a press would refuse whatever happened meanwhile (familyToLink() in ./link-writes.ts), as the family's
 * own create is waiting or stuck on the queue (filed under it), or it has a family link of another company: still
 * Suggested on the list, its own Confirm saying why, but left out of the bulk press, its count and its stamp.
 */
function suggestedRowsOf(b: LinkBasics, filter: Pick<LinksFilter, "status" | "q">): (SuggestedShown & { held: boolean })[] {
  const suggestions = b.suggestions;
  if (b.state !== "listed" || suggestions === null) return [];
  return b.families.flatMap((f): (SuggestedShown & { held: boolean })[] => {
    const key = String(f.id);
    const s = suggestions.get(key);
    if (b.linkOfFamily.has(key) || b.leftOf.has(key) || s === undefined || s.kind !== "suggested") return [];
    const name = recordNameWords(f.name, "family");
    const texts = rowTexts(name, (b.guardiansOf.get(key) ?? []).map((g) => g.email), { name: s.candidate.name, email: s.candidate.email });
    if (!shownBy(filter, ["suggested"], texts)) return [];
    return [{ familyId: f.id, familyKey: key, name, customerId: s.candidate.customerId, offer: b.offerFor(key, s.candidate.customerId, "suggested"),
      held: b.createQueuedFor.has(key) || b.familyLinkedAnywhere.has(key) }];
  }).sort((x, y) => byRosterOrder({ id: x.familyId, name: x.name, customerId: null }, { id: y.familyId, name: y.name, customerId: null }));
}
/** The Suggested rows a filter shows that a bulk press takes (Confirm all exact email matches): those of suggestedRowsOf() not `held`. */
export function suggestedRowsShown(b: LinkBasics, filter: Pick<LinksFilter, "status" | "q">): SuggestedShown[] {
  return suggestedRowsOf(b, filter).flatMap(({ held, ...r }) => (held ? [] : [r]));
}
/** The rows as the bulk stamp seals them: each `<family id>=<customer id>|<the row's pairKeys(), joined>`. */
export const bulkKeys = (rows: readonly SuggestedShown[]): string[] => rows.map((r) => `${r.familyKey}=${r.customerId}|${pairKeys(r.offer.proposals).join(",")}`);

/**
 * The families whose rows aim at each customer: a Suggested row's suggestion (`suggested`) and each of a Several
 * possible row's candidates (`several`), by the screen's own suggestions (a Left unlinked family is given to no
 * matcher, so it aims at nothing). The confirm step's warning and "Create a family from this"'s refusal both read it.
 */
export function aimIndex(b: Pick<LinkBasics, "suggestions">): Map<string, { familyKey: string; how: "suggested" | "several" }[]> {
  const out = new Map<string, { familyKey: string; how: "suggested" | "several" }[]>();
  for (const [familyKey, s] of b.suggestions ?? []) {
    if (s.kind === "none") continue;
    const aims = s.kind === "suggested" ? [s.candidate.customerId] : s.candidates.map((c) => c.customerId);
    for (const c of aims) out.set(c, [...(out.get(c) ?? []), { familyKey, how: s.kind }]);
  }
  return out;
}
/** The families whose rows aim at one customer (aimIndex()). */
export const familiesAimingAt = (b: Pick<LinkBasics, "suggestions">, customerId: string) => aimIndex(b).get(customerId) ?? [];

/**
 * Why a customer no family is linked to is meant for a family the portal has already (slice M3a2), so "Create a family
 * from this" would make a second family: the screen's rows suggest it (`suggested`) or list it as a candidate
 * (`several`) for these families (familiesAimingAt()); or a create of an active family with no family link, given up
 * after a try, made it (`given_up`: madeAfterGivingUp(), the family the portal saved first; `pickable` when that
 * family's row offers Pick a different customer for it, so its confirm step can be reached). Each family by its app id
 * and its name in words, by name. Nothing outside the `listed` state.
 */
export type CustomerAim =
  | { why: "suggested" | "several"; families: { id: AppFamilyId; name: string }[] }
  | { why: "given_up"; families: [{ id: AppFamilyId; name: string }]; pickable: boolean };
export function customerAims(b: LinkBasics, made: readonly MadeAfterGivingUp[]): Map<string, CustomerAim> {
  // `pickable` is chosenFor()'s answer alone: it is null for a Suggested row (whose only customer is its suggestion), the
  // one row that offers no Pick a different customer; a Several possible, No match or Left unlinked row offers it.
  const out = new Map<string, CustomerAim>();
  if (b.state !== "listed") return out;
  const familyOf = new Map(b.families.map((f) => [String(f.id), f]));
  const named = (key: string) => ({ id: familyOf.get(key)!.id, name: recordNameWords(familyOf.get(key)!.name, "family") });
  for (const [customerId, aims] of aimIndex(b)) {
    const families = aims.filter((a) => familyOf.has(a.familyKey)).map((a) => named(a.familyKey)).sort((x, y) => COLLATOR.compare(x.name, y.name));
    if (families.length > 0) out.set(customerId, { why: aims.some((a) => a.how === "suggested") ? "suggested" : "several", families });
  }
  for (const m of made) {
    if (m.role === "student" || m.familyId === null || out.has(m.customerQboId)) continue;
    const key = String(m.familyId);
    if (!familyOf.has(key) || b.linkOfFamily.has(key)) continue;
    out.set(m.customerQboId, { why: "given_up", families: [named(key)], pickable: b.chosenFor(key, m.customerQboId) !== null });
  }
  return out;
}
/**
 * The aims of every customer, read in the caller's transaction or one of its own: readLinkBasics()'s reads (12 or 13)
 * and, in the `listed` state, madeAfterGivingUp()'s (4 to 8), a fixed number whatever the number of customers.
 * Reconciliation shows them, and "Create a family from this" refuses by them under its own roster lock
 * (customerAimedAt(), ./link-writes.ts).
 */
export async function readCustomerAims(tx?: Tx): Promise<Map<string, CustomerAim>> {
  const run = async (t: Tx) => {
    const b = await readLinkBasics(t);
    return b.state !== "listed" ? new Map<string, CustomerAim>() : customerAims(b, await madeAfterGivingUp(t));
  };
  return tx ? run(tx) : db.transaction(run);
}
