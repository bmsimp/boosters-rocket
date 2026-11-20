/**
 * The rules for a customer's display name when staff make or rename one (v1 spec §6.1, "Name collisions"). Pure.
 *
 * QuickBooks requires a DisplayName to be unique across every customer, vendor and employee, and joins a sub-customer's
 * name to its parent's with a colon (FullyQualifiedName "Rivera Family:Leo Rivera"). So a name is trimmed, 1 to 100
 * characters, with no colon, tab or line break; and one that is taken is answered by offering the first free
 * "Name (2)", "Name (3)", never by failing and never by renaming anything without staff saying so.
 */
export const NAME_MAX = 100;

/** A tab, a line break, or any other control character: C0, DEL, C1, and the Unicode line and paragraph separators. */
const isControl = (ch: string): boolean => { const c = ch.codePointAt(0)!; return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029; };

/**
 * A name as the portal keeps it: composed (NFC), trimmed, each run of spaces one space. checkName() applies it to every
 * name staff type, and the accounting links screen compares names after it (src/lib/accounting/differences.ts).
 */
export const normalName = (raw: string): string => raw.normalize("NFC").trim().replace(/ {2,}/g, " ");

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

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

/** How names are compared: QuickBooks treats "Rivera Family" and "rivera family" as the same name. */
export const nameKey = (name: string): string => name.normalize("NFC").trim().toLocaleLowerCase("en");

/** "Smith Family (3)" is "Smith Family" with a suffix; the suffix is dropped before a new one is found. */
const SUFFIXED = /^(.*\S) \((\d{1,4})\)$/;

/**
 * The name to offer instead of `name` when it is taken: the first "Base (n)", n from 2, that is in none of `taken`
 * (compared as nameKey does) and fits in NAME_MAX. Null when `name` itself is free.
 */
export function freeName(name: string, taken: Iterable<string>): string | null {
  const used = new Set([...taken].map(nameKey));
  if (!used.has(nameKey(name))) return null;
  const base = SUFFIXED.exec(name)?.[1] ?? name;
  for (let n = 2; n < 10_000; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
  return null;
}
