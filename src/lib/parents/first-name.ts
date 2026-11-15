const SUFFIX = /^(jr|sr|ii|iii|iv|md|phd|esq)\.?$/i;
const TITLE = /^(mr|mrs|ms|miss|mx|dr|prof|rev|the)\.?$/i;
/** A household, a couple or a business rather than one person, or a name with something else written into it. */
const NOT_ONE_PERSON = /\b(family|household|and)\b|[&@/()\d]/i;
/** Two letters or more: letters, with apostrophes and hyphens inside ("Mary-Jane", "D'Arcy"). An initial is not a name. */
const GIVEN_NAME = /^\p{L}[\p{L}'’-]*\p{L}$/u;

/**
 * The first name to greet a person by, from a name as QuickBooks holds it: "Ana Rivera" or "Rivera, Ana". Pure. Null
 * when it can't be told, so the page says "Hi" rather than something wrong ("Hi, Rivera" to a record named
 * "Rivera Family", "Hi, Dr." to "Dr. Ana Rivera").
 */
export function firstName(name: string): string | null {
  const whole = name.trim();
  if (!whole || NOT_ONE_PERSON.test(whole)) return null;
  const [before = "", after, ...more] = whole.split(",").map((part) => part.trim());
  if (more.length || !before) return null;
  // "Rivera, Ana" puts the given name after the comma; "Ana Rivera, Jr." does not.
  const given = after === undefined || SUFFIX.test(after) ? before : after;
  const first = given.split(/\s+/)[0] ?? "";
  if (TITLE.test(first)) return null;
  return GIVEN_NAME.test(first) ? first : null;
}
