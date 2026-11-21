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
// Since slice M3c2 a family's Confirm and the bulk press link the guardians paired with it too (proposeGuardians(),
// ./proposals.ts), and try each paired row's "being sent" lock, shared, never waited for (recordSendingFree()), as Link
// this guardian does (./guardian-links.ts): a send holds it and then waits for the roster lock, so waiting for it here
// would make a cycle. A parent's save of their phone, address or sign-in email takes no roster lock: it reads the row's
// link as it stands when it saves (guardianLinksOf(), src/lib/parents/contact-queue.ts), before or after a press commits.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, accountingLinkEnded, buyout, family, guardian, requirement, student, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { asAppFamilyId, QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { clearLeftUnlinked } from "@/lib/families/left-unlinked";
import { recordNameWords } from "@/lib/families/words";
import { forgetFamilyMoney } from "@/lib/money/family-money";
import { isQboId } from "@/lib/quickbooks/client";
import { handful, noFamilyPool, type AimedAt } from "@/lib/roster/no-family";
import { blocksOthers, familyCreateWaiting, NO_FAMILY_CUSTOMER, queueSendIn, readyToSend, recordSendingFree } from "@/lib/roster/writes";
import { loadOpenWrites } from "@/lib/roster/queue";
import { ofRosterCompany } from "@/lib/roster/source";
import { nameKey } from "@/lib/roster/names";
import { isUuid } from "@/lib/seasons/ids";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { BULK_MAX, bulkKeys, readCustomerAims, readLinkBasics, REVIEW_LEFT_WORDS, SEND_ALL_MAX, sendAllKeys, sendAllShown, suggestedRowsShown, type LinkBasics, type LinksState, type ReviewLeftWhy, type SendOffer } from "./mapping";
import { pairKeys, type Proposals } from "./proposals";
import { isStatusKey, linkStanding, SEARCH_MAX, type StatusKey } from "./status";
import { bulkStampHolds, isChosen, linkStampHolds, reviewStampHolds, sendAllStampHolds, unlinkStampHolds, type Chosen } from "./stamp";

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
  rowChanged: `This family's row has changed since the page was drawn (a student added, renamed, made inactive or moved on either side, a guardian or a Parent customer under it changed, or what is suggested for it), so nothing was linked. ${AGAIN} Look it over, then press again.`,
  guardianSending: `One of the guardians this press would link is being changed in the books at this moment, so nothing was linked. Try again in a minute. ${AGAIN}`,
  studentTaken: `One of the students would have been linked to a customer or a record that is linked already, so nothing was linked. ${AGAIN}`,
  alreadyLeft: `This family is left unlinked already, so nothing was changed. ${AGAIN}`,
  notLeft: `This family isn't left unlinked now, so nothing was changed. ${AGAIN}`,
  listChanged: "The list has changed since the page was drawn (a family added to or gone from the Suggested rows it shows, a suggestion changed, a student added, renamed, made inactive or moved on either side, or a guardian or a Parent customer under one changed), so nothing was linked. It is shown again as it is now, with the new count: look it over, then press again.",
  bulkSending: (family: string) => `${family}, one of the families this list shows, is being made in the books at this moment, so nothing was linked. Try again in a minute: the list is shown again as it is now.`,
  bulkGuardianSending: (family: string) => `A guardian of ${family}, one of the families this list shows, is being changed in the books at this moment, so nothing was linked. Try again in a minute: the list is shown again as it is now.`,
  reviewChanged: `This family's link has changed since the page was drawn (it is no longer carried over to the same customer, or one of its students' links was added, removed or changed), so nothing was confirmed. ${AGAIN} Look it over, then press again.`,
  reviewNotStanding: `The customer this family is linked to isn't a family at the top of the books now, or isn't in the books' copy at all, so the link wasn't confirmed. ${AGAIN}`,
  notLinkedNow: `This family isn't linked to a customer in the books now, so nothing was unlinked. ${AGAIN}`,
  unlinkChanged: `This family's links have changed since the page was drawn (its own link, or one of its students' links, was made, ended or changed), so nothing was unlinked. ${AGAIN} Look it over, then press again.`,
  buyoutUnsettled: (n: number, titles: string) => `${n === 1 ? "A buy-out" : `${n} buy-outs`} of this family or its students (${titles}) ${n === 1 ? "isn't" : "aren't"} settled yet: ${n === 1 ? "its invoice is" : "their invoices are"} on the family's customer in the books, and nobody could reach ${n === 1 ? "it" : "them"} from the portal once the family is unlinked, so nothing was unlinked. Once the daily check has marked ${n === 1 ? "it" : "each"} paid, the guardian has switched back, or staff have closed it on the Reconciliation page where it may be closed, the family can be unlinked. ${AGAIN}`,
  unlinkMoving: (n: number) => `${n === 1 ? "A student's move" : `${n} students' moves`} into or out of this family ${n === 1 ? "is" : "are"} waiting, stuck or kept on the Reconciliation page, so nothing was unlinked. Once ${n === 1 ? "it has" : "they have"} gone through, or been given up there, try again. ${AGAIN}`,
  unlinkWaiting: (n: number) => `${n === 1 ? "A change" : `${n} changes`} for this family, its students or its guardians ${n === 1 ? "is" : "are"} waiting, stuck or kept on the Reconciliation page, so nothing was unlinked: ${n === 1 ? "it names" : "they name"} the customers this link ties the family to. Once ${n === 1 ? "it has" : "they have"} gone through, or been given up there, try again. ${AGAIN}`,
  unlinkBusy: `This family, one of its students or one of its guardians is being changed in the books at this moment, so nothing was unlinked. Try again in a minute. ${AGAIN}`,
  no_company: `The portal hasn't read the club's books yet, so nothing was linked. ${AGAIN}`,
  other_company: `QuickBooks is connected to a different company than the one the roster was read from, so nothing was linked. An Admin can see why under Settings, QuickBooks. ${AGAIN}`,
  no_shape: `The membership shape isn't chosen, or names a customer type the books no longer have, so the portal can't tell which customers are families. Nothing was linked. An Admin can choose it under Settings, QuickBooks. ${AGAIN}`,
} as const satisfies Record<string, string | ((...words: never[]) => string)> & Record<Exclude<LinksState, "listed">, string>;

