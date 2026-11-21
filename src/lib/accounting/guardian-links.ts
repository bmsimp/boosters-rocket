// The accounting links screen's guardian presses (stage 4's slice M3c of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 3: "A link ties a family to its accounting customer and, where the books have them ..., each student and
// parent to their own record under it. Each link records ... who confirmed it and when"; section 4: "It opens to show
// the students and guardians and their own links", "Every link, unlink, import and alignment is audited"): Link this
// guardian, which ties one open guardian row of a linked family to an existing Parent customer directly under the
// family's customer, and Unlink this guardian, which ends one open row's link alone. Neither sends anything to the
// books (open question 3), queues anything, or changes a guardian row. They read every family's guardians and every
// customer of the roster cache to work the row's offer out again, so this is staff code only, never imported by a
// parent page (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
//
// Each press runs in one transaction under the roster lock held exclusively, with the page's roster tag (lockRosterAs()),
// as the family presses do (./link-writes.ts): adding, removing and reinstating a guardian and renaming a person whose
// rows may send take the roster lock shared before they change a row or queue a change, and every link write holds it
// exclusively, so none of them runs while a press reads and writes. No guardian row or person is locked: the row is read
// under the roster lock, which keeps out everyone who changes it. The row's and its family's "being sent" locks are only
// tried, shared, never waited for (recordSendingFree(), familySendingFree()): a send holds the row's lock and then waits
// for the roster lock (whileGuardiansHeld(), then applyWritten()), so waiting for it here, under the roster lock, would
// make a cycle. A parent's save of their phone, address or sign-in email takes no roster lock: it reads the row's link
// as it stands when it saves (guardianLinksOf(), src/lib/parents/contact-queue.ts), before or after a press commits.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, writeQueue } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { asAppFamilyId, QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { isQboId } from "@/lib/quickbooks/client";
import { blocksOthers, familySendingFree, guardianCustomerLinked, recordSendingFree } from "@/lib/roster/writes";
import { isUuid } from "@/lib/seasons/ids";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { LINK_COPY, type LinkDone, type LinkOp } from "./link-writes";
import { readLinkBasics } from "./mapping";
import { guardianLinkStampHolds, guardianUnlinkStampHolds, isGuardianChosen } from "./stamp";

/** A press's answer, and on success the guardian's family (for the action to show its page again; never sent to the browser). */
export type GuardianLinkDone = LinkDone | { ok: true; message: string; familyId: AppFamilyId };
const no = (...errors: string[]): LinkDone => ({ ok: false, errors });
/** A queue item that holds a guardian press back: waiting, stuck, or kept (`refused`). */
const OPEN_ITEM = ["waiting", "stuck", "refused"] as const;

/** The last words of every refusal made once the arguments and the roster tag have been checked, as LINK_COPY's: the action shows the screen again. */
const AGAIN = "The row is shown again as it is now.";
/**
 * What staff read when a guardian press doesn't go through. Nothing is ever linked, ended or changed in these cases, and
 * none says more than the row's opening shows.
 */
