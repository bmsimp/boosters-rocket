// When the breach check (./breach-check.ts) last answered and last failed, for the Health page's line about it
// (src/lib/health/report.ts, `breach_check`). Times and a short code only: never anything of the password, its hash or
// the part of it sent, nor of the person or their address. A cache, not a record of the club's: each password chosen
// is audited on its own (`parent.password.set`, with whether it was checked).
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import type { BreachCheck, BreachNotChecked } from "./breach-check";

export const BREACH_MARK = "health.mark.breach_check";

export type BreachMark = {
  /** When the service last answered (found or not found). */
  answeredAt: string | null;
  /** When it last couldn't be asked or understood, and why. */
  failedAt: string | null;
  failure: BreachNotChecked | null;
  /** Whether the failure is the latest word: two asks in one millisecond have equal times. */
  failedLast: boolean;
};
const EMPTY: BreachMark = { answeredAt: null, failedAt: null, failure: null, failedLast: false };

export async function readBreachMark(): Promise<BreachMark | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, BREACH_MARK));
  return row ? { ...EMPTY, ...(row.value as Partial<BreachMark>) } : null;
}

/**
 * Records one ask of the service. Read and written under a lock of its key, so two asks at once take turns and neither
 * is lost. Never throws: a mark that can't be written must not stop a parent choosing a password, and the next ask
 * writes it again. It runs outside any transaction of the caller's.
 */
export async function markBreachCheck(check: BreachCheck, now = new Date()): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.mark:${BREACH_MARK}`}))`);
      const [row] = await tx.select().from(setting).where(eq(setting.key, BREACH_MARK));
      const before: BreachMark = row ? { ...EMPTY, ...(row.value as Partial<BreachMark>) } : EMPTY;
      const at = now.toISOString();
      const next: BreachMark = check.outcome === "not_checked"
        ? { ...before, failedAt: at, failure: check.why, failedLast: true }
        : { ...before, answeredAt: at, failedLast: false };
      await tx.insert(setting).values({ key: BREACH_MARK, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: now } });
    });
  } catch {
    // Nothing to do: the next ask writes it again.
  }
}