/** The unique indexes a confirm may meet, the last line against a wrong link: a family's, a student's, and since slice M3c2 a guardian row's. */
const FAMILY_UQ = new Set(["accounting_link_family_customer_uq", "accounting_link_family_uq"]);
const STUDENT_UQ = new Set(["accounting_link_student_customer_uq", "accounting_link_student_uq"]);
const GUARDIAN_UQ = new Set(["accounting_link_guardian_uq"]);
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
 * Whether the guardian pairs a press would link may be linked now (slice M3c2), before any write: each paired row's
 * "being sent" lock tried shared (recordSendingFree(), held to the transaction's end, never waited for), `sending` while
 * one is held; and no guardian row linked to a paired customer, read again in the transaction as Link this guardian
 * reads it (guardianCustomerLinked()'s rule), `changed` otherwise. The pairs were worked out under the roster lock, which
 * every link writer holds, so `changed` is only a last line.
 */
async function guardianPairsFree(tx: Tx, b: LinkBasics, proposals: Proposals): Promise<"ok" | "sending" | "changed"> {
  if (proposals.guardians.length === 0) return "ok";
  for (const g of proposals.guardians) if (!(await recordSendingFree(tx, g.guardianId))) return "sending";
  const taken = await tx.select({ id: accountingLink.id }).from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, b.realm!),
    isNotNull(accountingLink.guardianId), inArray(accountingLink.customerId, proposals.guardians.map((g) => g.customerQboId)))).limit(1);
  return taken.length > 0 ? "changed" : "ok";
}

/** Whether the books have a parent type (layered books whose shape names one): only then does a confirm say anything of guardians. */
const guardiansOfBooks = (b: LinkBasics) => b.shape !== null && b.shape.kind === "layered" && b.shape.parentTypeId !== null;

/**
 * The one write of a family's link (slices M3a and M3a2), in the caller's transaction, which holds the roster lock
 * exclusively and has checked the family (familyToLink()), the customer and the pairs against reads made in it (`b`):
 * the family's link (`confirmed`, by the staff member, aligned with the cache row's version) and one student link for
 * each pair proposed, the same way; since slice M3c2 one guardian link for each guardian pair proposed (the row to the
 * Parent customer whose email field holds its sign-in address), the same way; the family's Left unlinked mark cleared;
 * and one `accounting.link.confirm` row (`extra` added to its body: a bulk press's id), naming the guardians linked and
 * those the queue held back. A single Confirm and each family of a bulk press go through it, so a bulk link is exactly
 * a single one. `left` is whether the family's locked row had the mark (familyToLink()): the clear is made only then,
 * as it would change nothing otherwise. No guardian row column, queue item or cache row is changed, and nothing is
 * sent. Returns the links made.
 */
async function linkIn(tx: Tx, b: LinkBasics, familyId: AppFamilyId, customerId: string, chosen: Chosen, proposals: Proposals, o: LinkOp,
  left: boolean, extra: Record<string, unknown> = {}): Promise<{ linkIds: string[] }> {
  const familyKey = String(familyId);
  const realmId = b.realm!;
  const now = new Date();
  const aligned = (c: string) => (b.tokenOf.has(c) ? { syncedToken: b.tokenOf.get(c)!, syncedAt: now } : {});
  const [familyLink] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, familyId, origin: "confirmed", linkedBy: o.staffUserId, ...aligned(customerId) })
    .returning({ id: accountingLink.id });
  const studentLinks = proposals.pairs.length === 0 ? [] : await tx.insert(accountingLink).values(proposals.pairs.map((p) =>
    ({ system: QUICKBOOKS, realmId, customerId: p.customerQboId, studentId: p.studentId, origin: "confirmed" as const, linkedBy: o.staffUserId, ...aligned(p.customerQboId) })))
    .returning({ id: accountingLink.id });
  const guardianLinks = proposals.guardians.length === 0 ? [] : await tx.insert(accountingLink).values(proposals.guardians.map((g) =>
    ({ system: QUICKBOOKS, realmId, customerId: g.customerQboId, guardianId: g.guardianId, origin: "confirmed" as const, linkedBy: o.staffUserId, ...aligned(g.customerQboId) })))
    .returning({ id: accountingLink.id });
  const cleared = left ? await clearLeftUnlinked(tx, familyId) : false;
  const linkIds = [familyLink!.id, ...studentLinks.map((l) => l.id), ...guardianLinks.map((l) => l.id)];
  await writeAudit({ actor: o.actor, action: "accounting.link.confirm", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
    after: { familyId: familyKey, customerQboId: customerId, realmId, chosen,
      studentsLinked: proposals.pairs.map((p) => ({ studentId: String(p.studentId), customerQboId: p.customerQboId })),
      studentsLeft: proposals.recordsLeft.map((r) => String(r.id)), studentCustomersLeft: proposals.customersLeft.map((c) => c.qboId),
      guardiansLinked: proposals.guardians.map((g) => ({ guardianId: g.guardianId, customerQboId: g.customerQboId })),
      guardiansHeld: proposals.guardiansHeld.map((g) => g.guardianId),
      linkIds, ...(cleared ? { leftUnlinkedCleared: true } : {}), ...extra } }, tx);
  return { linkIds };
}

/**
 * How many students' moves into these families, kept only because the family had no customer in the books
 * (NO_FAMILY_CUSTOMER), can be sent now that they are linked, where Reconciliation offers it: only while the cache
 * holds the student's customer active, the rule loadOpenWrites() (src/lib/roster/queue.ts) applies to a kept move
 * before it asks whether the family joined is linked. One query, for a single press or a bulk one.
 */
