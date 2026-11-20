// The accounting links screen's presses (stage 4's slice M3a of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "The mapping screen": "For each row an admin with the linking permission can confirm the suggestion, pick a
// different customer ..., or leave it unlinked"): one write that links a family the portal has to a customer the books
// have (Confirm a Suggested row, Confirm a Several possible row's candidate, Pick a different customer), and the Left
// unlinked mark and its undo. A confirm sends nothing to the books (open question 3). It reads every family's
// guardians and every customer of the roster cache to work the suggestion out again, so it is staff code only, never
// imported by a parent page (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
//
// Each press runs in one transaction under the roster lock held exclusively, with the page's roster tag (lockRosterAs()).
// It takes no person's or guardian row's lock: adding, removing and reinstating a guardian take the roster lock shared
// before they change a row (the order above lockedPerson(), src/lib/parents/sessions.ts), and the family's students are
// added, renamed, moved and made inactive under the roster lock too (changeInPortal(), moveStudent(), the queue's
// finish), so holding it exclusively keeps every one of them out while the press reads the guardians, the students and
// the cache and writes the links. Reading the guardians to work the suggestion out again takes no row lock either.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, family, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { asAppFamilyId, QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { clearLeftUnlinked } from "@/lib/families/left-unlinked";
import { recordNameWords } from "@/lib/families/words";
import { isQboId } from "@/lib/quickbooks/client";
import { handful, type AimedAt } from "@/lib/roster/no-family";
import { familyCreateWaiting, NO_FAMILY_CUSTOMER } from "@/lib/roster/writes";
import { isUuid } from "@/lib/seasons/ids";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { BULK_MAX, bulkKeys, readCustomerAims, readLinkBasics, suggestedRowsShown, type LinkBasics, type LinksState } from "./mapping";
import { pairKeys, type Proposals } from "./proposals";
import { isStatusKey, linkStanding, SEARCH_MAX, type StatusKey } from "./status";
import { bulkStampHolds, isChosen, linkStampHolds, reviewStampHolds, type Chosen } from "./stamp";

