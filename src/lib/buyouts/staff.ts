// Staff only: the buy-outs staff must look at, for the Reconciliation page, and one family's buy-outs, for its own
// staff page. The first lists every family's, so neither is ever imported by parent code (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). Names are QuickBooks text, shown as text only. A buy-out names the app's own
// family and student, and so does a family's buy-outs page's address (stage 3 of the app-owned families spec); names
// are still read from the roster cache, by the family's and the student's customers: the family's through its record's
// link, in the records' company, the student's as the customer its invoice is billed to. Reconciliation's list is the
// roster's company's buy-outs; beside it, the treasurer's list of an earlier company's (stage 4's slice M7b,
// loadEarlierCompanyBuyouts()) names them by the app's own records, since the earlier company's customers are gone from
// the cache, and says what each leaves to settle in that company's books (earlierCompanyLook(), ./closing.ts).
import "server-only";
import { and, asc, desc, gt, inArray, isNotNull, ne, or, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, family, qboCustomer, requirement, seasonStep, student, writeQueue } from "@/lib/db/schema";
import { customerOfFamily, linksOf } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";
import { closeVerdict, earlierCompanyLook, type CloseItem, type CloseVerdict, type EarlierKind, type EarlierLook, type LookItem } from "./closing";
import { BUYOUT_WORDS, isLive } from "./rules";

/** A refused buy-out is listed this long after it was refused: the family has been told, and may choose again. */
const REFUSED_SHOWN_MS = 30 * 86_400_000;

type Row = typeof buyout.$inferSelect;

export type BuyoutToLook = {
  /**
   * `familyId`: the family that chose it, whose pages the links address. `familyQboId`: its customer; null when its
   * record has no link in the roster's company, when the page offers no links to the family.
   */
  id: string; familyId: AppFamilyId; familyQboId: string | null; familyName: string | null; subjectName: string | null; requirement: string;
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
  student_moved: "The student it was billed to has moved to another family, or is no longer active, in QuickBooks. If anything was paid on the invoice, the treasurer sorts it out in QuickBooks.",
  paid_before_void: "The family switched back to volunteering, but something was paid on the invoice, so the portal didn't void it. Sort it out in QuickBooks.",
  void_refused: "QuickBooks refused to void this invoice, so it is as it was. Check it in QuickBooks.",
  given_up: "A change to this buy-out's invoice was given up before QuickBooks said whether it went through. Check it in QuickBooks.",
};
const STATE_WORDS: Record<string, string> = {
  refused: "QuickBooks refused the invoice, so nothing was billed. The family was told to ask the club.",
  stuck: "A change to this buy-out's invoice is stuck: it won't be tried again until someone asks, above.",
};
/**
 * A refused buy-out whose code says why: the invoice carries the sign-in address of the guardian who chose it, as its
 * bill-to address, and QuickBooks (2210, as the check saw for a field that isn't an address) or the portal itself
 * (`bad_email`: longer than QuickBooks takes, or not an address) wouldn't take it.
 */
const ADDRESS_REFUSED = "QuickBooks wouldn't take the sign-in email address of the guardian who chose this as the invoice's bill-to address, so nothing was billed. "
  + "The family was told to ask the club: check that guardian's email address (on their own customer in QuickBooks, and on their Parents page here), then they can choose to pay instead again.";
const REFUSED_CODE_WORDS: Record<string, string> = { fault_2210: ADDRESS_REFUSED, bad_email: ADDRESS_REFUSED };
const wordsOf = (b: Row): string =>
  (b.flag ? FLAG_WORDS[b.flag] : null) ?? (b.state === "refused" && b.lastCode ? REFUSED_CODE_WORDS[b.lastCode] : null) ?? STATE_WORDS[b.state] ?? "Worth a look.";

/**
 * The buy-out as a page shows it, for the close to compare with: its state, its flag and when it last changed. Anything
 * the worker, the daily check or a guardian did to it since changes the tag.
 */