async function keptMovesInto(tx: Tx, b: LinkBasics, familyKeys: readonly string[]): Promise<number> {
  if (familyKeys.length === 0) return 0;
  const kept = await tx.select({ studentQboId: sql<string | null>`${writeQueue.request}->>'qboId'` }).from(writeQueue).where(and(eq(writeQueue.state, "refused"), ofRosterCompany,
    eq(writeQueue.lastCode, NO_FAMILY_CUSTOMER), sql`${writeQueue.request}->>'op' = 'move'`, inArray(sql<string>`${writeQueue.request}->>'toFamilyId'`, [...familyKeys])));
  return kept.filter((m) => m.studentQboId !== null && b.customerById.get(m.studentQboId)?.active === true).length;
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
 * with the cache row's version) and one student link for each pair proposed, the same way, since slice M3c2 one guardian
 * link for each guardian pair proposed (refused, keeping nothing, while a paired row's "being sent" lock is held:
 * guardianPairsFree()), and the family's Left unlinked mark cleared; nothing else: no record made, renamed or made
 * active or inactive, no student moved, no guardian row changed and no guardian link moved or ended, nothing written to
 * the roster cache, the money cache or the write queue. The unique indexes are the last line, answered in words,
 * keeping nothing. One `accounting.link.confirm` row in the transaction.
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
      const free = await guardianPairsFree(tx, b, proposals);
      if (free !== "ok") return no(free === "sending" ? LINK_COPY.guardianSending : LINK_COPY.rowChanged);
      await linkIn(tx, b, familyId, customerId, chosen, proposals, o, f.leftAt !== null);
      const keptMoves = await keptMovesInto(tx, b, [familyKey]);
      return { ok: true, message: confirmedWords({ family: recordNameWords(f.name, "family"), customer: b.customerById.get(customerId)?.displayName ?? customerId,
        linked: proposals.pairs.map((p) => p.recordName), recordsLeft: proposals.recordsLeft.map((r) => recordNameWords(r.name, "student")),
        customersLeft: proposals.customersLeft.map((c) => ({ name: c.name, active: c.active })), keptMoves,
        guardians: guardiansOfBooks(b) ? { linked: proposals.guardians.map((g) => ({ who: g.who, customer: g.customerName })), held: proposals.guardiansHeld.length } : null }) };
    });
  } catch (e) {
    const which = uniqueViolated(e);
    if (which !== null && FAMILY_UQ.has(which)) return no(which === "accounting_link_family_uq" ? LINK_COPY.linkedAlready : LINK_COPY.customerTaken);
    if (which !== null && STUDENT_UQ.has(which)) return no(LINK_COPY.studentTaken);
    if (which !== null && GUARDIAN_UQ.has(which)) return no(LINK_COPY.rowChanged);
    throw e;
  }
}

/**
 * The guardians paired with a link that the write queue held back (proposalsFor()'s `guardiansHeld`), in words: each is
 * held by an item naming their own row or blocking their own Parent customer. `under` names what the Parent customers
 * are under ("it", or "them" after a bulk press).
 */
const heldWords = (n: number, under = "it") => n === 1
  ? `A guardian whose sign-in address a Parent customer under ${under} holds wasn't linked, as a change for that guardian or for that Parent customer is waiting, stuck or kept on the Reconciliation page.`
  : `${n} guardians whose sign-in addresses Parent customers under ${under} hold weren't linked, as a change for each of them or for their Parent customer is waiting, stuck or kept on the Reconciliation page.`;
/**
 * What Link this guardian may do after a confirm, said conditionally (guardianOfferOf() and linkGuardian() decide):
 * `who` names the family or families, `where` their rows, `under` their customers.
 */
const byHandWords = (who: string, where: string, under: string) => `Another open guardian of ${who} can be linked in ${where} on this page, with Link this guardian,`
  + ` where an active Parent customer directly under ${under} is free for them and no change for them or that customer is waiting, stuck or kept on Reconciliation.`;

/** When a linked family's money is read from the books, said after a confirm. */
const MONEY_WORDS = "Its money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected; its Balances page shows the figures once one of those has read them.";

/**
 * What staff read after a confirm, each sentence true by the code: the link, the students linked and those left (shown
 * on the screen with the family's row afterwards: a record left and an active student customer left as differences, an
 * inactive student customer left only counted, differencesOf() in ./differences.ts), that nothing was sent, when its
 * money is read from the books (loadFamilyMoney() finds the link at the next load of a parent's Home or Payments, and
 * the money run reads it when staff ask for it on Balances or daily, while the books are connected; the Balances pages
 * read nothing live, only the row one of those stored), and a kept move into it that Reconciliation now offers to send.
 * Since slice M3c2, only in layered books with a parent type (`guardians` null otherwise: nothing about guardians), the
 * guardians linked with it (linkIn()) by name and customer, how many the write queue held back and why, and that another
 * open guardian can be linked in the row's opening, with Link this guardian, where its rules let it (linkGuardian()).
 */