export type LinkOp = { actor: Actor; ip: string | null; permission: string; staffUserId: string };
export type LinkDone = { ok: true; message: string } | { ok: false; errors: string[] };
const no = (...errors: string[]): LinkDone => ({ ok: false, errors });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const list = (names: readonly string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Shown again as it is now: the last words of every refusal made once the arguments and the page's roster tag have been
 * checked, since the action then shows the screen again. A value that isn't one the page sends (notFromPage) and a
 * roster tag that differs (ROSTER_MOVED) say to reload instead.
 */
const AGAIN = "The row is shown again as it is now.";
/** What staff read when a press doesn't go through. Nothing is ever linked or changed in these cases. */
export const LINK_COPY = {
  notFromPage: "That didn't go through, and nothing was linked or changed. Reload the page and try again.",
  familyGone: `This family isn't an active family in the portal now, so nothing was linked or changed. ${AGAIN}`,
  linkedAlready: `This family is linked to a customer in the books already, so nothing was linked. ${AGAIN}`,
  createWaiting: `Making this family in the books is still waiting on the queue, so nothing was linked or changed. Once it has gone through, or been given up on the Reconciliation page, try again. ${AGAIN}`,
  createSending: `This family is being made in the books at this moment, so nothing was linked or changed. Try again in a minute. ${AGAIN}`,
  customerTaken: `That customer is linked to another family now, so nothing was linked: a customer can be linked to only one family. ${AGAIN}`,
  notInPool: `That customer isn't one the books list as a family with no family in the portal now (it may have been made inactive, put under another customer, given another type, or be about to be linked by a change on Reconciliation), so nothing was linked. ${AGAIN}`,
  rowChanged: `This family's row has changed since the page was drawn (a student added, renamed, made inactive or moved on either side, or what is suggested for it), so nothing was linked. ${AGAIN} Look it over, then press again.`,
  studentTaken: `One of the students would have been linked to a customer or a record that is linked already, so nothing was linked. ${AGAIN}`,
  alreadyLeft: `This family is left unlinked already, so nothing was changed. ${AGAIN}`,
  notLeft: `This family isn't left unlinked now, so nothing was changed. ${AGAIN}`,
  listChanged: "The list has changed since the page was drawn (a family added to or gone from the Suggested rows it shows, a suggestion changed, or a student added, renamed, made inactive or moved on either side), so nothing was linked. It is shown again as it is now, with the new count: look it over, then press again.",
  reviewChanged: `This family's link has changed since the page was drawn (it is no longer carried over to the same customer, or one of its students' links was added, removed or changed), so nothing was confirmed. ${AGAIN} Look it over, then press again.`,
  reviewNotStanding: `The customer this family is linked to isn't a family at the top of the books now, or isn't in the books' copy at all, so the link wasn't confirmed. ${AGAIN}`,
  no_company: `The portal hasn't read the club's books yet, so nothing was linked. ${AGAIN}`,
  other_company: `QuickBooks is connected to a different company than the one the roster was read from, so nothing was linked. An Admin can see why under Settings, QuickBooks. ${AGAIN}`,
  no_shape: `The membership shape isn't chosen, or names a customer type the books no longer have, so the portal can't tell which customers are families. Nothing was linked. An Admin can choose it under Settings, QuickBooks. ${AGAIN}`,
} as const satisfies Record<string, string> & Record<Exclude<LinksState, "listed">, string>;

/** The unique indexes a confirm may meet, the last line against a wrong link: a family's, and a student's. */
const FAMILY_UQ = new Set(["accounting_link_family_customer_uq", "accounting_link_family_uq"]);
const STUDENT_UQ = new Set(["accounting_link_student_customer_uq", "accounting_link_student_uq"]);
/** The constraint a unique violation names, anywhere in the causes (drizzle wraps the database's error); null for none. */
const uniqueViolated = (e: unknown): string | null => {
  if (typeof e !== "object" || e === null) return null;
  const pg = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
  if (pg.code === "23505") return typeof pg.constraint_name === "string" ? pg.constraint_name : "";
  return uniqueViolated(pg.cause);
};

/** The family record, locked, and whether it may be linked or marked: active, with no family link of any company, its own create neither queued nor being made. */
async function familyToLink(tx: Tx, familyId: AppFamilyId): Promise<{ ok: true; name: string | null; leftAt: Date | null; leftBy: string | null } | { ok: false; error: string }> {
  const [f] = await tx.select({ name: family.name, active: family.active, leftAt: family.accountingLeftUnlinkedAt, leftBy: family.accountingLeftUnlinkedBy })
    .from(family).where(eq(family.id, familyId)).for("update");
  if (!f || !f.active) return { ok: false, error: LINK_COPY.familyGone };
  const [linked] = await tx.select({ id: accountingLink.id }).from(accountingLink).where(eq(accountingLink.familyId, familyId)).limit(1);
  if (linked) return { ok: false, error: LINK_COPY.linkedAlready };
  const making = await familyCreateWaiting(tx, familyId);
  if (making !== null) return { ok: false, error: making === "queued" ? LINK_COPY.createWaiting : LINK_COPY.createSending };
  return { ok: true, name: f.name, leftAt: f.leftAt, leftBy: f.leftBy };
}

/**
 * The one write of a family's link (slices M3a and M3a2), in the caller's transaction, which holds the roster lock
 * exclusively and has checked the family (familyToLink()), the customer and the pairs against reads made in it (`b`):
 * the family's link (`confirmed`, by the staff member, aligned with the cache row's version) and one student link for
 * each pair proposed, the same way, the family's Left unlinked mark cleared, and one `accounting.link.confirm` row
 * (`extra` added to its body: a bulk press's id). A single Confirm and each family of a bulk press go through it, so a
 * bulk link is exactly a single one. Returns the links made and how many of the kept moves into the family can be sent
 * now.
 */
async function linkIn(tx: Tx, b: LinkBasics, familyId: AppFamilyId, customerId: string, chosen: Chosen, proposals: Proposals, o: LinkOp,
  extra: Record<string, unknown> = {}): Promise<{ linkIds: string[]; keptMoves: number }> {
  const familyKey = String(familyId);
  const realmId = b.realm!;
  const now = new Date();
  const aligned = (c: string) => (b.tokenOf.has(c) ? { syncedToken: b.tokenOf.get(c)!, syncedAt: now } : {});
  const [familyLink] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, familyId, origin: "confirmed", linkedBy: o.staffUserId, ...aligned(customerId) })
    .returning({ id: accountingLink.id });
  const studentLinks = proposals.pairs.length === 0 ? [] : await tx.insert(accountingLink).values(proposals.pairs.map((p) =>
    ({ system: QUICKBOOKS, realmId, customerId: p.customerQboId, studentId: p.studentId, origin: "confirmed" as const, linkedBy: o.staffUserId, ...aligned(p.customerQboId) })))
    .returning({ id: accountingLink.id });
  const cleared = await clearLeftUnlinked(tx, familyId);
  const linkIds = [familyLink!.id, ...studentLinks.map((l) => l.id)];
  await writeAudit({ actor: o.actor, action: "accounting.link.confirm", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
    after: { familyId: familyKey, customerQboId: customerId, realmId, chosen,
      studentsLinked: proposals.pairs.map((p) => ({ studentId: String(p.studentId), customerQboId: p.customerQboId })),
      studentsLeft: proposals.recordsLeft.map((r) => String(r.id)), studentCustomersLeft: proposals.customersLeft.map((c) => c.qboId),
      linkIds, ...(cleared ? { leftUnlinkedCleared: true } : {}), ...extra } }, tx);
  // A student's move into this family kept only because it had no customer in the books (NO_FAMILY_CUSTOMER) can be
  // sent now where Reconciliation offers it: only while the cache holds the student's customer active, the rule
  // loadOpenWrites() (src/lib/roster/queue.ts) applies to a kept move before it asks whether the family joined is linked.
  const kept = await tx.select({ studentQboId: sql<string | null>`${writeQueue.request}->>'qboId'` }).from(writeQueue).where(and(eq(writeQueue.state, "refused"),
    eq(writeQueue.lastCode, NO_FAMILY_CUSTOMER), sql`${writeQueue.request}->>'op' = 'move'`, sql`${writeQueue.request}->>'toFamilyId' = ${familyKey}`));
  const keptMoves = kept.filter((m) => m.studentQboId !== null && b.customerById.get(m.studentQboId)?.active === true).length;
  return { linkIds, keptMoves };
}