export const closeTag = (b: Pick<Row, "state" | "flag" | "updatedAt">): string => `${b.state}.${b.flag ?? "-"}.${b.updatedAt.getTime()}`;

/**
 * Every queue item made for these buy-outs, by buy-out id (a buy-out's items name it in `request.buyoutId`), newest
 * first, each with the invoice QuickBooks made for it (`result_qbo_id`, kept on a create given up meanwhile too:
 * earlierCompanyLook() reads it). In a transaction (`tx`) they are locked, for the close (./close.ts).
 */
export async function itemsOf(ids: readonly string[], tx?: Tx): Promise<Map<string, (LookItem & { id: string })[]>> {
  const out = new Map<string, (LookItem & { id: string })[]>();
  if (ids.length === 0) return out;
  const q = (tx ?? db).select({ id: writeQueue.id, request: writeQueue.request, state: writeQueue.state, sent: writeQueue.sent, resultQboId: writeQueue.resultQboId }).from(writeQueue)
    .where(inArray(sql`${writeQueue.request}->>'buyoutId'`, [...ids])).orderBy(desc(writeQueue.createdAt));
  const rows = tx ? await q.for("update") : await q;
  for (const r of rows) {
    // A buy-out's invoice write is never kept as refused (only a roster change saved in the portal first is).
    if ((r.request.op !== "invoice_create" && r.request.op !== "invoice_void") || r.state === "refused") continue;
    const list = out.get(r.request.buyoutId) ?? [];
    list.push({ id: r.id, op: r.request.op, state: r.state, sent: r.sent, resultQboId: r.resultQboId });
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

/**
 * Every buy-out of the roster's company flagged for staff, stuck, or refused in the last 30 days, newest first, with the
 * family, the requirement and the amount. An earlier company's (its `realm_id` not the roster's) is the treasurer's
 * list's alone (loadEarlierCompanyBuyouts()), so none is listed twice or with a kept flag's words; none while the
 * roster names no company.
 */
export async function loadBuyoutsToLook(now: Date = new Date()): Promise<BuyoutToLook[]> {
  const source = await getRosterSource();
  if (source === null) return [];
  const rows = await db.select({ b: buyout, title: requirement.title }).from(buyout).innerJoin(requirement, eq(requirement.id, buyout.requirementId))
    .where(and(eq(buyout.realmId, source),
      or(isNotNull(buyout.flag), eq(buyout.state, "stuck"), and(eq(buyout.state, "refused"), gt(buyout.updatedAt, new Date(now.getTime() - REFUSED_SHOWN_MS))))))
    .orderBy(desc(buyout.updatedAt));
  if (rows.length === 0) return [];
  const links = await linksOf({ families: [...new Set(rows.map(({ b }) => b.familyId))], students: [] });
  const customerOf = (b: Row) => links.customerOfFamily.get(b.familyId) ?? null;
  // A per-student buy-out is billed to the student's own customer: its name is the student's.
  const named = rows.flatMap(({ b }) => [customerOf(b), b.studentId === null ? null : b.customerQboId]).filter((c): c is string => c !== null);
  const [names, items] = await Promise.all([namesOf([...new Set(named)]), itemsOf(rows.map(({ b }) => b.id))]);
  return rows.map(({ b, title }) => ({
    id: b.id, familyId: b.familyId, familyQboId: customerOf(b), familyName: names.get(customerOf(b) ?? "") ?? null, subjectName: b.studentId === null ? null : names.get(b.customerQboId) ?? null,
    requirement: title, amountCents: b.amountCents, state: b.state, flag: b.flag, code: b.lastCode, at: (b.flaggedAt ?? b.updatedAt).toISOString(),
    words: wordsOf(b),
    close: verdictOf(b, items.get(b.id) ?? []), tag: closeTag(b),
  }));
}

/**
 * What an earlier QuickBooks company's buy-out may have left in that company's books, for the treasurer to settle there
 * by hand (stage 4's slice M7b): what earlierCompanyLook() (./closing.ts) says of it, named by the app's own records
 * (the family's and the student's names: the earlier company's customers are gone from the roster cache), with the
 * requirement and its season (whose progress page is where a waiver is given), the amount, the earlier company, the
 * invoice or the note to search for, and since when. `close`: for a refund owed only, what closeVerdict() says (its
 * `paid_in_full`), the close this list offers; null for every other row.
 */
export type EarlierCompanyBuyout = {
  id: string; familyId: AppFamilyId; familyName: string; subjectName: string | null; requirement: string; seasonId: string;
  amountCents: number; realmId: string; invoiceQboId: string | null; note: string | null; at: string;
  kind: Exclude<EarlierKind, "nothing_to_settle">; madeAfter: boolean; words: string;
  close: CloseVerdict | null; tag: string;
};

/** The words for a family or a student the portal never knew a name for. */
export const NO_FAMILY_NAME = "A family with no name";
export const NO_STUDENT_NAME = "a student with no name";

const lookOf = (b: Row, items: readonly LookItem[]): EarlierLook =>
  earlierCompanyLook({ id: b.id, state: b.state, endReason: b.endReason, flag: b.flag, lastCode: b.lastCode, invoiceQboId: b.invoiceQboId, items });

/**
 * Every buy-out of another QuickBooks company than the roster's (decision 4 of stage 4's slice M7b: by its `realm_id`,
 * so the paid ones a change of company kept are read beside the ones it ended), newest first, that leaves something to
 * settle there; none while the roster names no company. It lists many families, so it is not audited, as
 * Reconciliation is not.
 */
export async function loadEarlierCompanyBuyouts(): Promise<EarlierCompanyBuyout[]> {
  const source = await getRosterSource();
  if (source === null) return [];
  const rows = await db.select({ b: buyout, title: requirement.title, seasonId: seasonStep.seasonId, familyName: family.name, studentName: student.name }).from(buyout)
    .innerJoin(requirement, eq(requirement.id, buyout.requirementId)).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId))
    .innerJoin(family, eq(family.id, buyout.familyId)).leftJoin(student, eq(student.id, buyout.studentId))
    .where(ne(buyout.realmId, source)).orderBy(desc(buyout.updatedAt), asc(buyout.id));
  if (rows.length === 0) return [];
  const items = await itemsOf(rows.map(({ b }) => b.id));
  return rows.flatMap(({ b, title, seasonId, familyName, studentName }) => {
    const own = items.get(b.id) ?? [];
    const look = lookOf(b, own);
    if (look.kind === "nothing_to_settle") return [];
    return [{
      id: b.id, familyId: b.familyId, familyName: familyName ?? NO_FAMILY_NAME, subjectName: b.studentId === null ? null : studentName ?? NO_STUDENT_NAME,
      requirement: title, seasonId, amountCents: b.amountCents, realmId: b.realmId, invoiceQboId: look.invoiceQboId, note: look.note, at: b.updatedAt.toISOString(),
      kind: look.kind, madeAfter: look.madeAfter, words: look.words, close: look.kind === "refund_owed" ? verdictOf(b, own) : null, tag: closeTag(b),
    }];
  });
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
    case "earlier_company": return "Ended when the club connected a different QuickBooks company: nothing more was sent to the earlier one";
    default: return "Ended";
  }
}