export function confirmedWords(s: { family: string; customer: string; linked: string[]; recordsLeft: string[]; customersLeft: { name: string; active: boolean }[]; keptMoves: number;
  guardians: { linked: { who: string; customer: string }[]; held: number } | null }): string {
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
  if (s.guardians !== null) {
    const g = s.guardians.linked;
    parts.push(g.length ? `${plural(g.length, "guardian", "guardians")} linked with it, each to the Parent customer under it whose email field holds their sign-in address: ${list(g.map((x) => `${x.who} to “${x.customer}”`))}.`
      : "No guardian was linked with it.");
    if (s.guardians.held > 0) parts.push(heldWords(s.guardians.held));
    parts.push(byHandWords("the family", "its row's opening", "it"));
  }
  parts.push("Nothing was sent to the books.");
  parts.push(MONEY_WORDS);
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

/** A bulk press found the list changed after it had begun writing: thrown, so its transaction keeps nothing, with the words it is answered in. */
class ListChanged extends Error {
  constructor(readonly words: string = LINK_COPY.listChanged) { super(words); }
}

/**
 * Confirm all exact email matches (stage 4's slice M3a2; section 4, "bulk confirm"; the lead's decisions 2 to 4): links
 * every Suggested row the page's filter showed, each to the customer filled in on its row, with the students and (since
 * slice M3c2) the guardians its row proposed, exactly as that row's Confirm would (linkIn()); a paired guardian row's
 * "being sent" lock held refuses the whole press (LINK_COPY.bulkGuardianSending). Nothing about the rows is taken from the browser: the press
 * sends the filter as the page parsed it, how many rows it showed and the stamp sealing them (bulkStamp()), and in one
 * transaction, under the roster lock held exclusively with the page's tag, the rows are worked out again from reads
 * made in it (suggestedRowsShown(), the page's own rule) and must be as many, at most BULK_MAX, and seal to the same
 * stamp. Then, for each row in the roster's order, the single press's checks (the family locked, active, unlinked, its
 * create neither waiting nor being made; the customer in the pool; the row still `suggested`) and the links. A family
 * whose own create is waiting or stuck isn't among the rows at all (suggestedRowsShown() leaves it out, page and press
 * alike), so only one being made at this moment can be found here, and that is said in words of its own
 * (LINK_COPY.bulkSending). All or nothing: any change refuses the whole press in one set of words
 * (LINK_COPY.listChanged), keeping nothing; the unique
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
      const linked: { name: string; pairs: number; recordsLeft: number; customersLeft: { active: boolean }[]; guardians: number; guardiansHeld: number }[] = [];
      for (const r of rows) {
        const f = await familyToLink(tx, r.familyId);
        if (!f.ok) throw new ListChanged(f.error === LINK_COPY.createSending ? LINK_COPY.bulkSending(r.name) : LINK_COPY.listChanged);
        if (!b.poolIds.has(r.customerId) || b.chosenFor(r.familyKey, r.customerId) !== "suggested") throw new ListChanged();
        const proposals = b.proposalsFor(r.familyKey, r.customerId);
        const free = await guardianPairsFree(tx, b, proposals);
        if (free !== "ok") throw new ListChanged(free === "sending" ? LINK_COPY.bulkGuardianSending(r.name) : LINK_COPY.listChanged);
        await linkIn(tx, b, r.familyId, r.customerId, "suggested", proposals, o, f.leftAt !== null, { bulk: pressId });
        linked.push({ name: r.name, pairs: proposals.pairs.length, recordsLeft: proposals.recordsLeft.length, customersLeft: proposals.customersLeft,
          guardians: proposals.guardians.length, guardiansHeld: proposals.guardiansHeld.length });
      }
      const keptMoves = await keptMovesInto(tx, b, rows.map((r) => r.familyKey));
      await writeAudit({ actor: o.actor, action: "accounting.link.bulk", permission: o.permission, ip: o.ip, targetType: "accounting_link", targetId: pressId,
        after: { pressId, count: rows.length, familyIds: rows.map((r) => r.familyKey), realmId: b.realm, status: filter.status, searched: filter.q !== "" } }, tx);
      return { ok: true, message: bulkConfirmedWords({ families: linked.map((l) => l.name), students: linked.reduce((n, l) => n + l.pairs, 0),
        recordsLeft: linked.reduce((n, l) => n + l.recordsLeft, 0), activeCustomersLeft: linked.reduce((n, l) => n + l.customersLeft.filter((c) => c.active).length, 0),
        inactiveCustomersLeft: linked.reduce((n, l) => n + l.customersLeft.filter((c) => !c.active).length, 0), keptMoves,
        guardians: guardiansOfBooks(b) ? { linked: linked.reduce((n, l) => n + l.guardians, 0), held: linked.reduce((n, l) => n + l.guardiansHeld, 0) } : null }) };
    });
  } catch (e) {
    if (e instanceof ListChanged) return no(e.words);
    const which = uniqueViolated(e);
    if (which !== null && (FAMILY_UQ.has(which) || STUDENT_UQ.has(which) || GUARDIAN_UQ.has(which))) return no(LINK_COPY.listChanged);
    throw e;
  }
}

/**
 * What staff read after a bulk press, each sentence true by the code: how many families were linked, each to the
 * customer filled in on its row (named up to a handful), how many students in all; where whoever was left shows (the
 * rule of confirmedWords()); since slice M3c2, only in layered books with a parent type, how many guardians were linked
 * with them and how many the queue held back (the rule of confirmedWords()); that nothing was sent; when the money is
 * read; and the kept moves into those families now sendable, counted over all of them.
 */
export function bulkConfirmedWords(s: { families: string[]; students: number; recordsLeft: number; activeCustomersLeft: number; inactiveCustomersLeft: number; keptMoves: number;
  guardians: { linked: number; held: number } | null }): string {
  const n = s.families.length;
  const parts = [n === 1 ? `1 family linked, to the customer that was filled in on its row: ${handful(s.families)}.`
    : `${n} families linked, each to the customer that was filled in on its row: ${handful(s.families)}.`];
  parts.push(s.students === 0 ? `No student was linked with ${n === 1 ? "it" : "them"}.` : `${plural(s.students, "student", "students")} linked with ${n === 1 ? "it" : "them"} in all.`);
  const differing = s.recordsLeft + s.activeCustomersLeft;
  if (differing > 0) parts.push(s.inactiveCustomersLeft === 0 ? "Whoever was left on either side shows with each family's row on this page, among its differences."
    : "Whoever was left on either side shows with each family's row on this page: an inactive student customer in the books in a count there, everyone else among its differences.");
  else if (s.inactiveCustomersLeft > 0) parts.push(s.inactiveCustomersLeft === 1 ? "The inactive student customer left in the books is counted with its family's row on this page, not listed among its differences."
    : "The inactive student customers left in the books are counted with their families' rows on this page, not listed among their differences.");
  if (s.guardians !== null) {
    parts.push(s.guardians.linked === 0 ? `No guardian was linked with ${n === 1 ? "it" : "them"}.`
      : `${plural(s.guardians.linked, "guardian", "guardians")} linked with ${n === 1 ? "it" : "them"} in all, each to the Parent customer under ${n === 1 ? "its" : "their family's"} customer whose email field holds their sign-in address.`);
    if (s.guardians.held > 0) parts.push(heldWords(s.guardians.held, n === 1 ? "it" : "them"));
    parts.push(n === 1 ? byHandWords("the family", "its row's opening", "it") : byHandWords("these families", "the opening of its family's row", "that family's customer"));
  }
  parts.push("Nothing was sent to the books.");
  parts.push(n === 1 ? MONEY_WORDS : "Each family's money is read from the books the next time a parent opens Home or Payments, when someone presses “Read every family now” on Balances, or at the daily read of every family's invoices, while the books are connected; its Balances page shows the figures once one of those has read them.");
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
 * a Customer gone or Not a family now row offers Unlink from the books instead, slice M3b); the student links it confirms worked out again (reviewOf():
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
        // Named as a confirm names the students it linked, so the audit page's record filter finds the row under each (confirmRowsOf()).
        studentsLinked: students.map((s) => ({ id: s.id, origin: "confirmed", linkedAt: now.toISOString(), linkedBy: o.staffUserId, studentId: String(s.studentId), customerQboId: s.customerId })),
        studentLinksLeft: offer.leaves.map((l) => l.linkId) } }, tx);
    return { ok: true, message: reviewedWords({ family: recordNameWords(f.name, "family"), customer: b.customerById.get(link.customerId)?.displayName ?? link.customerId,
      confirmed: offer.confirms.map((c) => c.name), left: offer.leaves.map((l) => ({ name: l.name, why: l.why })) }) };
  });
}

