"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { familyFromCustomer, NO_FAMILY_COPY } from "@/lib/roster/no-family";

// "Create a family from this", on Reconciliation's list of customers with no family (src/lib/roster/no-family.ts). It
// needs the linking permission, Accounting.Link.ReadWrite, and also Roster.Read, the page's own permission. A server
// action can be called with any values, not only the ones its page sends: it takes one, the customer's QuickBooks id,
// checked here for its type and size and in the library for its digits, and everything about the customer is checked
// again there, under the roster lock.
const P = "Accounting.Link.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE = { ok: false as const, errors: [NO_FAMILY_COPY.notFromPage] };
const ID_MAX = 64;

export const familyFromCustomerAction = staffAction(P, async (ctx: StaffCtx, customerQboId: string): Promise<Done> => {
  if (!can(ctx.effective, "Roster.Read") || typeof customerQboId !== "string" || customerQboId.length === 0 || customerQboId.length > ID_MAX) return NOT_FROM_PAGE;
  const r = await familyFromCustomer(customerQboId, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P, staffUserId: ctx.staffUserId });
  // The new family shows on the Families pages and every staff page that lists families.
  if (r.ok) revalidatePath("/", "layout");
  return r;
});
