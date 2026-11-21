"use server";
import { revalidatePath } from "next/cache";
import { requireStaffActionAlso, staffAction, type StaffCtx } from "@/lib/guards";
import { confirmAllSuggested, leaveUnlinked, LINK_COPY, linkFamilyToCustomer, reviewCarriedOver, sendAllDifferences, undoLeaveUnlinked, unlinkFamily, type LinkDone } from "@/lib/accounting/link-writes";
import { BULK_MAX } from "@/lib/accounting/mapping";
import { isStatusKey, SEARCH_MAX } from "@/lib/accounting/status";
import { isChosen, isGuardianChosen } from "@/lib/accounting/stamp";
import { linkGuardian, unlinkGuardian, type GuardianLinkDone } from "@/lib/accounting/guardian-links";
import { can } from "@/lib/permissions/effective";
import { isUuid } from "@/lib/seasons/ids";
import { familyPage } from "@/app/staff/(app)/family-pages";
import { sendToBooks, takeFromBooks } from "@/lib/roster/writes";

// The accounting links screen's presses (stage 4's slice M3a; src/lib/accounting/link-writes.ts): Confirm (a Suggested
// row's customer, a Several possible row's candidate, or one picked from the customers no family is linked to), Leave
// unlinked and Undo; since slice M3a2, Confirm all exact email matches and Confirm this link (a carried-over link
// confirmed as reviewed); since slice M3b, Unlink from the books; since slice M3c, Link this guardian and Unlink this
// guardian (src/lib/accounting/guardian-links.ts); since slice M4a, Take QuickBooks' into the app. Each needs the
// linking permission, Accounting.Link.ReadWrite (not Admin-only), and also
// Roster.Read, the page's own, checked here first and refused as the guard refuses (requireStaffActionAlso()). A server
// action can be called with any values, not only the ones its page sends: each argument is checked here for its type
// and size, and everything about the family, the customer and the students is checked again in the library, under the
// roster lock. Every answer shows the screen again as it is now.
const P = "Accounting.Link.ReadWrite" as const;
const NOT_FROM_PAGE: LinkDone = { ok: false, errors: [LINK_COPY.notFromPage] };
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const ID_MAX = 64, TAG_MAX = 64, STAMP_MAX = 64;
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P, staffUserId: ctx.staffUserId });
const again = () => revalidatePath("/staff/links");

export const confirmLinkAction = staffAction(P, async (ctx: StaffCtx, familyId: string, customerId: string, chosen: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!str(familyId, ID_MAX) || !str(customerId, ID_MAX) || !isChosen(chosen) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  const r = await linkFamilyToCustomer({ familyId, customerId, chosen, stamp }, rosterTag, op(ctx));
  // A link changes the family's page, the Families pages, Balances and every staff page that lists families.
  if (r.ok) revalidatePath("/", "layout");
  else again();
  return r;
});

export const leaveUnlinkedAction = staffAction(P, async (ctx: StaffCtx, familyId: string, rosterTag: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!str(familyId, ID_MAX) || !str(rosterTag, TAG_MAX)) return NOT_FROM_PAGE;
  const r = await leaveUnlinked(familyId, rosterTag, op(ctx));
  again();
  return r;
});

export const undoLeaveUnlinkedAction = staffAction(P, async (ctx: StaffCtx, familyId: string, rosterTag: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!str(familyId, ID_MAX) || !str(rosterTag, TAG_MAX)) return NOT_FROM_PAGE;
  const r = await undoLeaveUnlinked(familyId, rosterTag, op(ctx));
  again();
  return r;
});

/**
 * Confirm all exact email matches (slice M3a2): the filter as the page parsed it (its status key, "" for none, and its
 * search), how many Suggested rows it showed, the roster tag and the stamp sealing those rows. No family, customer or
 * student comes from the browser: the library works the rows out again under the roster lock.
 */