/** What staff read after Confirm this link, each sentence true by the code. */
export function reviewedWords(s: { family: string; customer: string; confirmed: string[]; left: { name: string; why: ReviewLeftWhy }[] }): string {
  const parts = [`The link of ${s.family} to “${s.customer}” in the books is confirmed: it is recorded as checked by you, and no longer as carried over.`];
  if (s.confirmed.length) parts.push(`Confirmed with it, as ${s.confirmed.length === 1 ? "its student's link" : "its students' links"}: ${list(s.confirmed)}.`);
  if (s.left.length) parts.push(`Left carried over: ${list(s.left.map((l) => `${l.name} (${REVIEW_LEFT_WORDS[l.why]})`))}.`);
  parts.push("Nothing was sent to the books.");
  return parts.join(" ");
}

/** A buy-out that isn't settled (the owner's choice 3 for slice M3b, which the owner confirmed on 2026-11-21): an unlink is refused while one stands. */
const UNSETTLED_BUYOUT = ["being_invoiced", "invoiced", "being_voided", "stuck"] as const;
/** A queue item that holds an unlink back: waiting, stuck, or kept (`refused`), of the roster's company (ofRosterCompany, src/lib/roster/source.ts). */
const OPEN_ITEM = ["waiting", "stuck", "refused"] as const;

/**
 * Unlink from the books (stage 4's slice M3b; section 4, "Every link, unlink, import and alignment is audited"; open
 * question 13, "an admin picks again"): ends a linked family's link to its customer in the books, with every link of its
 * student records (active or inactive, whatever customer each names, so a later link pairs its students afresh) and of
 * its guardian rows (open or closed). Its stored figures are forgotten at once (forgetFamilyMoney()). Sends nothing to the books; the
 * customer stays there as it is. A relink is this, then a link as Confirm or Pick a different customer makes it: nothing
 * is restored.
 *
 * In one transaction, under the roster lock held exclusively with the page's tag: the family record locked and active;
 * the state `listed`; its family link of the records' company locked and the one the page showed; its student records'
 * links and its guardian rows' links locked; the stamp (unlinkStamp(): the family, the link, its customer and the
 * student links) sealing to what is read now. Then, refused keeping nothing: a buy-out of the family or its students
 * not settled (being invoiced, invoiced whatever the stored figures say, being voided or stuck: the owner's choice 3,
 * which he confirmed on 2026-11-21), so nobody is left with an unpaid invoice they can't reach; a student's move into
 * or out of it, or any other change that blocks others (blocksOthers) filed under it or a student record of it, naming
 * one of its guardian rows, or targeting one of the customers its links name, waiting, stuck or kept; and the family's
 * "being made" or "being sent" lock, or the "being sent" lock of a student record or guardian row of it, held (each tried
 * shared, held to the transaction's end). A parent's change of their details or sign-in email refuses nothing: a waiting
 * one's own next try gives it up unsent, as its family is no longer linked; a stuck or kept one stays on Reconciliation. Then each link is moved to
 * `accounting_link_ended` as it was (its id, origin, `linked_at`, `linked_by`) with the press's time, the staff member
 * and `unlinked`, and deleted; the money row deleted under the family's
 * money lock, after the roster lock (the one order: nothing that holds the money lock takes the roster lock); and one
 * `accounting.link.remove` row. Nothing else: no record made, renamed, moved or made inactive, no guardian row opened,
 * closed, moved or otherwise changed, no session, sign-in, season, volunteering or forms record, the roster cache,
 * the queue or a paid buy-out touched.
 */
