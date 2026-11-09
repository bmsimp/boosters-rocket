import "server-only";
import { AccessDenied, registerGuard } from "@/lib/guards";
import { hasSetupSession } from "./session";

/** A setup-page action: refused unless this browser unlocked setup with the current code. */
export function setupAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    if (!(await hasSetupSession())) throw new AccessDenied();
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
