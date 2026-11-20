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
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, family, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { asAppFamilyId, QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { clearLeftUnlinked } from "@/lib/families/left-unlinked";
import { recordNameWords } from "@/lib/families/words";
import { isQboId } from "@/lib/quickbooks/client";
import { familyCreateWaiting, NO_FAMILY_CUSTOMER } from "@/lib/roster/writes";
import { isUuid } from "@/lib/seasons/ids";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { readLinkBasics, type LinksState } from "./mapping";
import { pairKeys } from "./proposals";
import { isChosen, linkStampHolds, type Chosen } from "./stamp";

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
      const realmId = b.realm!;
      const now = new Date();
      const aligned = (c: string) => (b.tokenOf.has(c) ? { syncedToken: b.tokenOf.get(c)!, syncedAt: now } : {});
      const [familyLink] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, familyId, origin: "confirmed", linkedBy: o.staffUserId, ...aligned(customerId) })
        .returning({ id: accountingLink.id });
      const studentLinks = proposals.pairs.length === 0 ? [] : await tx.insert(accountingLink).values(proposals.pairs.map((p) =>
        ({ system: QUICKBOOKS, realmId, customerId: p.customerQboId, studentId: p.studentId, origin: "confirmed" as const, linkedBy: o.staffUserId, ...aligned(p.customerQboId) })))
        .returning({ id: accountingLink.id });
      const cleared = await clearLeftUnlinked(tx, familyId);
      await writeAudit({ actor: o.actor, action: "accounting.link.confirm", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
        after: { familyId: familyKey, customerQboId: customerId, realmId, chosen,
          studentsLinked: proposals.pairs.map((p) => ({ studentId: String(p.studentId), customerQboId: p.customerQboId })),
          studentsLeft: proposals.recordsLeft.map((r) => String(r.id)), studentCustomersLeft: proposals.customersLeft.map((c) => c.qboId),
          linkIds: [familyLink!.id, ...studentLinks.map((l) => l.id)], ...(cleared ? { leftUnlinkedCleared: true } : {}) } }, tx);
      // A student's move into this family kept only because it had no customer in the books (NO_FAMILY_CUSTOMER) can be
      // sent now where Reconciliation offers it: only while the cache holds the student's customer active, the rule
      // loadOpenWrites() (src/lib/roster/queue.ts) applies to a kept move before it asks whether the family joined is linked.
      const keptMoves = await tx.select({ studentQboId: sql<string | null>`${writeQueue.request}->>'qboId'` }).from(writeQueue).where(and(eq(writeQueue.state, "refused"),
        eq(writeQueue.lastCode, NO_FAMILY_CUSTOMER), sql`${writeQueue.request}->>'op' = 'move'`, sql`${writeQueue.request}->>'toFamilyId' = ${familyKey}`));
      const sendable = keptMoves.filter((m) => m.studentQboId !== null && b.customerById.get(m.studentQboId)?.active === true).length;
      return { ok: true, message: confirmedWords({ family: recordNameWords(f.name, "family"), customer: b.customerById.get(customerId)?.displayName ?? customerId,
        linked: proposals.pairs.map((p) => p.recordName), recordsLeft: proposals.recordsLeft.map((r) => recordNameWords(r.name, "student")),
        customersLeft: proposals.customersLeft.map((c) => ({ name: c.name, active: c.active })), keptMoves: sendable }) };
    });
  } catch (e) {
    const which = uniqueViolated(e);
    if (which !== null && FAMILY_UQ.has(which)) return no(which === "accounting_link_family_uq" ? LINK_COPY.linkedAlready : LINK_COPY.customerTaken);
    if (which !== null && STUDENT_UQ.has(which)) return no(LINK_COPY.studentTaken);
    throw e;
  }
}

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
  parts.push("Its money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected; its Balances page shows the figures once one of those has read them.");
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

export type { Chosen };