export async function unlinkFamily(raw: { familyId: unknown; linkId: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  const { familyId: rawFamily, linkId: rawLink, stamp } = raw;
  if (!isUuid(rawFamily) || !isUuid(rawLink) || typeof stamp !== "string") return no(LINK_COPY.notFromPage);
  const familyKey = rawFamily.toLowerCase(), linkKey = rawLink.toLowerCase();
  const familyId = asAppFamilyId(familyKey);
  return db.transaction(async (tx): Promise<LinkDone> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    // `no key update`, not `update`: it still keeps out every change of the record, but not the key share a money read's
    // write of the family's money row takes on it (its foreign key). That read holds the family's money lock, which this
    // waits for further on (forgetFamilyMoney()): with `update` the two waited for each other, a deadlock.
    const [f] = await tx.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, familyId)).for("no key update");
    if (!f || !f.active) return no(LINK_COPY.familyGone);
    const b = await readLinkBasics(tx);
    if (b.state !== "listed") return no(LINK_COPY[b.state]);
    const realmId = b.realm!;
    const ofRealm = and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId));
    const [link] = await tx.select().from(accountingLink).where(and(eq(accountingLink.familyId, familyId), ofRealm)).for("update");
    if (!link) return no(LINK_COPY.notLinkedNow);
    if (link.id !== linkKey) return no(LINK_COPY.unlinkChanged);
    const records = await tx.select({ id: student.id, name: student.name }).from(student).where(eq(student.familyId, familyId));
    const rows = await tx.select({ id: guardian.id }).from(guardian).where(eq(guardian.familyId, familyId));
    const studentIds = records.map((r) => r.id), rowIds = rows.map((r) => r.id);
    const studentLinks = studentIds.length === 0 ? [] : await tx.select().from(accountingLink).where(and(inArray(accountingLink.studentId, studentIds), ofRealm))
      .orderBy(asc(accountingLink.id)).for("update");
    const guardianLinks = rowIds.length === 0 ? [] : await tx.select().from(accountingLink).where(and(inArray(accountingLink.guardianId, rowIds), ofRealm))
      .orderBy(asc(accountingLink.id)).for("update");
    if (!unlinkStampHolds(familyKey, link.id, link.customerId, studentLinks.map((l) => l.id), stamp)) return no(LINK_COPY.unlinkChanged);

    // Buy-outs first, locked, so a create or a void being finished at this moment is waited for and seen as it ends
    // (it takes the buy-out's row before the family's money row, as this does).
    const theirs = await tx.select({ id: buyout.id, state: buyout.state, title: requirement.title }).from(buyout).innerJoin(requirement, eq(buyout.requirementId, requirement.id))
      .where(studentIds.length === 0 ? eq(buyout.familyId, familyId) : or(eq(buyout.familyId, familyId), inArray(buyout.studentId, studentIds)))
      .orderBy(asc(buyout.id)).for("update", { of: buyout });
    const unsettled = theirs.filter((x) => (UNSETTLED_BUYOUT as readonly string[]).includes(x.state));
    if (unsettled.length > 0) return no(LINK_COPY.buyoutUnsettled(unsettled.length, list([...new Set(unsettled.map((x) => `“${x.title}”`))].sort())));
    const paidKept = theirs.filter((x) => x.state === "paid").length;

    // The queue: a move into or out of the family, then any other change that blocks others and names it.
    const customers = [...new Set([link.customerId, ...studentLinks.map((l) => l.customerId), ...guardianLinks.map((l) => l.customerId)])];
    const open = and(inArray(writeQueue.state, [...OPEN_ITEM]), ofRosterCompany);
    const moves = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(open, sql`${writeQueue.request}->>'op' = 'move'`, or(eq(writeQueue.familyId, familyId),
      sql`${writeQueue.request}->>'toFamilyId' = ${familyKey}`, sql`${writeQueue.request}->>'fromFamilyQboId' = ${link.customerId}`, sql`${writeQueue.request}->>'toFamilyQboId' = ${link.customerId}`)));
    if (moves.length > 0) return no(LINK_COPY.unlinkMoving(moves.length));
    const others = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(open, blocksOthers, or(eq(writeQueue.familyId, familyId),
      studentIds.length === 0 ? undefined : inArray(writeQueue.studentId, studentIds),
      rowIds.length === 0 ? undefined : inArray(sql<string>`${writeQueue.request}->>'guardianId'`, rowIds),
      inArray(writeQueue.targetQboId, customers))));
    if (others.length > 0) return no(LINK_COPY.unlinkWaiting(others.length));
    const making = await familyCreateWaiting(tx, familyId);
    if (making === "queued") return no(LINK_COPY.unlinkWaiting(1));
    if (making === "sending") return no(LINK_COPY.unlinkBusy);
    for (const id of [familyKey, ...studentIds.map(String), ...rowIds]) if (!(await recordSendingFree(tx, id))) return no(LINK_COPY.unlinkBusy);
    // A parent's change of their details or sign-in email filed under the family: it refuses nothing, and is said.
    // Only a waiting one is tried again by itself (runWriteQueue()); a stuck or kept one waits on Reconciliation.
    const detailItems = await tx.select({ state: writeQueue.state }).from(writeQueue).where(and(open, eq(writeQueue.familyId, familyId),
      sql`${writeQueue.request}->>'op' in ('contact', 'email')`));
    const details = { waiting: detailItems.filter((d) => d.state === "waiting").length, held: detailItems.filter((d) => d.state !== "waiting").length };

    // The links move to the history as they were, then go; then the money, and the audit row. The
    // time they ended is the database's, as the insert starts (statement_timestamp(), one for every row), past every lock
    // above: the clock audit_log.at and linked_at are written by, so the audit filter's windows compare like with like.
    const ended = [link, ...studentLinks, ...guardianLinks];
    const [{ endedAt }] = await tx.insert(accountingLinkEnded).values(ended.map((l) => ({ id: l.id, system: l.system, realmId: l.realmId, customerId: l.customerId, familyId: l.familyId,
      studentId: l.studentId, guardianId: l.guardianId, origin: l.origin, linkedAt: l.linkedAt, linkedBy: l.linkedBy, endedAt: sql`statement_timestamp()`, endedBy: o.staffUserId,
      endedHow: "unlinked" as const }))).returning({ endedAt: accountingLinkEnded.endedAt }) as [{ endedAt: Date }, ...{ endedAt: Date }[]];
    await tx.delete(accountingLink).where(inArray(accountingLink.id, ended.map((l) => l.id)));
    const moneyForgotten = await forgetFamilyMoney(tx, familyId);
    await writeAudit({ actor: o.actor, action: "accounting.link.remove", permission: o.permission, ip: o.ip, targetType: "family", targetId: familyKey,
      before: { link: { id: link.id, customerQboId: link.customerId, realmId: link.realmId, origin: link.origin, linkedAt: link.linkedAt.toISOString(), linkedBy: link.linkedBy },
        studentLinks: studentLinks.map((l) => ({ id: l.id, studentId: String(l.studentId), customerQboId: l.customerId, origin: l.origin })),
        guardianLinks: guardianLinks.map((l) => ({ id: l.id, guardianId: l.guardianId, customerQboId: l.customerId })) },
      after: { familyId: familyKey, customerQboId: link.customerId, realmId: link.realmId, endedAt: endedAt.toISOString(),
        studentLinksEnded: studentLinks.map((l) => ({ studentId: String(l.studentId), customerQboId: l.customerId })),
        guardianLinksEnded: guardianLinks.length, moneyForgotten, paidBuyoutsKept: paidKept } }, tx);

    // Whether Reconciliation lists the customer among those with no family now: the pool worked out again without the links ended.
    const familyLinked = new Set([...b.familyOfCustomer.keys()].filter((c) => c !== link.customerId));
    const endedStudents = new Set(studentLinks.map((l) => l.customerId));
    const studentLinked = new Set([...b.studentLinked].filter((c) => !endedStudents.has(c)));
    const listed = b.roster !== null && noFamilyPool(b.roster, b.customers, b.creates, { familyLinked, studentLinked }).some((c) => c.qboId === link.customerId);
    const nameOf = new Map(records.map((r) => [String(r.id), r.name]));
    return { ok: true, message: unlinkedWords({ family: recordNameWords(f.name, "family"), customer: b.customerById.get(link.customerId)?.displayName ?? null,
      students: studentLinks.map((l) => recordNameWords(nameOf.get(String(l.studentId)) ?? null, "student")).sort((x, y) => x.localeCompare(y)), guardianLinks: guardianLinks.length,
      paidKept, listedWithNoFamily: listed, details }) };
  });
}

