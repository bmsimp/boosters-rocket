// The words staff read about passkeys made at an earlier address of the portal (the sign-in release, slice SI-9b):
// the section on Settings, Parent sign-ins, its press and its answers, and the Health page's note. Written once, here,
// and tested word for word (tests/integration/settings-parents.test.ts, tests/integration/health-page.test.ts). First
// drafts the owner will revisit. Pure: it imports nothing, so the page, the action and the Health report all read it.

/** A count in words, as the settings page's n() writes it. */
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const passkeysWord = (p: number) => n(p, "passkey", "passkeys");
const peopleWord = (g: number) => n(g, "person", "people");
/** "1 person has" or "2 people have". */
const peopleHave = (count: number) => (count === 1 ? "1 person has" : `${count} people have`);

export const OLD_PASSKEYS_COPY = {
  heading: "Passkeys from an earlier address",
  /** The lede: the portal's origin now, how many passkeys of how many people were made elsewhere. */
  lede: (origin: string, passkeys: number, people: number) =>
    `A passkey works only at the address it was made at. The portal's address is now ${origin}. ${passkeysWord(passkeys)} of ${peopleWord(people)} ${passkeys === 1 ? "was" : "were"} made at another address, so ${passkeys === 1 ? "it no longer works" : "they no longer work"}, but the portal still asks ${people === 1 ? "that person" : "those people"} for ${passkeys === 1 ? "it" : "them"}.`,
  /** The list's term for passkeys whose origin the portal never recorded. */
  unrecorded: "An address the portal didn't record",
  /** The list's count beside each earlier origin. */
  count: (passkeys: number) => passkeysWord(passkeys),
  /** The warning before the press, by the club's level and how many would be left with no passkey and no app. */
  warning: (strict: boolean, leftWithNoFactor: number) =>
    leftWithNoFactor === 0
      ? "Everyone with one of these passkeys has an authenticator app or another passkey, so nobody is signed out and no backup codes go."
      : strict
        ? `${peopleHave(leftWithNoFactor)} no authenticator app and no other passkey: their backup codes go too, they are signed out, and after their password they add a passkey or an authenticator app before they see their family's page.`
        : `Removing them signs nobody out. ${peopleHave(leftWithNoFactor)} no authenticator app and no other passkey: their backup codes go too, and on a phone or computer the portal doesn't know yet they'll get an emailed code until they add a passkey again.`,
  /** The check before pressing. */
  makeSure: (origin: string) => `Make sure ${origin} is the address families use now: passkeys made there are kept.`,
  button: (passkeys: number) => `Remove ${passkeysWord(passkeys)} made at an earlier address`,
  pending: "Removing…",
  /** The press done: how many went, from how many people, and at Strict how many were signed out. */
  done: (passkeys: number, people: number, signedOut: number) =>
    `Removed ${passkeysWord(passkeys)} made at an earlier address, from ${peopleWord(people)}.${signedOut > 0 ? ` ${signedOut === 1 ? "1 person was" : `${signedOut} people were`} signed out.` : ""}`,
  /** The press refused: the count under the lock wasn't the count the page showed. */
  changed: "The number of passkeys made at an earlier address changed while this page was open. Look at the new number and press again.",
  /** The press refused: there are none now. */
  none: "There are no passkeys from an earlier address now.",
  /** The Health page's note on the Parent sign-ins line. */
  health: (passkeys: number, people: number) =>
    `${passkeysWord(passkeys)} of ${peopleWord(people)} ${passkeys === 1 ? "was" : "were"} made at an address other than the portal's address now, so ${passkeys === 1 ? "it no longer works" : "they no longer work"}. An Admin can remove ${passkeys === 1 ? "it" : "them"} under Settings, Parent sign-ins.`,
} as const;

/** Why the press was refused when the count it was shown is no longer the count (as setLevel()'s LEVEL_COUNT_CHANGED). */
export const OLD_PASSKEYS_CHANGED = OLD_PASSKEYS_COPY.changed;
