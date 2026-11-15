import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { familyMoney, setting } from "@/lib/db/schema";
import { MONEY_KEY } from "@/lib/money/settings";
import { setRosterSource } from "@/lib/roster/source";
import { MONEY_REALM, type ParentFamilySpec } from "./parent";
import { seedConnected, type QboStub } from "./qbo-stub";

/**
 * For tests that let the portal read invoices from the stub QuickBooks (tests/helpers/qbo-stub.ts). The families here
 * have numbers for QuickBooks ids, as real ones do: an id that isn't digits is never sent to QuickBooks, so FAMILY_A
 * and FAMILY_B (tests/helpers/parent.ts) only ever show money that seedFamilyMoney() stored.
 */
export const RIVERA: ParentFamilySpec = {
  family: { qboId: "7010", name: "Riverquill Family" },
  parent: { qboId: "7011", name: "Rosalind Riverquill", email: "rosalind.riverquill@family-r.example", phone: "512-555-0191" },
  students: [{ qboId: "7012", name: "Rafferty Riverquill" }, { qboId: "7013", name: "Romilly Riverquill" }],
};
export const CHENOWETH: ParentFamilySpec = {
  family: { qboId: "8010", name: "Chenoweth Family" },
  parent: { qboId: "8011", name: "Cordelia Chenoweth", email: "cordelia.chenoweth@family-c.example", phone: "737-555-0192" },
  students: [{ qboId: "8012", name: "Caspian Chenoweth" }, { qboId: "8013", name: "Clementine Chenoweth" }],
};

/** An invoice as QuickBooks sends one: $85.00, all of it still due, unless `extra` says otherwise. */
export const stubInvoice = (Id: string, customer: string, extra: Record<string, unknown> = {}) =>
  ({ Id, DocNumber: `INV-${Id}`, CustomerRef: { value: customer }, TotalAmt: 85, Balance: 85, TxnDate: "2026-11-01", DueDate: "2026-12-01", ...extra });

/** QuickBooks connected to a company the stub answers for, and the roster cache marked as read from that company. */
export async function connectCompany(stub: QboStub, realmId = MONEY_REALM): Promise<void> {
  await seedConnected(stub, { realmId });
  await db.transaction((tx) => setRosterSource(tx, realmId));
}

export const moneyRow = async (familyQboId: string) => (await db.select().from(familyMoney).where(eq(familyMoney.familyQboId, familyQboId)))[0];
export const invoiceQueries = (stub: QboStub) => stub.apiCalls().filter((c) => c.path.endsWith("/query")).map((c) => c.query.get("query"));

/** The stored freshness window (src/lib/money/settings.ts). */
export async function setFreshSeconds(freshSeconds: number): Promise<void> {
  const value = { freshSeconds };
  await db.insert(setting).values({ key: MONEY_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value } });
}

/** Makes what is stored for a family older, so the next page load finds it stale, or lets a failed try age past the wait before the next one. */
export async function ageMoney(familyQboId: string, ms: number): Promise<void> {
  const row = await moneyRow(familyQboId);
  if (!row) throw new Error(`ageMoney: nothing is stored for ${familyQboId}`);
  const back = (d: Date | null) => (d ? new Date(d.getTime() - ms) : null);
  await db.update(familyMoney).set({ readAt: back(row.readAt), failedAt: back(row.failedAt), mismatchAuditedAt: back(row.mismatchAuditedAt) }).where(eq(familyMoney.familyQboId, familyQboId));
}
