/**
 * The rules for a customer's display name when staff make or rename one (v1 spec §6.1, "Name collisions"). Pure.
 *
 * QuickBooks requires a DisplayName to be unique across every customer, vendor and employee, and joins a sub-customer's
 * name to its parent's with a colon (FullyQualifiedName "Rivera Family:Leo Rivera"). So a name is trimmed, 1 to 100
 * characters, with no colon, tab or line break; and one that is taken is answered by offering the first free
 * "Name (2)", "Name (3)", never by failing and never by renaming anything without staff saying so.
 */
import { isControl, NAME_MAX, normalName, type NameCheck } from "@/lib/families/names";

// The portal's own rules, shared with QuickBooks' (src/lib/families/names.ts).
export { freeName, NAME_MAX, nameKey, normalName, type NameCheck } from "@/lib/families/names";

export function checkName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, error: "Enter a name." };
  const name = normalName(raw);
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length > NAME_MAX) return { ok: false, error: `That name is too long: ${NAME_MAX} characters at most.` };
  if (name.includes(":")) return { ok: false, error: "A name can't have a colon in it: QuickBooks uses one to join a student's or parent's name to their family's." };
  // Tabs, line breaks and every other control character.
  if ([...name].some(isControl)) return { ok: false, error: "A name must be on one line, with no tabs." };
  return { ok: true, name };
}