/**
 * Links a family the portal has to a customer the books have: Confirm on a Suggested row (`suggested`), Confirm on one
 * of a Several possible row's candidates (`several`), or Pick a different customer from the customers no family is
 * linked to (`picked`). Sends nothing (open question 3). In one transaction, under the roster lock held exclusively with
 * the page's tag, from reads made in it: the state `listed`; the family record active (locked), with no family link of
 * any company and its own create neither waiting, stuck nor being made (familyCreateWaiting()); the customer still in
 * the pool (noFamilyPool(), as Reconciliation lists it); the way it was chosen still what the row offers it as
 * (`suggested`: the row's suggestion; `several`: one of its candidates; `picked`: any other customer of the pool, for a
 * Several possible, No match or Left unlinked row); and the students the press would link with it (./proposals.ts),
 * worked out again, sealing to the page's stamp. Then the family's link (`confirmed`, by the staff member, aligned
 * with the cache row's version) and one student link for each pair proposed, the same way, and the family's Left
 * unlinked mark cleared; nothing else: no record made, renamed or made active or inactive, no student moved, no guardian
 * row or guardian link touched, nothing written to the roster cache, the money cache or the write queue. The unique
 * indexes are the last line, answered in words, keeping nothing. One `accounting.link.confirm` row in the transaction.
 */
