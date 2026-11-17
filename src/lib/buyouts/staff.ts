// Staff only: the buy-outs staff must look at, for the Reconciliation page, and one family's buy-outs, for its own
// staff page. The first lists every family's, so neither is ever imported by parent code (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). Names are QuickBooks text, shown as text only.
import "server-only";
import { and, desc, gt, inArray, isNotNull, or, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, qboCustomer, requirement, writeQueue } from "@/lib/db/schema";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";
import { closeVerdict, type CloseItem, type CloseVerdict } from "./closing";
import { BUYOUT_WORDS, isLive } from "./rules";

/** A refused buy-out is listed this long after it was refused: the family has been told, and may choose again. */
const REFUSED_SHOWN_MS = 30 * 86_400_000;

type Row = typeof buyout.$inferSelect;

export type BuyoutToLook = {
  id: string; familyQboId: string; familyName: string | null; subjectName: string | null; requirement: string;
  amountCents: number; state: string; flag: string | null; code: string | null; at: string;
  /** What it is, in words, for the treasurer. */
  words: string;
  /** Whether staff may close it, and what closing does or what to do in QuickBooks first (./closing.ts). */
  close: CloseVerdict;
  /** The buy-out as the page showed it: a close is refused when it has changed since (./close.ts). */
  tag: string;
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

/**
 * The buy-out as a page shows it, for the close to compare with: its state, its flag and when it last changed. Anything
 * the worker, the daily check or a guardian did to it since changes the tag.
 */
export const closeTag = (b: Pick<Row, "state" | "flag" | "updatedAt">): string => `${b.state}.${b.flag ?? "-"}.${b.updatedAt.getTime()}`;

/**
 * Every queue item made for these buy-outs, by buy-out id (a buy-out's items name it in `request.buyoutId`), newest
 * first. In a transaction (`tx`) they are locked, for the close (./close.ts).
 */
export async function itemsOf(ids: readonly string[], tx?: Tx): Promise<Map<string, (CloseItem & { id: string })[]>> {
  const out = new Map<string, (CloseItem & { id: string })[]>();
  if (ids.length === 0) return out;
  const q = (tx ?? db).select({ id: writeQueue.id, request: writeQueue.request, state: writeQueue.state, sent: writeQueue.sent }).from(writeQueue)
    .where(inArray(sql`${writeQueue.request}->>'buyoutId'`, [...ids])).orderBy(desc(writeQueue.createdAt));
  const rows = tx ? await q.for("update") : await q;
  for (const r of rows) {
    if (r.request.op !== "invoice_create" && r.request.op !== "invoice_void") continue;
    const list = out.get(r.request.buyoutId) ?? [];
    list.push({ id: r.id, op: r.request.op, state: r.state, sent: r.sent });
    out.set(r.request.buyoutId, list);
  }
  return out;
}

export const verdictOf = (b: Row, items: readonly CloseItem[]): CloseVerdict =>
  closeVerdict({ state: b.state, flag: b.flag, lastCode: b.lastCode, invoiceQboId: b.invoiceQboId, items });

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return new Map((await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, ids))).map((c) => [c.qboId, c.name]));
}

/** Every buy-out flagged for staff, stuck, or refused in the last 30 days, newest first, with the family, the requirement and the amount. */
export async function loadBuyoutsToLook(now: Date = new Date()): Promise<BuyoutToLook[]> {
  const rows = await db.select({ b: buyout, title: requirement.title }).from(buyout).innerJoin(requirement, eq(requirement.id, buyout.requirementId))
    .where(or(isNotNull(buyout.flag), eq(buyout.state, "stuck"), and(eq(buyout.state, "refused"), gt(buyout.updatedAt, new Date(now.getTime() - REFUSED_SHOWN_MS)))))
    .orderBy(desc(buyout.updatedAt));
  if (rows.length === 0) return [];
  const [names, items] = await Promise.all([namesOf([...new Set(rows.flatMap(({ b }) => [b.familyQboId, b.subjectQboId]))]), itemsOf(rows.map(({ b }) => b.id))]);
  return rows.map(({ b, title }) => ({
    id: b.id, familyQboId: b.familyQboId, familyName: names.get(b.familyQboId) ?? null, subjectName: b.subjectQboId === b.familyQboId ? null : names.get(b.subjectQboId) ?? null,
    requirement: title, amountCents: b.amountCents, state: b.state, flag: b.flag, code: b.lastCode, at: (b.flaggedAt ?? b.updatedAt).toISOString(),
    words: (b.flag ? FLAG_WORDS[b.flag] : null) ?? STATE_WORDS[b.state] ?? "Worth a look.",
    close: verdictOf(b, items.get(b.id) ?? []), tag: closeTag(b),
  }));
}

