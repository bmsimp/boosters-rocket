import { and, asc, eq, gt, lte, sql, count } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";

export type RateLimitKind = "code_send_email" | "code_send_ip" | "code_check_ip" | "contact_save_parent" | "contact_open_parent" | "form_open_parent";
const WINDOW_MS = 15 * 60 * 1000;
/**
 * Guessing is stopped per code (5 tries, 10 minutes: signin-codes.ts) and per address (3 codes in 15 minutes). The two
 * per-IP limits only stop a flood: on a registration night a whole room of parents shares the school's one address, so
 * they sit well above what a full room asks for (spec §1 Rate limits).
 */
export const RATE_LIMITS: Record<RateLimitKind, { max: number; windowMs: number }> = {
  code_send_email: { max: 3, windowMs: WINDOW_MS },
  code_send_ip: { max: 60, windowMs: WINDOW_MS },
  code_check_ip: { max: 180, windowMs: WINDOW_MS },
  // A parent's own phone and address (contact-edits.ts), counted per person. Each save is a write to the club's
  // QuickBooks, and nobody changes their address more than a few times an hour. Opening the edit page reads the record
  // from QuickBooks each time, so that is bounded too, well above what editing takes.
  contact_save_parent: { max: 6, windowMs: 60 * 60 * 1000 },
  contact_open_parent: { max: 30, windowMs: WINDOW_MS },
  // Opening a form to sign, and checking how one stands (src/lib/forms/signing.ts), counted per person: each asks the
  // club's Documenso once, and Documenso counts every call the portal makes against one limit of its own. A family
  // signing a dozen forms in a sitting opens and checks each a few times, so this sits well above that.
  form_open_parent: { max: 120, windowMs: WINDOW_MS },
};

/**
 * "taken": counted. "first_refusal": the window is full and this is the first refusal since it filled, so the caller
 * audits it. "refused": the window is full and its refusal was already audited, so the caller writes nothing.
 */
export type RateLimitTake = "taken" | "first_refusal" | "refused";

/**
 * Counts one event for (kind, subject), or refuses without counting when the sliding window is full. Held in the
 * database, so it survives restarts and holds across servers; a per-subject advisory lock (the setup code's try counter
 * uses the same reserve-then-compare idea) makes a parallel burst count exactly.
 *
 * A full window is audited once: the first refusal marks the window's oldest event. The window stays full, with the
 * same oldest event, until that event ages out (refusals add no rows, so they neither extend the window nor grow the
 * table), and the mark goes with it. The next full window has a new, unmarked oldest event.
 */
export async function takeRateLimit(kind: RateLimitKind, subject: string, now = new Date()): Promise<RateLimitTake> {
  const { max, windowMs } = RATE_LIMITS[kind];
  const since = new Date(now.getTime() - windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.rate:${kind}:${subject}`}))`);
    const scope = and(eq(rateLimitEvent.kind, kind), eq(rateLimitEvent.subject, subject));
    await tx.delete(rateLimitEvent).where(and(scope, lte(rateLimitEvent.at, since)));
    const live = and(scope, gt(rateLimitEvent.at, since));
    const [{ n }] = (await tx.select({ n: count() }).from(rateLimitEvent).where(live)) as [{ n: number }];
    if (n < max) {
      await tx.insert(rateLimitEvent).values({ kind, subject, at: now });
      return "taken";
    }
    const [oldest] = await tx.select({ id: rateLimitEvent.id, refusalAudited: rateLimitEvent.refusalAudited }).from(rateLimitEvent)
      .where(live).orderBy(asc(rateLimitEvent.at), asc(rateLimitEvent.id)).limit(1);
    if (!oldest || oldest.refusalAudited) return "refused";
    await tx.update(rateLimitEvent).set({ refusalAudited: true }).where(eq(rateLimitEvent.id, oldest.id));
    return "first_refusal";
  });
}