export async function linkFamilyToCustomer(raw: { familyId: unknown; customerId: unknown; chosen: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  const { familyId: rawFamily, customerId, chosen, stamp } = raw;
  if (!isUuid(rawFamily) || typeof customerId !== "string" || !isQboId(customerId) || !isChosen(chosen) || typeof stamp !== "string") return no(LINK_COPY.notFromPage);
  const familyKey = rawFamily.toLowerCase();
  const familyId = asAppFamilyId(familyKey);
  try {
    return await db.transaction(async (tx): Promise<LinkDone> => {
      if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
      const f = await familyToLink(tx, familyId);
      if (!f.ok) return no(f.error);
      const b = await readLinkBasics(tx);
      if (b.state !== "listed") return no(LINK_COPY[b.state]);
      if (!b.poolIds.has(customerId)) return no(b.familyOfCustomer.has(customerId) ? LINK_COPY.customerTaken : LINK_COPY.notInPool);
      if (b.chosenFor(familyKey, customerId) !== chosen) return no(LINK_COPY.rowChanged);
      const proposals = b.proposalsFor(familyKey, customerId);
      if (!linkStampHolds(familyKey, customerId, chosen, pairKeys(proposals), stamp)) return no(LINK_COPY.rowChanged);
      const { keptMoves } = await linkIn(tx, b, familyId, customerId, chosen, proposals, o);
      return { ok: true, message: confirmedWords({ family: recordNameWords(f.name, "family"), customer: b.customerById.get(customerId)?.displayName ?? customerId,
        linked: proposals.pairs.map((p) => p.recordName), recordsLeft: proposals.recordsLeft.map((r) => recordNameWords(r.name, "student")),
        customersLeft: proposals.customersLeft.map((c) => ({ name: c.name, active: c.active })), keptMoves }) };
    });
  } catch (e) {
    const which = uniqueViolated(e);
    if (which !== null && FAMILY_UQ.has(which)) return no(which === "accounting_link_family_uq" ? LINK_COPY.linkedAlready : LINK_COPY.customerTaken);
    if (which !== null && STUDENT_UQ.has(which)) return no(LINK_COPY.studentTaken);
    throw e;
  }
}

/** When a linked family's money is read from the books, said after a confirm. */
const MONEY_WORDS = "Its money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected; its Balances page shows the figures once one of those has read them.";

/**
 * What staff read after a confirm, each sentence true by the code: the link, the students linked and those left (shown
 * on the screen with the family's row afterwards: a record left and an active student customer left as differences, an
 * inactive student customer left only counted, differencesOf() in ./differences.ts), that nothing was sent, when its
 * money is read from the books (loadFamilyMoney() finds the link at the next load of a parent's Home or Payments, and
 * the money run reads it when staff ask for it on Balances or daily, while the books are connected; the Balances pages
 * read nothing live, only the row one of those stored), that its guardians' own records in the books aren't linked by
 * it, and a kept move into it that Reconciliation now offers to send.
 */
export function confirmedWords(s: { family: string; customer: string; linked: string[]; recordsLeft: string[]; customersLeft: { name: string; active: boolean }[]; keptMoves: number }): string {
  const parts = [`${s.family} is linked to “${s.customer}” in the books.`];
  parts.push(s.linked.length ? `${plural(s.linked.length, "student", "students")} linked with it: ${list(s.linked)}.` : "No student was linked with it.");
  if (s.recordsLeft.length) parts.push(`Left with no link: ${list(s.recordsLeft)}, of the portal's students.`);
  if (s.customersLeft.length) parts.push(`Left with no record in the portal: ${list(s.customersLeft.map((c) => (c.active ? c.name : `${c.name} (inactive in the books)`)))}, of the student customers under it in the books.`);
  // A record left and an active student customer left are differences; an inactive student customer left is only counted (differencesOf()).
  const differing = s.recordsLeft.length + s.customersLeft.filter((c) => c.active).length;
  const inactive = s.customersLeft.length - s.customersLeft.filter((c) => c.active).length;
  if (differing > 0) parts.push(inactive === 0 ? "Whoever was left shows with the family's row on this page, among its differences."
    : "Whoever was left shows with the family's row on this page: an inactive student customer in the books in a count there, everyone else among its differences.");
  else if (inactive > 0) parts.push(inactive === 1 ? "That inactive student customer is counted with the family's row on this page, not listed among its differences."
    : "Those inactive student customers are counted with the family's row on this page, not listed among its differences.");
  parts.push("Nothing was sent to the books.");
  parts.push(MONEY_WORDS);
  parts.push("Its guardians' own records in the books aren't linked by this.");
  if (s.keptMoves > 0) parts.push(s.keptMoves === 1 ? "A student's move into this family, kept on Reconciliation only because the family had no customer in the books, can now be sent from there."
    : `${s.keptMoves} students' moves into this family, kept on Reconciliation only because the family had no customer in the books, can now be sent from there.`);
  return parts.join(" ");
}

/**
 * Leave unlinked: marks an active family with no family link, whose own create isn't waiting, stuck or being made, as
 * left unlinked (`family.accounting_left_unlinked_at` and `_by`), under the roster lock held exclusively with the page's
 * tag (a suggestion is worked out from every unlinked family at once, so the mark changes others' too). The screen then
 * gives it to no matcher. Audited (`accounting.link.leave_unlinked`, before and after) in the transaction.
 */
export async function leaveUnlinked(rawFamily: unknown, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  if (!isUuid(rawFamily)) return no(LINK_COPY.notFromPage);
  const familyKey = rawFamily.toLowerCase();
  const familyId = asAppFamilyId(familyKey);
  return db.transaction(async (tx): Promise<LinkDone> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const f = await familyToLink(tx, familyId);
    if (!f.ok) return no(f.error);
    if (f.leftAt !== null) return no(LINK_COPY.alreadyLeft);
    const at = new Date();
    await tx.update(family).set({ accountingLeftUnlinkedAt: at, accountingLeftUnlinkedBy: o.staffUserId, updatedAt: at }).where(eq(family.id, familyId));
    await writeAudit({ actor: o.actor, action: "accounting.link.leave_unlinked", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
      before: { familyId: familyKey, leftUnlinkedAt: null, leftUnlinkedBy: null }, after: { familyId: familyKey, leftUnlinkedAt: at.toISOString(), leftUnlinkedBy: o.staffUserId } }, tx);
    return { ok: true, message: `${recordNameWords(f.name, "family")} is left unlinked: this page suggests no customer for it, and it takes no part in another family's suggestion, until someone undoes it or links it. Nothing was sent to the books.` };
  });
}

