import { z } from "zod";

const emailSchema = z.string().email();

/** Trims and lower-cases an address; null when it isn't a valid one. No database import: safe in pure rules. */
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return emailSchema.safeParse(e).success ? e : null;
}
