import { describe, it, expect } from "vitest";
import { REASK_WINDOW_MS, provedRecently } from "@/lib/parents/reask-rule";

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
