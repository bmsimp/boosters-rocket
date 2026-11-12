import { normalizeEmail } from "@/lib/setup/state";

/**
 * Splits a QuickBooks email field into addresses (spec §1 Candidates). People type several addresses into one field,
 * separated by commas, semicolons or spaces. Each piece is trimmed and lower-cased; one that isn't a valid address is
 * unusable. Never throws; an unusable piece is cut to 80 characters so a pasted paragraph can't fill a page.
 */
export function parseEmailField(raw: string | null): { usable: string[]; unusable: string[] } {
  const usable: string[] = [], unusable: string[] = [];
  for (const piece of (raw ?? "").split(/[\s,;]+/)) {
    if (!piece) continue;
    const email = normalizeEmail(piece);
    if (email) { if (!usable.includes(email)) usable.push(email); }
    else { const kept = piece.toLowerCase().slice(0, 80); if (!unusable.includes(kept)) unusable.push(kept); }
  }
  return { usable, unusable };
}
