import "server-only";
import { AccessDenied, registerGuard } from "@/lib/guards";
import { hasSetupSession } from "./session";

export const SETUP_SESSION_ENDED = "Your setup session ended. Reload the page and enter a new setup code.";

/**
 * A setup-page action: refused unless this browser unlocked setup with the current code.
 * With `onExpired`, a form action that has no valid setup session returns that value (so the form can say what to do)
 * instead of throwing AccessDenied. The refusal is the same either way: `fn` never runs.
 */
export function setupAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts?: { onExpired?: () => R }) {
  const wrapped = async (...args: A): Promise<R> => {
    if (!(await hasSetupSession())) {
      if (opts?.onExpired) return opts.onExpired();
      throw new AccessDenied();
    }
    return fn(...args);
  };
  registerGuard(wrapped, { door: "setup" });
  return wrapped;
}

/** The unlock action itself: its guard is the code check (slowed down and audited) it performs. */
export function setupUnlockAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => fn(...args);
  registerGuard(wrapped, { door: "setup-unlock" });
  return wrapped;
}