export const GUARDIAN_LINK_COPY = {
  rowGone: `This guardian isn't an open guardian of an active family in the portal now, so nothing was linked or changed. ${AGAIN}`,
  noParentType: `The membership shape has no parent type now, so the books have no Parent customer to link a guardian to. Nothing was linked. ${AGAIN}`,
  familyNotLinked: `This guardian's family isn't linked to a customer in the books now, so nothing was linked. Link the family first. ${AGAIN}`,
  familyNotStanding: `The customer this guardian's family is linked to isn't a family at the top of the books now, or isn't in the books' copy at all, so nothing was linked. ${AGAIN}`,
  linkedAlready: `This guardian is linked to a customer in the books already, so nothing was linked. ${AGAIN}`,
  notOffered: `That customer isn't one this guardian can be linked to now (it may have been linked to another guardian, made inactive, moved or given another type in the books), so nothing was linked. ${AGAIN}`,
  rowChanged: `This guardian's row has changed since the page was drawn (the family's link, or what is filled in for the guardian), so nothing was linked. ${AGAIN} Look it over, then press again.`,
  rowWaiting: (n: number) => `${n === 1 ? "A change" : `${n} changes`} for this guardian ${n === 1 ? "is" : "are"} waiting, stuck or kept on the Reconciliation page, so nothing was linked: ${n === 1 ? "it was" : "they were"} asked before the link, for another customer or none. Once ${n === 1 ? "it has" : "they have"} gone through, or been given up there, try again. ${AGAIN}`,
  customerWaiting: (n: number) => `${n === 1 ? "A change" : `${n} changes`} to that Parent customer ${n === 1 ? "is" : "are"} waiting, stuck or kept on the Reconciliation page, so nothing was linked. Once ${n === 1 ? "it has" : "they have"} gone through, or been given up there, try again. ${AGAIN}`,
  busy: `This guardian or their family is being changed in the books at this moment, so nothing was linked or changed. Try again in a minute. ${AGAIN}`,
  notLinkedNow: `This guardian isn't linked to a customer in the books now, so nothing was unlinked. ${AGAIN}`,
  unlinkChanged: `This guardian's link has changed since the page was drawn, so nothing was unlinked. ${AGAIN} Look it over, then press again.`,
  unlinkWaiting: (n: number) => `${n === 1 ? "A change" : `${n} changes`} for this guardian or their Parent customer ${n === 1 ? "is" : "are"} waiting, stuck or kept on the Reconciliation page, so nothing was unlinked. Once ${n === 1 ? "it has" : "they have"} gone through, or been given up there, try again. ${AGAIN}`,
  unlinkBusy: `This guardian or their family is being changed in the books at this moment, so nothing was unlinked. Try again in a minute. ${AGAIN}`,
} as const;

/** The constraint a unique violation names, anywhere in the causes (drizzle wraps the database's error); null for none. */
const uniqueViolated = (e: unknown): string | null => {
  if (typeof e !== "object" || e === null) return null;
  const pg = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
  if (pg.code === "23505") return typeof pg.constraint_name === "string" ? pg.constraint_name : "";
  return uniqueViolated(pg.cause);
};

/**
 * Link this guardian: ties an open guardian row to an existing Parent customer under its family's customer in the books
 * (the lead's decision 2). Sends nothing (open question 3). In one transaction, under the roster lock held exclusively
 * with the page's tag, from reads made in it (readLinkBasics(tx)): the state `listed`; layered books with a parent type;
 * the row open (its person blocked or not: a link is the books' side, not a sign-in) in an active family record whose
 * family link of the records' company stands; the row with no guardian link of that company; the customer one the row
 * is offered now (guardianOfferOf(): active, of the parent type, directly under the family's customer, with no guardian
 * row of the company, open or closed, linked to it, guardianCustomerLinked() read again too, and no student or
 * family link naming it); `chosen` what the row offers it as; the stamp holding (guardianLinkStamp()). Then refused, keeping nothing: any
 * queue item naming the row, of any op (a parent's change of their details among them), waiting, stuck or kept, so no
 * change asked before the link is sent to a customer it wasn't asked for (the lead's decision 5); any change that blocks
 * others waiting, stuck or kept that targets the customer; the row's or the family's "being sent" lock held. Then one
 * `accounting_link` row (`confirmed`, by the staff member, aligned with the cache row's version as a family's link is)
 * and one `accounting.link.guardian` row. Nothing else: no guardian row column, queue item or cache row changed. The
 * unique index is the last line, answered in words, keeping nothing.
 */
