"use server";
import { revalidatePath } from "next/cache";
import { requireStaffActionAlso, staffAction, type StaffCtx } from "@/lib/guards";
import { leaveUnlinked, LINK_COPY, linkFamilyToCustomer, undoLeaveUnlinked, type LinkDone } from "@/lib/accounting/link-writes";
import { isChosen } from "@/lib/accounting/stamp";

// The accounting links screen's presses (stage 4's slice M3a; src/lib/accounting/link-writes.ts): Confirm (a Suggested
// row's customer, a Several possible row's candidate, or one picked from the customers no family is linked to), Leave
// unlinked and Undo. Each needs the linking permission, Accounting.Link.ReadWrite (not Admin-only), and also
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
