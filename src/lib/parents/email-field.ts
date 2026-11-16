import { normalizeEmail } from "@/lib/email";
import { parseEmailField } from "./emails";

/**
 * A QuickBooks email field changed for one address (src/lib/parents/email-change.ts). Pure: it reads nothing and
 * changes nothing.
 *
 * A field can hold several addresses, separated by commas, semicolons or spaces in any mix (parseEmailField). The
 * change replaces one address, wherever it stands and however it is written (`Ana@Example.com` is `ana@example.com`),
 * every time it appears, with the new address as the portal stores addresses: trimmed and lower-cased. Every other
 * character of the field stays as it was: the other addresses, the separators, the spaces around them.
 */

/**
 * The longest field the portal sends. QuickBooks' own limit for an email field has not been checked (EMAIL_UPDATE in
 * src/lib/quickbooks/client.ts): until the owner's sandbox check says otherwise, a longer field is not sent at all.
 */
export const EMAIL_FIELD_MAX = 100;

export type FieldChange =
  | { ok: true; field: string }
  /**
   * `absent`: the address being replaced isn't in the field. `already_there`: the new address is in it already, so the
   * change would leave the field holding it twice, or would really be a removal. `too_long`: the field would be longer
   * than EMAIL_FIELD_MAX. `invalid`: either address isn't one, or they are the same.
   */
  | { ok: false; reason: "absent" | "already_there" | "too_long" | "invalid" };

/** The pieces of a field: addresses (and anything else typed there) at even places, the separators between them at odd ones. */
const piecesOf = (field: string) => field.split(/([\s,;]+)/);

export function replaceAddressInField(field: string | null, from: string, to: string): FieldChange {
  const old = normalizeEmail(from), next = normalizeEmail(to);
  if (!old || !next || old === next) return { ok: false, reason: "invalid" };
  const raw = field ?? "";
  if (parseEmailField(raw).usable.includes(next)) return { ok: false, reason: "already_there" };
  const pieces = piecesOf(raw);
  let found = false;
  for (let i = 0; i < pieces.length; i += 2) {
    if (pieces[i] && normalizeEmail(pieces[i]!) === old) { pieces[i] = next; found = true; }
  }
  if (!found) return { ok: false, reason: "absent" };
  const changed = pieces.join("");
  return changed.length > EMAIL_FIELD_MAX ? { ok: false, reason: "too_long" } : { ok: true, field: changed };
}

/**
 * Whether a field already reads as the change made: the new address is in it and the old one is nowhere in it. After
 * a write whose answer was lost, the next try finds this and takes the change as made, rather than sending it again.
 * `firstOnly` is for a record whose sign-in is its first address alone (./access-rules.ts): the new one must be first.
 */
export function fieldHasChange(field: string | null, from: string, to: string, firstOnly: boolean): boolean {
  const old = normalizeEmail(from), next = normalizeEmail(to);
  if (!old || !next || old === next) return false;
  const usable = parseEmailField(field).usable;
  return !usable.includes(old) && (firstOnly ? usable[0] === next : usable.includes(next));
}