/** Undo: takes a family's Left unlinked mark off, under the same lock. Audited (`accounting.link.leave_unlinked.undo`, before and after). */
export async function undoLeaveUnlinked(rawFamily: unknown, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  if (!isUuid(rawFamily)) return no(LINK_COPY.notFromPage);
  const familyKey = rawFamily.toLowerCase();
  const familyId = asAppFamilyId(familyKey);
  return db.transaction(async (tx): Promise<LinkDone> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [f] = await tx.select({ name: family.name, leftAt: family.accountingLeftUnlinkedAt, leftBy: family.accountingLeftUnlinkedBy }).from(family).where(eq(family.id, familyId)).for("update");
    if (!f) return no(LINK_COPY.familyGone);
    if (f.leftAt === null) return no(LINK_COPY.notLeft);
    await tx.update(family).set({ accountingLeftUnlinkedAt: null, accountingLeftUnlinkedBy: null, updatedAt: new Date() }).where(eq(family.id, familyId));
    await writeAudit({ actor: o.actor, action: "accounting.link.leave_unlinked.undo", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
      before: { familyId: familyKey, leftUnlinkedAt: f.leftAt.toISOString(), leftUnlinkedBy: f.leftBy }, after: { familyId: familyKey, leftUnlinkedAt: null, leftUnlinkedBy: null } }, tx);
    return { ok: true, message: `${recordNameWords(f.name, "family")} is no longer left unlinked: this page suggests a customer for it again where one matches.` };
  });
}

/** A bulk press found the list changed after it had begun writing: thrown, so its transaction keeps nothing. */
class ListChanged extends Error {}

