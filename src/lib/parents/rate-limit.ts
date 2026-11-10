import { and, asc, eq, gt, lte, sql, count } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { rateLimitEvent } from "@/lib/db/schema";

export type RateLimitKind = "code_send_email" | "code_send_ip" | "code_check_ip";
const WINDOW_MS = 15 * 60 * 1000;
export const RATE_LIMITS: Record<RateLimitKind, { max: number; windowMs: number }> = {
  code_send_email: { max: 3, windowMs: WINDOW_MS },
  code_send_ip: { max: 10, windowMs: WINDOW_MS },
  code_check_ip: { max: 30, windowMs: WINDOW_MS },
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
