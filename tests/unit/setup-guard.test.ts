import { describe, it, expect, vi } from "vitest";

const hasSetupSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/setup/session", () => ({ hasSetupSession }));

import { setupAction, SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { AccessDenied, guardOf } from "@/lib/guards";

describe("setupAction", () => {
  it("runs the action when the setup session is valid", async () => {
    hasSetupSession.mockResolvedValue(true);
    expect(await setupAction(async (n: number) => n + 1)(1)).toBe(2);
  });

  it("throws AccessDenied without a session, and never runs the action", async () => {
    hasSetupSession.mockResolvedValue(false);
    const fn = vi.fn(async () => 1);
    await expect(setupAction(fn)()).rejects.toBeInstanceOf(AccessDenied);
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the form's own message when the setup session ended, still without running the action", async () => {
    hasSetupSession.mockResolvedValue(false);
    const fn = vi.fn(async () => ({ error: "" }));
    const wrapped = setupAction(fn, { onExpired: () => ({ error: SETUP_SESSION_ENDED }) });
    expect(await wrapped()).toEqual({ error: "Your setup session ended. Reload the page and enter a new setup code." });
    expect(fn).not.toHaveBeenCalled();
    expect(guardOf(wrapped)?.door).toBe("setup");
  });
});