/**
 * Confirm all exact email matches (stage 4's slice M3a2; section 4, "bulk confirm"; the lead's decisions 2 to 4): links
 * every Suggested row the page's filter showed, each to the customer filled in on its row, with the students its row
 * proposed, exactly as that row's Confirm would (linkIn()). Nothing about the rows is taken from the browser: the press
 * sends the filter as the page parsed it, how many rows it showed and the stamp sealing them (bulkStamp()), and in one
 * transaction, under the roster lock held exclusively with the page's tag, the rows are worked out again from reads
 * made in it (suggestedRowsShown(), the page's own rule) and must be as many, at most BULK_MAX, and seal to the same
 * stamp. Then, for each row in the roster's order, the single press's checks (the family locked, active, unlinked, its
 * create neither waiting nor being made; the customer in the pool; the row still `suggested`) and the links. All or
 * nothing: any change refuses the whole press in one set of words (LINK_COPY.listChanged), keeping nothing; the unique
 * indexes are the last line, answered the same way. One `accounting.link.confirm` row per family (with `bulk`, the
 * press's id) and one `accounting.link.bulk` row, in the transaction. Sends nothing to the books.
 */
export async function confirmAllSuggested(raw: { status: unknown; q: unknown; count: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  const { status: rawStatus, q, count, stamp } = raw;
  if (!(rawStatus === "" || isStatusKey(rawStatus)) || typeof q !== "string" || q.length > SEARCH_MAX || typeof count !== "number" || !Number.isInteger(count)
    || count < 1 || typeof stamp !== "string") return no(LINK_COPY.notFromPage);
  // More than a press may link (the page offers no button then): refused as a list that isn't the one a press can take.
  if (count > BULK_MAX) return no(LINK_COPY.listChanged);
  const filter = { status: rawStatus === "" ? null : (rawStatus as StatusKey), q };
  try {
    return await db.transaction(async (tx): Promise<LinkDone> => {
      if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
      const b = await readLinkBasics(tx);
      if (b.state !== "listed") return no(LINK_COPY[b.state]);
      const rows = suggestedRowsShown(b, filter);
      if (rows.length !== count || rows.length > BULK_MAX || !bulkStampHolds(filter, count, bulkKeys(rows), stamp)) return no(LINK_COPY.listChanged);
      const pressId = randomUUID();
      const linked: { name: string; pairs: number; recordsLeft: number; customersLeft: { active: boolean }[]; keptMoves: number }[] = [];
      for (const r of rows) {
        const f = await familyToLink(tx, r.familyId);
        if (!f.ok || !b.poolIds.has(r.customerId) || b.chosenFor(r.familyKey, r.customerId) !== "suggested") throw new ListChanged();
        const proposals = b.proposalsFor(r.familyKey, r.customerId);
        const { keptMoves } = await linkIn(tx, b, r.familyId, r.customerId, "suggested", proposals, o, { bulk: pressId });
        linked.push({ name: r.name, pairs: proposals.pairs.length, recordsLeft: proposals.recordsLeft.length, customersLeft: proposals.customersLeft, keptMoves });
      }
      await writeAudit({ actor: o.actor, action: "accounting.link.bulk", permission: o.permission, ip: o.ip, targetType: "accounting_link", targetId: pressId,
        after: { pressId, count: rows.length, familyIds: rows.map((r) => r.familyKey), realmId: b.realm, status: filter.status, searched: filter.q !== "" } }, tx);
      return { ok: true, message: bulkConfirmedWords({ families: linked.map((l) => l.name), students: linked.reduce((n, l) => n + l.pairs, 0),
        recordsLeft: linked.reduce((n, l) => n + l.recordsLeft, 0), activeCustomersLeft: linked.reduce((n, l) => n + l.customersLeft.filter((c) => c.active).length, 0),
        inactiveCustomersLeft: linked.reduce((n, l) => n + l.customersLeft.filter((c) => !c.active).length, 0), keptMoves: linked.reduce((n, l) => n + l.keptMoves, 0) }) };
    });
  } catch (e) {
    if (e instanceof ListChanged) return no(LINK_COPY.listChanged);
    const which = uniqueViolated(e);
    if (which !== null && (FAMILY_UQ.has(which) || STUDENT_UQ.has(which))) return no(LINK_COPY.listChanged);
    throw e;
  }
}

/**
 * What staff read after a bulk press, each sentence true by the code: how many families were linked, each to the
 * customer filled in on its row (named up to a handful), how many students in all; where whoever was left shows (the
 * rule of confirmedWords()); that nothing was sent; when the money is read; that the guardians' own records aren't
 * linked; and the kept moves into those families now sendable, counted over all of them.
 */
export function bulkConfirmedWords(s: { families: string[]; students: number; recordsLeft: number; activeCustomersLeft: number; inactiveCustomersLeft: number; keptMoves: number }): string {
  const n = s.families.length;
  const parts = [n === 1 ? `1 family linked, to the customer that was filled in on its row: ${handful(s.families)}.`
    : `${n} families linked, each to the customer that was filled in on its row: ${handful(s.families)}.`];
  parts.push(s.students === 0 ? `No student was linked with ${n === 1 ? "it" : "them"}.` : `${plural(s.students, "student", "students")} linked with ${n === 1 ? "it" : "them"} in all.`);
  const differing = s.recordsLeft + s.activeCustomersLeft;
  if (differing > 0) parts.push(s.inactiveCustomersLeft === 0 ? "Whoever was left on either side shows with each family's row on this page, among its differences."
    : "Whoever was left on either side shows with each family's row on this page: an inactive student customer in the books in a count there, everyone else among its differences.");
  else if (s.inactiveCustomersLeft > 0) parts.push(s.inactiveCustomersLeft === 1 ? "The inactive student customer left in the books is counted with its family's row on this page, not listed among its differences."
    : "The inactive student customers left in the books are counted with their families' rows on this page, not listed among their differences.");
  parts.push("Nothing was sent to the books.");
  parts.push(n === 1 ? MONEY_WORDS : "Each family's money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected; its Balances page shows the figures once one of those has read them.");
  parts.push(n === 1 ? "Its guardians' own records in the books aren't linked by this." : "Their guardians' own records in the books aren't linked by this.");
  if (s.keptMoves > 0) parts.push(s.keptMoves === 1 ? "A student's move into one of these families, kept on Reconciliation only because the family had no customer in the books, can now be sent from there."
    : `${s.keptMoves} students' moves into these families, kept on Reconciliation only because the families had no customer in the books, can now be sent from there.`);
  return parts.join(" ");
}

/**
 * Confirm this link, for a carried-over link (stage 4's slice M3a2; open question 2, "carried-over links ... with their
 * own status and filter so an admin can review them"; the lead's choice 7): records that a staff member has checked a
 * link the portal carried over from the roster. In one transaction under the roster lock held exclusively with the
 * page's tag, from reads made in it: the family active (locked); its family link of the records' company (locked)
 * still the one the page showed and still `carried_over`; the state `listed`; the customer standing (linkStanding():
 * Customer gone and Not a family now are slice M3b's); the student links it confirms worked out again (reviewOf():
 * each carried-over student link of the family's active records to a customer the roster lists directly under the
 * family's customer) and sealing to the page's stamp. Then the family link and those student links become `confirmed`,
 * by the staff member, at the press's time (`linked_at`), with `synced_token` and `synced_at` as they were: a review
 * aligns nothing. Every other carried-over student link is left as it is, and said. No guardian link is touched (slice
 * M3c's), nothing is sent to the books. One `accounting.link.confirm` row (`chosen: "reviewed"`), whose `before` keeps
 * that the links were carried over.
 */
export async function reviewCarriedOver(raw: { familyId: unknown; linkId: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  const { familyId: rawFamily, linkId: rawLink, stamp } = raw;
  if (!isUuid(rawFamily) || !isUuid(rawLink) || typeof stamp !== "string") return no(LINK_COPY.notFromPage);
  const familyKey = rawFamily.toLowerCase(), linkKey = rawLink.toLowerCase();
  const familyId = asAppFamilyId(familyKey);
  return db.transaction(async (tx): Promise<LinkDone> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [f] = await tx.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, familyId)).for("update");
    if (!f || !f.active) return no(LINK_COPY.familyGone);
    const b = await readLinkBasics(tx);
    if (b.state !== "listed") return no(LINK_COPY[b.state]);
    const [link] = await tx.select().from(accountingLink).where(and(eq(accountingLink.familyId, familyId), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, b.realm!))).for("update");
    if (!link || link.id !== linkKey || link.origin !== "carried_over") return no(LINK_COPY.reviewChanged);
    if (linkStanding(b.customerById.get(link.customerId), { cacheHasCustomers: b.customers.length > 0, listedAsFamily: b.listedAsFamily }).is !== "stands") return no(LINK_COPY.reviewNotStanding);
    const offer = b.reviewOf(familyKey);
    if (offer === null || offer.linkId !== link.id || !reviewStampHolds(familyKey, link.id, link.customerId, offer.confirms.map((c) => c.linkId), stamp)) return no(LINK_COPY.reviewChanged);
    const studentIds = offer.confirms.map((c) => c.linkId);
    const students = studentIds.length === 0 ? [] : await tx.select().from(accountingLink).where(inArray(accountingLink.id, studentIds)).for("update");
    if (students.length !== studentIds.length || students.some((s) => s.origin !== "carried_over")) return no(LINK_COPY.reviewChanged);
    const now = new Date();
    await tx.update(accountingLink).set({ origin: "confirmed", linkedBy: o.staffUserId, linkedAt: now, updatedAt: now }).where(inArray(accountingLink.id, [link.id, ...studentIds]));
    const was = (l: typeof link) => ({ id: l.id, origin: l.origin, linkedAt: l.linkedAt.toISOString(), linkedBy: l.linkedBy });
    const studentOf = (l: typeof link) => ({ ...was(l), studentId: String(l.studentId), customerQboId: l.customerId });
    await writeAudit({ actor: o.actor, action: "accounting.link.confirm", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
      before: { familyId: familyKey, customerQboId: link.customerId, realmId: link.realmId, link: was(link), studentLinks: students.map(studentOf) },
      after: { familyId: familyKey, customerQboId: link.customerId, realmId: link.realmId, chosen: "reviewed",
        link: { id: link.id, origin: "confirmed", linkedAt: now.toISOString(), linkedBy: o.staffUserId },
        studentLinks: students.map((s) => ({ id: s.id, origin: "confirmed", linkedAt: now.toISOString(), linkedBy: o.staffUserId, studentId: String(s.studentId), customerQboId: s.customerId })),
        studentLinksLeft: offer.leaves.map((l) => l.linkId) } }, tx);
    return { ok: true, message: reviewedWords({ family: recordNameWords(f.name, "family"), customer: b.customerById.get(link.customerId)?.displayName ?? link.customerId,
      confirmed: offer.confirms.map((c) => c.name), left: offer.leaves.map((l) => ({ name: l.name, why: l.why })) }) };
  });
}