export const confirmAllAction = staffAction(P, async (ctx: StaffCtx, status: string, q: string, count: number, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (typeof status !== "string" || !(status === "" || isStatusKey(status)) || typeof q !== "string" || q.length > SEARCH_MAX || typeof count !== "number" || !Number.isInteger(count)
    || count < 1 || count > BULK_MAX || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  const r = await confirmAllSuggested({ status, q, count, stamp }, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  else again();
  return r;
});

/** Confirm this link (slice M3a2): the family's app id, its carried-over family link's id, the roster tag and the stamp. */
export const reviewLinkAction = staffAction(P, async (ctx: StaffCtx, familyId: string, linkId: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!str(familyId, ID_MAX) || !str(linkId, ID_MAX) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  const r = await reviewCarriedOver({ familyId, linkId, stamp }, rosterTag, op(ctx));
  again();
  return r;
});

/**
 * Unlink from the books (slice M3b): the family's app id, its family link's id, the roster tag and the stamp. No
 * customer or student comes from the browser: the library reads the links again under the roster lock.
 */
export const unlinkAction = staffAction(P, async (ctx: StaffCtx, familyId: string, linkId: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!str(familyId, ID_MAX) || !str(linkId, ID_MAX) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  const r = await unlinkFamily({ familyId, linkId, stamp }, rosterTag, op(ctx));
  // An unlink changes the family's page, the Families pages, Balances and every staff page that lists families.
  if (r.ok) revalidatePath("/", "layout");
  else again();
  return r;
});

/** A guardian press's answer, its family's page shown again on success: the family's id stays on the server. */
const shownAgain = (r: GuardianLinkDone): LinkDone => {
  again();
  if (!r.ok) return r;
  if ("familyId" in r) revalidatePath(familyPage(r.familyId));
  return { ok: true, message: r.message };
};

/**
 * Link this guardian (slice M3c): the guardian row's id, the Parent customer chosen from its row's candidates, how it was
 * chosen (`suggested` or `picked`), the roster tag and the stamp. The library works the row's candidates out again
 * under the roster lock.
 */
export const linkGuardianAction = staffAction(P, async (ctx: StaffCtx, guardianId: string, customerId: string, chosen: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!isUuid(guardianId) || !str(customerId, ID_MAX) || !/^\d{1,19}$/.test(customerId) || !isGuardianChosen(chosen) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  return shownAgain(await linkGuardian({ guardianId, customerId, chosen, stamp }, rosterTag, op(ctx)));
});

/** Unlink this guardian (slice M3c): the guardian row's id, its link's id, the roster tag and the stamp. */
export const unlinkGuardianAction = staffAction(P, async (ctx: StaffCtx, guardianId: string, linkId: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!isUuid(guardianId) || !isUuid(linkId) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  return shownAgain(await unlinkGuardian({ guardianId, linkId, stamp }, rosterTag, op(ctx)));
});

/**
 * Take QuickBooks' into the app (slice M4a): what the row's difference takes (`name`, `inactive` or `place`, and since
 * slice M4b `active`), the kind of record (`family` or `student`; a place is always a student's), the record's app id,
 * the roster tag and the stamp sealing the value the row showed. The linking permission and the page's Roster.Read
 * settle it (the owner's choice 6, as recommended): nothing is sent to the books but the buy-out void a student's move
 * brings, as any move's, and the library works the value out again under the roster lock. A record made active again
 * holds its family's sign-ins, which only Roster.Family.ReadWrite releases (releaseSigninHoldAction(), ../parents/actions.ts).
 */
export const takeDifferenceAction = staffAction(P, async (ctx: StaffCtx, field: string, kind: string, recordId: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  if (!(field === "name" || field === "inactive" || field === "active" || field === "place") || !(kind === "family" || kind === "student") || (field === "place" && kind !== "student")
    || !str(recordId, ID_MAX) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  const r = await takeFromBooks(field === "place" ? { field, studentId: recordId, stamp } : { field, kind, recordId, stamp }, rosterTag, op(ctx));
  // A name, a record made inactive or active again, or a student moved changes the Families pages, Balances and the family's pages.
  if (r.ok) revalidatePath("/", "layout");
  else again();
  return r;
});

/**
 * Send the app's to QuickBooks (slice M5a): what the row's difference sends (`name`, `inactive` or `place`), the kind
 * of record (`family` or `student`; a place is always a student's), the record's app id, the roster tag and the stamp
 * sealing the value the row showed. It sends the portal's value over the books', so it needs Roster.Family.ReadWrite
 * too, the permission that changes families (the owner's choice 6, which he confirmed on 2026-11-21, as
 * "Create in QuickBooks and link" needs both), checked here first with the page's Roster.Read and refused as the guard
 * refuses. A balance that stops a make-inactive is said with its amount only for a holder of Finance.Balance.Read, as on
 * a family's page. The library works the value out again under the roster lock, and sends through today's writes alone.
 */
export const sendDifferenceAction = staffAction(P, async (ctx: StaffCtx, field: string, kind: string, recordId: string, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  await requireStaffActionAlso(ctx, "Roster.Family.ReadWrite");
  if (!(field === "name" || field === "inactive" || field === "place") || !(kind === "family" || kind === "student") || (field === "place" && kind !== "student")
    || !str(recordId, ID_MAX) || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  const { changed, ...r } = await sendToBooks(field === "place" ? { field, studentId: recordId, stamp } : { field, kind, recordId, stamp }, rosterTag,
    { ...op(ctx), showAmounts: can(ctx.effective, "Finance.Balance.Read") });
  // A name, a student's family or an inactive record sent changes the Families pages, Reconciliation and the family's
  // pages; since slice M5b a layered family's make-inactive stopped part way may have changed them too (`changed`, as
  // the family page's own action revalidates on it), and `changed` itself stays on the server.
  if (r.ok || changed === true) revalidatePath("/", "layout");
  else again();
  return r;
});

/**
 * Send the app's for all (slice M5b): the filter as the page parsed it (its status key, "" for none, and its search),
 * how many sends it showed, the roster tag and the stamp sealing them. It needs what a single send needs (the linking
 * permission, Roster.Read and Roster.Family.ReadWrite: the owner's choice 6, which he confirmed on 2026-11-21),
 * checked first and refused as the guard refuses. No record, customer or value comes from the browser: the
 * library works the sends out again under the roster lock, queues them all or none, and sends nothing at the press.
 */
export const sendAllAction = staffAction(P, async (ctx: StaffCtx, status: string, q: string, count: number, rosterTag: string, stamp: string): Promise<LinkDone> => {
  await requireStaffActionAlso(ctx, "Roster.Read");
  await requireStaffActionAlso(ctx, "Roster.Family.ReadWrite");
  if (typeof status !== "string" || !(status === "" || isStatusKey(status)) || typeof q !== "string" || q.length > SEARCH_MAX || typeof count !== "number" || !Number.isInteger(count)
    || count < 1 || !str(rosterTag, TAG_MAX) || !str(stamp, STAMP_MAX)) return NOT_FROM_PAGE;
  // More than SEND_ALL_MAX is refused by the library, in words that say to narrow the list.
  const r = await sendAllDifferences({ status, q, count, stamp }, rosterTag, op(ctx));
  // Names and students' families queued change Reconciliation and the family's pages (each item is listed there).
  if (r.ok) revalidatePath("/", "layout");
  else again();
  return r;
});
