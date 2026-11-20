import { describe, expect, it } from "vitest";
import { MOST_DECLINES, OFFER_AGAIN_AFTER_MS, PROVED_WITH_SIGNIN_MS, atSignin, declineCounts, deviceDue, offerDue, provedAtSignin, type OfferFactsAll } from "@/lib/parents/passkey-offer-rule";
import { REASK_WINDOW_MS } from "@/lib/parents/reask-rule";

// The passkey offer's rule (the sign-in release, slice SI-8; open question 31): offered only right after a sign-in
// that proved the password and a second step, to a person who may add a passkey with one tap and holds none, on a
// device with no "Not now" in the last 30 days, and to a person who has said "Not now" fewer than three times.
const NOW = new Date("2026-11-20T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SECOND = 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Every condition true: a session made a minute ago and proved then, on a device never stamped, no passkey, no declines. */
const due = (o: Partial<OfferFactsAll> = {}): OfferFactsAll => ({
  sessionMadeAt: ago(60 * SECOND), strongAt: ago(60 * SECOND), device: { offeredAt: null }, declines: 0, mayAdd: true, passkeys: 0, ...o,
});

describe("the passkey offer's rule", () => {
  it("offers when every condition holds", () => {
    expect(offerDue(due(), NOW)).toBe(true);
  });

  it("is a month and three declines", () => {
    expect(OFFER_AGAIN_AFTER_MS).toBe(30 * DAY);
    expect(MOST_DECLINES).toBe(3);
  });

  it("offers a session made within the window, to the second, and not a second past it", () => {
    expect(offerDue(due({ sessionMadeAt: ago(REASK_WINDOW_MS - SECOND), strongAt: ago(REASK_WINDOW_MS - SECOND) }), NOW)).toBe(true);
    expect(offerDue(due({ sessionMadeAt: ago(REASK_WINDOW_MS), strongAt: ago(REASK_WINDOW_MS) }), NOW)).toBe(true);
    expect(offerDue(due({ sessionMadeAt: ago(REASK_WINDOW_MS + SECOND), strongAt: ago(60 * SECOND) }), NOW)).toBe(false);
    expect(offerDue(due({ sessionMadeAt: ago(11 * 60 * SECOND), strongAt: ago(11 * 60 * SECOND) }), NOW)).toBe(false);
  });

  it("offers nothing to a session made in the future (a clock ahead of the server's)", () => {
    expect(atSignin({ sessionMadeAt: new Date(NOW.getTime() + SECOND), strongAt: NOW }, NOW)).toBe(false);
  });

  it("offers nothing to a session with no proof: a password on a remembered device", () => {
    expect(offerDue(due({ strongAt: null }), NOW)).toBe(false);
  });

  it("offers nothing to a session whose proof is past the window, nor to an old session that asked again just now", () => {
    expect(offerDue(due({ sessionMadeAt: ago(60 * SECOND), strongAt: ago(REASK_WINDOW_MS + SECOND) }), NOW)).toBe(false);
    expect(offerDue(due({ sessionMadeAt: ago(60 * 60 * SECOND), strongAt: ago(5 * SECOND) }), NOW)).toBe(false);
  });

  it("offers only a proof made with the sign-in, a minute either way: not one made by asking again minutes after a password-only sign-in", () => {
    expect(PROVED_WITH_SIGNIN_MS).toBe(60 * SECOND);
    const made = ago(5 * 60 * SECOND);
    expect(provedAtSignin({ sessionMadeAt: made, strongAt: new Date(made.getTime() + 60 * SECOND) })).toBe(true);
    expect(provedAtSignin({ sessionMadeAt: made, strongAt: new Date(made.getTime() + 61 * SECOND) })).toBe(false);
    expect(provedAtSignin({ sessionMadeAt: made, strongAt: new Date(made.getTime() - 60 * SECOND) })).toBe(true);
    expect(provedAtSignin({ sessionMadeAt: made, strongAt: new Date(made.getTime() - 61 * SECOND) })).toBe(false);
    expect(provedAtSignin({ sessionMadeAt: made, strongAt: null })).toBe(false);
    // Made five minutes ago by the password alone, then asked again on Sign-in settings two minutes ago.
    expect(offerDue(due({ sessionMadeAt: made, strongAt: ago(2 * 60 * SECOND) }), NOW)).toBe(false);
    expect(offerDue(due({ sessionMadeAt: made, strongAt: new Date(made.getTime() + 2 * SECOND) }), NOW)).toBe(true);
  });

  it("offers nothing when the session may not add a passkey now", () => {
    expect(offerDue(due({ mayAdd: false }), NOW)).toBe(false);
  });

  it("offers nothing to a person who holds a passkey", () => {
    expect(offerDue(due({ passkeys: 1 }), NOW)).toBe(false);
    expect(offerDue(due({ passkeys: 2 }), NOW)).toBe(false);
  });

  it("offers nothing when the session names no device", () => {
    expect(deviceDue(null, NOW)).toBe(false);
    expect(offerDue(due({ device: null }), NOW)).toBe(false);
  });

  it("comes back on a device 30 days after its Not now, and not a second sooner", () => {
    expect(offerDue(due({ device: { offeredAt: ago(29 * DAY) } }), NOW)).toBe(false);
    expect(offerDue(due({ device: { offeredAt: ago(30 * DAY - SECOND) } }), NOW)).toBe(false);
    expect(offerDue(due({ device: { offeredAt: ago(30 * DAY) } }), NOW)).toBe(true);
    expect(offerDue(due({ device: { offeredAt: ago(30 * DAY + SECOND) } }), NOW)).toBe(true);
  });

  it("offers nothing after the third Not now, on any device", () => {
    expect(offerDue(due({ declines: 2 }), NOW)).toBe(true);
    expect(offerDue(due({ declines: 3 }), NOW)).toBe(false);
    expect(offerDue(due({ declines: 4 }), NOW)).toBe(false);
  });

  it("counts a Not now by the same rule, whatever the passkeys and the add's own checks", () => {
    expect(declineCounts(due(), NOW)).toBe(true);
    expect(declineCounts(due({ mayAdd: false, passkeys: 1 }), NOW)).toBe(true);
    expect(declineCounts(due({ declines: 3 }), NOW)).toBe(false);
    expect(declineCounts(due({ device: { offeredAt: ago(DAY) } }), NOW)).toBe(false);
    expect(declineCounts(due({ device: null }), NOW)).toBe(false);
    expect(declineCounts(due({ strongAt: null }), NOW)).toBe(false);
    // A proof made by asking again later, not with the sign-in: never drawn for it, and not counted.
    expect(declineCounts(due({ sessionMadeAt: ago(REASK_WINDOW_MS + SECOND) }), NOW)).toBe(false);
  });

  it("counts a Not now pressed after the ten minutes, the box still on screen: the parent's answer is kept", () => {
    const late = due({ sessionMadeAt: ago(12 * 60 * SECOND), strongAt: ago(12 * 60 * SECOND) });
    expect(offerDue(late, NOW)).toBe(false);
    expect(declineCounts(late, NOW)).toBe(true);
    expect(declineCounts({ ...late, declines: 3 }, NOW)).toBe(false);
    expect(declineCounts({ ...late, device: { offeredAt: ago(DAY) } }, NOW)).toBe(false);
  });
});