export async function linkGuardian(raw: { guardianId: unknown; customerId: unknown; chosen: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<GuardianLinkDone> {
  const { guardianId: rawRow, customerId, chosen, stamp } = raw;
  if (!isUuid(rawRow) || typeof customerId !== "string" || !isQboId(customerId) || !isGuardianChosen(chosen) || typeof stamp !== "string") return no(LINK_COPY.notFromPage);
  const rowKey = rawRow.toLowerCase();
  try {
    return await db.transaction(async (tx): Promise<GuardianLinkDone> => {
      if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
      const b = await readLinkBasics(tx);
      if (b.state !== "listed") return no(LINK_COPY[b.state]);
      if (b.shape === null || b.shape.kind !== "layered" || b.shape.parentTypeId === null) return no(GUARDIAN_LINK_COPY.noParentType);
      const row = b.guardianById.get(rowKey);
      if (row === undefined || row.status === "disabled" || row.familyId === null || !b.families.some((f) => String(f.id) === String(row.familyId))) return no(GUARDIAN_LINK_COPY.rowGone);
      const familyKey = String(row.familyId);
      if (!b.linkOfFamily.has(familyKey)) return no(GUARDIAN_LINK_COPY.familyNotLinked);
      const books = b.guardianBooksOf(familyKey);
      if (books === null) return no(GUARDIAN_LINK_COPY.familyNotStanding);
      if (b.linkOfGuardian.has(row.id)) return no(GUARDIAN_LINK_COPY.linkedAlready);
      const offered = b.guardianOfferOf(row.id);
      const offer = offered !== null && "offer" in offered ? offered.offer : null;
      if (offer === null || !offer.candidates.some((c) => c.qboId === customerId)) return no(GUARDIAN_LINK_COPY.notOffered);
      if ((offer.suggested === customerId ? "suggested" : "picked") !== chosen) return no(GUARDIAN_LINK_COPY.rowChanged);
      if (!guardianLinkStampHolds(row.id, books.familyLink.id, customerId, chosen, stamp)) return no(GUARDIAN_LINK_COPY.rowChanged);
      const realmId = b.realm!;
      if (await guardianCustomerLinked(tx, realmId, customerId, row.id)) return no(GUARDIAN_LINK_COPY.notOffered);

      const open = inArray(writeQueue.state, [...OPEN_ITEM]);
      const ofRow = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(open, sql`${writeQueue.request}->>'guardianId' = ${row.id}`));
      if (ofRow.length > 0) return no(GUARDIAN_LINK_COPY.rowWaiting(ofRow.length));
      const ofCustomer = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(open, blocksOthers, eq(writeQueue.targetQboId, customerId)));
      if (ofCustomer.length > 0) return no(GUARDIAN_LINK_COPY.customerWaiting(ofCustomer.length));
      if (!(await recordSendingFree(tx, row.id)) || !(await familySendingFree(tx, asAppFamilyId(familyKey)))) return no(GUARDIAN_LINK_COPY.busy);

      const token = b.tokenOf.get(customerId);
      const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, guardianId: row.id, origin: "confirmed", linkedBy: o.staffUserId,
        ...(token !== undefined ? { syncedToken: token, syncedAt: new Date() } : {}) }).returning({ id: accountingLink.id });
      await writeAudit({ actor: o.actor, action: "accounting.link.guardian", permission: o.permission, ip: o.ip, targetType: "guardian", targetId: row.id,
        after: { guardianId: row.id, familyId: familyKey, customerQboId: customerId, realmId, chosen, linkId: link!.id } }, tx);
      const customer = offer.candidates.find((c) => c.qboId === customerId)!.name;
      return { ok: true, message: guardianLinkedWords({ who: row.name, customer }), familyId: row.familyId };
    });
  } catch (e) {
    if (uniqueViolated(e) === "accounting_link_guardian_uq") return no(GUARDIAN_LINK_COPY.linkedAlready);
    throw e;
  }
}

/**
 * What staff read after Link this guardian, each sentence true by the code: the link; that nothing was sent and their
 * access is as it was (no guardian row or sign-in is touched); what is sent to that Parent customer from now on, by the
 * portal's own rules (a rename of the person and a removal through queueForGuardian(), a parent's change of their
 * phone, mailing address or sign-in email through queueContactChange() and queueEmailChange(), each while the customer
 * is the row's own: ownParentCustomer()); and that the details the portal holds now aren't sent by this (the lead's
 * decision 6).
 */
