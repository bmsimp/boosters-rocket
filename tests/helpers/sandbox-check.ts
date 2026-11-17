// The check of the portal's own QuickBooks requests in tests (src/lib/quickbooks/sandbox-check/): a company connected
// through the QuickBooks stub with products, services and a few invoices to read, and the stub's switches set the way
// the portal expects a real company to answer.
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCheckRecord, qboCheckRun, qboConnection, type CheckResult } from "@/lib/db/schema";
import { connectRoster } from "./roster-writes";
import { defaultQuirks, type QboStub } from "./qbo-stub";

/** The product the check puts on its invoice (the first active service), and one that is inactive. */
export const CHECK_ITEMS = [
  { Id: "7", Name: "Volunteer buy-out", Type: "Service", Active: true },
  { Id: "8", Name: "Old fee", Type: "NonInventory", Active: false },
];

/** An invoice as the reads find one: a sales line naming a product on the list, a subtotal, a Pay link. */
export const readInvoice = (Id: string, customer: string, o: Record<string, unknown> = {}) => ({
  Id, SyncToken: "0", DocNumber: `D${Id}`, TxnDate: "2026-10-01", DueDate: "2026-11-01", TotalAmt: 50, Balance: 50, CustomerRef: { value: customer },
  Line: [{ DetailType: "SalesItemLineDetail", Amount: 50, SalesItemLineDetail: { ItemRef: { value: "7" }, Qty: 1 } }, { DetailType: "SubTotalLineDetail", Amount: 50, SubTotalLineDetail: {} }],
  InvoiceLink: `https://connect.intuit.com/t/scs-v1-read-${Id}`, ...o,
});

/** Every switch of the stub set as the portal expects of a real company (the roadmap's checks table and the client's comments). */
export function intuitLike(stub: QboStub): void {
  stub.quirks = {
    ...defaultQuirks(), fullNames: true, balances: true, checkEmail: true, limitCode: "6000",
    limits: { "PrimaryPhone.FreeFormNumber": 30, "BillAddr.Line1": 500, "BillAddr.City": 255, "BillAddr.PostalCode": 30, "PrimaryEmailAddr.Address": 100 },
  };
}

/**
 * The FZN-shaped company of the stub, connected as an Intuit sandbox and its roster read (connectRoster), with
 * products and services and two invoices to read, and the stub answering as the portal expects (intuitLike).
 */
export async function checkCompany(stub: QboStub, o: { environment?: "sandbox" | "production" } = {}): Promise<void> {
  await connectRoster(stub);
  stub.items = CHECK_ITEMS.map((i) => ({ ...i }));
  stub.invoices = [readInvoice("901", "10"), readInvoice("902", "12")];
  intuitLike(stub);
  if (o.environment === "production") await db.update(qboConnection).set({ environment: "production" });
}

/** The newest run of the check, and its result for each request by key. */
export async function lastRun() {
  const [run] = await db.select().from(qboCheckRun).orderBy(desc(qboCheckRun.startedAt)).limit(1);
  if (!run) throw new Error("no run of the check");
  const byKey = Object.fromEntries(run.results.map((r) => [r.key, r])) as Record<string, CheckResult>;
  return { run, byKey };
}

/** The records a run of the check listed as its own. */
export const recordsOf = (runId: string) => db.select().from(qboCheckRecord).where(eq(qboCheckRecord.runId, runId));