/** How a buy-out stands, in words for staff: the words a parent reads while it is live, and how it ended once it has. */
export function stateWords(b: Pick<Row, "state" | "endReason">): string {
  if (isLive(b.state)) return BUYOUT_WORDS[b.state as keyof typeof BUYOUT_WORDS];
  if (b.state === "refused") return "Refused by QuickBooks: nothing was billed";
  switch (b.endReason) {
    case "switched_back": return "Ended: the family switched back to volunteering, and the invoice was voided";
    case "student_moved": return "Ended: the student moved to another family, and the invoice was voided";
    case "voided_in_quickbooks": return "Ended: the invoice was voided in QuickBooks";
    case "closed_by_staff": return "Closed by staff: nothing was sent to QuickBooks";
    default: return "Ended";
  }
}

/**
 * What the family's stored figures last said of the buy-out's invoice: none made, not among them, open, part paid,
 * paid or voided. `owedCents`: what is still owed on it, said only to staff who may see money.
 */
export type InvoiceAsRead = { kind: "none" | "not_read" | "open" | "part_paid" | "paid" | "voided"; owedCents: number | null; readAt: string | null };

export type FamilyBuyout = {
  id: string; requirement: string; subjectName: string | null; amountCents: number; state: string; words: string; flag: string | null; flagWords: string | null;
  code: string | null; chosenAt: string; changedAt: string; invoice: InvoiceAsRead; close: CloseVerdict; tag: string;
};

/**
 * One family's buy-outs, every state, newest first: the ones it chose (`buyout.family_qbo_id`), with the requirement,
 * who it was for, the amount, how it stands, what the family's stored figures last said of its invoice, and whether
 * staff may close it. The family's own figures only, and only from the company the buy-out's invoice is in and the
 * roster came from.
 */
export async function loadFamilyBuyouts(familyQboId: string): Promise<{ familyName: string | null; buyouts: FamilyBuyout[] }> {
  const rows = await db.select({ b: buyout, title: requirement.title }).from(buyout).innerJoin(requirement, eq(requirement.id, buyout.requirementId))
    .where(eq(buyout.familyQboId, familyQboId)).orderBy(desc(buyout.createdAt));
  const [names, items, money, source] = await Promise.all([namesOf([familyQboId, ...new Set(rows.map(({ b }) => b.subjectQboId))]), itemsOf(rows.map(({ b }) => b.id)),
    moneyRows([familyQboId]), getRosterSource()]);
  const row = money.get(familyQboId);
  return { familyName: names.get(familyQboId) ?? null, buyouts: rows.map(({ b, title }) => {
    const figures = row?.invoices && row.readAt && row.realmId === b.realmId && row.realmId === source ? row : null;
    const inv = b.invoiceQboId && figures ? figures.invoices!.find((i) => i.qboId === b.invoiceQboId) ?? null : null;
    const invoice: InvoiceAsRead = !b.invoiceQboId ? { kind: "none", owedCents: null, readAt: null }
      : !inv ? { kind: "not_read", owedCents: null, readAt: figures?.readAt?.toISOString() ?? null }
        : { kind: inv.totalCents === 0 ? "voided" : inv.balanceCents <= 0 ? "paid" : inv.balanceCents < inv.totalCents ? "part_paid" : "open",
          owedCents: inv.totalCents > 0 && inv.balanceCents > 0 ? inv.balanceCents : null, readAt: figures!.readAt!.toISOString() };
    return {
      id: b.id, requirement: title, subjectName: b.subjectQboId === b.familyQboId ? null : names.get(b.subjectQboId) ?? "A student no longer on the roster",
      amountCents: b.amountCents, state: b.state, words: stateWords(b), flag: b.flag, flagWords: b.flag ? FLAG_WORDS[b.flag] ?? null : null, code: b.lastCode,
      chosenAt: b.createdAt.toISOString(), changedAt: b.updatedAt.toISOString(), invoice, close: verdictOf(b, items.get(b.id) ?? []), tag: closeTag(b),
    };
  }) };
}
