import { and, eq, gt, lte, sql, count } from "drizzle-orm";
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
 * Counts one event for (kind, subject) and returns true, or returns false without counting when the sliding window is
 * full. Held in the database, so it survives restarts and holds across servers; a per-subject advisory lock (the setup
 * code's try counter uses the same reserve-then-compare idea) makes a parallel burst count exactly.
 */
export async function takeRateLimit(kind: RateLimitKind, subject: string, now = new Date()): Promise<boolean> {
  const { max, windowMs } = RATE_LIMITS[kind];
  const since = new Date(now.getTime() - windowMs);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.rate:${kind}:${subject}`}))`);
    const scope = and(eq(rateLimitEvent.kind, kind), eq(rateLimitEvent.subject, subject));
    await tx.delete(rateLimitEvent).where(and(scope, lte(rateLimitEvent.at, since)));
    const [{ n }] = (await tx.select({ n: count() }).from(rateLimitEvent).where(and(scope, gt(rateLimitEvent.at, since)))) as [{ n: number }];
    if (n >= max) return false;
    await tx.insert(rateLimitEvent).values({ kind, subject, at: now });
    return true;
  });
}
