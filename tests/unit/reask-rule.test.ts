import { describe, it, expect } from "vitest";
import { REASK_WINDOW_MS, newestFactorSince, proofCountsBesideNewestFactor, provedRecently } from "@/lib/parents/reask-rule";

/**
 * Asking again (the sign-in release, slice SI-5a; open question 28): a change of how a parent signs in goes ahead
 * without asking again only while the session proved the password and the second step within the last 10 minutes.
 */
describe("provedRecently", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is 10 minutes", () => {
    expect(REASK_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it("takes a proof from just now up to the window's last moment", () => {
    expect(provedRecently(now, now)).toBe(true);
    expect(provedRecently(ago(1), now)).toBe(true);
    expect(provedRecently(ago(REASK_WINDOW_MS), now)).toBe(true);
  });

  it("refuses no proof (a session from before the password release), one past the window, and one ahead of the clock", () => {
    expect(provedRecently(null, now)).toBe(false);
    expect(provedRecently(ago(REASK_WINDOW_MS + 1), now)).toBe(false);
    expect(provedRecently(ago(24 * 60 * 60 * 1000), now)).toBe(false);
    expect(provedRecently(ago(-1), now)).toBe(false);
    expect(provedRecently(ago(-60_000), now)).toBe(false);
  });
});

/**
 * A proof made before the person's newest second factor came into force no longer counts (the sign-in release, slice
 * SI-6b's second read for the authenticator app, extended in slice SI-7a to the newest of the app and the passkeys): it
 * may have been made with the emailed code the factor has replaced, in another session.
 */
describe("proofCountsBesideNewestFactor", () => {
  const since = new Date("2026-11-19T12:00:00Z");
  const at = (ms: number) => new Date(since.getTime() + ms);

  it("counts every proof of a person with no second factor", () => {
    expect(proofCountsBesideNewestFactor(at(-60 * 60_000), null)).toBe(true);
  });
  it("counts a proof made when the newest factor came into force or after it", () => {
    expect(proofCountsBesideNewestFactor(since, since)).toBe(true);
    expect(proofCountsBesideNewestFactor(at(1), since)).toBe(true);
  });
  it("refuses a proof made before the newest factor came into force, however recent", () => {
    expect(proofCountsBesideNewestFactor(at(-1), since)).toBe(false);
    expect(proofCountsBesideNewestFactor(at(-2 * 60_000), since)).toBe(false);
  });
});

describe("newestFactorSince", () => {
  const app = new Date("2026-11-19T12:00:00Z");
  const passkey = new Date("2026-11-19T12:05:00Z");

  it("is null with neither, and the one there is with one", () => {
    expect(newestFactorSince(null, null)).toBeNull();
    expect(newestFactorSince(app, null)).toBe(app);
    expect(newestFactorSince(null, passkey)).toBe(passkey);
  });
  it("is the later of the app and the newest passkey", () => {
    expect(newestFactorSince(app, passkey)).toBe(passkey);
    expect(newestFactorSince(passkey, app)).toBe(passkey);
    // A proof between the two counts beside the app alone, and not beside the passkey added after it.
    const between = new Date("2026-11-19T12:02:00Z");
    expect(proofCountsBesideNewestFactor(between, app)).toBe(true);
    expect(proofCountsBesideNewestFactor(between, newestFactorSince(app, passkey))).toBe(false);
  });
});