/**
 * What the family's stored figures last said of the buy-out's invoice: none made, not among them, open, part paid,
 * paid or voided; or, for a buy-out of an earlier QuickBooks company than the roster's, that it is in that company's
 * books (`earlier_company`, with its id, `qboId`, and no figures: none of that company's are kept). `owedCents`: what is
 * still owed on it, said only to staff who may see money.
 */
export type InvoiceAsRead = { kind: "none" | "not_read" | "open" | "part_paid" | "paid" | "voided" | "earlier_company"; owedCents: number | null; readAt: string | null; qboId?: string };

export type FamilyBuyout = {
  id: string; requirement: string; subjectName: string | null; amountCents: number; state: string; words: string; flag: string | null; flagWords: string | null;
  code: string | null; chosenAt: string; changedAt: string; invoice: InvoiceAsRead; close: CloseVerdict; tag: string;
  /** For a buy-out of an earlier QuickBooks company than the roster's: what it leaves to settle there (earlierCompanyLook()); null for the roster's company's. */
  earlier: EarlierLook | null;
};

/**
 * One family's buy-outs, every state, newest first: the ones it chose (`buyout.family_id`, the app's family the page's
 * address names, active or not), with the requirement, who it was for, the amount, how it stands, what the family's
 * stored figures last said of its invoice, and whether staff may close it. The family's own figures only (its app
 * family's row), and only from the company the buy-out's invoice is in and the roster came from. `familyName` is the
 * roster cache's name of the customer the family's link names in the roster's company: null when it has no link there,
 * or the cache no longer holds that customer. `familyQboId` is that customer, for the way back to the family's page.
 * A buy-out of an earlier QuickBooks company than the roster's (stage 4's slice M7b) reads its invoice as in that
 * company's books, and says what it leaves to settle there (`earlier`).
 */