/**
 * What staff read after an unlink, each sentence true by the code: the link ended and those of the students (by name)
 * and guardians (a count) with it; the figures forgotten and what the guardians read now (loadFamilyMoney()'s
 * `notConnected`); the paid buy-outs kept, "Paid instead" by their own state; a parent's changes of their details on
 * their way: a waiting one given up unsent at its next try (contactStopFrom(): `family_off` for a guardian's,
 * `not_the_family` for a family's), a stuck or kept one left on Reconciliation, which runWriteQueue() never tries by
 * itself; that nothing was sent and, for a customer the books' copy holds, that it stays; that the row now shows what
 * the page suggests for it, Pick a different customer only once the row offers it (never on a Suggested row); and,
 * where the customer is in the pool now, that Reconciliation lists it.
 */
export function unlinkedWords(s: { family: string; customer: string | null; students: string[]; guardianLinks: number; paidKept: number; listedWithNoFamily: boolean;
  details: { waiting: number; held: number } }): string {
  const parts = [s.customer === null ? `${s.family} is no longer linked to its customer in the books, which the books' copy doesn't hold now.` : `${s.family} is no longer linked to “${s.customer}” in the books.`];
  if (s.students.length) parts.push(`${s.students.length === 1 ? "Its student's link ended with it" : "Its students' links ended with it"}: ${list(s.students)}.`);
  if (s.guardianLinks > 0) parts.push(s.guardianLinks === 1 ? "A guardian's own link to a Parent customer ended with it too." : `${s.guardianLinks} guardians' own links to Parent customers ended with it too.`);
  parts.push("Its stored figures were forgotten, and its guardians now read that the club hasn't connected their payments to the portal yet, with no invoices, Pay or buy-out offer, until it is linked again.");
  if (s.paidKept > 0) parts.push(s.paidKept === 1 ? "Its paid buy-out is kept, and still reads Paid instead." : `Its ${s.paidKept} paid buy-outs are kept, and still read Paid instead.`);
  if (s.details.waiting > 0) parts.push(s.details.waiting === 1 ? "A guardian's change of their details on its way to the books is given up unsent at its next try, as the family is no longer linked."
    : `${s.details.waiting} changes of guardians' details on their way to the books are given up unsent at their next try, as the family is no longer linked.`);
  if (s.details.held > 0) parts.push(s.details.held === 1 ? "A guardian's change of their details that is stuck or kept stays on the Reconciliation page, where it can be given up: nothing is sent from it while the family has no link."
    : `${s.details.held} changes of guardians' details that are stuck or kept stay on the Reconciliation page, where they can be given up: nothing is sent from them while the family has no link.`);
  parts.push(s.customer === null ? "Nothing was sent to the books." : "Nothing was sent to the books, and the customer stays there as it is.");
  parts.push("Its row on this page now shows what the page suggests for it: link it again there, with Confirm, or with Pick a different customer once the row offers it (a Suggested row offers it once it is left unlinked).");
  if (s.listedWithNoFamily) parts.push("Reconciliation now lists the customer under Customers with no family, where “Create a family from this” would make a second family, unless this page suggests it for a family.");
  return parts.join(" ");
}

/**
 * Which family a customer no family is linked to is meant for, for "Create a family from this" (slice M3a2: it refuses
 * one the accounting links screen aims at): read in that press's transaction, after its own exclusive roster lock, by
 * the screen's own rule (readCustomerAims(): a Suggested row's suggestion, a Several possible row's candidate, or a
 * customer a given-up create of an active family with no family link made). Passed to familyFromCustomer() by its
 * action, so src/lib/roster/no-family.ts never imports this screen's modules (which import it).
 *
 * What it can't hold still: unblocking a person and a parent's confirmed change of sign-in email change the addresses
 * the matcher reads without taking the roster lock (readLinkBasics()), so one that commits after this read and before
 * the press commits can make the customer Suggested for a family all the same. The parent rows aren't locked here:
 * adding a guardian holds the person's row while it waits for the roster lock (the order above lockedPerson(),
 * src/lib/parents/sessions.ts), so a press holding the roster lock and waiting on that row would make a cycle. That
 * window is the press's own few moments; every writer that takes the roster lock is kept out for all of it.
 */
export async function customerAimedAt(tx: Tx, customerId: string): Promise<AimedAt | null> {
  const aim = (await readCustomerAims(tx)).get(customerId);
  if (aim === undefined) return null;
  const names = aim.families.map((f) => f.name);
  return aim.why === "given_up" ? { why: "given_up", families: [names[0]!], pickable: aim.pickable } : { why: aim.why, families: names };
}

export type { Chosen };

/* ---- Send the app's for all (stage 4's slice M5b of the app-owned families spec, section 5: "there is a bulk Send the
   app's for all"; M5a's lead decision 5 and M5b's decision 3) ---- */

/** What staff read when Send the app's for all doesn't go through. Nothing is ever queued or sent in these cases. */
export const SEND_ALL_COPY = {
  notFromPage: "That didn't go through, and nothing was sent. Reload the page and try again.",
  changed: "The list changed since this page was drawn, so nothing was sent. Look at it again.",
  overCap: `That is more than ${SEND_ALL_MAX} differences for one press, so nothing was sent. Narrow the list with the search or a status, then press again.`,
  busy: (about: string) => `${about}, one of the differences this list shows, is being changed in the books at this moment, so nothing was sent. Try again in a minute: the list is shown again as it is now.`,
  familyBusy: (about: string) => `${about}, one of the differences this list shows, can't be queued at this moment: a family it moves them into or out of is being changed or made in QuickBooks just now, so nothing was sent. Try again in a minute: the list is shown again as it is now.`,
  sameName: (name: string) => `Two of the names this list would send are both “${name}”, and every name in QuickBooks must be different, so nothing was sent. Rename one of the records on its page, or narrow the list so only one of them is in it, then press again.`,
} as const;

/** A send of the bulk press refused after it had begun queueing: thrown, so its transaction keeps nothing, with the words it is answered in. */
class SendAllRefused extends Error {
  constructor(readonly words: string) { super(words); }
}

/**
 * What staff read after Send the app's for all, each sentence true by the code: how many names and students' families
 * were queued; that the queue's worker sends each within a few minutes, over the books' value the list showed, holding
 * back and keeping one QuickBooks has changed since; that Reconciliation shows any that waits or is kept; what was left
 * for a later press and what was passed over, and why; and, when the inactive families' list has rows
 * (`inactiveListed`), that it isn't in it.
 */