/** What staff read after Confirm this link, each sentence true by the code. */
export function reviewedWords(s: { family: string; customer: string; confirmed: string[]; left: { name: string; why: "inactive" | "elsewhere" }[] }): string {
  const parts = [`${s.family}'s link to “${s.customer}” in the books is confirmed: it is recorded as checked by you, and no longer as carried over.`];
  if (s.confirmed.length) parts.push(`Confirmed with it, as ${s.confirmed.length === 1 ? "its student's link" : "its students' links"}: ${list(s.confirmed)}.`);
  if (s.left.length) parts.push(`Left carried over: ${list(s.left.map((l) => `${l.name} (${l.why === "inactive" ? "inactive in the portal" : "under another customer in the books"})`))}.`);
  parts.push("Nothing was sent to the books.");
  return parts.join(" ");
}

/**
 * Which family a customer no family is linked to is meant for, for "Create a family from this" (slice M3a2: it refuses
 * one the accounting links screen aims at): read in that press's transaction, after its own exclusive roster lock, by
 * the screen's own rule (readCustomerAims(): a Suggested row's suggestion, a Several possible row's candidate, or a
 * customer a given-up create of an active family with no family link made). Passed to familyFromCustomer() by its
 * action, so src/lib/roster/no-family.ts never imports this screen's modules (which import it).
 */
export async function customerAimedAt(tx: Tx, customerId: string): Promise<AimedAt | null> {
  const aim = (await readCustomerAims(tx)).get(customerId);
  if (aim === undefined) return null;
  return { why: aim.why, families: aim.families.map((f) => f.name) };
}

export type { Chosen };