export function guardianLinkedWords(s: { who: string; customer: string }): string {
  return [`${s.who} is linked to “${s.customer}” in the books, as their own Parent customer.`,
    "Nothing was sent to the books, and their access in the portal is as it was.",
    `From now on, a rename of ${s.who}, their removal from this family, and a change of their phone, mailing address or sign-in email go to that Parent customer, by the portal's own rules, while it is theirs alone under this family.`,
    "The details the portal holds for them now aren't sent by this."].join(" ");
}

/**
 * Unlink this guardian (the lead's decisions 3 and 7: the way to split a shared Parent customer and to undo a wrong
 * link): ends one open guardian row's link of the records' company, whatever it stands as. In one transaction under the
 * roster lock held exclusively with the page's tag: the state `listed`; the row open in an active family record; its
 * link locked and the one the page showed (guardianUnlinkStamp()). Then refused, keeping nothing: a change that blocks
 * others naming the row or targeting the link's customer, waiting, stuck or kept; the row's or the family's "being sent"
 * lock held. A parent's change of their details or sign-in email refuses nothing: a waiting one's own next try gives it
 * up unsent (contactStopFrom(): `not_own`, as the row's link no longer names its customer); a stuck or kept one stays
 * on Reconciliation. Then the link moves to `accounting_link_ended` as it was (its id, origin, `linked_at`,
 * `linked_by`) with the database's time, the staff member and `unlinked`, and is deleted; one
 * `accounting.link.guardian.remove` row. Nothing else: the row stays open with its sign-in, nothing is sent, nothing is
 * queued, the customer stays in the books.
 */
export async function unlinkGuardian(raw: { guardianId: unknown; linkId: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<GuardianLinkDone> {
  const { guardianId: rawRow, linkId: rawLink, stamp } = raw;
  if (!isUuid(rawRow) || !isUuid(rawLink) || typeof stamp !== "string") return no(LINK_COPY.notFromPage);
  const rowKey = rawRow.toLowerCase(), linkKey = rawLink.toLowerCase();
  return db.transaction(async (tx): Promise<GuardianLinkDone> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const b = await readLinkBasics(tx);
    if (b.state !== "listed") return no(LINK_COPY[b.state]);
    const row = b.guardianById.get(rowKey);
    if (row === undefined || row.status === "disabled" || row.familyId === null || !b.families.some((f) => String(f.id) === String(row.familyId))) return no(GUARDIAN_LINK_COPY.rowGone);
    const realmId = b.realm!;
    const [link] = await tx.select().from(accountingLink)
      .where(and(eq(accountingLink.guardianId, row.id), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId))).for("update");
    if (!link) return no(GUARDIAN_LINK_COPY.notLinkedNow);
    if (link.id !== linkKey || !guardianUnlinkStampHolds(row.id, link.id, link.customerId, stamp)) return no(GUARDIAN_LINK_COPY.unlinkChanged);

    const open = inArray(writeQueue.state, [...OPEN_ITEM]);
    const blocking = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(open, blocksOthers,
      sql`(${writeQueue.request}->>'guardianId' = ${row.id} or ${writeQueue.targetQboId} = ${link.customerId})`));
    if (blocking.length > 0) return no(GUARDIAN_LINK_COPY.unlinkWaiting(blocking.length));
    if (!(await recordSendingFree(tx, row.id)) || !(await familySendingFree(tx, row.familyId))) return no(GUARDIAN_LINK_COPY.unlinkBusy);
    // A parent's change of their details or sign-in email naming the row: it refuses nothing, and is said.
    const detailItems = await tx.select({ state: writeQueue.state }).from(writeQueue).where(and(open, sql`${writeQueue.request}->>'guardianId' = ${row.id}`,
      sql`${writeQueue.request}->>'op' in ('contact', 'email')`));
    const details = { waiting: detailItems.filter((d) => d.state === "waiting").length, held: detailItems.filter((d) => d.state !== "waiting").length };

    // The time it ended is the database's, as the insert starts (statement_timestamp()), past every lock above, as unlinkFamily()'s.
    const [{ endedAt }] = await tx.insert(accountingLinkEnded).values({ id: link.id, system: link.system, realmId: link.realmId, customerId: link.customerId, familyId: null,
      studentId: null, guardianId: link.guardianId, origin: link.origin, linkedAt: link.linkedAt, linkedBy: link.linkedBy, endedAt: sql`statement_timestamp()`, endedBy: o.staffUserId,
      endedHow: "unlinked" }).returning({ endedAt: accountingLinkEnded.endedAt }) as [{ endedAt: Date }];
    await tx.delete(accountingLink).where(eq(accountingLink.id, link.id));
    await writeAudit({ actor: o.actor, action: "accounting.link.guardian.remove", permission: o.permission, ip: o.ip, targetType: "guardian", targetId: row.id,
      before: { link: { id: link.id, guardianId: row.id, customerQboId: link.customerId, realmId: link.realmId, origin: link.origin, linkedAt: link.linkedAt.toISOString(), linkedBy: link.linkedBy } },
      after: { guardianId: row.id, familyId: String(row.familyId), customerQboId: link.customerId, realmId: link.realmId, endedAt: endedAt.toISOString(),
        detailsWaiting: details.waiting, detailsHeld: details.held } }, tx);
    // Whether the row's opening offers to link them again (guardianBooksOf(), which the row's own link doesn't change).
    const relink = b.guardianBooksOf(String(row.familyId)) !== null;
    return { ok: true, message: guardianUnlinkedWords({ who: row.name, customer: b.customerById.get(link.customerId)?.displayName ?? null, details, relink }), familyId: row.familyId };
  });
}

