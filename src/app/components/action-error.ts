/**
 * The one message for a server action that threw: refused (AccessDenied), signed out, or broken.
 * It is the same for every reason, so it never hints at why (spec §5.1).
 */
export const ACTION_FAILED = "That didn't go through. Please try again. If it keeps happening, sign out and back in.";

/** Runs a server action; a throw becomes `fallback` instead of crashing the page. */
export async function safely<R>(fn: () => Promise<R>, fallback: R): Promise<R> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
