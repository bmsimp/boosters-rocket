import { normalizeEmail } from "@/lib/email";
import { parseEmailField } from "./emails";

/**
 * A QuickBooks email field changed for one address. Pure: it reads nothing and changes nothing. Until stage 3's slice
 * 11d a parent's confirmed change of sign-in email (src/lib/parents/email-change.ts) wrote it to their record first;
 * since then that change is the portal's alone, and slice S11e sends it on with these rules.
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
 * Whether `email` signs in through a record whose email field is `field`, by the record's own rule (OwnRecord.signsInBy,
 * ./my-family.ts): its first usable address alone on a parent's own record or a flat member's, any of them on a
 * family's record in a club with no parent type. The one rule for it: a record is the person's own, by ownRecordIn(),
 * only while it holds, which the take-in of contact details (./contact-take-in.ts) goes by.
 */
export function fieldSignsIn(field: string | null, email: string, signsInBy: "first" | "every"): boolean {
  const usable = parseEmailField(field).usable;
  return (signsInBy === "every" ? usable : usable.slice(0, 1)).includes(email.trim().toLowerCase());
}