/**
 * What staff read after Unlink this guardian, each sentence true by the code: the link ended; that nothing was sent, their
 * access is as it was and the customer stays in the books; a parent's changes of their details on their way (a waiting
 * one given up unsent at its next try, contactStopFrom()'s `not_own`; a stuck or kept one left on Reconciliation, which
 * runWriteQueue() never tries by itself); that no Parent customer is made for them by this or by itself later (nothing
 * is queued here, and at a later reinstate queueForGuardian()'s grant holds a second one back while this one stays under
 * the family with no guardian linked to it: `linked_before`, slice M3b2); and whether the row can be linked again here:
 * only where its family may have a guardian linked now (`relink`: guardianBooksOf(), a family link that stands in
 * layered books with a parent type), and otherwise when that is so.
 */
export function guardianUnlinkedWords(s: { who: string; customer: string | null; details: { waiting: number; held: number }; relink: boolean }): string {
  const parts = [s.customer === null ? `${s.who} is no longer linked to their customer in the books, which the books' copy doesn't hold now.` : `${s.who} is no longer linked to “${s.customer}” in the books.`];
  parts.push(s.customer === null ? "Nothing was sent to the books, and their access in the portal is as it was." : "Nothing was sent to the books, the customer stays there as it is, and their access in the portal is as it was.");
  if (s.details.waiting > 0) parts.push(s.details.waiting === 1 ? "A change of their details on its way to the books is given up unsent at its next try, as that customer is no longer theirs."
    : `${s.details.waiting} changes of their details on their way to the books are given up unsent at their next try, as that customer is no longer theirs.`);
  if (s.details.held > 0) parts.push(s.details.held === 1 ? "A change of their details that is stuck or kept stays on the Reconciliation page, where it can be given up."
    : `${s.details.held} changes of their details that are stuck or kept stay on the Reconciliation page, where they can be given up.`);
  parts.push("Nothing is sent for them to a Parent customer now, and no Parent customer is made for them by this, or later by itself.");
  parts.push(s.relink ? "They can be linked to a Parent customer again in the family's row on this page."
    : "Linking them to a Parent customer again isn't offered on this page until their family is linked to a family customer that stands in the books and the membership shape has a parent type.");
  return parts.join(" ");
}