export function sentAllWords(s: { names: number; places: number; later: number; passedOver: { inactive: number; booksInactive: number }; inactiveListed: boolean }): string {
  const queued = [s.names ? plural(s.names, "name", "names") : null, s.places ? plural(s.places, "student's family", "students' families") : null].filter((x): x is string => x !== null);
  const parts = [`Queued for QuickBooks: ${queued.join(" and ")}.`,
    "The portal sends each within a few minutes, over the books' value this list showed: one QuickBooks has changed since is held back and kept, never sent over. The Reconciliation page shows any that waits or is kept."];
  if (s.later > 0) parts.push(`${s.later === 1 ? "One more difference waits" : `${s.later} more differences wait`} for a change queued now to reach QuickBooks first, as ${s.later === 1 ? "it reads" : "they read"} the same customer: press again once it has.`);
  if (s.passedOver.inactive > 0) parts.push(`Passed over: ${plural(s.passedOver.inactive, "make-inactive", "make-inactives")}, as each reads a balance first: send ${s.passedOver.inactive === 1 ? "it" : "each"} on its own row.`);
  if (s.passedOver.booksInactive > 0) parts.push(`Passed over: ${plural(s.passedOver.booksInactive, "difference whose customer QuickBooks has inactive", "differences whose customer QuickBooks has inactive")}: the portal sends nothing there, and never makes a customer active.`);
  if (s.inactiveListed) parts.push("The inactive families listed after the families aren't part of this.");
  return parts.join(" ");
}

/**
 * Send the app's for all (stage 4's slice M5b): queues the portal's value of every name and student's family the
 * page's filter showed (sendAllShown(), the page's own rule), each as a change saved first, and sends nothing at the
 * press: the queue's worker (runWriteQueue()) takes each once its lease (SAVED_LEASE_MS) is out and sends it as any
 * saved change, settled by the field against the books' value the row showed. Nothing about the sends is taken from the
 * browser: the press sends the filter as the page parsed it, how many sends it showed and the stamp sealing them
 * (sendAllStamp()), and in one transaction, under the roster lock held exclusively with the page's tag and a live
 * connection to the roster's company (readyToSend()), the sends are worked out again from reads made after the lock is
 * taken (readLinkBasics(tx), and the queue's open items, loadOpenWrites(), read on its own connection, since its many
 * reads each open their own; every writer that takes the roster lock is kept out meanwhile, and each send's own checks
 * read the queue again in this transaction) and must be as many, at most SEND_ALL_MAX, and seal to the same stamp. Then,
 * in the list's order, each send's in-transaction half (queueSendIn(), the single send's own checks, with the record's
 * "being sent" lock tried, never waited for). All or nothing: any refusal refuses the whole press, keeping nothing, in
 * its own words (a record being changed at this moment, or a family a student's move goes into or out of: `busy`; two
 * names alike) or as a list that changed. One
 * `accounting.difference.send` row per difference (with `bulk`, the press's id, and `queueId`) and one
 * `accounting.difference.send_all` row, in the transaction. It never makes anything inactive, nor active.
 */
export async function sendAllDifferences(raw: { status: unknown; q: unknown; count: unknown; stamp: unknown }, rosterTag: string, o: LinkOp): Promise<LinkDone> {
  const { status: rawStatus, q, count, stamp } = raw;
  if (!(rawStatus === "" || isStatusKey(rawStatus)) || typeof q !== "string" || q.length > SEARCH_MAX || typeof count !== "number" || !Number.isInteger(count)
    || count < 1 || typeof stamp !== "string") return no(SEND_ALL_COPY.notFromPage);
  // More than a press may queue (the page offers no button then).
  if (count > SEND_ALL_MAX) return no(SEND_ALL_COPY.overCap);
  const filter = { status: rawStatus === "" ? null : (rawStatus as StatusKey), q };
  try {
    return await db.transaction(async (tx): Promise<LinkDone> => {
      const ready = await readyToSend(tx, rosterTag);
      if (!ready.ok) return no(ready.error);
      const b = await readLinkBasics(tx);
      if (b.state !== "listed") return no(SEND_ALL_COPY.changed);
      const shown = sendAllShown(b, await loadOpenWrites(), filter);
      if (shown.sends.length !== count || shown.sends.length > SEND_ALL_MAX || !sendAllStampHolds(filter, count, sendAllKeys(shown.sends), stamp)) return no(SEND_ALL_COPY.changed);
      const pressId = randomUUID();
      const names = new Set<string>();
      for (const s of shown.sends) {
        const r = await queueSendIn(tx, ready, askOf(s), o, { pressId, lock: "try" });
        const name = s.field === "name" ? s.seal.value[1]! : null;
        if (!r.ok) {
          if (r.busy === "record") throw new SendAllRefused(SEND_ALL_COPY.busy(s.about));
          if (r.busy === "family") throw new SendAllRefused(SEND_ALL_COPY.familyBusy(s.about));
          throw new SendAllRefused(name !== null && names.has(nameKey(name)) ? SEND_ALL_COPY.sameName(name) : SEND_ALL_COPY.changed);
        }
        if (name !== null) names.add(nameKey(name));
      }
      const placed = shown.sends.filter((s) => s.field === "place").length;
      await writeAudit({ actor: o.actor, action: "accounting.difference.send_all", permission: o.permission, ip: o.ip, targetType: "accounting_difference", targetId: pressId,
        after: { pressId, count: shown.sends.length, names: shown.sends.length - placed, places: placed, passedOver: shown.passedOver, later: shown.later.length,
          status: filter.status, searched: filter.q !== "", realmId: ready.source } }, tx);
      return { ok: true, message: sentAllWords({ names: shown.sends.length - placed, places: placed, later: shown.later.length, passedOver: shown.passedOver, inactiveListed: shown.inactiveListed }) };
    });
  } catch (e) {
    if (e instanceof SendAllRefused) return no(e.words);
    throw e;
  }
}
/** A send offer as the single press asks it (sendDifferenceAction()): the field, the record and the row's stamp. */
const askOf = (s: SendOffer) => (s.field === "place" ? { field: "place" as const, studentId: s.recordId, stamp: s.stamp } : { field: "name" as const, kind: s.kind, recordId: s.recordId, stamp: s.stamp });
