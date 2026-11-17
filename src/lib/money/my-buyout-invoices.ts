// Parent-facing: which of one family's invoices are its own volunteer buy-outs, so Payments can say so beside the
// invoice's number. It takes the family's id, which the caller takes from the session (ctx.familyQboId), and reads that
// family's buy-outs alone: nothing the browser sends names an invoice. In the staff-only import scan with the rest of
// src/lib/money (tests/integration/page-guards.test.ts).
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, requirement, type StoredInvoice } from "@/lib/db/schema";
import { getRosterSource } from "@/lib/roster/source";

/** An invoice the portal made for this family's buy-out: the customer it was raised on, and the requirement it pays instead of. */
type BuyoutInvoice = { customerQboId: string; requirementTitle: string };
/** By the invoice's QuickBooks id. */
export type MyBuyoutInvoices = ReadonlyMap<string, BuyoutInvoice>;

/**
 * The invoices of the family's own buy-outs, in the company the roster came from (a buy-out of another company is
 * cleared on a change of company anyway). A buy-out another family chose, for a student who has since moved here, is
 * not this family's: its invoice is shown like any other.
 */
export async function loadMyBuyoutInvoices(familyQboId: string): Promise<MyBuyoutInvoices> {
  const realmId = await getRosterSource();
  if (!realmId) return new Map();
  const rows = await db.select({ invoiceQboId: buyout.invoiceQboId, customerQboId: buyout.customerQboId, requirementTitle: requirement.title })
    .from(buyout).innerJoin(requirement, eq(requirement.id, buyout.requirementId))
    .where(and(eq(buyout.familyQboId, familyQboId), eq(buyout.realmId, realmId), isNotNull(buyout.invoiceQboId)));
  return new Map(rows.map((r) => [r.invoiceQboId!, { customerQboId: r.customerQboId, requirementTitle: r.requirementTitle }]));
}

/** The requirement a shown invoice is this family's buy-out for, or null: the same invoice id on the same customer. */
export function buyoutTitleOf(invoices: MyBuyoutInvoices | undefined, invoice: Pick<StoredInvoice, "qboId" | "customerQboId">): string | null {
  const found = invoices?.get(invoice.qboId);
  return found && found.customerQboId === invoice.customerQboId ? found.requirementTitle : null;
}
