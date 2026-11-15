import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const MONEY_KEY = "money.settings";

/**
 * How long the figures QuickBooks gave for a family are shown as they are ("freshness window", v1 spec §8.2: "a short
 * cache"). Past it, a page load asks QuickBooks again before it shows them. No page sets it yet: the default stands
 * unless a row is stored.
 */
export type MoneySettings = { freshSeconds: number };
export const DEFAULT_MONEY_SETTINGS: MoneySettings = { freshSeconds: 5 * 60 };

const stored = z.object({ freshSeconds: z.number().int().min(0).max(366 * 86_400) });

/** A missing value, or one that doesn't parse, is the default: a short window, never an endless one. */
export function parseMoneySettings(value: unknown): MoneySettings {
  const parsed = stored.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_MONEY_SETTINGS };
}

export async function getMoneySettings(tx?: Tx): Promise<MoneySettings> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, MONEY_KEY));
  return parseMoneySettings(row?.value);
}
