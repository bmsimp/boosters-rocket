/**
 * The portal's own rules for a family's or a student's name, books or none. Pure. A name is composed (NFC), trimmed,
 * each run of spaces one space, 1 to 100 characters, on one line; two active families are never called the same
 * (compared as nameKey() does), and one that is taken is answered by offering the first free "Name (2)". An accounting
 * plugin adds its books' own rules on top (QuickBooks' colon: src/lib/roster/names.ts).
 */
export const NAME_MAX = 100;

/** A tab, a line break, or any other control character: C0, DEL, C1, and the Unicode line and paragraph separators. */
export const isControl = (ch: string): boolean => { const c = ch.codePointAt(0)!; return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029; };

/** A name as the portal keeps it: composed (NFC), trimmed, each run of spaces one space. */
export const normalName = (raw: string): string => raw.normalize("NFC").trim().replace(/ {2,}/g, " ");

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** A family's or student's name as staff typed it, by the portal's own rules. */
export function checkRecordName(raw: unknown): NameCheck {
  if (typeof raw !== "string") return { ok: false, error: "Enter a name." };
  const name = normalName(raw);
  if (!name) return { ok: false, error: "Enter a name." };
  if (name.length > NAME_MAX) return { ok: false, error: `That name is too long: ${NAME_MAX} characters at most.` };
  if ([...name].some(isControl)) return { ok: false, error: "A name must be on one line, with no tabs." };
  return { ok: true, name };
}

/** How names are compared: "Rivera Family" and "rivera family" are the same name. */
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
