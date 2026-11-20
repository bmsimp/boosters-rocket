// The passkey offer on Home (the sign-in release, slice SI-8; section 6 of the app-owned families spec, "The passkey,
// offered", and open question 31): the one rule that decides whether a session is offered a passkey now, and whether a
// press of "Not now" counts. Pure: it imports only the asking-again window, so the page, the action and a unit test
// read the same rule (tests/unit/passkey-offer-rule.test.ts). What it is given is read by passkey-offer.ts.

import { REASK_WINDOW_MS, provedRecently } from "./reask-rule";

/** How long after a "Not now" on a device the offer may come back on it: 30 days ("at most once a month on a device"). */
export const OFFER_AGAIN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** After this many presses of "Not now", by the person on any device, Home offers a passkey no more: only Sign-in settings. */
export const MOST_DECLINES = 3;

/** What the rule reads of the session, its device and its person. */
export type OfferFacts = {
  /** When the session was made (`parent_auth_session.created_at`). */
  sessionMadeAt: Date;
  /** The session's own proof of the password and a second step (`strong_at`, as sessionStrongAt() reads it), or null. */
  strongAt: Date | null;
  /** The device the session names, a remembered device of the person's, with its last "Not now", or null with none. */
  device: { offeredAt: Date | null } | null;
  /** How many times the person has pressed "Not now" (`parent.passkey_offer_declines`). */
  declines: number;
};

/** The facts beside those that only the offer reads: whether the session may add a passkey now (mayAddPasskey()), and how many the person holds. */
export type OfferFactsAll = OfferFacts & { mayAdd: boolean; passkeys: number };

/**
 * Whether this session is still at its sign-in, as far as the offer goes ("at sign-in only"): made within the window
 * (REASK_WINDOW_MS, no longer ago and not in the future) and proved there, with the password and a second step
 * (`strong_at` set, within the window too). A sign-in on a remembered device proves only the password and stamps
 * nothing, so it is offered nothing: a lasting factor added from a password and a device cookie alone would outlive a
 * password reset. Asking again later on Sign-in settings stamps `strong_at`, but the session is no longer new, so the
 * offer never comes back to Home by it.
 */
export function atSignin(f: Pick<OfferFacts, "sessionMadeAt" | "strongAt">, now: Date): boolean {
  const age = now.getTime() - f.sessionMadeAt.getTime();
  return age >= 0 && age <= REASK_WINDOW_MS && provedRecently(f.strongAt, now);
}

/** Whether the device the session names may be offered: there, and "Not now" never pressed on it, or at least 30 days ago. */
export function deviceDue(device: OfferFacts["device"], now: Date): boolean {
  if (device === null) return false;
  return device.offeredAt === null || now.getTime() - device.offeredAt.getTime() >= OFFER_AGAIN_AFTER_MS;
}

/**
 * Whether a press of "Not now" counts (decision 7 of SI-8): read again under the person's row, so two taps, or two
 * tabs, count once. The session at its sign-in, the device due, and fewer than three declines.
 */
export function declineCounts(f: OfferFacts, now: Date): boolean {
  return atSignin(f, now) && deviceDue(f.device, now) && f.declines < MOST_DECLINES;
}

/**
 * Whether the offer is drawn now: the session may add a passkey with one tap (mayAddPasskey(): sign-ins on, not
 * blocked, a row that counts, a password chosen, a proof within the window), the person holds no passkey (the portal
 * can't tell whether this device holds one of theirs; a holder adds another on Sign-in settings), and a "Not now"
 * would count.
 */
export function offerDue(f: OfferFactsAll, now: Date): boolean {
  return f.mayAdd && f.passkeys === 0 && declineCounts(f, now);
}
