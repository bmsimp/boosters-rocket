// Staff only: the buy-outs staff must look at, for the Reconciliation page. It lists every family's, so it is never
// imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). Names are QuickBooks text,
// shown as text only.
import "server-only";
import { and, desc, gt, inArray, isNotNull, or, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, qboCustomer, requirement } from "@/lib/db/schema";

/** A refused buy-out is listed this long after it was refused: the family has been told, and may choose again. */
const REFUSED_SHOWN_MS = 30 * 86_400_000;

export type BuyoutToLook = {
  id: string; familyQboId: string; familyName: string | null; subjectName: string | null; requirement: string;
  amountCents: number; state: string; flag: string | null; code: string | null; at: string;
  /** What it is, in words, for the treasurer. */
  words: string;
};

const FLAG_WORDS: Record<string, string> = {
  missing: "QuickBooks no longer shows this invoice to the family: it was voided or deleted there. Check it in QuickBooks.",
  other_customer: "The invoice is on another customer in QuickBooks than the one it was made for. Check it in QuickBooks.",
  student_moved: "The student it was billed to has moved to another family. If anything was paid on the invoice, the treasurer sorts it out in QuickBooks.",
  paid_before_void: "The family switched back to volunteering, but something was paid on the invoice, so the portal didn't void it. Sort it out in QuickBooks.",
  void_refused: "QuickBooks refused to void this invoice, so it is as it was. Check it in QuickBooks.",
  given_up: "A change to this buy-out's invoice was given up before QuickBooks said whether it went through. Check it in QuickBooks.",
};
const STATE_WORDS: Record<string, string> = {
  refused: "QuickBooks refused the invoice, so nothing was billed. The family was told to ask the club.",
  stuck: "A change to this buy-out's invoice is stuck: it won't be tried again until someone asks, above.",
};

/** Every buy-out flagged for staff, stuck, or refused in the last 30 days, newest first, with the family, the requirement and the amount. */
export async function loadBuyoutsToLook(now: Date = new Date()): Promise<BuyoutToLook[]> {
  const rows = await db.select({ b: buyout, title: requirement.title }).from(buyout).innerJoin(requirement, eq(requirement.id, buyout.requirementId))
    .where(or(isNotNull(buyout.flag), eq(buyout.state, "stuck"), and(eq(buyout.state, "refused"), gt(buyout.updatedAt, new Date(now.getTime() - REFUSED_SHOWN_MS)))))
    .orderBy(desc(buyout.updatedAt));
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap(({ b }) => [b.familyQboId, b.subjectQboId]))];
  const names = new Map((await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, ids))).map((c) => [c.qboId, c.name]));
  return rows.map(({ b, title }) => ({
    id: b.id, familyQboId: b.familyQboId, familyName: names.get(b.familyQboId) ?? null, subjectName: b.subjectQboId === b.familyQboId ? null : names.get(b.subjectQboId) ?? null,
    requirement: title, amountCents: b.amountCents, state: b.state, flag: b.flag, code: b.lastCode, at: (b.flaggedAt ?? b.updatedAt).toISOString(),
    words: (b.flag ? FLAG_WORDS[b.flag] : null) ?? STATE_WORDS[b.state] ?? "Worth a look.",
  }));
}
