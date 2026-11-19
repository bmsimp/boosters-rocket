/**
 * The rules of a volunteer buy-out (v1 spec §11.5), as pure functions: whether a requirement offers one, what it costs
 * a family or a student now, how a requirement reads while a buy-out is under way, and how staff type a price. Nothing
 * here reads the database or the clock: ./my-buyouts.ts and ./writes.ts read what these are given, and the volunteer
 * entry of src/lib/seasons/kinds.ts reads the requirement's standing through withBuyout().
 */
import type { BuyoutState } from "@/lib/db/schema";
import type { Requirement, Standing } from "@/lib/seasons/progress";

/** A requirement as far as a buy-out goes: its kind and amount, and what staff set for a buy-out. */
export type BuyoutTerms = Pick<Requirement, "kind" | "amount" | "amountUnit"> & { buyoutUnitCents: number | null; itemQboId: string | null };

/** A buy-out is offered on a volunteer requirement with an amount, a price per unit and the product or service it is billed with. */
export const buyoutOffered = (r: BuyoutTerms): boolean =>
  r.kind === "volunteer" && r.amount !== null && r.amount > 0 && r.amountUnit !== null && r.buyoutUnitCents !== null && r.buyoutUnitCents > 0 && r.itemQboId !== null;

/**
 * What a buy-out costs now: the price of one unit times the units still owed after confirmed credit. A requirement
 * counted in hours is rounded up to whole hours (2.5 left is 3 hours); one counted in shifts is whole already. `off`:
 * no buy-out is offered; `met`: credit has met it, and there is nothing to buy.
 */
export type Quote = { ok: true; units: number; unitCents: number; amountCents: number } | { ok: false; why: "off" | "met" };
export function quoteBuyout(r: BuyoutTerms, confirmed: number): Quote {
  if (!buyoutOffered(r)) return { ok: false, why: "off" };
  const unitCents = r.buyoutUnitCents!;
  // In whole minutes first, so 6 − 3.9999999 hours of credit is 2 hours left, not 3.
  const leftMinutes = r.amountUnit === "hours" ? Math.round(r.amount! * 60) - Math.round(Math.max(confirmed, 0) * 60) : null;
  const units = leftMinutes !== null ? Math.ceil(leftMinutes / 60) : Math.ceil(r.amount! - Math.max(confirmed, 0) - 1e-9);
  if (units <= 0) return { ok: false, why: "met" };
  return { ok: true, units, unitCents, amountCents: units * unitCents };
}

/** A buy-out that still stands: at most one per requirement and subject (`buyout_family_live_uq`, `buyout_student_live_uq`). A voided or refused one is history. */
export const LIVE_STATES: readonly BuyoutState[] = ["being_invoiced", "invoiced", "paid", "being_voided", "stuck"];
export const isLive = (state: BuyoutState): boolean => LIVE_STATES.includes(state);

/** What is known of a live buy-out for a requirement: its state, and whether its invoice's balance is 0 in the stored figures. */
export type BuyoutFact = { state: BuyoutState; invoicePaid: boolean };

/** How a requirement reads while a buy-out stands, in the words a parent and staff read alike. */
export const BUYOUT_WORDS = {
  being_invoiced: "Buy-out being set up",
  invoiced: "Buy-out invoiced",
  paid: "Paid instead",
  being_voided: "Buy-out being cancelled",
  stuck: "Buy-out waiting for the club",
} as const;

/** Paid: QuickBooks says so in the stored figures (the invoice's balance is 0), or the daily check already marked it. */
export const buyoutPaid = (b: BuyoutFact): boolean => b.state === "paid" || (b.state === "invoiced" && b.invoicePaid);

/**
 * A volunteer requirement's standing with its buy-out, if any (v1 spec §10.2): met when confirmed credit reaches the
 * amount or the buy-out is paid. Credit still counts as it did: a requirement credit has met reads as credit says.
 */
export function withBuyout(credit: Standing, b: BuyoutFact | null): Standing {
  if (credit.met || !b || !isLive(b.state)) return credit;
  if (buyoutPaid(b)) return { met: true, words: BUYOUT_WORDS.paid };
  return { met: false, words: BUYOUT_WORDS[b.state as Exclude<BuyoutState, "voided" | "refused" | "paid">] };
}

/** What a guardian may do about a buy-out in this state: choose one (none stands), switch back (invoiced, nothing paid), or wait. */
export function guardianMay(b: BuyoutFact | null, quote: Quote): "choose" | "switch_back" | "wait" | "nothing" {
  if (!b || !isLive(b.state)) return quote.ok ? "choose" : "nothing";
  if (b.state === "invoiced" && !b.invoicePaid) return "switch_back";
  if (b.state === "being_invoiced" || b.state === "being_voided") return "wait";
  return "nothing";
}

/** The most a price per unit may be: $10,000.00. */
export const MAX_UNIT_CENTS = 1_000_000;

/**
 * A price as staff type it ("50", "50.00", "$12.5", "1,250.00") in integer cents, or null when it isn't one: at most two
 * decimals, more than 0 and at most MAX_UNIT_CENTS. Read from the text, digit by digit: no arithmetic on dollars.
 */
export function parsePrice(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const cents = Number(m[1]!.replaceAll(",", "")) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 && cents <= MAX_UNIT_CENTS ? cents : null;
}

/** The price as the staff form shows it again: "50.00". */
export const priceText = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/** The units in words: "2 shifts", "1 hour". */
export const unitsWords = (unit: Requirement["amountUnit"], n: number): string => `${n} ${unit === "hours" ? (n === 1 ? "hour" : "hours") : n === 1 ? "shift" : "shifts"}`;
/** One unit in words, for "per shift" and "per hour". */
export const perUnitWords = (unit: Requirement["amountUnit"]): string => (unit === "hours" ? "per hour" : "per shift");

/**
 * What the figures the worker's daily read stored say about one invoiced buy-out (v1 spec §8.4, ./daily-check.ts):
 * `paid` (its balance is 0), `ok` (still there, on its customer, with something to pay), `voided` (voided in
 * QuickBooks: it is there with a total of 0, so nothing is owed for it), or a flag for staff: the invoice is on another
 * customer than the buy-out's (`other_customer`), QuickBooks no longer shows it to the family because it was deleted
 * there (`missing`), or the student it was billed to is no longer active and directly under the family in QuickBooks
 * (`student_moved`: since stage 3's slice 9c the check voids nothing for such a buy-out; it flags it once for staff).
 */
export function judgeInvoice(b: { invoiceQboId: string; customerQboId: string; perStudent: boolean },
  invoices: readonly { qboId: string; customerQboId: string; totalCents: number; balanceCents: number }[], customerStillTheFamilys: boolean):
  "paid" | "ok" | "voided" | "missing" | "other_customer" | "student_moved" {
  if (b.perStudent && !customerStillTheFamilys) return "student_moved";
  const inv = invoices.find((i) => i.qboId === b.invoiceQboId);
  if (!inv) return "missing";
  // A voided invoice has a total of 0: QuickBooks keeps it, with nothing on it.
  if (inv.totalCents === 0) return inv.customerQboId === b.customerQboId ? "voided" : "other_customer";
  if (inv.customerQboId !== b.customerQboId) return "other_customer";
  if (inv.totalCents > 0 && inv.balanceCents <= 0) return "paid";
  return "ok";
}