export async function loadFamilyBuyouts(familyId: AppFamilyId): Promise<{ familyQboId: string | null; familyName: string | null; buyouts: FamilyBuyout[] }> {
  const [familyQboId, rows] = await Promise.all([customerOfFamily(familyId), db.select({ b: buyout, title: requirement.title }).from(buyout)
    .innerJoin(requirement, eq(requirement.id, buyout.requirementId)).where(eq(buyout.familyId, familyId)).orderBy(desc(buyout.createdAt))]);
  const students = rows.flatMap(({ b }) => (b.studentId === null ? [] : [b.customerQboId]));
  const [names, items, money, source] = await Promise.all([namesOf([...(familyQboId === null ? [] : [familyQboId]), ...new Set(students)]), itemsOf(rows.map(({ b }) => b.id)),
    moneyRows([familyId]), getRosterSource()]);
  const row = money.get(familyId);
  return { familyQboId, familyName: familyQboId === null ? null : names.get(familyQboId) ?? null, buyouts: rows.map(({ b, title }) => {
    const figures = row?.invoices && row.readAt && row.realmId === b.realmId && row.realmId === source ? row : null;
    const inv = b.invoiceQboId && figures ? figures.invoices!.find((i) => i.qboId === b.invoiceQboId) ?? null : null;
    const own = items.get(b.id) ?? [];
    const earlier = source !== null && b.realmId !== source ? lookOf(b, own) : null;
    const invoice: InvoiceAsRead = earlier?.invoiceQboId ? { kind: "earlier_company", owedCents: null, readAt: null, qboId: earlier.invoiceQboId }
      : !b.invoiceQboId ? { kind: "none", owedCents: null, readAt: null }
      : !inv ? { kind: "not_read", owedCents: null, readAt: figures?.readAt?.toISOString() ?? null }
        : { kind: inv.totalCents === 0 ? "voided" : inv.balanceCents <= 0 ? "paid" : inv.balanceCents < inv.totalCents ? "part_paid" : "open",
          owedCents: inv.totalCents > 0 && inv.balanceCents > 0 ? inv.balanceCents : null, readAt: figures!.readAt!.toISOString() };
    return {
      id: b.id, requirement: title, subjectName: b.studentId === null ? null : names.get(b.customerQboId) ?? "A student no longer on the roster",
      amountCents: b.amountCents, state: b.state, words: stateWords(b), flag: b.flag, flagWords: b.flag ? FLAG_WORDS[b.flag] ?? null : null, code: b.lastCode,
      chosenAt: b.createdAt.toISOString(), changedAt: b.updatedAt.toISOString(), invoice, close: verdictOf(b, own), tag: closeTag(b), earlier,
    };
  }) };
}
